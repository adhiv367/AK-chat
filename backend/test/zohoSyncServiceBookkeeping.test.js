'use strict';

// Phase 8H Part 1 — direct tests for zohoSyncService.js's exported
// sync-state bookkeeping helpers: recordSyncSuccess, recordNotePending,
// recordSyncFailure. These are NOT re-tested via the orchestration-level
// zohoSyncService.test.js (which never mocks pool.query, relying on the
// helpers' own best-effort try/catch) — this file mocks pool.query
// directly on the shared '../src/db' singleton (same pattern as
// test/zohoRoutes.test.js's installDb) so it can assert exactly what SQL
// and params each helper issues, and that failures to write bookkeeping
// are swallowed (non-fatal) rather than propagated.

const test = require('node:test');
const assert = require('node:assert/strict');

function installDb(query) {
  const pool = require('../src/db');
  const original = pool.query;
  pool.query = query;
  return () => { pool.query = original; };
}

function freshSyncService() {
  delete require.cache[require.resolve('../src/services/zohoSyncService')];
  return require('../src/services/zohoSyncService');
}

const WORKSPACE_ID = 1;
const WA_ACCOUNT_ID = 5;
const CONTACT_NUMBER = '+919999999999';

// ── recordSyncSuccess ────────────────────────────────────────────────────

test('recordSyncSuccess: upserts a completed row with the given connection/lead ids', async () => {
  const calls = [];
  const restore = installDb(async (sql, params) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return { rows: [] };
  });
  try {
    const svc = freshSyncService();
    await svc.recordSyncSuccess(WORKSPACE_ID, WA_ACCOUNT_ID, CONTACT_NUMBER, { zohoConnectionId: 10, zohoLeadId: 'LEAD1' });

    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /INSERT INTO coexistence\.zoho_sync_state/);
    assert.match(calls[0].sql, /sync_status = 'completed'/);
    assert.deepEqual(calls[0].params, [WORKSPACE_ID, WA_ACCOUNT_ID, 10, 'LEAD1', CONTACT_NUMBER]);
  } finally {
    restore();
  }
});

test('recordSyncSuccess: nulls out connection/lead ids when not supplied', async () => {
  const calls = [];
  const restore = installDb(async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [] };
  });
  try {
    const svc = freshSyncService();
    await svc.recordSyncSuccess(WORKSPACE_ID, WA_ACCOUNT_ID, CONTACT_NUMBER, {});

    assert.deepEqual(calls[0].params, [WORKSPACE_ID, WA_ACCOUNT_ID, null, null, CONTACT_NUMBER]);
  } finally {
    restore();
  }
});

test('recordSyncSuccess: a pool.query rejection is swallowed (best-effort, never throws)', async () => {
  const restore = installDb(async () => {
    throw new Error('connection terminated unexpectedly');
  });
  try {
    const svc = freshSyncService();
    await assert.doesNotReject(() => svc.recordSyncSuccess(WORKSPACE_ID, WA_ACCOUNT_ID, CONTACT_NUMBER, { zohoConnectionId: 10, zohoLeadId: 'LEAD1' }));
  } finally {
    restore();
  }
});

// ── recordNotePending ───────────────────────────────────────────────────

test('recordNotePending: reads existing attempt_count then upserts a note_pending row with computed backoff', async () => {
  const calls = [];
  const restore = installDb(async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: s, params });
    if (/^SELECT attempt_count, max_attempts FROM coexistence\.zoho_sync_state/.test(s)) {
      return { rows: [{ attempt_count: 1, max_attempts: 8 }] };
    }
    return { rows: [] };
  });
  try {
    const svc = freshSyncService();
    const err = Object.assign(new Error('Zoho CRM rate limit exceeded'), { zohoStatus: 429 });
    await svc.recordNotePending(WORKSPACE_ID, WA_ACCOUNT_ID, CONTACT_NUMBER, { zohoConnectionId: 10, zohoLeadId: 'LEAD1', err });

    assert.equal(calls.length, 2);
    assert.match(calls[0].sql, /^SELECT attempt_count, max_attempts FROM coexistence\.zoho_sync_state/);
    const upsert = calls[1];
    assert.match(upsert.sql, /INSERT INTO coexistence\.zoho_sync_state/);
    assert.match(upsert.sql, /'note_pending'/);
    // params: [workspaceId, whatsappAccountId, zohoConnectionId, zohoLeadId, contactNumber, failureType, errMessage, backoffMs]
    assert.equal(upsert.params[0], WORKSPACE_ID);
    assert.equal(upsert.params[1], WA_ACCOUNT_ID);
    assert.equal(upsert.params[2], 10);
    assert.equal(upsert.params[3], 'LEAD1');
    assert.equal(upsert.params[4], CONTACT_NUMBER);
    assert.equal(upsert.params[5], 'retryable_failure', '429 must classify as retryable_failure');
    assert.match(upsert.params[6], /rate limit/);
    assert.ok(Number(upsert.params[7]) > 0, 'backoff ms must be a positive number');
  } finally {
    restore();
  }
});

