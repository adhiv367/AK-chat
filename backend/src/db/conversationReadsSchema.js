// conversation_reads — per-(workspace_id, wa_number, contact_number) "last
// read" stamp, used by POST /messages/mark-read (routes/messages.js,
// routes/pipelines.js) to clear a conversation's unread badge, and read
// back by dashboard.js.
//
// CORRECTED: the live table already has a workspace_id column and a
// composite PRIMARY KEY (workspace_id, wa_number, contact_number) — it is
// already workspace-scoped and that primary key already guarantees
// uniqueness for the ON CONFLICT target the app relies on. There is no
// `id` column on this table, so no id-based dedup logic is valid here.
// This ensure-step is now just an idempotent existence check: create the
// table (matching the live shape exactly) only if it's genuinely absent —
// a no-op against the current, already-correct database. No index/dedupe
// work is needed or performed, since the existing primary key already
// provides the required uniqueness guarantee.

const pool = require('../db');

async function ensureConversationReadsTable() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS coexistence.conversation_reads (
        workspace_id   BIGINT NOT NULL,
        wa_number      TEXT NOT NULL,
        contact_number TEXT NOT NULL,
        last_read_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, wa_number, contact_number)
      )
    `);
  } finally {
    client.release();
  }
}

module.exports = { ensureConversationReadsTable };