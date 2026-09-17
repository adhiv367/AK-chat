'use strict';

// Regression tests for Phase 6 Part 3E: Campaign Detail's "Delivery" counters
// (SENT/DELIVERED/READ/FAILED/PENDING) showing all-zero while the recipient
// table directly underneath correctly showed `sent`/`sent`.
//
// Root cause: the old rollup derived SENT/DELIVERED/READ *entirely* from
// `LEFT JOIN coexistence.chat_history ch ON ch.message_id = bl.wa_message_id`.
// coexistence.broadcast_logs.status ('sent'/'failed'/'PENDING') is the value
// already proven reliable everywhere else in the codebase (computeDisplayStatus,
// the /broadcasts list SQL CASE, campaigns.js's reconcileCampaignStatus, and the
// recipient table itself all key off it directly) — so a recipient whose
// chat_history row didn't happen to join (missing row, any transformation
// touching message_id/wa_message_id) silently dropped out of the "sent" count
// even though broadcast_logs already said 'sent'.
//
// Fix (see src/routes/broadcasts.js computeDeliveryRollup): broadcast_logs.status
// is now the FLOOR for "sent"; chat_history is consulted only to layer on the
// more granular delivered/read signal it alone carries (Part 3B: broadcast_logs
// is never written 'delivered'/'read', only chat_history is).
//
// No real Postgres is used — pool.query is monkey-patched, same approach as
// test/broadcastStatus.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

// routes/broadcasts.js requires queue/sendQueue.js at load time, which opens a
// real ioredis connection in this sandboxed environment — stub it out, same as
// test/broadcastStatus.test.js.
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
const { getBroadcastWithLogs, computeDeliveryRollup } = require('../src/routes/broadcasts');

// ─── computeDeliveryRollup — pure unit tests ───────────────────────────────

test('computeDeliveryRollup: two `sent` broadcast_logs rows with no chat_history match still produce SENT=2 (the live bug)', () => {
  // Exactly the reported live scenario: broadcast_logs says sent/sent, but the
  // chat_history join has nothing for either wa_message_id.
  const recipients = [
    { status: 'sent', wa_message_id: 'wamid.AAA' },
    { status: 'sent', wa_message_id: 'wamid.BBB' },
  ];
  const rollup = computeDeliveryRollup(recipients, {}); // empty chat_history map
  assert.deepEqual(rollup, { total: 2, pending: 0, failed: 0, sent: 2, delivered: 0, read: 0 });
});

test('computeDeliveryRollup: one sent + one delivered (via chat_history) produces correct aggregate', () => {
  const recipients = [
    { status: 'sent', wa_message_id: 'wamid.A' },
    { status: 'sent', wa_message_id: 'wamid.B' },
  ];
  const chatStatusByMessageId = { 'wamid.A': 'sent', 'wamid.B': 'delivered' };
  const rollup = computeDeliveryRollup(recipients, chatStatusByMessageId);
  assert.deepEqual(rollup, { total: 2, pending: 0, failed: 0, sent: 2, delivered: 1, read: 0 });
});

test('computeDeliveryRollup: one delivered + one read produces correct aggregate', () => {
  const recipients = [
    { status: 'sent', wa_message_id: 'wamid.A' },
    { status: 'sent', wa_message_id: 'wamid.B' },
  ];
  const chatStatusByMessageId = { 'wamid.A': 'delivered', 'wamid.B': 'read' };
  const rollup = computeDeliveryRollup(recipients, chatStatusByMessageId);
  assert.deepEqual(rollup, { total: 2, pending: 0, failed: 0, sent: 2, delivered: 2, read: 1 });
});