test('recordNotePending: no existing row defaults attempt_count to 0 before classifying', async () => {
  const calls = [];
  const restore = installDb(async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: s, params });
    if (/^SELECT attempt_count, max_attempts FROM coexistence\.zoho_sync_state/.test(s)) {
      return { rows: [] }; // no existing row yet
    }
    return { rows: [] };
  });
  try {
    const svc = freshSyncService();
    const err = Object.assign(new Error('Zoho CRM rejected the request'), { zohoStatus: 400 });
    await svc.recordNotePending(WORKSPACE_ID, WA_ACCOUNT_ID, CONTACT_NUMBER, { err });

    const upsert = calls[1];
    assert.equal(upsert.params[5], 'permanent_failure', '400 must classify as permanent_failure');
    // permanent failures are pushed ~100 years out, never a small number.
    assert.ok(Number(upsert.params[7]) > 1000 * 60 * 60 * 24 * 300);
  } finally {
    restore();
  }
});

test('recordNotePending: swallows write failures without throwing', async () => {
  const restore = installDb(async (sql) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT attempt_count/.test(s)) return { rows: [] };
    throw new Error('db unavailable');
  });
  try {
    const svc = freshSyncService();
    const err = Object.assign(new Error('boom'), { zohoStatus: 500 });
    await assert.doesNotReject(() => svc.recordNotePending(WORKSPACE_ID, WA_ACCOUNT_ID, CONTACT_NUMBER, { err }));
  } finally {
    restore();
  }
});

// ── recordSyncFailure ────────────────────────────────────────────────────

test('recordSyncFailure: retryable error stays sync_status=pending with a bounded backoff', async () => {
  const calls = [];
  const restore = installDb(async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: s, params });
    if (/^SELECT attempt_count, max_attempts FROM coexistence\.zoho_sync_state/.test(s)) {
      return { rows: [{ attempt_count: 0, max_attempts: 8 }] };
    }
    return { rows: [] };
  });
  try {
    const svc = freshSyncService();
    const err = Object.assign(new Error('Zoho API rate limit exceeded'), { zohoStatus: 429 });
    await svc.recordSyncFailure(WORKSPACE_ID, WA_ACCOUNT_ID, CONTACT_NUMBER, err);

    const upsert = calls[1];
    assert.match(upsert.sql, /INSERT INTO coexistence\.zoho_sync_state/);
    // params: [workspaceId, whatsappAccountId, contactNumber, status, failureType, errMessage, delayMs]
    assert.equal(upsert.params[0], WORKSPACE_ID);
    assert.equal(upsert.params[1], WA_ACCOUNT_ID);
    assert.equal(upsert.params[2], CONTACT_NUMBER);
    assert.equal(upsert.params[3], 'pending');
    assert.equal(upsert.params[4], 'retryable_failure');
    assert.match(upsert.params[5], /rate limit/);
    const delayMs = Number(upsert.params[6]);
    assert.ok(delayMs > 0 && delayMs < 1000 * 60 * 60 * 24, 'retryable backoff must be bounded (well under 100 years)');
  } finally {
    restore();
  }
});

test('recordSyncFailure: reauth-required error gets a real, bounded backoff (not the ~100y permanent placeholder)', async () => {
  const calls = [];
  const restore = installDb(async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: s, params });
    if (/^SELECT attempt_count, max_attempts FROM coexistence\.zoho_sync_state/.test(s)) {
      return { rows: [{ attempt_count: 3, max_attempts: 8 }] };
    }
    return { rows: [] };
  });
  try {
    const svc = freshSyncService();
    const err = Object.assign(new Error('Zoho API rejected the access token (401)'), { zohoStatus: 401 });
    await svc.recordSyncFailure(WORKSPACE_ID, WA_ACCOUNT_ID, CONTACT_NUMBER, err);

    const upsert = calls[1];
    assert.equal(upsert.params[3], 'pending', 'row must stay pending so a future manual resync/enqueueSync finds it');
    assert.equal(upsert.params[4], 'reauth_required');
    const delayMs = Number(upsert.params[6]);
    // Root cause of the Phase 8I FIX Part 2 bug: reauth_required used to
    // reuse the permanent_failure "~100 years" placeholder, producing a
    // next_attempt_at ~100 years in the future (e.g. year 2126) instead of
    // a real, bounded retry time. It must now use the SAME bounded
    // exponential backoff as an ordinary retryable failure (capped at
    // ZOHO_RETRY_MAX_MS, ~1 hour, plus up to 20% jitter) — a real,
    // calculable, near-future timestamp.
    assert.ok(delayMs > 0, 'delay must be positive');
    assert.ok(delayMs <= 1000 * 60 * 60 * 1.2, 'reauth_required backoff must be bounded like any other retryable delay (<= ~1h20m incl. jitter), never ~100 years');
    assert.ok(delayMs < 1000 * 60 * 60 * 24 * 300, 'must never regress to the ~100-year "permanent" placeholder');
  } finally {
    restore();
  }
});

