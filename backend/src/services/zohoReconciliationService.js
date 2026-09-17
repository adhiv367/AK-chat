// Phase 8H Part 1 — Zoho CRM RECONCILIATION SERVICE.
//
// Orchestration layer around coexistence.zoho_sync_state (see
// zohoSyncStateSchema.js's header for the full table-design rationale).
// Reuses every existing 8A–8G building block unmodified except for the
// small additive hooks documented in zohoSyncService.js's own header:
//
//   - zohoSyncService.syncConversationToZoho   -> the actual Lead+Note sync
//     work. This file NEVER re-implements Lead/Note creation itself — a
//     retry is just calling this again with the same
//     (workspaceId, whatsappAccountId, contactNumber), which is safe to
//     repeat because zohoLeadService/zohoNoteService's own atomic-claim +
//     idempotency-key machinery (8C) already guarantees "retry Note
//     without recreating Lead" and "duplicate-safe Lead/Note
//     reconciliation" — see those files' headers. This service's only job
//     is deciding WHICH conversations are due for a retry and WHEN.
//   - zohoConnectionService.findConnection      -> used by
//     resetForReauthRecovery() to confirm a connection is actually healthy
//     again before un-blocking its reauth_required rows.
//   - zohoRetryClassifier.classifyFailure/computeBackoffMs -> the retry
//     policy itself (see that file's header).
//   - zohoSafeLogger                             -> every log line here
//     goes through it — zero secrets/tokens, ever.
//
// ── Atomic lease/claim (spec) ─────────────────────────────────────────────
// claimDueSyncStateRows() follows the EXACT pattern
// sequenceScheduler.js's claimDueEnrollmentIds() already established in
// this codebase: one transaction, `SELECT ... FOR UPDATE SKIP LOCKED`,
// flip status + push a lease (locked_until) forward, COMMIT. See that
// file's header for why this is both the concurrency guard (two workers
// can never claim the same row) and the crash-recovery mechanism (a
// crashed worker's claimed rows simply become claimable again once
// locked_until passes — no separate sweep needed).
//
// ── Per-workspace + per-WhatsApp-number isolation ────────────────────────
// Every query below filters on workspace_id + whatsapp_account_id
// explicitly wherever a specific conversation is targeted (enqueueSync,
// resetForReauthRecovery) — mirrors zohoConnectionService's
// assertWhatsappAccountInWorkspace discipline. The claim query itself
// (claimDueSyncStateRows) is intentionally NOT scoped to one
// workspace/account — it is a global background sweep across every
// workspace's due rows, exactly like sequenceScheduler's own claim query
// is global across every workspace's due enrollments; per-row isolation is
// preserved because each row's own workspace_id/whatsapp_account_id is
// carried through untouched into the zohoSyncService call that processes
// it, so a claimed row can only ever act on its own conversation's own
// connection (zohoLeadService.resolveConnectionRow re-verifies this on
// every call regardless).

const os = require('os');
const pool = require('../db');
const zohoSyncService = require('./zohoSyncService');
const zohoConnectionService = require('./zohoConnectionService');
const safeLog = require('./zohoSafeLogger');

// How many sync-state rows a single tick claims at once. Kept modest —
// mirrors sequenceScheduler's BATCH_SIZE reasoning (processing is not free
// here: each row triggers a real Zoho API round trip via
// zohoSyncService.syncConversationToZoho).
const BATCH_SIZE = parseInt(process.env.ZOHO_RECONCILIATION_BATCH_SIZE || '10', 10);

// Claim lease — comfortably longer than one conversation's sync attempt
// (an AI extraction call + up to two Zoho API calls) while still short
// enough that a crashed process's claimed rows recover promptly. Mirrors
// sequenceScheduler's CLAIM_LEASE_MS reasoning.
const CLAIM_LEASE_MS = parseInt(process.env.ZOHO_RECONCILIATION_LEASE_MS || '120000', 10);

// Identifies which worker/process currently holds a row's lease — purely
// informational (logging/debugging which instance is stuck), never used
// for correctness (the DB lock + locked_until are what actually matter).
const WORKER_ID = `${os.hostname()}:${process.pid}`;

