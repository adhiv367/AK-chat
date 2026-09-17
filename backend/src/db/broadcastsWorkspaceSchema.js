// Phase 3F-1B — additive SaaS column on the pre-existing coexistence.broadcasts
// table (not created anywhere in this codebase's db/ folder — same situation
// as whatsapp_accounts/retarget_customers before their own workspace columns
// were added; see db/whatsappAccountsSchema.js and db/retargetWorkspaceSchema.js
// for the identical pattern this file mirrors).
//
// coexistence.broadcast_logs is NOT given its own workspace_id column —
// every broadcast_logs row is owned by exactly one broadcasts row via
// broadcast_id, so ownership is derived by joining to broadcasts.workspace_id
// wherever logs are read (routes/broadcasts.js#getBroadcastWithLogs). This
// avoids a second backfill and a second column to keep in sync.
//
// This file only ALTERs coexistence.broadcasts, additively, the same
// idempotent way every other Phase 3 workspace-column migration does:
//   1. ADD COLUMN IF NOT EXISTS workspace_id.
//   2. Backfill workspace_id on any existing row that doesn't have one,
//      into the same default workspace every other Phase 3 backfill uses
//      (coexistence.workspaces, oldest row first).
//   3. Index it.
//
// Never deletes, duplicates, or overwrites any existing broadcast data —
// purely additive tagging, exactly like the sibling migrations.
//
// Must run after ensureWorkspaceTables() (the default workspace must exist
// to backfill onto). See index.js boot order.

const pool = require('../db');

async function ensureBroadcastsWorkspaceColumns() {
  await pool.query(`
    ALTER TABLE coexistence.broadcasts
      ADD COLUMN IF NOT EXISTS workspace_id BIGINT
        REFERENCES coexistence.workspaces(id) ON DELETE CASCADE
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_broadcasts_workspace_id
      ON coexistence.broadcasts (workspace_id)
  `);

  await backfillWorkspaceId();
}

async function backfillWorkspaceId() {
  const { rows: needsBackfill } = await pool.query(
    `SELECT id FROM coexistence.broadcasts WHERE workspace_id IS NULL`
  );
  if (needsBackfill.length === 0) return;

  const { rows: wsRows } = await pool.query(
    `SELECT id FROM coexistence.workspaces ORDER BY id ASC LIMIT 1`
  );
  if (wsRows.length === 0) {
    // Workspace tables haven't seeded yet (shouldn't happen — this runs
    // after ensureWorkspaceTables in index.js — but never crash boot over it).
    console.warn('[broadcastsWorkspaceSchema] no workspace found to backfill onto yet; will retry next boot');
    return;
  }
  const defaultWorkspaceId = wsRows[0].id;

  const { rowCount } = await pool.query(
    `UPDATE coexistence.broadcasts
        SET workspace_id = $1
      WHERE workspace_id IS NULL`,
    [defaultWorkspaceId]
  );
  if (rowCount > 0) {
    console.log(`[broadcastsWorkspaceSchema] backfilled workspace_id for ${rowCount} existing broadcast(s) -> workspace ${defaultWorkspaceId}`);
  }
}

// Phase 6 Part 3A — additive `source` column on coexistence.broadcasts,
// distinguishing broadcasts created directly in Broadcast Studio from ones
// created by Campaign Studio's Send Now (routes/campaigns.js's
// POST /campaigns/:id/send inserts 'campaign' into this column). Same
// idempotent ADD COLUMN IF NOT EXISTS pattern as ensureBroadcastsWorkspaceColumns
// above — this was the actual root cause of live Send Now failures: that
// INSERT referenced a `source` column no migration had ever created, so
// Postgres rejected the insert ("column \"source\" of relation \"broadcasts\"
// does not exist"), the exception propagated up through campaigns.js's
// execErr catch, and the campaign was marked 'failed'.
async function ensureBroadcastsSourceColumn() {
  await pool.query(`
    ALTER TABLE coexistence.broadcasts
      ADD COLUMN IF NOT EXISTS source TEXT
  `);
  await ensureBroadcastsSourceCheckAllowsCampaign();
}

// Phase 6 Part 3A follow-up — the ADD COLUMN above never defined a CHECK
// constraint. Live evidence (docker exec akchat-db psql ... pg_get_constraintdef)
// showed the running database nonetheless already carries:
//   broadcasts_source_check CHECK ((source = ANY (ARRAY['manual','target'])))
// This constraint is NOT created anywhere in this codebase (grepped —
// no `broadcasts_source_check` and no CHECK on broadcasts.source exists in
// src/db/*.js), so it predates/is external to this migration file — likely
// carried over from an earlier deployment of this table. Whatever its
// origin, it is real on the live volume and rejects Campaign Studio's
// 'campaign' value, which is what routes/campaigns.js's POST
// /campaigns/:id/send has always written (see the doc comment above
// ensureBroadcastsSourceColumn). 'manual' and 'target' must be preserved
// exactly as-is: routes/targetMessage.js's POST /target/campaign writes
// 'target', and routes/broadcasts.js's POST /broadcasts writes no source at
// all (NULL, which any CHECK constraint permits regardless of its allowed
// list) — so 'manual' is not written by any code path in this repo today,
// but is kept because it may already label existing live rows and dropping
// it would be a semantic change to data this migration must not make.
//
// Idempotent by construction: DROP CONSTRAINT IF EXISTS then re-ADD with the
// widened list, every boot. Never drops the constraint permanently (it is
// always re-added in the same statement), never touches existing row data,
// never widens beyond the three known values.
async function ensureBroadcastsSourceCheckAllowsCampaign() {
  await pool.query(`
    ALTER TABLE coexistence.broadcasts
      DROP CONSTRAINT IF EXISTS broadcasts_source_check
  `);
  await pool.query(`
    ALTER TABLE coexistence.broadcasts
      ADD CONSTRAINT broadcasts_source_check
      CHECK (source IS NULL OR source = ANY (ARRAY['manual'::text, 'target'::text, 'campaign'::text]))
  `);
}

module.exports = {
  ensureBroadcastsWorkspaceColumns,
  ensureBroadcastsSourceColumn,
  ensureBroadcastsSourceCheckAllowsCampaign,
};




