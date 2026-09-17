// Phase 6.6 — WhatsApp Flow submission → Contact / Business Field mapping.
//
// Consumes a Flow submission's response_json (already safely stored by
// Phase 6.5's flowSubmissionService.js) and, where the Flow has an
// explicit field_mapping configured, writes the mapped values into the
// EXISTING contact/business-field storage — never a new architecture:
//
//   - "name"  -> coexistence.contacts.name          (same column/semantics
//                as routes/messages.js's POST /contacts/save)
//   - "email" -> coexistence.contacts.custom_fields.email, merged with the
//                jsonb `||` operator — the exact convention
//                POST /contacts/save already uses for a bare `email`
//   - anything else -> treated as a business/custom field_key and applied
//                through the EXISTING businessFieldValueService.js
//                (services/businessFieldDefinitionService.js +
//                businessFieldValueService.js — Phase 8E), which already
//                validates the value against that field's definition/type
//                and stores it under
//                contacts.custom_fields.business_fields.<whatsappAccountId>
//
// No new tables, no new contact-creation architecture, no CRM/Zoho/
// Automation/Campaign/Sequence/Template code touched. flows.field_mapping
// (JSONB, added in Phase 6.1) is the ONLY mapping source — a plain
// { submittedFieldKey: targetFieldKey } object, e.g.:
//   { "name": "name", "email": "email", "roof_type": "roof_type" }
//
// Every failure mode here is caught and reported back as a per-field skip
// reason (never thrown) — one bad field must never block the others, and
// this module must never be able to fail the Flow submission that was
// already durably stored by flowSubmissionService.js.

const pool = require('../db');
const {
  ValidationError,
  NotFoundError,
} = require('./businessFieldDefinitionService');
const { setContactBusinessFieldValues } = require('./businessFieldValueService');

// Mapping targets that resolve to a real, existing Contact column/JSON key
// rather than a configured business field. Anything not in this set is
// assumed to be a business field_key and is resolved via the existing
// business-field system (which itself safely rejects an unknown/inactive
// key — see businessFieldValueService.setContactBusinessFieldValues).
const STANDARD_CONTACT_TARGETS = new Set(['name', 'email']);

const MAX_NAME_LENGTH = 255;

// Normalizes flows.field_mapping into a plain { submittedKey: targetKey }
// object, dropping anything malformed rather than throwing — a flow saved
// with a stray non-string mapping value must not break every future
// submission for that flow.
function normalizeFieldMapping(fieldMapping) {
  if (!fieldMapping || typeof fieldMapping !== 'object' || Array.isArray(fieldMapping)) return {};
  const out = {};
  for (const [submittedKey, targetKey] of Object.entries(fieldMapping)) {
    if (typeof submittedKey === 'string' && submittedKey.trim() && typeof targetKey === 'string' && targetKey.trim()) {
      out[submittedKey] = targetKey.trim();
    }
  }
  return out;
}

async function loadFlow(flowId, workspaceId) {
  const { rows } = await pool.query(
    `SELECT id, workspace_id, whatsapp_account_id, field_mapping
       FROM coexistence.flows WHERE id = $1 AND workspace_id = $2`,
    [flowId, workspaceId]
  );
  return rows[0] || null;
}

// Resolves the contact this submission belongs to, creating it if it
// doesn't exist yet — same (wa_number, contact_number) UNIQUE-keyed
// upsert convention routes/messages.js's POST /contacts/save already
// uses, extended only to also set workspace_id on a brand-new row (that
// column already exists — added additively by
// db/contactsWorkspaceSchema.js — this just populates it correctly at
// creation time instead of relying on a one-off backfill migration).
// Never overwrites an existing contact's workspace_id.
async function resolveOrCreateContact({ workspaceId, waNumber, contactNumber }) {
  const { rows } = await pool.query(
    `INSERT INTO coexistence.contacts
       (workspace_id, wa_number, contact_number, tags, custom_fields, updated_at)
     VALUES ($1, $2, $3, '[]'::jsonb, '{}'::jsonb, NOW())
     ON CONFLICT (wa_number, contact_number) DO UPDATE SET
       workspace_id = COALESCE(coexistence.contacts.workspace_id, EXCLUDED.workspace_id),
       updated_at = NOW()
     RETURNING id, workspace_id`,
    [workspaceId, waNumber, contactNumber]
  );
  return rows[0] || null;
}

// "name" -> contacts.name. Same validation routes/messages.js's
// POST /contacts/save already applies (non-empty string, max 255 chars).
async function applyNameField(contactId, value) {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, reason: 'value is not a non-empty string' };
  }
  const cleaned = value.trim();
  if (cleaned.length > MAX_NAME_LENGTH) {
    return { ok: false, reason: `value exceeds ${MAX_NAME_LENGTH} characters` };
  }
  await pool.query(
    `UPDATE coexistence.contacts SET name = $1, updated_at = NOW() WHERE id = $2`,
    [cleaned, contactId]
  );
  return { ok: true };
}

// "email" -> contacts.custom_fields.email, merged with the `||` jsonb
// operator — exactly the merge routes/messages.js's POST /contacts/save
// uses for a bare `email` field, so this can never wipe unrelated
// custom_fields keys (including other business_fields.<account> data).
async function applyEmailField(contactId, value) {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, reason: 'value is not a non-empty string' };
  }
  const cleaned = value.trim();
  await pool.query(
    `UPDATE coexistence.contacts
        SET custom_fields = custom_fields || $1::jsonb, updated_at = NOW()
      WHERE id = $2`,
    [JSON.stringify({ email: cleaned }), contactId]
  );
  return { ok: true };
}

