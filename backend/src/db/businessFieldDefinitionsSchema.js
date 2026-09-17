// Phase 8E — Dynamic Business Fields: additive schema extension.
//
// Per the 8E spec ("prefer reusing/extending existing zoho_field_mappings
// if its current structure safely supports this"), this file does NOT
// create a new table. coexistence.zoho_field_mappings (created in 8A —
// see zohoSchema.js) already has exactly the shape 8E needs as a base:
// workspace_id + whatsapp_account_id scoping, field_key/field_label/
// field_type, a JSONB field_config for extensible per-field config
// (options, etc.), zoho_target for future Zoho mapping metadata,
// is_active + display_order, and a UNIQUE(workspace_id,
// whatsapp_account_id, field_key) constraint that already gives us "no
// duplicate field key within an account" for free.
//
// This file only ALTERs that table, additively, the same idempotent
// pattern used throughout this codebase's db/ folder (ADD COLUMN IF NOT
// EXISTS, DROP+ADD CONSTRAINT for CHECKs so they can be widened safely,
// CREATE INDEX IF NOT EXISTS):
//
//   - description             TEXT              — help text / description
//   - is_required              BOOLEAN            — required/optional
//   - field_scope              TEXT               — 'standard' | 'business_specific'
//   - extraction_key           TEXT               — stable key for future AI extraction (8F+)
//   - extraction_instruction   TEXT               — free-text guidance for future AI extraction (8F+)
//   - config_version           INTEGER            — bumped by the service on every update
//
// field_config (already JSONB, already NOT NULL DEFAULT '{}') is reused,
// unmodified in shape, to hold `{ options: [...] }` for select/multiselect
// fields — no new column needed for that.
//
// field_type is widened from its previous free-form TEXT (no CHECK existed
// before 8E) to a CHECK constraint covering exactly the 8E-required set:
// text, number, boolean, date, select, multiselect. Existing rows (from
// 8A/8B/8C, all still field_type='text' since nothing wrote other values
// yet) remain valid under the new, stricter constraint.
//
// Must run after:
//   - ensureZohoTables()  (creates coexistence.zoho_field_mappings itself)
//
// Does NOT touch zoho_connections, zoho_lead_links, zoho_extraction_audit,
// or zoho_lead_notes — those are untouched by 8E.

const pool = require('../db');

const BUSINESS_FIELD_TYPES = ['text', 'number', 'boolean', 'date', 'select', 'multiselect'];
const BUSINESS_FIELD_SCOPES = ['standard', 'business_specific'];

async function ensureBusinessFieldDefinitionColumns() {
  await pool.query(`
    ALTER TABLE coexistence.zoho_field_mappings
      ADD COLUMN IF NOT EXISTS description TEXT
  `);
  await pool.query(`
    ALTER TABLE coexistence.zoho_field_mappings
      ADD COLUMN IF NOT EXISTS is_required BOOLEAN NOT NULL DEFAULT false
  `);
  await pool.query(`
    ALTER TABLE coexistence.zoho_field_mappings
      ADD COLUMN IF NOT EXISTS field_scope TEXT NOT NULL DEFAULT 'business_specific'
  `);
  await pool.query(`
    ALTER TABLE coexistence.zoho_field_mappings
      ADD COLUMN IF NOT EXISTS extraction_key TEXT
  `);
  await pool.query(`
    ALTER TABLE coexistence.zoho_field_mappings
      ADD COLUMN IF NOT EXISTS extraction_instruction TEXT
  `);
  await pool.query(`
    ALTER TABLE coexistence.zoho_field_mappings
      ADD COLUMN IF NOT EXISTS config_version INTEGER NOT NULL DEFAULT 1
  `);

  // Widen field_type into an explicit CHECK (none existed pre-8E). Every
  // existing row was written with field_type='text' (8A/8B/8C never wrote
  // any other value), so this cannot fail against existing data.
  await pool.query(`
    ALTER TABLE coexistence.zoho_field_mappings
      DROP CONSTRAINT IF EXISTS zoho_field_mappings_field_type_check
  `);
  await pool.query(`
    ALTER TABLE coexistence.zoho_field_mappings
      ADD CONSTRAINT zoho_field_mappings_field_type_check
      CHECK (field_type IN (${BUSINESS_FIELD_TYPES.map((t) => `'${t}'`).join(', ')}))
  `);

  await pool.query(`
    ALTER TABLE coexistence.zoho_field_mappings
      DROP CONSTRAINT IF EXISTS zoho_field_mappings_field_scope_check
  `);
  await pool.query(`
    ALTER TABLE coexistence.zoho_field_mappings
      ADD CONSTRAINT zoho_field_mappings_field_scope_check
      CHECK (field_scope IN (${BUSINESS_FIELD_SCOPES.map((s) => `'${s}'`).join(', ')}))
  `);

  // Supports "list active fields for this account, in display order" — the
  // read path every future extraction/UI consumer will use.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_zoho_field_mappings_account_active_order
      ON coexistence.zoho_field_mappings (workspace_id, whatsapp_account_id, is_active, display_order)
  `);
}

module.exports = {
  ensureBusinessFieldDefinitionColumns,
  BUSINESS_FIELD_TYPES,
  BUSINESS_FIELD_SCOPES,
};