test('computeDeliveryRollup: both read -> SENT/DELIVERED are 0 exclusive-bucket style is NOT what we want; funnel counts stay cumulative', () => {
  const recipients = [
    { status: 'sent', wa_message_id: 'wamid.A' },
    { status: 'sent', wa_message_id: 'wamid.B' },
  ];
  const chatStatusByMessageId = { 'wamid.A': 'read', 'wamid.B': 'read' };
  const rollup = computeDeliveryRollup(recipients, chatStatusByMessageId);
  // Cumulative funnel semantics (see the doc comment in broadcasts.js): a read
  // message also counts toward sent/delivered.
  assert.deepEqual(rollup, { total: 2, pending: 0, failed: 0, sent: 2, delivered: 2, read: 2 });
});

test('computeDeliveryRollup: a failed recipient increments FAILED, a pending one increments PENDING', () => {
  const recipients = [
    { status: 'failed', wa_message_id: null },
    { status: 'PENDING', wa_message_id: null },
  ];
  const rollup = computeDeliveryRollup(recipients, {});
  assert.deepEqual(rollup, { total: 2, pending: 1, failed: 1, sent: 0, delivered: 0, read: 0 });
});

test('computeDeliveryRollup: zero recipients does not throw or divide by zero', () => {
  const rollup = computeDeliveryRollup([], {});
  assert.deepEqual(rollup, { total: 0, pending: 0, failed: 0, sent: 0, delivered: 0, read: 0 });
});

test('computeDeliveryRollup: handles undefined recipients/map gracefully', () => {
  const rollup = computeDeliveryRollup(undefined, undefined);
  assert.deepEqual(rollup, { total: 0, pending: 0, failed: 0, sent: 0, delivered: 0, read: 0 });
});

test('computeDeliveryRollup: status casing — PENDING (uppercase) and sent/failed (lowercase) are normalized consistently', () => {
  const recipients = [
    { status: 'PENDING', wa_message_id: null },
    { status: 'SENT', wa_message_id: 'wamid.X' }, // defensive: uppercase sent should still count
    { status: 'failed', wa_message_id: null },
  ];
  const rollup = computeDeliveryRollup(recipients, { 'wamid.X': 'READ' });
  assert.deepEqual(rollup, { total: 3, pending: 1, failed: 1, sent: 1, delivered: 1, read: 1 });
});

// ─── getBroadcastWithLogs — end-to-end reproduction of the live bug ────────

function installDb(scenario) {
  async function dispatch(sql, params) {
    if (/FROM coexistence\.broadcasts b\s*\n\s*LEFT JOIN coexistence\.message_templates/.test(sql)) {
      return { rows: scenario.broadcastRow ? [scenario.broadcastRow] : [] };
    }
    if (/recipient_count/.test(sql)) {
      return { rows: [scenario.agg || { recipient_count: 0, sent_at: null, pending_count: 0, failed_count: 0, success_count: 0, errors: null }] };
    }
    if (/action = 'BROADCAST'/.test(sql) && /ORDER BY sent_at DESC NULLS LAST/.test(sql)) {
      return { rows: scenario.recipientRows || [] };
    }
    if (/action = 'TEST'/.test(sql)) {
      return { rows: scenario.testRows || [] };
    }
    // New: per-message chat_history status lookup (replaces the old join)
    if (/FROM coexistence\.chat_history WHERE message_id = ANY/.test(sql)) {
      const ids = params[0] || [];
      const rows = ids
        .filter((id) => scenario.chatHistory && scenario.chatHistory[id])
        .map((id) => ({ message_id: id, status: scenario.chatHistory[id] }));
      return { rows };
    }
    return { rows: [] };
  }
  const originalQuery = pool.query;
  pool.query = dispatch;
  return { restore() { pool.query = originalQuery; } };
}

