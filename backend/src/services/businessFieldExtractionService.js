// Phase 8F — AI → Dynamic Field Mapping.
//
// Connects the completed 8D customer-conversation extraction engine
// (customerExtractionService.js) to the completed 8E dynamic business-field
// configuration (businessFieldDefinitionService.js). This file contains NO
// business-specific field names, types, or logic — every field it works
// with comes from whatever is currently configured, active, for the exact
// workspace_id + whatsapp_account_id being asked about (spec 8F §1).
//
// This file does NOT redesign 8D or 8E — it is a thin orchestration layer:
//   1. Load only ACTIVE 8E field definitions for this workspace/account
//      (businessFieldDefinitionService.listFieldDefinitions with
//      includeInactive: false).
//   2. Pass them into the (8F-extended) 8D extraction flow
//      (customerExtractionService.extractCustomerInformation), which
//      already handles: full conversation loading, evidence, confidence,
//      malformed-AI-output safety, evidence-integrity cross-checking,
//      correction/previous handling, and audit persistence via the
//      existing zoho_extraction_audit table (spec 8F §5) — NOTHING here
//      duplicates that logic.
//   3. Shape the response for API consumption: extracted fields, missing
//      required business fields, uncertain fields, overall status (spec
//      8F §3).
//
// This file explicitly does NOT:
//   - create/update a Zoho Lead (that is 8G).
//   - overwrite a contact's stored business-field values
//     (businessFieldValueService.setContactBusinessFieldValues) — spec 8F
//     §5 requires actual customer-value persistence to stay separate from
//     this preview/audit extraction, so this is a read-only preview
//     operation against a contact's values unless a caller explicitly
//     opts in via applyToContact (see extractAndApply below), which is
//     still not automatic CRM sync.

const fieldDefinitionsService = require('./businessFieldDefinitionService');
const customerExtractionService = require('./customerExtractionService');
const fieldValueService = require('./businessFieldValueService');

/**
 * Runs 8D+8F extraction for one conversation, using ONLY the active 8E
 * field definitions configured for this exact workspace/whatsapp account
 * (spec 8F §1 — strict workspace_id + whatsapp_account_id isolation is
 * inherited from both businessFieldDefinitionService.listFieldDefinitions
 * and customerExtractionService.extractCustomerInformation, which each
 * independently verify the whatsapp account belongs to the workspace).
 *
 * @param {object} params
 * @param {number|string} params.workspaceId - MUST be server-resolved by
 *   the caller (e.g. from the authenticated session's req.workspace.id),
 *   never trusted from client input (spec 8F §7).
 * @param {number|string} params.whatsappAccountId
 * @param {string} params.contactNumber
 * @param {Array<object>} [params.conversationMessages] - optional
 *   pre-fetched conversation; forwarded as-is to 8D.
 * @param {boolean} [params.persist=true] - forwarded to 8D; false ->
 *   preview-only, no audit row written.
 * @param {string} [params.model] - optional Gemini model override.
 * @returns {Promise<object>} shape:
 *   {
 *     extraction: { ...8D standard fields..., business_fields, validation, business_validation },
 *     standard: { status, missing_required_fields, uncertain_fields },
 *     business: {
 *       status, extracted_fields, missing_required_fields, uncertain_fields, overall_confidence
 *     },
 *     fieldDefinitions: [ ...serialized 8E definitions used for this call... ],
 *     complete: boolean,   // standard 8D completeness (unchanged meaning)
 *     audit: object|null,
 *     error: string|null,
 *   }
 */
async function extractBusinessFields(params = {}) {
  const { workspaceId, whatsappAccountId, contactNumber, conversationMessages, persist = true, model } = params;

  if (!workspaceId) throw new Error('workspaceId is required');
  if (!whatsappAccountId) throw new Error('whatsappAccountId is required');

  // §1 — Load only active field definitions for this workspace + account.
  // This call itself asserts the whatsapp account belongs to this
  // workspace, so a mismatched pair fails closed here before anything else
  // runs (and again, independently, inside extractCustomerInformation).
  const fieldDefinitions = await fieldDefinitionsService.listFieldDefinitions(workspaceId, whatsappAccountId, {
    includeInactive: false,
  });

  // §2 — Extend/reuse the existing 8D extraction flow, now field-aware.
  // When fieldDefinitions is empty, this is byte-for-byte the same call 8D
  // has always supported — extraction "must still work using existing 8D
  // behavior" (spec 8F §1) when no business-specific fields are configured.
  const result = await customerExtractionService.extractCustomerInformation({
    workspaceId,
    whatsappAccountId,
    contactNumber,
    conversationMessages,
    persist,
    model,
    fieldDefinitions,
  });

  const { extraction } = result;
  const businessValidation = extraction.business_validation || { status: 'COMPLETE', extracted_fields: {}, missing_required_fields: [], uncertain_fields: [], overall_confidence: 0 };

  return {
    extraction,
    standard: {
      status: result.status,
      missing_required_fields: extraction.validation?.missing_required_fields || [],
      uncertain_fields: extraction.validation?.uncertain_fields || [],
    },
    business: {
      status: businessValidation.status,
      extracted_fields: businessValidation.extracted_fields,
      missing_required_fields: businessValidation.missing_required_fields,
      uncertain_fields: businessValidation.uncertain_fields,
      overall_confidence: businessValidation.overall_confidence,
    },
    fieldDefinitions,
    complete: result.complete,
    audit: result.audit,
    error: result.error,
  };
}

/**
 * Convenience wrapper: runs extractBusinessFields(), then — ONLY when the
 * caller explicitly asks (applyToContact=true) AND a contactId is given —
 * writes the CONFIRMED (not uncertain, not missing) business-field values
 * to the contact's stored values via the existing 8E
 * businessFieldValueService.setContactBusinessFieldValues() safe
 * validate-then-write path. This is still a deliberate, explicit,
 * per-call opt-in — never automatic — and is entirely separate from any
 * future Zoho sync (8G). Values below the confirm confidence threshold, or
 * fields the model didn't find, are never written.
 *
 * @param {object} params - same as extractBusinessFields(), plus:
 * @param {number|string} [params.contactId] - required when applyToContact is true.
 * @param {boolean} [params.applyToContact=false]
 */
async function extractAndApply(params = {}) {
  const { applyToContact = false, contactId } = params;
  const result = await extractBusinessFields(params);

  if (!applyToContact) return { ...result, applied: null };
  if (!contactId) throw new Error('contactId is required when applyToContact is true');

  const confirmedValues = {};
  for (const [key, entry] of Object.entries(result.business.extracted_fields || {})) {
    if (result.business.uncertain_fields.includes(key)) continue; // only write confirmed values
    confirmedValues[key] = entry.value;
  }

  if (Object.keys(confirmedValues).length === 0) {
    return { ...result, applied: {} };
  }

  const applied = await fieldValueService.setContactBusinessFieldValues(
    params.workspaceId,
    params.whatsappAccountId,
    contactId,
    confirmedValues
  );

  return { ...result, applied };
}

module.exports = {
  extractBusinessFields,
  extractAndApply,
};

