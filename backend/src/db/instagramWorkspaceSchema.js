// Phase 3C — workspace isolation for the Instagram module.
//
// Mirrors db/whatsappAccountsSchema.js / db/retargetWorkspaceSchema.js: this
// file does NOT create any table (instagramSchema.js already owns every
// instagram_* table) — it only ALTERs existing tables, additively:
//   1. ADD COLUMN IF NOT EXISTS workspace_id.
//   2. Backfill workspace_id on any existing row that doesn't have one.
//
// Column placement — why more than just instagram_accounts:
//   instagram_accounts is the natural owner of workspace scoping (every
//   account is connected by one workspace via OAuth), and every child table
//   (contacts, conversations, campaigns, templates, workflows) carries an
//   instagram_account_id FK that *should* resolve workspace ownership
//   transitively.
//
//   In practice instagram_account_id on those child tables is NULLABLE —
//   it was bolted on later (see instagramSchema.js) for multi-account
//   support, and real pre-existing "Invi Creation" data (the single default
//   tenant, see workspaceSchema.js#resolveDefaultWorkspaceName) predates
//   that column and has instagram_account_id = NULL. A pure account-id join
//   would silently make that legacy data invisible to every workspace once
//   routes start filtering by workspace. So contacts/conversations/
//   campaigns/templates/workflows also get their own workspace_id column,
//   backfilled first from their linked account's workspace (when linked),
//   then falling back to the default workspace (when not linked — the
//   legacy/orphaned case) — same convention as every other *WorkspaceSchema
//   backfill in this codebase.
//
//   instagram_messages/instagram_notes/instagram_tags/instagram_ai_logs and
//   instagram_workflow_executions/instagram_workflow_execution_steps are
//   deliberately left untouched: they key off conversation_id/contact_id/
//   workflow_id, all of which now carry workspace_id directly, so route-level
//   ownership checks can join up one level instead of duplicating the column
//   everywhere ("add workspace_id only where genuinely required").
//
//   instagram_settings is a legacy global-singleton table (superseded by the
//   per-account OAuth flow, but still a live, reachable route) — it also
//   gets its own workspace_id so each workspace gets its own settings row
//   instead of sharing one global row.
//
//   instagram_analytics is unused by any route that reads/writes per-row
//   data tied to a tenant (it's never queried anywhere; instagramAnalytics.js
//   computes counts live from messages/conversations) — left untouched.
//
// Must run after ensureInstagramTables() (so these tables exist) and after
// ensureWorkspaceTables() (so the default workspace exists to backfill
// onto). See index.js boot order.

const pool = require('../db');

async function ensureInstagramWorkspaceColumns() {
  // 1) Top-level accounts table.
  await pool.query(`
    ALTER TABLE coexistence.instagram_accounts
      ADD COLUMN IF NOT EXISTS workspace_id BIGINT
        REFERENCES coexistence.workspaces(id) ON DELETE CASCADE
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_instagram_accounts_workspace_id
      ON coexistence.instagram_accounts (workspace_id)
  `);

  // 2) Child tables that carry (nullable) instagram_account_id.
  const childTables = [
    'instagram_contacts', 'instagram_conversations', 'instagram_campaigns',
    'instagram_templates', 'instagram_workflows',
  ];
  for (const t of childTables) {
    await pool.query(`
      ALTER TABLE coexistence.${t}
        ADD COLUMN IF NOT EXISTS workspace_id BIGINT
          REFERENCES coexistence.workspaces(id) ON DELETE CASCADE
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_${t}_workspace_id
        ON coexistence.${t} (workspace_id)
    `);
  }

  // 3) Legacy global-singleton settings table.
  await pool.query(`
    ALTER TABLE coexistence.instagram_settings
      ADD COLUMN IF NOT EXISTS workspace_id BIGINT
        REFERENCES coexistence.workspaces(id) ON DELETE CASCADE
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_instagram_settings_workspace_id
      ON coexistence.instagram_settings (workspace_id)
  `);
  // One settings row per workspace going forward.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_instagram_settings_workspace_id
      ON coexistence.instagram_settings (workspace_id)
      WHERE workspace_id IS NOT NULL
  `);

  await backfillWorkspaceId();
}

async function getDefaultWorkspaceId() {
  const { rows } = await pool.query(
    `SELECT id FROM coexistence.workspaces ORDER BY id ASC LIMIT 1`
  );
  return rows[0]?.id || null;
}

async function backfillWorkspaceId() {
  const defaultWorkspaceId = await getDefaultWorkspaceId();
  if (!defaultWorkspaceId) {
    // Workspace tables haven't seeded yet (shouldn't happen — this runs
    // after ensureWorkspaceTables in index.js — but never crash boot over it).
    console.warn('[instagramWorkspaceSchema] no workspace found to backfill onto yet; will retry next boot');
    return;
  }

  // 1) instagram_accounts — every existing account is legacy/pre-SaaS, so it
  // belongs to the single default ("Invi Creation") workspace.
  const { rowCount: accountsBackfilled } = await pool.query(
    `UPDATE coexistence.instagram_accounts
        SET workspace_id = $1
      WHERE workspace_id IS NULL`,
    [defaultWorkspaceId]
  );
  if (accountsBackfilled > 0) {
    console.log(`[instagramWorkspaceSchema] backfilled workspace_id for ${accountsBackfilled} existing Instagram account(s) -> workspace ${defaultWorkspaceId}`);
  }

  // 2) Child tables: first resolve via their linked account (transitively
  // correct), then fall back to the default workspace for genuinely
  // orphaned/legacy rows with no account link.
  const childTables = [
    'instagram_contacts', 'instagram_conversations', 'instagram_campaigns',
    'instagram_templates', 'instagram_workflows',
  ];
  for (const t of childTables) {
    const { rowCount: viaAccount } = await pool.query(
      `UPDATE coexistence.${t} c
          SET workspace_id = a.workspace_id
         FROM coexistence.instagram_accounts a
        WHERE c.instagram_account_id = a.id
          AND c.workspace_id IS NULL
          AND a.workspace_id IS NOT NULL`
    );
    const { rowCount: orphans } = await pool.query(
      `UPDATE coexistence.${t}
          SET workspace_id = $1
        WHERE workspace_id IS NULL`,
      [defaultWorkspaceId]
    );
    if (viaAccount > 0 || orphans > 0) {
      console.log(`[instagramWorkspaceSchema] backfilled workspace_id on ${t}: ${viaAccount} via linked account, ${orphans} orphaned -> default workspace ${defaultWorkspaceId}`);
    }
  }

  // 3) instagram_settings — a partial UNIQUE index on workspace_id means at
  // most one row per workspace. The route only ever kept the most recent
  // row anyway (ORDER BY id DESC LIMIT 1), so only the newest NULL row
  // becomes the default workspace's settings row; any older orphaned rows
  // are left workspace_id = NULL (unreachable by any workspace-scoped
  // query from here on, but not destroyed).
  const { rowCount: settingsBackfilled } = await pool.query(
    `UPDATE coexistence.instagram_settings
        SET workspace_id = $1
      WHERE id = (
        SELECT id FROM coexistence.instagram_settings
         WHERE workspace_id IS NULL
         ORDER BY id DESC LIMIT 1
      )`,
    [defaultWorkspaceId]
  );
  if (settingsBackfilled > 0) {
    console.log(`[instagramWorkspaceSchema] backfilled workspace_id for ${settingsBackfilled} instagram_settings row -> workspace ${defaultWorkspaceId}`);
  }
}

module.exports = { ensureInstagramWorkspaceColumns };