/**
 * Idempotent upsert of a (workspace, whatsapp_account, contact_number)
 * conversation into the sync-state queue. Safe to call repeatedly for the
 * same identity — duplicate-safe by construction via
 * uq_zoho_sync_state_identity (spec "duplicate-safe Lead/Note
 * reconciliation"): a second enqueue for a conversation already
 * pending/processing/lead_synced/note_pending is a no-op on the
 * queue-position fields (never resets attempt_count or jumps the queue),
 * while an enqueue for a conversation already 'completed' resets it back
 * to 'pending' for a fresh attempt (e.g. the caller has new information
 * worth re-syncing).
 *
 * @param {object} params
 * @param {number|string} params.workspaceId
 * @param {number|string} params.whatsappAccountId
 * @param {string} params.contactNumber
 * @param {number|string} [params.zohoConnectionId]
 * @param {object} [params.syncPayload] - forwarded to
 *   zohoSyncService.syncConversationToZoho on retry (e.g. { persist, model }).
 */
async function enqueueSync({ workspaceId, whatsappAccountId, contactNumber, zohoConnectionId, syncPayload } = {}) {
  if (!workspaceId) throw new Error('workspaceId is required');
  if (!whatsappAccountId) throw new Error('whatsappAccountId is required');
  if (!contactNumber) throw new Error('contactNumber is required');

  const { rows } = await pool.query(
    `INSERT INTO coexistence.zoho_sync_state
       (workspace_id, whatsapp_account_id, zoho_connection_id, contact_number, sync_status, sync_payload, next_attempt_at)
     VALUES ($1, $2, $3, $4, 'pending', $5, NOW())
     ON CONFLICT ON CONSTRAINT uq_zoho_sync_state_identity DO UPDATE
       SET sync_payload = COALESCE($5, coexistence.zoho_sync_state.sync_payload),
           zoho_connection_id = COALESCE($3, coexistence.zoho_sync_state.zoho_connection_id),
           -- Only re-queue if this row was previously terminal/stuck.
           -- A row already pending/processing/lead_synced/note_pending is
           -- left exactly where it is (never re-jumps the retry queue or
           -- resets its own backoff/attempt_count — spec "duplicate-safe").
           sync_status = CASE
             WHEN coexistence.zoho_sync_state.sync_status = 'completed' THEN 'pending'
             ELSE coexistence.zoho_sync_state.sync_status
           END,
           next_attempt_at = CASE
             WHEN coexistence.zoho_sync_state.sync_status = 'completed' THEN NOW()
             ELSE coexistence.zoho_sync_state.next_attempt_at
           END,
           attempt_count = CASE
             WHEN coexistence.zoho_sync_state.sync_status = 'completed' THEN 0
             ELSE coexistence.zoho_sync_state.attempt_count
           END,
           failure_type = CASE
             WHEN coexistence.zoho_sync_state.sync_status = 'completed' THEN NULL
             ELSE coexistence.zoho_sync_state.failure_type
           END,
           updated_at = NOW()
     RETURNING *`,
    [workspaceId, whatsappAccountId, zohoConnectionId || null, contactNumber, JSON.stringify(syncPayload || {})]
  );
  return rows[0];
}

/**
 * Atomically claim up to `limit` sync-state rows that are due for an
 * attempt: sync_status is one of the retryable in-flight statuses AND
 * either not currently locked or its lease has expired (crash recovery —
 * see file header), AND next_attempt_at has arrived (backoff — see
 * zohoRetryClassifier.js). Never throws for "nothing due" — returns [].
 */
async function claimDueSyncStateRows(limit = BATCH_SIZE) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id
         FROM coexistence.zoho_sync_state
        WHERE sync_status IN ('pending', 'lead_synced', 'note_pending')
          AND next_attempt_at <= NOW()
          AND (locked_until IS NULL OR locked_until < NOW())
        ORDER BY next_attempt_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit]
    );
    if (rows.length === 0) {
      await client.query('COMMIT');
      return [];
    }
    const ids = rows.map((r) => r.id);
    await client.query(
      `UPDATE coexistence.zoho_sync_state
          SET sync_status = 'processing',
              locked_until = NOW() + ($2 || ' milliseconds')::interval,
              locked_by = $3
        WHERE id = ANY($1::bigint[])`,
      [ids, String(CLAIM_LEASE_MS), WORKER_ID]
    );
    await client.query('COMMIT');
    return ids;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Process exactly one claimed sync-state row: re-invokes
 * zohoSyncService.syncConversationToZoho for its conversation. That call
 * itself is responsible for writing the terminal outcome back onto this
 * same row (completed / note_pending / lead_synced / failed) — see
 * zohoSyncService.js's own additive recordSyncOutcome* hooks — so this
 * function's only remaining job is loading the row, calling through, and
 * making sure a row is NEVER left permanently stuck in 'processing' if
 * zohoSyncService throws something unexpected that its own try/catch
 * didn't already convert into a recorded outcome.
 */
