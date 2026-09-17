// Phase 3F-1C — additive SaaS column on the pre-existing
// coexistence.message_templates table, same idempotent convention as every
// other Phase 3 workspace-column migration (see db/broadcastsWorkspaceSchema.js,
// db/whatsappAccountsSchema.js, db/retargetWorkspaceSchema.js, etc).
//
// Why message_templates needs its own workspace_id rather than being derived
// solely through whatsapp_account_id:
//   - Templates CAN exist with whatsapp_account_id = NULL (drafted before an
//     account is picked, or an account later unlinked/deleted). Treating
//     NULL as "visible to every workspace" — the previous behavior — means
//     any workspace could read/edit/delete another workspace's unlinked
//     draft templates. That is the exact bug this migration closes.
//   - A template's own workspace_id is set at creation time and does not
//     change if the linked WhatsApp account is later swapped or removed, so
//     ownership stays stable and explicit instead of riding on a nullable FK.
//
// This file only ALTERs coexistence.message_templates, additively:
//   1. ADD COLUMN IF NOT EXISTS workspace_id.
//   2. Backfill workspace_id on any existing row that doesn't have one:
//      - if the template is linked to a whatsapp_account, inherit that
//        account's workspace_id (preserves correct ownership for every
//        existing linked template, including current Invi Creation data).
//      - anything still NULL after that (unlinked legacy templates) falls
//        back to the same default workspace every other Phase 3 backfill
//        uses (coexistence.workspaces, oldest row first).
//   3. Index it.
//
// Never deletes, duplicates, or overwrites any existing template data —
// purely additive tagging, exactly like the sibling migrations.
//
// Must run after ensureWorkspaceTables() (default workspace must exist to
// backfill onto) and after ensureWhatsappAccountsSaasColumns() (the
// inherit-from-linked-account backfill step joins on
// whatsapp_accounts.workspace_id). See index.js boot order.

const pool = require('../db');

async function ensureTemplatesWorkspaceColumns() {
  await pool.query(`
    ALTER TABLE coexistence.message_templates
      ADD COLUMN IF NOT EXISTS workspace_id BIGINT
        REFERENCES coexistence.workspaces(id) ON DELETE CASCADE
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_message_templates_workspace_id
      ON coexistence.message_templates (workspace_id)
  `);

  await backfillWorkspaceId();
}

async function backfillWorkspaceId() {
  const { rows: needsBackfill } = await pool.query(
    `SELECT id FROM coexistence.message_templates WHERE workspace_id IS NULL`
  );
  if (needsBackfill.length === 0) return;

  // Step 1: inherit workspace_id from the linked WhatsApp account, wherever
  // one exists — this covers the vast majority of real (Invi Creation)
  // templates and preserves their true ownership exactly.
  const { rowCount: inherited } = await pool.query(
    `UPDATE coexistence.message_templates t
        SET workspace_id = wa.workspace_id
       FROM coexistence.whatsapp_accounts wa
      WHERE t.whatsapp_account_id = wa.id
        AND t.workspace_id IS NULL
        AND wa.workspace_id IS NOT NULL`
  );
  if (inherited > 0) {
    console.log(`[templatesWorkspaceSchema] backfilled workspace_id for ${inherited} template(s) from linked WhatsApp account`);
  }

  // Step 2: anything still unresolved (no linked account, or linked account
  // itself has no workspace_id) falls back to the default workspace, same
  // as every other Phase 3 backfill.
  const { rows: stillNull } = await pool.query(
    `SELECT id FROM coexistence.message_templates WHERE workspace_id IS NULL`
  );
  if (stillNull.length === 0) return;

  const { rows: wsRows } = await pool.query(
    `SELECT id FROM coexistence.workspaces ORDER BY id ASC LIMIT 1`
  );
  if (wsRows.length === 0) {
    // Workspace tables haven't seeded yet (shouldn't happen — this runs
    // after ensureWorkspaceTables in index.js — but never crash boot over it).
    console.warn('[templatesWorkspaceSchema] no workspace found to backfill onto yet; will retry next boot');
    return;
  }
  const defaultWorkspaceId = wsRows[0].id;

  const { rowCount } = await pool.query(
    `UPDATE coexistence.message_templates
        SET workspace_id = $1
      WHERE workspace_id IS NULL`,
    [defaultWorkspaceId]
  );
  if (rowCount > 0) {
    console.log(`[templatesWorkspaceSchema] backfilled workspace_id for ${rowCount} remaining (unlinked) template(s) -> default workspace ${defaultWorkspaceId}`);
  }
}

module.exports = { ensureTemplatesWorkspaceColumns };