test('recordSyncFailure: exhausted attempt_count reclassifies a normally-retryable error as permanent', async () => {
  const calls = [];
  const restore = installDb(async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: s, params });
    if (/^SELECT attempt_count, max_attempts FROM coexistence\.zoho_sync_state/.test(s)) {
      return { rows: [{ attempt_count: 7, max_attempts: 8 }] };
    }
    return { rows: [] };
  });
  try {
    const svc = freshSyncService();
    const err = Object.assign(new Error('Zoho API rate limit exceeded'), { zohoStatus: 429 });
    await svc.recordSyncFailure(WORKSPACE_ID, WA_ACCOUNT_ID, CONTACT_NUMBER, err);

    const upsert = calls[1];
    assert.equal(upsert.params[4], 'permanent_failure', 'attempt_count+1 >= max_attempts must exhaust retries');
    const delayMs = Number(upsert.params[6]);
    assert.ok(delayMs > 1000 * 60 * 60 * 24 * 300);
  } finally {
    restore();
  }
});

test('recordSyncFailure: swallows write failures without throwing', async () => {
  const restore = installDb(async (sql) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT attempt_count/.test(s)) return { rows: [] };
    throw new Error('db unavailable');
  });
  try {
    const svc = freshSyncService();
    const err = Object.assign(new Error('boom'), { zohoStatus: 500 });
    await assert.doesNotReject(() => svc.recordSyncFailure(WORKSPACE_ID, WA_ACCOUNT_ID, CONTACT_NUMBER, err));
  } finally {
    restore();
  }
});

test('recordSyncFailure: caller-input validation error (no status/zohoStatus) classifies as permanent_failure', async () => {
  const calls = [];
  const restore = installDb(async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: s, params });
    if (/^SELECT attempt_count, max_attempts FROM coexistence\.zoho_sync_state/.test(s)) {
      return { rows: [{ attempt_count: 0, max_attempts: 8 }] };
    }
    return { rows: [] };
  });
  try {
    const svc = freshSyncService();
    const err = new Error('A valid contactNumber is required');
    await svc.recordSyncFailure(WORKSPACE_ID, WA_ACCOUNT_ID, CONTACT_NUMBER, err);

    const upsert = calls[1];
    assert.equal(upsert.params[4], 'permanent_failure');
  } finally {
    restore();
  }
});

// ── Phase 8J FIX — Fix 1: err.zohoForceRetryable overrides classification ─
// Root cause: the synthetic "a prior Note attempt for this Lead is still
// unresolved" bookkeeping Error has neither .status nor .zohoStatus — the
// exact same shape as a genuine caller-input validation error — so it was
// falling into classifyFailure's "no status fields -> permanent_failure"
// branch by coincidence, pushing next_attempt_at ~100 years out (Arun's
// 2126 case) and permanently excluding the row from reconciliation. This
// condition must always stay open/retryable with a normal bounded backoff.
test('recordNotePending: an err.zohoForceRetryable-marked error (e.g. unresolved-Note-obligation signal) classifies as retryable_failure, never permanent, with a bounded backoff', async () => {
  const calls = [];
  const restore = installDb(async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: s, params });
    if (/^SELECT attempt_count, max_attempts FROM coexistence\.zoho_sync_state/.test(s)) {
      return { rows: [{ attempt_count: 6, max_attempts: 8 }] };
    }
    return { rows: [] };
  });
  try {
    const svc = freshSyncService();
    const err = new Error(
      'A previous Note attempt for this Lead is still unresolved (pending/failed) and this retry\'s extraction produced no note content to (re)submit — keeping the sync open for another attempt rather than declaring it complete.'
    );
    err.zohoForceRetryable = true;
    // Sanity: this error has NO status/zohoStatus, same shape as the
    // caller-input-validation case tested above — proving the classifier
    // now distinguishes them by the explicit flag, not by shape.
    assert.equal(err.status, undefined);
    assert.equal(err.zohoStatus, undefined);

    await svc.recordNotePending(WORKSPACE_ID, WA_ACCOUNT_ID, CONTACT_NUMBER, {
      zohoConnectionId: 10,
      zohoLeadId: LEAD_ID,
      err,
    });

    const upsert = calls[1];
    assert.equal(upsert.params[5], 'retryable_failure', 'must classify as retryable_failure, never permanent_failure');
    const backoffMs = Number(upsert.params[7]);
    assert.ok(backoffMs > 0, 'must have a real, positive backoff');
    assert.ok(backoffMs < 1000 * 60 * 60 * 24, 'must be a normal bounded backoff, never the ~100-year permanent-failure placeholder (2126)');
  } finally {
    restore();
  }
});

