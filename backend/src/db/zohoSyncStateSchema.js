// Phase 8H Part 1 — Zoho CRM RECONCILIATION FOUNDATION: persistent sync
// state + bounded retry bookkeeping.
//
// ── Why a new table instead of reusing zoho_lead_links/zoho_lead_notes ──
// zoho_lead_links (8A/8C) and zoho_lead_notes (8C Part 2) are each scoped
// to ONE Zoho sub-resource (a Lead, a Note) and already carry their own
// idempotency identity. Neither one, on its own, can express "this
// conversation's sync attempt got the Lead synced but the Note is still
// pending" as a single claimable unit of work — that partial-success shape
// is exactly what zohoSyncService.syncConversationToZoho already returns
// (`{ synced: true, partial: true, note: null, noteError }`, see that
// file's header) but nothing durable tracks it for a later retry to pick
// up. coexistence.zoho_sync_state is that missing durable unit: ONE row
// per (workspace, whatsapp_account, contact_number) — the same identity
// zoho_lead_links already uses — that tracks the sync PIPELINE'S state
// across both the Lead and Note steps, so a reconciliation sweep (8H Part
// 1's zohoReconciliationScheduler.js) can atomically claim exactly the
// conversations that still need work, without re-deriving that from
// zoho_lead_links + zoho_lead_notes join logic scattered across callers.
//
// This table does NOT replace zoho_lead_links/zoho_lead_notes — it sits
// ABOVE them as the retry-queue/orchestration ledger. The Lead/Note rows
// remain the source of truth for "does a Zoho Lead/Note id exist"; this
// table is the source of truth for "does this conversation still need a
// sync attempt, and when/how many times has it been tried".
//
// ── sync_status lifecycle (spec: pending/processing/lead_synced/
//    note_pending/completed) ──────────────────────────────────────────────
//   pending       — queued for a first (or re-)attempt; not yet claimed.
//   processing    — currently claimed by a worker (see lease/claim below).
//   lead_synced   — this attempt's Lead step succeeded but the Note step
//                   has not been attempted/confirmed yet. Distinct from
//                   note_pending: lead_synced means "about to try the
//                   Note in this same attempt"; a row can also land here
//                   directly from a crash (Lead confirmed synced, worker
//                   died before it even started the Note call).
//   note_pending  — Lead is confirmed synced (zoho_lead_id known) AND the
//                   Note attempt is specifically what needs retrying next
//                   (spec "Lead-success/Note-failure recovery — retry Note
//                   without recreating Lead"). Kept distinct from
//                   'pending' so the scheduler never re-attempts Lead
//                   creation for a row that already has a Lead.
//   completed     — Lead synced AND (Note synced OR no Note was needed for
//                   this attempt, e.g. syncConversationToZoho returned
//                   partial=false with note=null). Terminal — the row is
//                   not reclaimed unless something explicitly resets it
//                   back to 'pending' (e.g. a future conversation change).
//
// ── failure_type lifecycle (spec: retryable_failure/permanent_failure/
//    reauth_required) ─────────────────────────────────────────────────────
//   retryable_failure  — transient (network error, 429, 5xx, malformed
//                         response). Eligible for bounded exponential
//                         backoff via zohoRetryClassifier.js.
//   permanent_failure  — Zoho itself rejected the request in a way a retry
//                         cannot fix (e.g. validation failure not
//                         resolved by 8G's field-fallback, a deleted-Lead
//                         404 on update). Excluded from the scheduler's
//                         claim query once max_attempts is reached OR the
//                         classifier marks it non-retryable outright.
//   reauth_required    — the underlying zoho_connections row itself needs
//                         the user to redo OAuth consent (mirrors
//                         zoho_connections.status='reauth_required').
//                         Excluded from automatic retry entirely (retrying
//                         against a connection that needs reauth cannot
//                         succeed) until the connection's status flips back
//                         to 'connected', at which point a future manual/
//                         resync call resets the row to 'pending'.
//   NULL               — no failure recorded (row is pending its first
//                         attempt, or currently 'completed').
//
// ── Bounded retry + exponential backoff (spec) ───────────────────────────
// attempt_count / max_attempts + next_attempt_at implement the backoff:
// zohoRetryClassifier.js computes next_attempt_at = NOW() + backoff(attempt
// _count) on each retryable failure; the scheduler's claim query only
// selects rows where next_attempt_at <= NOW(), so a failing row is never
// hammered — it simply becomes invisible to the claim query until its
// backoff window elapses. attempt_count >= max_attempts flips failure_type
// to 'permanent_failure' (see zohoRetryClassifier.classifyFailure) so the
// row stops being claimed at all, rather than retrying forever.
//
// ── Atomic lease/claim (spec) ────────────────────────────────────────────
// Same pattern as sequenceScheduler.js's claimDueEnrollmentIds: a single
// transaction does `SELECT ... FOR UPDATE SKIP LOCKED` on eligible rows,
// then immediately flips sync_status to 'processing' and pushes
// locked_until forward by a lease window BEFORE committing. Two workers
// (or two ticks of the same worker, in case a tick overruns its interval)
// can never claim the same row — Postgres row locking is the guard, not an
// in-memory flag. locked_until also gives crash recovery for free: if a
// worker dies mid-attempt, the row simply sits in 'processing' until
// locked_until passes, at which point the NEXT tick's claim query
// (WHERE sync_status != 'processing' OR locked_until < NOW()) treats it as
// claimable again — no separate sweep job needed for this table, mirroring
// sequenceScheduler's lease-based crash recovery exactly.
//
// ── Per-workspace + per-WhatsApp-number isolation ────────────────────────
// workspace_id + whatsapp_account_id are both stored directly on every row
// (never derived only via a join), matching the isolation convention
// zohoSchema.js's header already established for zoho_connections/
// zoho_lead_links/zoho_lead_notes — every query in
// zohoReconciliationService.js filters on both explicitly.
//
// ── Duplicate-safe reconciliation ────────────────────────────────────────
// UNIQUE(workspace_id, whatsapp_account_id, contact_number) — the exact
// same identity zoho_lead_links already enforces — guarantees at most one
// sync-state row per conversation. Enqueueing a conversation that already
// has a row is an idempotent UPSERT (see
// zohoReconciliationService.enqueueSync), never a second row.
//
// Must run after ensureZohoTables() (FKs coexistence.zoho_connections /
// zoho_lead_links are informational — see zoho_connection_id/zoho_lead_id
// below — this table also directly FKs coexistence.workspaces /
// coexistence.whatsapp_accounts, same as zoho_connections itself).

