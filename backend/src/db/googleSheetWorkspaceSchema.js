// Phase 3E — additive SaaS column on the pre-existing Google Sheet /
// Shopify-order sync tables (coexistence.google_sheet_settings,
// coexistence.contact_sync_log). These tables predate the workspace model
// and were never migrated when Retarget's equivalent tables were
// (db/retargetWorkspaceSchema.js#ensureRetargetSheetWorkspaceColumns) —
// this file closes that gap using the exact same additive pattern:
//   1. ADD COLUMN IF NOT EXISTS workspace_id.
//   2. UNIQUE(workspace_id) on google_sheet_settings — "one active sheet
//      connection, period" becomes "one active sheet connection per
//      workspace", same invariant the old single-row-global model enforced.
//   3. Backfill any existing (legacy, pre-3E) row onto the same default
//      workspace convention used everywhere else (coexistence.workspaces,
//      oldest row first).
//
// This file does NOT create either table — it only ALTERs them. Must run
// after ensureWorkspaceTables() (so the default workspace exists to
// backfill onto). See index.js boot order.

const pool = require('../db');

async function ensureGoogleSheetWorkspaceColumns() {
  await pool.query(`
    ALTER TABLE coexistence.google_sheet_settings
      ADD COLUMN IF NOT EXISTS workspace_id BIGINT
        REFERENCES coexistence.workspaces(id) ON DELETE CASCADE
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_google_sheet_settings_workspace_id
      ON coexistence.google_sheet_settings (workspace_id)
      WHERE workspace_id IS NOT NULL
  `);

  await pool.query(`
    ALTER TABLE coexistence.contact_sync_log
      ADD COLUMN IF NOT EXISTS workspace_id BIGINT
        REFERENCES coexistence.workspaces(id) ON DELETE CASCADE
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_contact_sync_log_workspace_id
      ON coexistence.contact_sync_log (workspace_id)
  `);

  await backfillWorkspaceId();
}

async function backfillWorkspaceId() {
  const { rows: wsRows } = await pool.query(
    `SELECT id FROM coexistence.workspaces ORDER BY id ASC LIMIT 1`
  );
  if (wsRows.length === 0) {
    // Never crash boot over it — same "retry next boot" rule as
    // retargetWorkspaceSchema.js.
    const { rows: needsAny } = await pool.query(
      `SELECT 1 FROM coexistence.google_sheet_settings WHERE workspace_id IS NULL
       UNION ALL
       SELECT 1 FROM coexistence.contact_sync_log WHERE workspace_id IS NULL
       LIMIT 1`
    );
    if (needsAny.length > 0) {
      console.warn('[googleSheetWorkspaceSchema] no workspace found to backfill onto yet; will retry next boot');
    }
    return;
  }
  const defaultWorkspaceId = wsRows[0].id;

  // Pre-3E, google_sheet_settings only ever had a single active row
  // (the old ORDER BY id DESC LIMIT 1, no-workspace-concept query), so
  // there is at most one legacy row to backfill — it can never collide
  // with the new UNIQUE(workspace_id) index.
  const { rowCount: settingsCount } = await pool.query(
    `UPDATE coexistence.google_sheet_settings
        SET workspace_id = $1
      WHERE workspace_id IS NULL`,
    [defaultWorkspaceId]
  );
  if (settingsCount > 0) {
    console.log(`[googleSheetWorkspaceSchema] backfilled workspace_id for ${settingsCount} existing google sheet setting(s) -> workspace ${defaultWorkspaceId}`);
  }

  const { rowCount: logCount } = await pool.query(
    `UPDATE coexistence.contact_sync_log
        SET workspace_id = $1
      WHERE workspace_id IS NULL`,
    [defaultWorkspaceId]
  );
  if (logCount > 0) {
    console.log(`[googleSheetWorkspaceSchema] backfilled workspace_id for ${logCount} existing contact sync log row(s) -> workspace ${defaultWorkspaceId}`);
  }
}

module.exports = { ensureGoogleSheetWorkspaceColumns };
