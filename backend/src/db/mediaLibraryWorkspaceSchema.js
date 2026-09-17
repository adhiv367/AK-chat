// Phase 3F-1 — additive SaaS column on the pre-existing
// coexistence.media_library table (not created anywhere in this codebase's
// db/ folder — same situation as whatsapp_accounts/broadcasts before their
// own workspace columns were added; see db/whatsappAccountsSchema.js and
// db/broadcastsWorkspaceSchema.js for the identical pattern this file
// mirrors).
//
// coexistence.media_meta_sync is NOT given its own workspace_id column —
// every media_meta_sync row is owned by exactly one media_library row via
// media_id, so ownership is derived by joining to media_library.workspace_id
// wherever sync rows are read/written (routes/mediaLibrary.js). This avoids
// a second backfill and a second column to keep in sync.
//
// This file only ALTERs coexistence.media_library, additively, the same
// idempotent way every other Phase 3 workspace-column migration does:
//   1. ADD COLUMN IF NOT EXISTS workspace_id.
//   2. Backfill workspace_id on any existing row that doesn't have one:
//      - if whatsapp_account_id links to a whatsapp_accounts row, inherit
//        that account's workspace_id (precise pass).
//      - otherwise (whatsapp_account_id is NULL, or points at an account
//        that itself has no workspace_id yet) -> fall back to the default
//        workspace, same "first workspace" convention as every other
//        Phase 3 backfill (coexistence.workspaces, oldest row first).
//   3. Index it.
//
// Never deletes, duplicates, or overwrites any existing media_library row —
// purely additive tagging, exactly like the sibling migrations.
//
// Must run after ensureWorkspaceTables() (default workspace must exist) AND
// after ensureWhatsappAccountsSaasColumns() (whatsapp_accounts.workspace_id
// must already be backfilled — media is backfilled BY JOINING to it, same
// as contactsWorkspaceSchema.js's contacts backfill). See index.js boot
// order.

const pool = require('../db');

async function getDefaultWorkspaceId() {
  const { rows } = await pool.query(
    `SELECT id FROM coexistence.workspaces ORDER BY id ASC LIMIT 1`
  );
  return rows[0]?.id ?? null;
}

async function ensureMediaLibraryWorkspaceColumns() {
  await pool.query(`
    ALTER TABLE coexistence.media_library
      ADD COLUMN IF NOT EXISTS workspace_id BIGINT
        REFERENCES coexistence.workspaces(id) ON DELETE CASCADE
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_media_library_workspace_id
      ON coexistence.media_library (workspace_id)
  `);

  await backfillWorkspaceId();
}

async function backfillWorkspaceId() {
  const { rows: needsBackfill } = await pool.query(
    `SELECT id FROM coexistence.media_library WHERE workspace_id IS NULL LIMIT 1`
  );
  if (needsBackfill.length === 0) return;

  // 1) Precise pass: media whose whatsapp_account_id matches a connected
  //    WhatsApp account inherits THAT account's workspace.
  const { rowCount: viaAccount } = await pool.query(`
    UPDATE coexistence.media_library m
       SET workspace_id = wa.workspace_id
      FROM coexistence.whatsapp_accounts wa
     WHERE m.workspace_id IS NULL
       AND m.whatsapp_account_id = wa.id
       AND wa.workspace_id IS NOT NULL
  `);

  // 2) Fallback: anything still unmatched (no owning account, or an
  //    account that itself has no workspace_id yet) goes to the default
  //    workspace — same convention used by every other Phase 3 backfill.
  const defaultWorkspaceId = await getDefaultWorkspaceId();
  let orphans = 0;
  if (defaultWorkspaceId) {
    const { rowCount } = await pool.query(
      `UPDATE coexistence.media_library
          SET workspace_id = $1
        WHERE workspace_id IS NULL`,
      [defaultWorkspaceId]
    );
    orphans = rowCount;
  } else {
    console.warn('[mediaLibraryWorkspaceSchema] no workspace found to backfill orphaned media onto yet; will retry next boot');
  }

  if (viaAccount > 0 || orphans > 0) {
    console.log(`[mediaLibraryWorkspaceSchema] backfilled workspace_id on media_library: ${viaAccount} via matching WhatsApp account, ${orphans} orphaned -> default workspace ${defaultWorkspaceId}`);
  }
}

module.exports = { ensureMediaLibraryWorkspaceColumns };