'use strict';

// Regression tests for the Broadcast Studio status-lifecycle / per-recipient
// log fix (see the audit this file accompanies). No real Postgres is used —
// pool.query is monkey-patched on the shared '../src/db' singleton, same
// approach as test/planChangeRequests.test.js and test/usersSeatLimit.test.js.
//
// Covers:
//   1. 4/4 successful -> SENT
//   2. 1/4 successful + 3/4 failed -> PARTIAL
//   3. 0/4 successful + 4/4 failed -> FAILED
//   4. pending/running recipients do not produce premature SENT
//   7. GET /broadcasts/:id exposes individual BROADCAST recipient results
//   8. Existing TEST broadcast behavior remains unchanged
//   9. Existing all-success broadcast behavior remains unchanged (dup of #1
//      at the route level, exercising getBroadcastWithLogs end-to-end)

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// routes/broadcasts.js pulls in queue/sendQueue.js at require-time, which
// opens a real ioredis connection (and retries indefinitely against a
// nonexistent 'redis' host in this sandboxed test environment, hanging the
// test run). Stub it out before requiring broadcasts.js — none of the
// status/log-aggregation logic under test here touches the queue.
const sendQueuePath = require.resolve('../src/queue/sendQueue');
require.cache[sendQueuePath] = {
  id: sendQueuePath,
  filename: sendQueuePath,
  loaded: true,
  exports: {
    enqueueSend: async () => {},
    startSendWorker: () => {},
    shutdownSendQueue: async () => {},
    sendQueue: { add: async () => {} },
  },
};

const pool = require('../src/db');
const { computeDisplayStatus, getBroadcastWithLogs } = require('../src/routes/broadcasts');

// ─── computeDisplayStatus — pure unit tests ────────────────────────────────

test('computeDisplayStatus: 4/4 successful -> SENT', () => {
  const status = computeDisplayStatus('SENDING', { pending_count: 0, failed_count: 0, success_count: 4 });
  assert.equal(status, 'SENT');
});

test('computeDisplayStatus: 1/4 successful + 3/4 failed -> PARTIAL', () => {
  const status = computeDisplayStatus('SENDING', { pending_count: 0, failed_count: 3, success_count: 1 });
  assert.equal(status, 'PARTIAL');
});

test('computeDisplayStatus: 0/4 successful + 4/4 failed -> FAILED', () => {
  const status = computeDisplayStatus('SENDING', { pending_count: 0, failed_count: 4, success_count: 0 });
  assert.equal(status, 'FAILED');
});

test('computeDisplayStatus: pending/running recipients never produce premature SENT', () => {
  // Even with some successes already in, any PENDING recipient keeps it SENDING.
  const status = computeDisplayStatus('SENDING', { pending_count: 2, failed_count: 0, success_count: 2 });
  assert.equal(status, 'SENDING');
});

test('computeDisplayStatus: DRAFT/SCHEDULED pass through untouched regardless of stale logs', () => {
  assert.equal(computeDisplayStatus('DRAFT', { pending_count: 0, failed_count: 0, success_count: 0 }), 'DRAFT');
  assert.equal(computeDisplayStatus('SCHEDULED', { pending_count: 0, failed_count: 0, success_count: 0 }), 'SCHEDULED');
});

test('computeDisplayStatus: no BROADCAST logs yet falls back to raw status', () => {
  assert.equal(computeDisplayStatus('SENDING', {}), 'SENDING');
});

// ─── getBroadcastWithLogs — full route-level scenarios ─────────────────────

function installDb(scenario) {
  const calls = [];
  async function dispatch(sql, params) {
    calls.push({ sql, params });

    // Main broadcast + template row
    if (/FROM coexistence\.broadcasts b\s*\n\s*LEFT JOIN coexistence\.message_templates/.test(sql)) {
      return { rows: scenario.broadcastRow ? [scenario.broadcastRow] : [] };
    }
    // Aggregate counts query (recipient_count / pending_count / failed_count / success_count)
    if (/recipient_count/.test(sql)) {
      return { rows: [scenario.agg || { recipient_count: 0, sent_at: null, pending_count: 0, failed_count: 0, success_count: 0, errors: null }] };
    }
    // Individual recipient rows (per-recipient exposure)
    if (/action = 'BROADCAST'/.test(sql) && /ORDER BY sent_at DESC NULLS LAST/.test(sql)) {
      return { rows: scenario.recipientRows || [] };
    }
    // TEST log rows
    if (/action = 'TEST'/.test(sql)) {
      return { rows: scenario.testRows || [] };
    }
    // Delivery rollup (chat_history join)
    if (/LEFT JOIN coexistence\.chat_history/.test(sql)) {
      return { rows: [scenario.rollup || { total: 0, pending: 0, failed: 0, sent: 0, delivered: 0, read: 0 }] };
    }
    return { rows: [] };
  }
  const originalQuery = pool.query;
  pool.query = dispatch;
  return { calls, restore() { pool.query = originalQuery; } };
}

