// Phase 6.11 — WhatsApp Flow Form submission -> Lead creation/update.
//
// Reuses the EXISTING Lead creation/update process (zohoLeadService.js —
// createLead / updateLead / getLinkedLead, and its
// coexistence.zoho_lead_links idempotency table) exactly the same way
// zohoSyncService.js's syncConversationToZoho already does. No new CRM
// architecture, no new schema, no changes to zohoLeadService.js itself.
//
// Scope (STRICT — see Phase 6.11 spec):
//   - Called ONLY from flowSubmissionService.js, ONLY after a Flow
//     submission has already been durably stored (non-duplicate insert)
//     and existing Contact/Business Field mapping has run.
//   - Never throws — every failure mode (missing Zoho connection, Lead
//     create/update failure, malformed field, incomplete mapping) is
//     caught internally and returned as { attempted, ok, reason }. A
//     Flow -> Lead failure must never fail the Flow submission itself.
//   - Never logs/returns Zoho tokens, access tokens, or secrets — only
//     zohoLeadService's already-sanitized Error#message ever reaches
//     `reason`.
//   - Idempotency (no duplicate Leads per submission/message_id) comes
//     entirely from reusing getLinkedLead()/createLead()'s existing
//     coexistence.zoho_lead_links UNIQUE(workspace_id,
//     whatsapp_account_id, contact_number) identity — the exact same
//     mechanism syncConversationToZoho relies on. No new DB schema.
//   - Works with ARBITRARY Flow field_mapping — never assumes specific
//     field keys (no hardcoded "dress_type" etc.). The customer name is
//     whichever submitted key the Flow's own field_mapping points at the
//     standard "name" target (the same target flowFieldMappingService.js
//     uses for coexistence.contacts.name) — if none is mapped, no name is
//     guessed, and zohoLeadService itself already falls back to the
//     WhatsApp number for Last_Name (see buildLeadFields).

const zohoLeadService = require('./zohoLeadService');

// "dress_type" -> "Dress Type", "customer_name" -> "Customer Name".
function prettifyLabel(key) {
  return String(key)
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Finds the submitted field whose field_mapping target is the standard
// "name" contact target (same STANDARD_CONTACT_TARGETS convention as
// flowFieldMappingService.js) and returns its submitted value — never a
// hardcoded field key. Returns null (never a guessed/invented name) if the
// Flow has no such mapping, or the mapped field wasn't actually submitted.
function resolveCustomerName(fieldMapping, responseData) {
  if (!fieldMapping || typeof fieldMapping !== 'object' || !responseData || typeof responseData !== 'object') {
    return null;
  }
  for (const [submittedKey, targetKey] of Object.entries(fieldMapping)) {
    if (targetKey !== 'name') continue;
    const value = responseData[submittedKey];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return null;
}

// Builds the required single-line Lead description:
//   "<Label>: <value> | <Label>: <value> | ... | Flow: <name> (ID: <id>)
//    | created from WhatsApp Flow Form"
// Only fields the Flow actually declared in field_mapping AND that were
// actually submitted (non-empty) are included — arbitrary field_mapping,
// no hardcoded field names. The exact phrase "created from WhatsApp Flow
// Form" is always appended verbatim, as required by spec.
function buildDescription({ fieldMapping, responseData, flowName, flowId }) {
  const parts = [];
  const data = responseData && typeof responseData === 'object' ? responseData : {};
  const mapping = fieldMapping && typeof fieldMapping === 'object' ? fieldMapping : {};

  for (const submittedKey of Object.keys(mapping)) {
    const value = data[submittedKey];
    if (value === undefined || value === null || String(value).trim() === '') continue;
    parts.push(`${prettifyLabel(submittedKey)}: ${String(value).trim()}`);
  }

  parts.push(`Flow: ${flowName || 'Unknown Flow'} (ID: ${flowId})`);
  parts.push('created from WhatsApp Flow Form');

  return parts.join(' | ');
}

// Never leaks Zoho tokens/secrets — zohoLeadService's own errors are
// already sanitized (see zohoApiError/resolveConnectionRow), this just
// bounds the length defensively before it's logged/returned upstream.
function sanitizeReason(err) {
  if (!err) return 'unknown error';
  return String(err.message || 'unknown error').slice(0, 300);
}

/**
 * Main entry point — attempts to create-or-update a Lead from a single
 * Flow submission, reusing the existing Lead process end to end. Never
 * throws.
 *
 * @param {object} params
 * @param {number|string} params.flowId
 * @param {string} params.flowName
 * @param {object} params.fieldMapping - the Flow's own field_mapping
 * @param {number|string} params.workspaceId
 * @param {number|string} params.whatsappAccountId
 * @param {string} params.contactNumber
 * @param {object} params.responseData - the parsed Flow response object
 * @returns {Promise<{attempted: boolean, ok: boolean, reason?: string, zohoLeadId?: string, created?: boolean}>}
 */
async function attemptFlowToLead({ flowId, flowName, fieldMapping, workspaceId, whatsappAccountId, contactNumber, responseData }) {
  if (!workspaceId || !whatsappAccountId || !contactNumber) {
    return { attempted: false, ok: false, reason: 'missing workspace/account/contact identifiers' };
  }

  try {
    const name = resolveCustomerName(fieldMapping, responseData);
    const description = buildDescription({ fieldMapping, responseData, flowName, flowId });

    const leadInput = {
      workspaceId,
      whatsappAccountId,
      contactNumber,
      name,
      interestSummary: description,
    };

    // §Idempotency — read AKChat's own ledger first (same pattern as
    // zohoSyncService.syncConversationToZoho): update the already-linked
    // Lead if one exists for this exact (workspace, account, contact)
    // identity, otherwise create. This is what guarantees a retried
    // webhook/duplicate submission (already filtered out upstream by
    // flow_submissions.message_id UNIQUE before this is ever called) —
    // and any other repeat submission from the same contact — never
    // produces a second Lead.
    let existingLink;
    try {
      existingLink = await zohoLeadService.getLinkedLead(workspaceId, whatsappAccountId, contactNumber);
    } catch (err) {
      return { attempted: true, ok: false, reason: sanitizeReason(err) };
    }

    let lead;
    try {
      lead = existingLink && existingLink.zohoLeadId
        ? await zohoLeadService.updateLead(leadInput)
        : await zohoLeadService.createLead(leadInput);
    } catch (err) {
      return { attempted: true, ok: false, reason: sanitizeReason(err) };
    }

    return {
      attempted: true,
      ok: true,
      zohoLeadId: lead ? lead.zohoLeadId : undefined,
      created: Boolean(lead && lead.created),
    };
  } catch (err) {
    return { attempted: true, ok: false, reason: sanitizeReason(err) };
  }
}

module.exports = {
  attemptFlowToLead,
  resolveCustomerName,
  buildDescription,
  prettifyLabel,
};