test('recordNotePending: an exhausted err.zohoForceRetryable case (attempt_count reaches max_attempts) still eventually reclassifies as permanent, same as any other retryable failure', async () => {
  const calls = [];
  const restore = installDb(async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: s, params });
    if (/^SELECT attempt_count, max_attempts FROM coexistence\.zoho_sync_state/.test(s)) {
      return { rows: [{ attempt_count: 7, max_attempts: 8 }] };
    }
    return { rows: [] };
  });
  try {
    const svc = freshSyncService();
    const err = new Error('still unresolved');
    err.zohoForceRetryable = true;

    await svc.recordNotePending(WORKSPACE_ID, WA_ACCOUNT_ID, CONTACT_NUMBER, {
      zohoConnectionId: 10,
      zohoLeadId: LEAD_ID,
      err,
    });

    const upsert = calls[1];
    // attempt_count(7) + 1 >= max_attempts(8) -> bounded-retry exhaustion
    // still applies exactly like any other retryable_failure; the forced
    // flag only prevents MISCLASSIFICATION as permanent, it does not grant
    // unlimited retries.
    assert.equal(upsert.params[5], 'permanent_failure');
  } finally {
    restore();
  }
});

// ── Phase 8I FIX — PART 3: hasUnresolvedNoteObligation ───────────────────
// Root cause: syncConversationToZoho's "nothing worth attaching as a Note
// this time" shortcut used to call recordSyncSuccess (sync_status=
// 'completed') unconditionally whenever recomputed noteContent was empty —
// even when an earlier attempt's zoho_lead_notes row for the SAME Lead was
// still 'pending'/'failed' (e.g. Arun's case: a 401 on the Note call, then
// a later retry whose re-run extraction produced no note content). Because
// 'completed' is excluded from zohoReconciliationService's claim query,
// that permanently orphaned the failed Note with nothing ever created in
// Zoho, while the system reported full success. hasUnresolvedNoteObligation
// is the read-only check that now gates that shortcut.

const LEAD_ID = '1410618000000545002';

test('hasUnresolvedNoteObligation: true when a zoho_lead_notes row for this Lead is still failed', async () => {
  const calls = [];
  const restore = installDb(async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: s, params });
    if (/^SELECT 1 FROM coexistence\.zoho_lead_notes/.test(s)) {
      assert.deepEqual(params, [WORKSPACE_ID, WA_ACCOUNT_ID, LEAD_ID]);
      assert.match(s, /status IN \('pending', 'failed'\)/);
      return { rows: [{ '?column?': 1 }] };
    }
    return { rows: [] };
  });
  try {
    const svc = freshSyncService();
    const result = await svc.hasUnresolvedNoteObligation(WORKSPACE_ID, WA_ACCOUNT_ID, LEAD_ID);
    assert.equal(result, true);
  } finally {
    restore();
  }
});

test('hasUnresolvedNoteObligation: false when no matching zoho_lead_notes row exists (genuinely nothing to attach)', async () => {
  const restore = installDb(async () => ({ rows: [] }));
  try {
    const svc = freshSyncService();
    const result = await svc.hasUnresolvedNoteObligation(WORKSPACE_ID, WA_ACCOUNT_ID, LEAD_ID);
    assert.equal(result, false);
  } finally {
    restore();
  }
});

test('hasUnresolvedNoteObligation: false (fail-safe) when no zohoLeadId is given yet', async () => {
  const restore = installDb(async () => { throw new Error('should never query without a lead id'); });
  try {
    const svc = freshSyncService();
    const result = await svc.hasUnresolvedNoteObligation(WORKSPACE_ID, WA_ACCOUNT_ID, null);
    assert.equal(result, false);
  } finally {
    restore();
  }
});
test('hasUnresolvedNoteObligation: false (non-fatal) when the lookup query itself throws', async () => {
  const restore = installDb(async () => { throw new Error('db unavailable'); });
  try {
    const svc = freshSyncService();
    const result = await svc.hasUnresolvedNoteObligation(WORKSPACE_ID, WA_ACCOUNT_ID, LEAD_ID);
    assert.equal(result, false, 'a bookkeeping-query failure must never itself block/crash the sync');
  } finally {
    restore();
  }
});