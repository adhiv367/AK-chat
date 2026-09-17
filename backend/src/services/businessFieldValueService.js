// Phase 8E — Dynamic Business Fields: customer-value storage foundation.
//
// Per spec §4: "If existing contacts.custom_fields can safely hold this
// data, reuse it rather than introducing unnecessary duplicate storage."
// coexistence.contacts.custom_fields is already a JSONB column used for
// several unrelated purposes (see routes/contacts.js — retarget URLs,
// import provenance, etc.), so business-field values are namespaced under
// a dedicated top-level key, further namespaced by whatsapp_account_id, so
// this NEVER collides with existing keys and NEVER mixes data across
// WhatsApp accounts that might share a contact row:
//
//   custom_fields = {
//     ...whatever already exists, untouched...
//     business_fields: {
//       "<whatsappAccountId>": { "<field_key>": <value>, ... }
//     }
//   }
//
// This file does NOT implement automatic AI extraction (8F+) — it only
// provides safe get/set primitives that validate a value against its field
// definition (type, required, allowed options) before writing, and that
// only ever touch the business_fields.<account> sub-object — every other
// key in custom_fields, and every other account's sub-object, is
// preserved untouched (uses jsonb_set, never a wholesale overwrite).

const pool = require('../db');
const {
  listFieldDefinitions,
  assertWhatsappAccountInWorkspace,
  ValidationError,
  NotFoundError,
} = require('./businessFieldDefinitionService');

function validateValueAgainstDefinition(def, value) {
  if (value === null || value === undefined) {
    if (def.isRequired) {
      throw new ValidationError(`"${def.fieldKey}" is required`);
    }
    return null;
  }

  switch (def.fieldType) {
    case 'text':
      if (typeof value !== 'string') throw new ValidationError(`"${def.fieldKey}" must be a string`);
      return value;
    case 'number': {
      const n = Number(value);
      if (Number.isNaN(n)) throw new ValidationError(`"${def.fieldKey}" must be a number`);
      return n;
    }
    case 'boolean':
      if (typeof value !== 'boolean') throw new ValidationError(`"${def.fieldKey}" must be a boolean`);
      return value;
    case 'date':
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        throw new ValidationError(`"${def.fieldKey}" must be a valid date string`);
      }
      return value;
    case 'select': {
      const options = def.fieldConfig?.options || [];
      if (typeof value !== 'string' || !options.includes(value)) {
        throw new ValidationError(`"${def.fieldKey}" must be one of: ${options.join(', ')}`);
      }
      return value;
    }
    case 'multiselect': {
      const options = def.fieldConfig?.options || [];
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !options.includes(v))) {
        throw new ValidationError(`"${def.fieldKey}" must be an array of values from: ${options.join(', ')}`);
      }
      return value;
    }
    default:
      // Unreachable given businessFieldDefinitionService validates
      // field_type at write time, but fail closed rather than silently
      // accepting an unrecognized type.
      throw new ValidationError(`Unsupported field_type "${def.fieldType}" for "${def.fieldKey}"`);
  }
}

// Reads the currently-stored business-field values for a contact, scoped
// to this workspace + whatsapp account. Returns {} if the contact has none
// yet — never throws for "no values", only for ownership/not-found issues.
async function getContactBusinessFieldValues(workspaceId, whatsappAccountId, contactId) {
  await assertWhatsappAccountInWorkspace(workspaceId, whatsappAccountId);

  const { rows } = await pool.query(
    `SELECT custom_fields FROM coexistence.contacts WHERE id = $1 AND workspace_id = $2`,
    [contactId, workspaceId]
  );
  if (rows.length === 0) throw new NotFoundError('Contact not found in this workspace');

  const customFields = rows[0].custom_fields || {};
  return customFields.business_fields?.[String(whatsappAccountId)] || {};
}

// Validates `values` (a plain { field_key: value } object) against this
// account's active field definitions, then merges the validated result
// into contacts.custom_fields.business_fields.<whatsappAccountId>. The
// full custom_fields object is reconstructed in JS (existing custom_fields
// spread first) so every other key in custom_fields, and every other
// account's business_fields sub-object, is left exactly as it was — see
// the fix note inline below for why this isn't done via a single SQL
// jsonb_set call. Unknown field keys (not a configured, active
// definition) are rejected rather than silently stored, so this never
// becomes a second, unstructured custom-fields dumping ground.
async function setContactBusinessFieldValues(workspaceId, whatsappAccountId, contactId, values = {}) {
  await assertWhatsappAccountInWorkspace(workspaceId, whatsappAccountId);

  const { rows: contactRows } = await pool.query(
    `SELECT id, custom_fields FROM coexistence.contacts WHERE id = $1 AND workspace_id = $2`,
    [contactId, workspaceId]
  );
  if (contactRows.length === 0) throw new NotFoundError('Contact not found in this workspace');

  const definitions = await listFieldDefinitions(workspaceId, whatsappAccountId, { includeInactive: false });
  const byKey = new Map(definitions.map((d) => [d.fieldKey, d]));

  const validated = {};
  for (const [key, value] of Object.entries(values || {})) {
    const def = byKey.get(key);
    if (!def) {
      throw new ValidationError(`"${key}" is not a configured, active business field for this WhatsApp account`);
    }
    validated[key] = validateValueAgainstDefinition(def, value);
  }

  // Required-field completeness is intentionally NOT enforced here beyond
  // "if a required field is being set to null/undefined, reject it" (see
  // validateValueAgainstDefinition) — a partial save of some fields is a
  // normal, valid state (e.g. a form saved before every field was filled
  // in), and 8E does not implement any workflow that would treat a
  // customer record as "complete".

  const existing = contactRows[0].custom_fields || {};
  const existingForAccount = existing.business_fields?.[String(whatsappAccountId)] || {};
  const merged = { ...existingForAccount, ...validated };

  // Bug fix (Phase 6.6 runtime error): jsonb_set(target, path, value, true)
  // only creates the FINAL key of `path` when create_missing is true — it
  // does not create missing intermediate objects. When a contact's
  // custom_fields has no "business_fields" key yet (e.g. custom_fields =
  // '{}', as for a brand-new contact), the path ['business_fields',
  // String(whatsappAccountId)]'s parent doesn't exist, so jsonb_set
  // silently no-ops and returns custom_fields UNCHANGED — no SQL error.
  // The old code then read rows[0].custom_fields.business_fields[...] and
  // crashed with "Cannot read properties of undefined (reading '<id>')"
  // because .business_fields was never actually added.
  //
  // Fix: construct the complete updated custom_fields object here in JS —
  // `existing` is spread first, so every other key and every other
  // account's business_fields sub-object is preserved exactly as before —
  // and write it with a plain assignment. This sidesteps jsonb_set's
  // partial-path-creation limitation entirely instead of working around it
  // with nested SQL, and needs no schema/architecture change.
  const updatedCustomFields = {
    ...existing,
    business_fields: {
      ...(existing.business_fields || {}),
      [String(whatsappAccountId)]: merged,
    },
  };

  const { rows } = await pool.query(
    `UPDATE coexistence.contacts
        SET custom_fields = $3::jsonb,
            updated_at = NOW()
      WHERE id = $1 AND workspace_id = $2
      RETURNING custom_fields`,
    [contactId, workspaceId, JSON.stringify(updatedCustomFields)]
  );
  return rows[0].custom_fields.business_fields[String(whatsappAccountId)];
}

module.exports = {
  getContactBusinessFieldValues,
  setContactBusinessFieldValues,
  validateValueAgainstDefinition,
};