const pool = require('../db');

const ZOHO_SYNC_STATUSES = [
  'pending',
  'processing',
  'lead_synced',
  'note_pending',
  'completed',
  // Phase 8H Part 2 — the extraction ran but the customer's conversation
  // does not yet have all standard-required fields (name/place). This is
  // NOT a Zoho API failure (failure_type stays NULL for these rows) and it
  // is deliberately excluded from the claim-query status list below and
  // from idx_zoho_sync_state_claimable — the scheduler must never poll or
  // retry these on its own. Progress instead comes from the next inbound
  // WhatsApp message re-invoking syncConversationToZoho directly (see
  // zohoSyncService.js's recordIncompleteExtraction), which naturally
  // re-attempts extraction and moves the row on to lead_synced/completed
  // once the missing fields show up — never from a background sweep.
  'incomplete',
  // Final Phase 8 migration fix — retryable_failure/permanent_failure/
  // reauth_required are, and remain, the FAILURE_TYPE column's values
  // (see ZOHO_FAILURE_TYPES below and zohoSyncService.recordSyncFailure,
  // which always leaves sync_status='pending' on a failure and records
  // the failure kind in failure_type instead). No code in this app ever
  // writes these three strings into sync_status. They're included here
  // only so the sync_status CHECK constraint itself permanently allows
  // the full status vocabulary end-to-end without a future manual ALTER,
  // per this migration's explicit requirement — this is purely a widening
  // of what the database will accept, not a change to what any service
  // writes or to zohoRetryClassifier/zohoReconciliationService/
  // zohoSyncService's actual read/write behavior.
  'retryable_failure',
  'permanent_failure',
  'reauth_required',
];