test('getBroadcastWithLogs: 4/4 successful -> displays SENT and keeps recipients', async () => {
  const db = installDb({
    broadcastRow: { id: 5, status: 'SENDING', workspace_id: 1 },
    agg: { recipient_count: 4, sent_at: new Date(), pending_count: 0, failed_count: 0, success_count: 4, errors: null },
    recipientRows: [1, 2, 3, 4].map(n => ({ id: n, sent_to: `+1555000000${n}`, status: 'sent', wa_message_id: `wamid.${n}`, error_message: null, sent_at: new Date() })),
  });
  try {
    const data = await getBroadcastWithLogs(5, 1);
    assert.equal(data.status, 'SENT');
    assert.equal(data.recipients.length, 4);
    assert.ok(data.recipients.every(r => r.status === 'sent'));
  } finally { db.restore(); }
});

test('getBroadcastWithLogs: 1/4 successful + 3/4 failed -> displays PARTIAL, individual failures visible', async () => {
  const recipientRows = [
    { id: 1, sent_to: '+15550001', status: 'sent', wa_message_id: 'wamid.1', error_message: null, sent_at: new Date() },
    { id: 2, sent_to: '+15550002', status: 'failed', wa_message_id: null, error_message: 'Meta 400: template paused | code=132001', sent_at: new Date() },
    { id: 3, sent_to: '+15550003', status: 'failed', wa_message_id: null, error_message: 'Meta 400: template paused | code=132001', sent_at: new Date() },
    { id: 4, sent_to: '+15550004', status: 'failed', wa_message_id: null, error_message: 'Meta 400: template paused | code=132001', sent_at: new Date() },
  ];
  const db = installDb({
    broadcastRow: { id: 6, status: 'SENDING', workspace_id: 1 },
    agg: { recipient_count: 4, sent_at: new Date(), pending_count: 0, failed_count: 3, success_count: 1, errors: ['Meta 400: template paused | code=132001'] },
    recipientRows,
  });
  try {
    const data = await getBroadcastWithLogs(6, 1);
    assert.equal(data.status, 'PARTIAL');
    assert.equal(data.recipients.filter(r => r.status === 'failed').length, 3);
    assert.equal(data.recipients.filter(r => r.status === 'sent').length, 1);
    // The failures are individually visible, not collapsed into one row.
    assert.ok(data.recipients.find(r => r.id === 2).error_message.includes('132001'));
  } finally { db.restore(); }
});

test('getBroadcastWithLogs: 0/4 successful + 4/4 failed -> displays FAILED', async () => {
  const db = installDb({
    broadcastRow: { id: 7, status: 'SENDING', workspace_id: 1 },
    agg: { recipient_count: 4, sent_at: new Date(), pending_count: 0, failed_count: 4, success_count: 0, errors: ['Access token missing'] },
    recipientRows: [1, 2, 3, 4].map(n => ({ id: n, sent_to: `+1555000${n}`, status: 'failed', wa_message_id: null, error_message: 'Access token missing', sent_at: new Date() })),
  });
  try {
    const data = await getBroadcastWithLogs(7, 1);
    assert.equal(data.status, 'FAILED');
    assert.equal(data.recipients.length, 4);
    assert.ok(data.recipients.every(r => r.status === 'failed'));
  } finally { db.restore(); }
});

test('getBroadcastWithLogs: recipients still pending -> displays SENDING, never SENT prematurely', async () => {
  const db = installDb({
    broadcastRow: { id: 8, status: 'SENDING', workspace_id: 1 },
    agg: { recipient_count: 4, sent_at: null, pending_count: 2, failed_count: 0, success_count: 2, errors: null },
    recipientRows: [
      { id: 1, sent_to: '+1', status: 'sent', wa_message_id: 'w1', error_message: null, sent_at: new Date() },
      { id: 2, sent_to: '+2', status: 'sent', wa_message_id: 'w2', error_message: null, sent_at: new Date() },
      { id: 3, sent_to: '+3', status: 'PENDING', wa_message_id: null, error_message: null, sent_at: null },
      { id: 4, sent_to: '+4', status: 'PENDING', wa_message_id: null, error_message: null, sent_at: null },
    ],
  });
  try {
    const data = await getBroadcastWithLogs(8, 1);
    assert.equal(data.status, 'SENDING');
    assert.notEqual(data.status, 'SENT');
  } finally { db.restore(); }
});

test('getBroadcastWithLogs: existing TEST broadcast rows are unaffected by the BROADCAST aggregate logic', async () => {
  const db = installDb({
    broadcastRow: { id: 9, status: 'DRAFT', workspace_id: 1 },
    agg: { recipient_count: 0, sent_at: null, pending_count: 0, failed_count: 0, success_count: 0, errors: null },
    recipientRows: [],
    testRows: [{ id: 99, action: 'TEST', sent_to: '+1555test', status: 'sent', sent_at: new Date(), wa_message_id: 'wamid.test', error_message: null }],
  });
  try {
    const data = await getBroadcastWithLogs(9, 1);
    // No BROADCAST recipients yet -> raw DRAFT status passes through untouched.
    assert.equal(data.status, 'DRAFT');
    // TEST log still present as its own individual row, exactly as before.
    const testLog = data.logs.find(l => l.action === 'TEST');
    assert.ok(testLog);
    assert.equal(testLog.status, 'sent');
    assert.equal(data.recipients.length, 0);
  } finally { db.restore(); }
});