// Anything else -> an existing business/custom field_key, applied through
// the EXISTING businessFieldValueService (type validation, active/known
// field_key enforcement, and the jsonb_set-based per-account storage are
// all inherited unchanged from Phase 8E). Called one field at a time
// (rather than batching the whole mapping into a single
// setContactBusinessFieldValues call) specifically so one invalid/unknown
// key can't abort every other field in the same submission — that
// function throws on the FIRST bad key in a batch, which would violate
// spec §E ("one field fails -> other valid fields should still map").
async function applyBusinessField({ workspaceId, whatsappAccountId, contactId, fieldKey, value }) {
  if (!whatsappAccountId) {
    return { ok: false, reason: 'flow has no WhatsApp account bound — cannot resolve business field definitions' };
  }
  try {
    await setContactBusinessFieldValues(workspaceId, whatsappAccountId, contactId, { [fieldKey]: value });
    return { ok: true };
  } catch (err) {
    if (err instanceof ValidationError || err instanceof NotFoundError) {
      return { ok: false, reason: err.message };
    }
    throw err;
  }
}

/**
 * Main entry point — called once per newly-stored (non-duplicate) Flow
 * submission. Never throws: every failure mode is caught and reported as
 * a skip reason so a bad mapping config or submission can never disturb
 * the caller (flowSubmissionService.recordFlowSubmission, which has
 * already durably stored the raw submission before this ever runs).
 *
 * @param {object} params
 * @param {number|string} params.flowId
 * @param {number|string} params.workspaceId - resolved upstream from the
 *   receiving phone_number_id, never from submitted data (see
 *   flowSubmissionService.js's workspace-safety note)
 * @param {string} params.waNumber - digits-only business number that
 *   received the reply (used only for the (wa_number, contact_number)
 *   contact lookup key, same as everywhere else in this codebase)
 * @param {string} params.contactNumber - digits-only customer number
 * @param {object} params.responseData - the parsed Flow response object
 *   (flow_token plus whatever fields the Flow's screens submitted)
 * @returns {Promise<{attempted: boolean, mapped: string[], skipped: Array<{field?: string, reason: string, type: 'missing'|'error'|'config'}>}>}
 */
async function mapFlowSubmissionToContact({ flowId, workspaceId, waNumber, contactNumber, responseData }) {
  const summary = { attempted: false, mapped: [], skipped: [] };

  try {
    const flow = await loadFlow(flowId, workspaceId);
    if (!flow) {
      summary.skipped.push({ reason: 'flow not found in this workspace', type: 'config' });
      return summary;
    }

    const mapping = normalizeFieldMapping(flow.field_mapping);
    if (Object.keys(mapping).length === 0) {
      // Spec §E: empty mapping -> submission stays successfully stored,
      // no mapping work, no error.
      return summary;
    }

    if (!responseData || typeof responseData !== 'object') {
      summary.skipped.push({ reason: 'no response data to map', type: 'config' });
      return summary;
    }

    summary.attempted = true;

    if (!waNumber || !contactNumber) {
      summary.skipped.push({ reason: 'recipient/contact number not resolvable', type: 'config' });
      return summary;
    }

    const contact = await resolveOrCreateContact({ workspaceId, waNumber, contactNumber });
    if (!contact || String(contact.workspace_id) !== String(workspaceId)) {
      // Never write into a contact row that resolved to a different
      // workspace than the one this submission belongs to (spec §B.7 —
      // never trust workspace_id/contact ownership from submitted data).
      summary.skipped.push({ reason: 'contact could not be safely resolved to this workspace', type: 'config' });
      return summary;
    }

    for (const [submittedKey, targetKey] of Object.entries(mapping)) {
      if (!(submittedKey in responseData) || responseData[submittedKey] === undefined) {
        summary.skipped.push({ field: submittedKey, reason: 'not present in submission', type: 'missing' });
        continue;
      }
      const value = responseData[submittedKey];

      try {
        let result;
        if (STANDARD_CONTACT_TARGETS.has(targetKey)) {
          result = targetKey === 'name'
            ? await applyNameField(contact.id, value)
            : await applyEmailField(contact.id, value);
        } else {
          result = await applyBusinessField({
            workspaceId,
            whatsappAccountId: flow.whatsapp_account_id,
            contactId: contact.id,
            fieldKey: targetKey,
            value,
          });
        }

        if (result.ok) {
          summary.mapped.push(submittedKey);
        } else {
          // Never log the submitted value itself — field name + short
          // reason only (spec §H).
          console.warn(`[flowFieldMappingService] flow=${flowId} field "${submittedKey}" -> "${targetKey}" skipped: ${result.reason}`);
          summary.skipped.push({ field: submittedKey, reason: result.reason, type: 'error' });
        }
      } catch (fieldErr) {
        // One field's unexpected failure must never block the others.
        console.error(`[flowFieldMappingService] flow=${flowId} field "${submittedKey}" -> "${targetKey}" error:`, fieldErr.message);
        summary.skipped.push({ field: submittedKey, reason: 'internal error', type: 'error' });
      }
    }

    return summary;
  } catch (err) {
    console.error('[flowFieldMappingService] mapFlowSubmissionToContact error:', err.message);
    summary.skipped.push({ reason: 'internal error', type: 'error' });
    return summary;
  }
}

module.exports = {
  normalizeFieldMapping,
  mapFlowSubmissionToContact,
  STANDARD_CONTACT_TARGETS,
};

