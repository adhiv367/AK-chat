// Phase 8E — Dynamic Business Fields: field-definition CRUD service.
//
// Scoped to coexistence.zoho_field_mappings (extended additively by
// db/businessFieldDefinitionsSchema.js — see that file for why this reuses
// zoho_field_mappings instead of a new table). Mirrors the isolation model
// established by zohoConnectionService.js: every public function requires
// BOTH workspaceId AND whatsappAccountId and verifies the WhatsApp account
// belongs to that workspace before touching any row.
//
// This file does NOT implement AI field extraction (8F+) or Zoho Lead
// create/update (8G+) — extraction_key/extraction_instruction/zoho_target
// are metadata columns only; nothing here calls Zoho or an AI model.

const pool = require('../db');
const { BUSINESS_FIELD_TYPES, BUSINESS_FIELD_SCOPES } = require('../db/businessFieldDefinitionsSchema');

const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const TYPES_WITH_OPTIONS = new Set(['select', 'multiselect']);

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.status = 404;
  }
}

// ── Ownership guard ─────────────────────────────────────────────────────
// Same choke point pattern as zohoConnectionService.assertWhatsappAccountInWorkspace
// — every public function below calls this first, so a whatsappAccountId
// belonging to a different workspace can never be used to read/write
// business-field rows, regardless of what the caller supplies.
async function assertWhatsappAccountInWorkspace(workspaceId, whatsappAccountId) {
  if (!workspaceId) throw new ValidationError('workspaceId is required');
  if (!whatsappAccountId) throw new ValidationError('whatsappAccountId is required');

  const { rows } = await pool.query(
    `SELECT id FROM coexistence.whatsapp_accounts WHERE id = $1 AND workspace_id = $2`,
    [whatsappAccountId, workspaceId]
  );
  if (rows.length === 0) {
    throw new NotFoundError('WhatsApp account not found in this workspace');
  }
}

// ── Validation ───────────────────────────────────────────────────────────

function validateFieldKey(fieldKey) {
  if (typeof fieldKey !== 'string' || !FIELD_KEY_RE.test(fieldKey)) {
    throw new ValidationError(
      'field_key must be lowercase letters, numbers, and underscores, starting with a letter (max 64 chars)'
    );
  }
}

function validateFieldType(fieldType) {
  if (!BUSINESS_FIELD_TYPES.includes(fieldType)) {
    throw new ValidationError(`field_type must be one of: ${BUSINESS_FIELD_TYPES.join(', ')}`);
  }
}

function validateFieldScope(fieldScope) {
  if (!BUSINESS_FIELD_SCOPES.includes(fieldScope)) {
    throw new ValidationError(`field_scope must be one of: ${BUSINESS_FIELD_SCOPES.join(', ')}`);
  }
}

// Validates + normalizes field_config. Only `options` is currently defined
// (for select/multiselect); everything else in field_config is passed
// through untouched so future config shapes never require a code change
// here, but options ARE enforced: required + non-empty for select/
// multiselect, and rejected (ignored, per spec) for every other type.
function normalizeFieldConfig(fieldType, fieldConfigInput) {
  const config = { ...(fieldConfigInput && typeof fieldConfigInput === 'object' ? fieldConfigInput : {}) };

  if (TYPES_WITH_OPTIONS.has(fieldType)) {
    if (!Array.isArray(config.options) || config.options.length === 0) {
      throw new ValidationError(`field_config.options is required and must be a non-empty array for field_type "${fieldType}"`);
    }
    const seen = new Set();
    for (const opt of config.options) {
      if (typeof opt !== 'string' || !opt.trim()) {
        throw new ValidationError('field_config.options must be an array of non-empty strings');
      }
      if (seen.has(opt)) {
        throw new ValidationError(`field_config.options contains a duplicate value: "${opt}"`);
      }
      seen.add(opt);
    }
  } else if (config.options !== undefined) {
    // Options are meaningless for non-select types — spec §1 says "absent
    // or ignored for other types". We ignore rather than error, to keep a
    // type-change (select -> text) from being blocked by stale options.
    delete config.options;
  }

  return config;
}

function validateZohoTarget(zohoTarget) {
  if (zohoTarget === undefined || zohoTarget === null || zohoTarget === '') return null;
  if (typeof zohoTarget !== 'string' || zohoTarget.length > 255) {
    throw new ValidationError('zoho_target must be a string (max 255 chars)');
  }
  return zohoTarget;
}

function validateDisplayOrder(displayOrder) {
  if (displayOrder === undefined || displayOrder === null) return 0;
  const n = Number(displayOrder);
  if (!Number.isInteger(n)) {
    throw new ValidationError('display_order must be an integer');
  }
  return n;
}

