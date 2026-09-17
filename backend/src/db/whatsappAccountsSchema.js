// Phase 2B — additive SaaS columns on the pre-existing
// coexistence.whatsapp_accounts table.
//
// IMPORTANT: whatsapp_accounts is NOT created anywhere in this codebase's
// db/ folder (unlike instagramSchema.js / retargetSchema.js / workspaceSchema.js,
// which each own a CREATE TABLE). It's a pre-existing table from an earlier
// phase not represented here. This file therefore does NOT create the table —
// it only ALTERs it, additively, the same idempotent way the rest of the
// schema files do:
//   1. ADD COLUMN IF NOT EXISTS for every new field.
//   2. Backfill workspace_id on any existing row that doesn't have one,
//      into the same default workspace Phase 1 already resolved
//      (coexistence.workspaces, oldest row first — mirrors
//      workspaceSchema.js's own "first workspace" convention).
//
// Nothing here touches access_token_encrypted, verify_token_encrypted,
// phone_number_id, waba_id, webhook config, or any row's existing values —
// this is purely additive, so the existing Invi Creation account is
// never modified, only tagged with the workspace it already effectively
// belongs to.

const pool = require('../db');

async function ensureWhatsappAccountsSaasColumns() {
  await pool.query(`
    ALTER TABLE coexistence.whatsapp_accounts
      ADD COLUMN IF NOT EXISTS workspace_id BIGINT
        REFERENCES coexistence.workspaces(id) ON DELETE CASCADE
  `);
  // Meta Business Manager ID the WABA lives under — discovered during
  // Embedded Signup, not asked of the user in the manual form, so it's
  // nullable and only populated for embedded-signup connections.
  await pool.query(`
    ALTER TABLE coexistence.whatsapp_accounts
      ADD COLUMN IF NOT EXISTS business_id TEXT
  `);
  // 'manual' (existing paste-credentials form) vs 'embedded_signup'. Lets the
  // UI/health checks distinguish provenance without guessing from other
  // columns. Existing rows default to 'manual', which is accurate — they
  // were all created through the paste form before this column existed.
  await pool.query(`
    ALTER TABLE coexistence.whatsapp_accounts
      ADD COLUMN IF NOT EXISTS connected_via TEXT NOT NULL DEFAULT 'manual'
  `);
  // The Meta user ID that completed Embedded Signup, for audit/debugging.
  // Never used for authorization — workspace_id is what scopes access.
  await pool.query(`
    ALTER TABLE coexistence.whatsapp_accounts
      ADD COLUMN IF NOT EXISTS connected_by_meta_user_id TEXT
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_workspace_id
      ON coexistence.whatsapp_accounts (workspace_id)
  `);

  await backfillWorkspaceId();
}

async function backfillWorkspaceId() {
  const { rows: needsBackfill } = await pool.query(
    `SELECT id FROM coexistence.whatsapp_accounts WHERE workspace_id IS NULL`
  );
  if (needsBackfill.length === 0) return;

  const { rows: wsRows } = await pool.query(
    `SELECT id FROM coexistence.workspaces ORDER BY id ASC LIMIT 1`
  );
  if (wsRows.length === 0) {
    // Workspace tables haven't seeded yet (shouldn't happen — this runs
    // after ensureWorkspaceTables in index.js — but never crash boot over it).
    console.warn('[whatsappAccountsSchema] no workspace found to backfill onto yet; will retry next boot');
    return;
  }
  const defaultWorkspaceId = wsRows[0].id;

  const { rowCount } = await pool.query(
    `UPDATE coexistence.whatsapp_accounts
        SET workspace_id = $1
      WHERE workspace_id IS NULL`,
    [defaultWorkspaceId]
  );
  if (rowCount > 0) {
    console.log(`[whatsappAccountsSchema] backfilled workspace_id for ${rowCount} existing WhatsApp account(s) -> workspace ${defaultWorkspaceId}`);
  }
}

module.exports = { ensureWhatsappAccountsSaasColumns };