test('getBroadcastWithLogs: live-bug reproduction — 2 recipients `sent`, no chat_history rows -> statusRollup.sent = 2, not 0', async () => {
  const recipientRows = [
    { id: 1, sent_to: '917708868749', status: 'sent', wa_message_id: 'wamid.LIVE1', error_message: null, sent_at: new Date() },
    { id: 2, sent_to: '916382121634', status: 'sent', wa_message_id: 'wamid.LIVE2', error_message: null, sent_at: new Date() },
  ];
  const db = installDb({
    broadcastRow: { id: 42, status: 'SENDING', workspace_id: 1 },
    agg: { recipient_count: 2, sent_at: new Date(), pending_count: 0, failed_count: 0, success_count: 2, errors: null },
    recipientRows,
    chatHistory: {}, // deliberately empty — reproduces the live mismatch
  });
  try {
    const data = await getBroadcastWithLogs(42, 1);
    assert.equal(data.status, 'SENT');
    assert.deepEqual(data.statusRollup, { total: 2, pending: 0, failed: 0, sent: 2, delivered: 0, read: 0 });
    // The recipient table and the aggregate counters must agree.
    assert.equal(data.recipients.filter((r) => r.status === 'sent').length, data.statusRollup.sent);
  } finally { db.restore(); }
});

test('getBroadcastWithLogs: chat_history confirms delivered/read on top of broadcast_logs sent floor', async () => {
  const recipientRows = [
    { id: 1, sent_to: '+1', status: 'sent', wa_message_id: 'wamid.D1', error_message: null, sent_at: new Date() },
    { id: 2, sent_to: '+2', status: 'sent', wa_message_id: 'wamid.D2', error_message: null, sent_at: new Date() },
  ];
  const db = installDb({
    broadcastRow: { id: 43, status: 'SENDING', workspace_id: 1 },
    agg: { recipient_count: 2, sent_at: new Date(), pending_count: 0, failed_count: 0, success_count: 2, errors: null },
    recipientRows,
    chatHistory: { 'wamid.D1': 'delivered', 'wamid.D2': 'read' },
  });
  try {
    const data = await getBroadcastWithLogs(43, 1);
    assert.deepEqual(data.statusRollup, { total: 2, pending: 0, failed: 0, sent: 2, delivered: 2, read: 1 });
  } finally { db.restore(); }
});

test('getBroadcastWithLogs: aggregate counts always equal recipient-level records (no drift)', async () => {
  const recipientRows = [
    { id: 1, sent_to: '+1', status: 'sent', wa_message_id: 'wamid.1', error_message: null, sent_at: new Date() },
    { id: 2, sent_to: '+2', status: 'failed', wa_message_id: null, error_message: 'boom', sent_at: null },
    { id: 3, sent_to: '+3', status: 'PENDING', wa_message_id: null, error_message: null, sent_at: null },
  ];
  const db = installDb({
    broadcastRow: { id: 44, status: 'SENDING', workspace_id: 1 },
    agg: { recipient_count: 3, sent_at: new Date(), pending_count: 1, failed_count: 1, success_count: 1, errors: ['boom'] },
    recipientRows,
    chatHistory: {},
  });
  try {
    const data = await getBroadcastWithLogs(44, 1);
    assert.equal(data.statusRollup.sent, recipientRows.filter((r) => r.status === 'sent').length);
    assert.equal(data.statusRollup.failed, recipientRows.filter((r) => r.status === 'failed').length);
    assert.equal(data.statusRollup.pending, recipientRows.filter((r) => r.status === 'PENDING').length);
  } finally { db.restore(); }
});

test('getBroadcastWithLogs: zero recipients -> statusRollup is all zeroes, no crash', async () => {
  const db = installDb({
    broadcastRow: { id: 45, status: 'DRAFT', workspace_id: 1 },
    agg: { recipient_count: 0, sent_at: null, pending_count: 0, failed_count: 0, success_count: 0, errors: null },
    recipientRows: [],
    chatHistory: {},
  });
  try {
    const data = await getBroadcastWithLogs(45, 1);
    assert.deepEqual(data.statusRollup, { total: 0, pending: 0, failed: 0, sent: 0, delivered: 0, read: 0 });
  } finally { db.restore(); }
});