const ZOHO_FAILURE_TYPES = [
  'retryable_failure',
  'permanent_failure',
  'reauth_required',
];

// ── Phase 8 final migration fix — self-healing status CHECK constraint ──
// Background: CREATE TABLE IF NOT EXISTS (below) only ever runs its full
// CREATE TABLE body on a database that does NOT already have this table.
// That means ZOHO_SYNC_STATUSES is the source of truth for a *fresh*
// database, but it is a no-op for a database that already has
// coexistence.zoho_sync_state from before 'incomplete' was added to this
// array — CREATE TABLE IF NOT EXISTS silently skips the whole statement,
// constraint included, leaving the OLD (narrower) CHECK constraint in
// place. That gap is exactly what forced the one-off manual
//   ALTER TABLE ... DROP CONSTRAINT zoho_sync_state_status_check;
//   ALTER TABLE ... ADD CONSTRAINT zoho_sync_state_status_check CHECK (...);
// run directly against the local DB (see this table's original PR notes).
//
// ensureZohoSyncStatusCheckConstraint() below makes that ALTER pair a
// permanent, idempotent part of every startup instead of a manual step —
// same pattern already used elsewhere in this codebase for exactly this
// situation (see ensureBroadcastsSourceCheckAllowsCampaign in
// broadcastsWorkspaceSchema.js): unconditionally DROP CONSTRAINT IF EXISTS
// (never errors — a no-op on a fresh DB that never had the old narrower
// constraint, since CREATE TABLE already added the current one), then
// unconditionally re-ADD it built fresh from ZOHO_SYNC_STATUSES. Every run
// ends with exactly one correct constraint in place, regardless of what
// was there before — fresh databases get it from CREATE TABLE and then
// this simply confirms/re-asserts the identical definition; a stale
// database's narrower constraint gets replaced with the current one.
//
// Safety: this only ever WIDENS the allowed set (ZOHO_SYNC_STATUSES has
// never had a status removed, only added), so re-validating existing rows
// against the new constraint can never fail — every row already satisfies
// the old (narrower) constraint, and the new constraint is a superset.
// This never touches row data (no UPDATE/DELETE) and never touches any
// table other than coexistence.zoho_sync_state. Business logic
// (zohoSyncService.js, zohoReconciliationService.js,
// zohoRetryClassifier.js) is untouched — this only changes what the
// database is willing to store, never what the app writes.
async function ensureZohoSyncStatusCheckConstraint() {
  await pool.query(`
    ALTER TABLE coexistence.zoho_sync_state
      DROP CONSTRAINT IF EXISTS zoho_sync_state_status_check
  `);
  await pool.query(`
    ALTER TABLE coexistence.zoho_sync_state
      ADD CONSTRAINT zoho_sync_state_status_check
        CHECK (sync_status IN (${ZOHO_SYNC_STATUSES.map((s) => `'${s}'`).join(', ')}))
  `);
}

