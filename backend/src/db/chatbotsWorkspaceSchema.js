// Phase 3C — additive SaaS column on the pre-existing coexistence.chatbots
// table.
//
// IMPORTANT: chatbots is NOT created anywhere in this codebase's db/
// folder (same situation as whatsapp_accounts — see whatsappAccountsSchema.js
// header comment). It's a pre-existing table from an earlier phase not
// represented here. This file therefore does NOT create the table — it
// only ALTERs it, additively, the same idempotent way the rest of the
// schema files do:
//   1. ADD COLUMN IF NOT EXISTS workspace_id.
//   2. Backfill workspace_id on any existing row that doesn't have one,
//      into the same default workspace Phase 1 resolved
//      (coexistence.workspaces, oldest row first — same convention as
//      workspaceSchema.js / whatsappAccountsSchema.js).
//
// Nothing here touches name, description, status, trigger_type, or config
// on any existing chatbot row — this is purely additive.
//
// Must run after ensureWorkspaceTables() (so the default workspace exists
// to backfill onto). See index.js boot order.

const pool = require('../db');

async function ensureChatbotsWorkspaceColumns() {
  await pool.query(`
    ALTER TABLE coexistence.chatbots
      ADD COLUMN IF NOT EXISTS workspace_id BIGINT
        REFERENCES coexistence.workspaces(id) ON DELETE CASCADE
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_chatbots_workspace_id
      ON coexistence.chatbots (workspace_id)
  `);

  await backfillWorkspaceId();
}

async function backfillWorkspaceId() {
  const { rows: needsBackfill } = await pool.query(
    `SELECT id FROM coexistence.chatbots WHERE workspace_id IS NULL`
  );
  if (needsBackfill.length === 0) return;

  const { rows: wsRows } = await pool.query(
    `SELECT id FROM coexistence.workspaces ORDER BY id ASC LIMIT 1`
  );
  if (wsRows.length === 0) {
    // Workspace tables haven't seeded yet (shouldn't happen — this runs
    // after ensureWorkspaceTables in index.js — but never crash boot over it).
    console.warn('[chatbotsWorkspaceSchema] no workspace found to backfill onto yet; will retry next boot');
    return;
  }
  const defaultWorkspaceId = wsRows[0].id;

  const { rowCount } = await pool.query(
    `UPDATE coexistence.chatbots
        SET workspace_id = $1
      WHERE workspace_id IS NULL`,
    [defaultWorkspaceId]
  );
  if (rowCount > 0) {
    console.log(`[chatbotsWorkspaceSchema] backfilled workspace_id for ${rowCount} existing chatbot(s) -> workspace ${defaultWorkspaceId}`);
  }
}

module.exports = { ensureChatbotsWorkspaceColumns };