// Phase 3C — additive SaaS columns on the pre-existing retarget_* tables
// (owned/created by retargetSchema.js).
//
// Mirrors db/whatsappAccountsSchema.js exactly: this file does NOT create
// any table (retargetSchema.js already owns retarget_customers,
// retarget_sheet_settings, and retarget_sync_log) — it only ALTERs the
// existing tables, additively:
//   1. ADD COLUMN IF NOT EXISTS workspace_id.
//   2. Backfill workspace_id on any existing row that doesn't have one,
//      into the same default workspace Phase 1 resolved
//      (coexistence.workspaces, oldest row first — same convention as
//      workspaceSchema.js / whatsappAccountsSchema.js).
//
// Phase 3C-4: retarget_sheet_settings and retarget_sync_log now ALSO get an
// additive workspace_id column (ensureRetargetSheetWorkspaceColumns below),
// so the "one active sheet connection" model becomes "one active sheet
// connection per workspace" and sync history is scoped per workspace —
// closing the gap this file's original comment (above) called out as
// deliberately left untouched. retarget_customers' own column/backfill
// (ensureRetargetWorkspaceColumns) is unchanged from the prior phase.
//
// Must run after ensureRetargetTables() (so the tables exist) and after
// ensureWorkspaceTables() (so the default workspace exists to backfill
// onto). See index.js boot order.

const pool = require('../db');

async function ensureRetargetWorkspaceColumns() {
  await pool.query(`
    ALTER TABLE coexistence.retarget_customers
      ADD COLUMN IF NOT EXISTS workspace_id BIGINT
        REFERENCES coexistence.workspaces(id) ON DELETE CASCADE
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_retarget_customers_workspace_id
      ON coexistence.retarget_customers (workspace_id)
  `);

  await backfillWorkspaceId();
}

async function backfillWorkspaceId() {
  const { rows: needsBackfill } = await pool.query(
    `SELECT id FROM coexistence.retarget_customers WHERE workspace_id IS NULL`
  );
  if (needsBackfill.length === 0) return;

  const { rows: wsRows } = await pool.query(
    `SELECT id FROM coexistence.workspaces ORDER BY id ASC LIMIT 1`
  );
  if (wsRows.length === 0) {
    // Workspace tables haven't seeded yet (shouldn't happen — this runs
    // after ensureWorkspaceTables in index.js — but never crash boot over it).
    console.warn('[retargetWorkspaceSchema] no workspace found to backfill onto yet; will retry next boot');
    return;
  }
  const defaultWorkspaceId = wsRows[0].id;

  const { rowCount } = await pool.query(
    `UPDATE coexistence.retarget_customers
        SET workspace_id = $1
      WHERE workspace_id IS NULL`,
    [defaultWorkspaceId]
  );
  if (rowCount > 0) {
    console.log(`[retargetWorkspaceSchema] backfilled workspace_id for ${rowCount} existing retarget customer(s) -> workspace ${defaultWorkspaceId}`);
  }
}

// ── Phase 3C-4: retarget_sheet_settings + retarget_sync_log ─────────────
// Same additive pattern as above, applied to the two sync-bookkeeping
// tables. A UNIQUE index on retarget_sheet_settings.workspace_id enforces
// "one active sheet connection per workspace" (was "one active connection,
// period" pre-3C) — the same invariant the old single-row-global model
// enforced, just scoped per workspace instead of system-wide.
async function ensureRetargetSheetWorkspaceColumns() {
  await pool.query(`
    ALTER TABLE coexistence.retarget_sheet_settings
      ADD COLUMN IF NOT EXISTS workspace_id BIGINT
        REFERENCES coexistence.workspaces(id) ON DELETE CASCADE
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_retarget_sheet_settings_workspace_id
      ON coexistence.retarget_sheet_settings (workspace_id)
      WHERE workspace_id IS NOT NULL
  `);

  await pool.query(`
    ALTER TABLE coexistence.retarget_sync_log
      ADD COLUMN IF NOT EXISTS workspace_id BIGINT
        REFERENCES coexistence.workspaces(id) ON DELETE CASCADE
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_retarget_sync_log_workspace_id
      ON coexistence.retarget_sync_log (workspace_id)
  `);

  await backfillSheetAndLogWorkspaceId();
}

async function backfillSheetAndLogWorkspaceId() {
  const { rows: wsRows } = await pool.query(
    `SELECT id FROM coexistence.workspaces ORDER BY id ASC LIMIT 1`
  );
  if (wsRows.length === 0) {
    // Same "never crash boot over it, retry next boot" rule as
    // backfillWorkspaceId above.
    const { rows: needsAny } = await pool.query(
      `SELECT 1 FROM coexistence.retarget_sheet_settings WHERE workspace_id IS NULL
       UNION ALL
       SELECT 1 FROM coexistence.retarget_sync_log WHERE workspace_id IS NULL
       LIMIT 1`
    );
    if (needsAny.length > 0) {
      console.warn('[retargetWorkspaceSchema] no workspace found to backfill sheet/log onto yet; will retry next boot');
    }
    return;
  }
  const defaultWorkspaceId = wsRows[0].id;

  // Pre-3C, retarget_sheet_settings only ever had a single active row
  // (getSettings() always did ORDER BY id DESC LIMIT 1 with no workspace
  // concept), so there is at most one legacy row to backfill — it can
  // never collide with the new UNIQUE(workspace_id) index.
  const { rowCount: settingsCount } = await pool.query(
    `UPDATE coexistence.retarget_sheet_settings
        SET workspace_id = $1
      WHERE workspace_id IS NULL`,
    [defaultWorkspaceId]
  );
  if (settingsCount > 0) {
    console.log(`[retargetWorkspaceSchema] backfilled workspace_id for ${settingsCount} existing retarget sheet setting(s) -> workspace ${defaultWorkspaceId}`);
  }

  // Legacy sync_log rows (CSV/Excel imports + sheet syncs that ran before
  // this phase) predate any workspace attribution — attributed to the same
  // default workspace as retarget_customers/retarget_sheet_settings, purely
  // so existing history remains visible somewhere rather than vanishing.
  const { rowCount: logCount } = await pool.query(
    `UPDATE coexistence.retarget_sync_log
        SET workspace_id = $1
      WHERE workspace_id IS NULL`,
    [defaultWorkspaceId]
  );
  if (logCount > 0) {
    console.log(`[retargetWorkspaceSchema] backfilled workspace_id for ${logCount} existing retarget sync log row(s) -> workspace ${defaultWorkspaceId}`);
  }
}

module.exports = { ensureRetargetWorkspaceColumns, ensureRetargetSheetWorkspaceColumns };