async function ensureZohoSyncStateTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.zoho_sync_state (
      id                    BIGSERIAL PRIMARY KEY,
      workspace_id          BIGINT NOT NULL REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,
      whatsapp_account_id   BIGINT NOT NULL REFERENCES coexistence.whatsapp_accounts(id) ON DELETE CASCADE,

      -- Informational linkage only — never trusted as the sole source of
      -- truth for "does a Lead/Note exist" (zoho_lead_links/zoho_lead_notes
      -- remain that source of truth; see file header). Nullable because a
      -- fresh 'pending' row has neither yet.
      zoho_connection_id    BIGINT REFERENCES coexistence.zoho_connections(id) ON DELETE CASCADE,
      zoho_lead_id          TEXT,

      contact_number        TEXT NOT NULL,

      sync_status           TEXT NOT NULL DEFAULT 'pending',
      failure_type          TEXT,
      last_error            TEXT,

      attempt_count         INTEGER NOT NULL DEFAULT 0,
      max_attempts          INTEGER NOT NULL DEFAULT 8,
      next_attempt_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      -- Lease/claim (see file header "Atomic lease/claim"). NULL when not
      -- currently claimed by any worker.
      locked_until          TIMESTAMPTZ,
      locked_by             TEXT,

      -- Sync-payload snapshot: the exact params
      -- zohoSyncService.syncConversationToZoho needs to retry this
      -- conversation WITHOUT re-deriving them from scratch (e.g. a
      -- persist/model override the original caller specified). Kept as
      -- JSONB so this table never needs a schema change when
      -- syncConversationToZoho's param shape grows.
      sync_payload          JSONB NOT NULL DEFAULT '{}'::jsonb,

      last_attempt_at       TIMESTAMPTZ,
      last_success_at       TIMESTAMPTZ,
      completed_at          TIMESTAMPTZ,

      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT zoho_sync_state_status_check
        CHECK (sync_status IN (${ZOHO_SYNC_STATUSES.map((s) => `'${s}'`).join(', ')})),
      CONSTRAINT zoho_sync_state_failure_type_check
        CHECK (failure_type IS NULL OR failure_type IN (${ZOHO_FAILURE_TYPES.map((s) => `'${s}'`).join(', ')})),

      -- Duplicate-safe identity — same triple as zoho_lead_links'
      -- uq_zoho_lead_links_identity (see file header).
      CONSTRAINT uq_zoho_sync_state_identity
        UNIQUE (workspace_id, whatsapp_account_id, contact_number)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_zoho_sync_state_workspace_id
      ON coexistence.zoho_sync_state (workspace_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_zoho_sync_state_whatsapp_account_id
      ON coexistence.zoho_sync_state (whatsapp_account_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_zoho_sync_state_zoho_connection_id
      ON coexistence.zoho_sync_state (zoho_connection_id)
  `);
  // Claim-query index: the scheduler's WHERE clause always filters on
  // (sync_status, next_attempt_at) together — see
  // zohoReconciliationScheduler.js's claimDueSyncStateIds.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_zoho_sync_state_claimable
      ON coexistence.zoho_sync_state (next_attempt_at)
      WHERE sync_status IN ('pending', 'lead_synced', 'note_pending')
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION coexistence.zoho_sync_state_touch_updated_at()
    RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    DROP TRIGGER IF EXISTS trg_zoho_sync_state_touch_updated_at ON coexistence.zoho_sync_state
  `);
  await pool.query(`
    CREATE TRIGGER trg_zoho_sync_state_touch_updated_at
      BEFORE UPDATE ON coexistence.zoho_sync_state
      FOR EACH ROW EXECUTE FUNCTION coexistence.zoho_sync_state_touch_updated_at()
  `);

  // Final Phase 8 migration fix — see ensureZohoSyncStatusCheckConstraint's
  // own header for why this can't just live inside the CREATE TABLE above.
  // Runs every startup, on both fresh and pre-existing databases; it's a
  // cheap read-and-compare that only ever issues the ALTER pair when the
  // live constraint has actually drifted from ZOHO_SYNC_STATUSES.
  await ensureZohoSyncStatusCheckConstraint();
}

module.exports = {
  ensureZohoSyncStateTable,
  ensureZohoSyncStatusCheckConstraint,
  ZOHO_SYNC_STATUSES,
  ZOHO_FAILURE_TYPES,
};