async function processSyncStateRow(id) {
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.zoho_sync_state WHERE id = $1`,
    [id]
  );
  const row = rows[0];
  if (!row) return; // claimed then deleted concurrently — nothing to do.

  const payload = row.sync_payload && typeof row.sync_payload === 'object' ? row.sync_payload : {};

  try {
    await zohoSyncService.syncConversationToZoho({
      workspaceId: row.workspace_id,
      whatsappAccountId: row.whatsapp_account_id,
      contactNumber: row.contact_number,
      ...payload,
    });
    // zohoSyncService's own recordSyncOutcome* hooks already persisted the
    // terminal state for this row (completed / note_pending / lead_synced /
    // failed-with-backoff) as part of that call — nothing further to do
    // here on the success path.
  } catch (err) {
    // Defense-in-depth only: zohoSyncService already records failures
    // itself before rethrowing (see that file), so this row should already
    // be back to a non-'processing' status. If it somehow is not (e.g. a
    // truly unexpected throw before zohoSyncService's own recording ran —
    // bad params, etc.), never leave it wedged in 'processing' — release
    // it back to 'pending' with backoff so the next tick can try again.
    safeLog.error(`sync-state row ${id} processing threw unexpectedly`, err, {
      workspaceId: row.workspace_id,
      whatsappAccountId: row.whatsapp_account_id,
    });
    await pool.query(
      `UPDATE coexistence.zoho_sync_state
          SET sync_status = CASE WHEN sync_status = 'processing' THEN 'pending' ELSE sync_status END,
              locked_until = NULL,
              last_error = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [id, String(err.message || 'Unexpected reconciliation error').slice(0, 500)]
    );
  }
}

/**
 * ── Reauth handling / recovery ────────────────────────────────────────────
 * Called once a Zoho connection is reconnected (e.g. from the OAuth
 * callback route, or a future manual "reconnect" action) — flips every
 * sync_state row that was blocked on failure_type='reauth_required' for
 * THIS connection back to 'pending' so the next scheduler tick picks them
 * up again. Never touches rows for other connections/workspaces (spec
 * "per-workspace + per-WhatsApp-number isolation").
 */
async function resetForReauthRecovery(workspaceId, whatsappAccountId) {
  if (!workspaceId || !whatsappAccountId) return { reset: 0 };

  const connection = await zohoConnectionService.findConnection(workspaceId, whatsappAccountId);
  if (!connection || connection.status !== 'connected') {
    // Nothing to recover unless the connection is actually healthy again.
    return { reset: 0 };
  }

  const { rowCount } = await pool.query(
    `UPDATE coexistence.zoho_sync_state
        SET sync_status = 'pending',
            failure_type = NULL,
            last_error = NULL,
            next_attempt_at = NOW(),
            locked_until = NULL
      WHERE workspace_id = $1
        AND whatsapp_account_id = $2
        AND failure_type = 'reauth_required'`,
    [workspaceId, whatsappAccountId]
  );

  if (rowCount > 0) {
    safeLog.info(`Reconnected — released ${rowCount} reauth-blocked sync row(s) for retry`, {
      workspaceId,
      whatsappAccountId,
    });
  }
  return { reset: rowCount };
}

/**
 * Read-only status lookup for a single conversation's sync-state row (used
 * by a future admin/UI surface — 8H Part 1 does not add a route for this,
 * kept here for 8H Part 2/8I to wire up without duplicating the query).
 */
async function getSyncState(workspaceId, whatsappAccountId, contactNumber) {
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.zoho_sync_state
      WHERE workspace_id = $1 AND whatsapp_account_id = $2 AND contact_number = $3`,
    [workspaceId, whatsappAccountId, contactNumber]
  );
  return rows[0] || null;
}

module.exports = {
  enqueueSync,
  claimDueSyncStateRows,
  processSyncStateRow,
  resetForReauthRecovery,
  getSyncState,
  BATCH_SIZE,
  CLAIM_LEASE_MS,
};