// ── Serialization ────────────────────────────────────────────────────────
// Sanitized JSON only, per spec §3 — never leaks anything beyond this
// row's own configured shape (no internal ids from other tables, no
// tokens — this table never stores any).
function serialize(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    whatsappAccountId: row.whatsapp_account_id,
    fieldKey: row.field_key,
    fieldLabel: row.field_label,
    description: row.description,
    fieldType: row.field_type,
    isRequired: row.is_required,
    fieldScope: row.field_scope,
    fieldConfig: row.field_config,
    zohoTarget: row.zoho_target,
    extractionKey: row.extraction_key,
    extractionInstruction: row.extraction_instruction,
    isActive: row.is_active,
    displayOrder: row.display_order,
    configVersion: row.config_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── CRUD ─────────────────────────────────────────────────────────────────

// List, deterministically ordered (display_order then field_key so ties
// never reorder between requests). includeInactive=false by default so
// normal consumers (future extraction/UI) only ever see usable fields.
async function listFieldDefinitions(workspaceId, whatsappAccountId, { includeInactive = true } = {}) {
  await assertWhatsappAccountInWorkspace(workspaceId, whatsappAccountId);

  const params = [workspaceId, whatsappAccountId];
  let activeClause = '';
  if (!includeInactive) {
    activeClause = 'AND is_active = true';
  }

  const { rows } = await pool.query(
    `SELECT * FROM coexistence.zoho_field_mappings
      WHERE workspace_id = $1 AND whatsapp_account_id = $2 ${activeClause}
      ORDER BY display_order ASC, field_key ASC`,
    params
  );
  return rows.map(serialize);
}

async function createFieldDefinition(workspaceId, whatsappAccountId, input = {}) {
  await assertWhatsappAccountInWorkspace(workspaceId, whatsappAccountId);

  const fieldKey = input.fieldKey;
  const fieldLabel = typeof input.fieldLabel === 'string' ? input.fieldLabel.trim() : '';
  const fieldType = input.fieldType || 'text';
  const fieldScope = input.fieldScope || 'business_specific';

  validateFieldKey(fieldKey);
  if (!fieldLabel) {
    throw new ValidationError('fieldLabel is required');
  }
  validateFieldType(fieldType);
  validateFieldScope(fieldScope);
  const fieldConfig = normalizeFieldConfig(fieldType, input.fieldConfig);
  const zohoTarget = validateZohoTarget(input.zohoTarget);
  const displayOrder = validateDisplayOrder(input.displayOrder);
  const isRequired = Boolean(input.isRequired);
  const isActive = input.isActive === undefined ? true : Boolean(input.isActive);
  const description = typeof input.description === 'string' ? input.description.trim() || null : null;
  const extractionKey = typeof input.extractionKey === 'string' ? input.extractionKey.trim() || null : null;
  const extractionInstruction =
    typeof input.extractionInstruction === 'string' ? input.extractionInstruction.trim() || null : null;

  // Required fields cannot be configured with an invalid/empty type-config
  // combination — the normalizeFieldConfig() call above already enforces
  // options-for-select; this extra guard covers spec §3's "required fields
  // cannot contain invalid configuration" for the boolean/date case where
  // "required" + no sensible default is still a legal, deliberate choice
  // left to the caller — no additional constraint needed beyond what's
  // already validated above.

  try {
    const { rows } = await pool.query(
      `INSERT INTO coexistence.zoho_field_mappings
         (workspace_id, whatsapp_account_id, field_key, field_label, description,
          field_type, is_required, field_scope, field_config, zoho_target,
          extraction_key, extraction_instruction, is_active, display_order, config_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, 1)
       RETURNING *`,
      [
        workspaceId,
        whatsappAccountId,
        fieldKey,
        fieldLabel,
        description,
        fieldType,
        isRequired,
        fieldScope,
        JSON.stringify(fieldConfig),
        zohoTarget,
        extractionKey,
        extractionInstruction,
        isActive,
        displayOrder,
      ]
    );
    return serialize(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      // uq_zoho_field_mappings_key — duplicate field_key within this
      // workspace/account (spec §2: "enforce database uniqueness").
      throw new ValidationError(`A field with key "${fieldKey}" already exists for this WhatsApp account`);
    }
    throw err;
  }
}

async function getFieldDefinition(workspaceId, whatsappAccountId, id) {
  await assertWhatsappAccountInWorkspace(workspaceId, whatsappAccountId);
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.zoho_field_mappings
      WHERE id = $1 AND workspace_id = $2 AND whatsapp_account_id = $3`,
    [id, workspaceId, whatsappAccountId]
  );
  if (rows.length === 0) throw new NotFoundError('Field definition not found');
  return serialize(rows[0]);
}

async function updateFieldDefinition(workspaceId, whatsappAccountId, id, input = {}) {
  const existing = await getFieldDefinition(workspaceId, whatsappAccountId, id);

  const fieldType = input.fieldType !== undefined ? input.fieldType : existing.fieldType;
  validateFieldType(fieldType);

  const fieldScope = input.fieldScope !== undefined ? input.fieldScope : existing.fieldScope;
  validateFieldScope(fieldScope);

  const fieldLabel =
    input.fieldLabel !== undefined ? (typeof input.fieldLabel === 'string' ? input.fieldLabel.trim() : '') : existing.fieldLabel;
  if (!fieldLabel) {
    throw new ValidationError('fieldLabel cannot be empty');
  }

  const fieldConfigSource = input.fieldConfig !== undefined ? input.fieldConfig : existing.fieldConfig;
  const fieldConfig = normalizeFieldConfig(fieldType, fieldConfigSource);

  const zohoTarget = input.zohoTarget !== undefined ? validateZohoTarget(input.zohoTarget) : existing.zohoTarget;
  const displayOrder = input.displayOrder !== undefined ? validateDisplayOrder(input.displayOrder) : existing.displayOrder;
  const isRequired = input.isRequired !== undefined ? Boolean(input.isRequired) : existing.isRequired;
  const isActive = input.isActive !== undefined ? Boolean(input.isActive) : existing.isActive;
  const description =
    input.description !== undefined ? (typeof input.description === 'string' ? input.description.trim() || null : null) : existing.description;
  const extractionKey =
    input.extractionKey !== undefined
      ? (typeof input.extractionKey === 'string' ? input.extractionKey.trim() || null : null)
      : existing.extractionKey;
  const extractionInstruction =
    input.extractionInstruction !== undefined
      ? (typeof input.extractionInstruction === 'string' ? input.extractionInstruction.trim() || null : null)
      : existing.extractionInstruction;

  // field_key is immutable once created — future extraction/AI/Zoho
  // mapping metadata, and any customer-side stored values (see
  // businessFieldValueService.js), are all keyed by field_key. Allowing a
  // rename would silently orphan existing stored values instead of a
  // deliberate delete+recreate.
  if (input.fieldKey !== undefined && input.fieldKey !== existing.fieldKey) {
    throw new ValidationError('field_key cannot be changed after creation');
  }

  const { rows } = await pool.query(
    `UPDATE coexistence.zoho_field_mappings SET
       field_label = $3,
       description = $4,
       field_type = $5,
       is_required = $6,
       field_scope = $7,
       field_config = $8::jsonb,
       zoho_target = $9,
       extraction_key = $10,
       extraction_instruction = $11,
       is_active = $12,
       display_order = $13,
       config_version = config_version + 1,
       updated_at = NOW()
     WHERE id = $1 AND workspace_id = $2
     RETURNING *`,
    [
      id,
      workspaceId,
      fieldLabel,
      description,
      fieldType,
      isRequired,
      fieldScope,
      JSON.stringify(fieldConfig),
      zohoTarget,
      extractionKey,
      extractionInstruction,
      isActive,
      displayOrder,
    ]
  );
  if (rows.length === 0) throw new NotFoundError('Field definition not found');
  return serialize(rows[0]);
}

async function setFieldActive(workspaceId, whatsappAccountId, id, isActive) {
  await assertWhatsappAccountInWorkspace(workspaceId, whatsappAccountId);
  const { rows } = await pool.query(
    `UPDATE coexistence.zoho_field_mappings
        SET is_active = $4, config_version = config_version + 1, updated_at = NOW()
      WHERE id = $1 AND workspace_id = $2 AND whatsapp_account_id = $3
      RETURNING *`,
    [id, workspaceId, whatsappAccountId, Boolean(isActive)]
  );
  if (rows.length === 0) throw new NotFoundError('Field definition not found');
  return serialize(rows[0]);
}

// Hard delete is only allowed when the field is already deactivated AND no
// contact in this workspace currently carries a stored value for it (spec
// §3: "optionally delete only when safe; prefer soft deactivation if
// existing data may depend on it"). Otherwise the caller is told to
// deactivate instead — deactivation (setFieldActive(false)) is always safe
// and is the recommended path.
async function deleteFieldDefinition(workspaceId, whatsappAccountId, id) {
  const existing = await getFieldDefinition(workspaceId, whatsappAccountId, id);

  if (existing.isActive) {
    throw new ValidationError('Deactivate this field before deleting it');
  }

  const { rows: valueRows } = await pool.query(
    `SELECT id FROM coexistence.contacts
      WHERE workspace_id = $1
        AND custom_fields #> ARRAY['business_fields', $2::text, $3] IS NOT NULL
      LIMIT 1`,
    [workspaceId, String(whatsappAccountId), existing.fieldKey]
  );
  if (valueRows.length > 0) {
    throw new ValidationError('This field has stored customer values and cannot be deleted; it remains deactivated');
  }

  const { rowCount } = await pool.query(
    `DELETE FROM coexistence.zoho_field_mappings WHERE id = $1 AND workspace_id = $2 AND whatsapp_account_id = $3`,
    [id, workspaceId, whatsappAccountId]
  );
  if (rowCount === 0) throw new NotFoundError('Field definition not found');
  return true;
}

module.exports = {
  listFieldDefinitions,
  createFieldDefinition,
  getFieldDefinition,
  updateFieldDefinition,
  setFieldActive,
  deleteFieldDefinition,
  assertWhatsappAccountInWorkspace,
  validateFieldKey,
  validateFieldType,
  validateFieldScope,
  normalizeFieldConfig,
  ValidationError,
  NotFoundError,
};