// Phase 6 Gap #1 — additive SaaS column on the pre-existing
// coexistence.contact_field_definitions table (not created anywhere in this
// codebase's db/ folder — same situation as categories, see
// contactsWorkspaceSchema.js). This file only ALTERs it, additively, the
// same idempotent way the rest of the schema files do:
//   1. ADD COLUMN IF NOT EXISTS workspace_id.
//   2. Backfill workspace_id on any existing row that doesn't have one.
//   3. Index it.
//
// MUST run after:
//   - ensureWorkspaceTables()  (default workspace must exist to backfill onto)
//
// contact_field_definitions has no wa_number/whatsapp_account_id to derive a
// workspace from (it's a global settings table, not per-contact), so — same
// as coexistence.categories — every existing row backfills straight to the
// default workspace (oldest workspace, i.e. Invi Creation / workspace_id=1
// in the current database). This never duplicates or deletes a field
// definition — it only tags existing rows.

const pool = require('../db');

async function getDefaultWorkspaceId() {
  const { rows } = await pool.query(
    `SELECT id FROM coexistence.workspaces ORDER BY id ASC LIMIT 1`
  );
  return rows[0]?.id ?? null;
}

async function ensureContactFieldsWorkspaceColumns() {
  await pool.query(`
    ALTER TABLE coexistence.contact_field_definitions
      ADD COLUMN IF NOT EXISTS workspace_id BIGINT
        REFERENCES coexistence.workspaces(id) ON DELETE CASCADE
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_contact_field_definitions_workspace_id
      ON coexistence.contact_field_definitions (workspace_id)
  `);

  const { rows: needsBackfill } = await pool.query(
    `SELECT id FROM coexistence.contact_field_definitions WHERE workspace_id IS NULL LIMIT 1`
  );
  if (needsBackfill.length === 0) return;

  const defaultWorkspaceId = await getDefaultWorkspaceId();
  if (!defaultWorkspaceId) {
    console.warn('[contactFieldsWorkspaceSchema] no workspace found to backfill contact_field_definitions onto yet; will retry next boot');
    return;
  }
  const { rowCount } = await pool.query(
    `UPDATE coexistence.contact_field_definitions
        SET workspace_id = $1
      WHERE workspace_id IS NULL`,
    [defaultWorkspaceId]
  );
  if (rowCount > 0) {
    console.log(`[contactFieldsWorkspaceSchema] backfilled workspace_id for ${rowCount} existing field definition${rowCount === 1 ? '' : 's'} -> workspace ${defaultWorkspaceId}`);
  }
}

module.exports = { ensureContactFieldsWorkspaceColumns };

