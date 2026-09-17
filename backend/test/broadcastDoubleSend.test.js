'use strict';

// Regression tests for Phase 6 Part 3C: sendBroadcastById must not be able
// to execute twice against the same broadcast (double-click, retried POST,
// duplicate campaign Send Now delegation). Before this fix, every call
// unconditionally set status='SENDING' and inserted a fresh PENDING
// broadcast_logs row + enqueued a fresh send for EVERY recipient — including
// ones a prior call had already succeeded. See claimBroadcastForSending in
// src/routes/broadcasts.js.
//
// No real Postgres/Redis is used — pool.connect()/pool.query() are
// monkey-patched, and sendQueue is stubbed, same approach as
// test/broadcastStatus.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

// routes/broadcasts.js pulls in queue/sendQueue.js at require-time.
const sendQueuePath = require.resolve('../src/queue/sendQueue');
let enqueueCalls = [];
require.cache[sendQueuePath] = {
  id: sendQueuePath,
  filename: sendQueuePath,
  loaded: true,
  exports: {
    enqueueSend: async (jobData) => { enqueueCalls.push(jobData); },
    sendQueue: { add: async () => {} },
    startSendWorker: () => {},
    shutdownSendQueue: async () => {},
  },
};

// resolveAccount/insertPendingRow are also required at load time.
const messageSenderPath = require.resolve('../src/services/messageSender');
require.cache[messageSenderPath] = {
  id: messageSenderPath,
  filename: messageSenderPath,
  loaded: true,
  exports: {
    resolveAccount: async () => ({
      account: { id: 1, phoneNumberId: '111', displayPhoneNumber: '15550001111', accessToken: 'tok', isActive: true },
    }),
    insertPendingRow: async () => `local-${Date.now()}-${Math.random()}`,
    markSent: async () => {},
    markFailed: async () => {},
    formatSendError: (e) => String(e && e.message || e),
  },
};

const pool = require('../src/db');
const { sendBroadcastById } = require('../src/routes/broadcasts');

// Minimal fake transactional pool: a single in-memory `broadcasts` row plus
// a running list of every broadcast_logs INSERT, so tests can assert exactly
// how many recipient rows/enqueues a given call produced.
function installDb({ broadcastRow }) {
  const broadcastLogInserts = [];
  let currentStatus = broadcastRow.status;

  async function dispatch(sql, params) {
    if (/SELECT status FROM coexistence\.broadcasts.*FOR UPDATE/is.test(sql)) {
      return { rows: [{ status: currentStatus }] };
    }
    if (/UPDATE coexistence\.broadcasts SET status = 'SENDING'/i.test(sql)) {
      currentStatus = 'SENDING';
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT b\.\*.*FROM coexistence\.broadcasts b/is.test(sql)) {
      return { rows: [{ ...broadcastRow, status: currentStatus, t_id: null }] };
    }
    if (/INSERT INTO coexistence\.broadcast_logs/i.test(sql) && /BROADCAST/.test(sql)) {
      const id = broadcastLogInserts.length + 1;
      broadcastLogInserts.push({ id, params });
      return { rows: [{ id }] };
    }
    if (/UPDATE coexistence\.broadcast_logs/i.test(sql)) {
      return { rows: [], rowCount: 1 };
    }
    // getBroadcastWithLogs' various aggregate/recipient/rollup SELECTs
    if (/FROM coexistence\.broadcast_logs/i.test(sql)) {
      return { rows: [] };
    }
    return { rows: [], rowCount: 0 };
  }

  pool.connect = async () => ({
    query: async (sql, params) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
      return dispatch(sql, params);
    },
    release: () => {},
  });
  pool.query = async (sql, params) => dispatch(sql, params);

  return { broadcastLogInserts, getStatus: () => currentStatus };
}

test.beforeEach(() => { enqueueCalls = []; });

test('a DRAFT broadcast can be sent: claims the row, enqueues every recipient once', async () => {
  const db = installDb({
    broadcastRow: {
      id: 501, workspace_id: 1, status: 'DRAFT', from_number: '15550001111',
      recipient_numbers: [{ contact_number: '919000000001', name: 'A' }, { contact_number: '919000000002', name: 'B' }],
      message_type: 'text', body: 'hello {{contact.name}}',
    },
  });

  const { statusCode, body } = await sendBroadcastById(1, 501);

  assert.equal(statusCode, 200);
  assert.equal(body.enqueued, 2);
  assert.equal(db.broadcastLogInserts.length, 2);
  assert.equal(enqueueCalls.length, 2);
  assert.equal(db.getStatus(), 'SENDING');
});

test('a second sendBroadcastById call on the same (now SENDING) broadcast is rejected and resends nothing', async () => {
  const db = installDb({
    broadcastRow: {
      id: 502, workspace_id: 1, status: 'DRAFT', from_number: '15550001111',
      recipient_numbers: [{ contact_number: '919000000003', name: 'C' }],
      message_type: 'text', body: 'hi',
    },
  });

  const first = await sendBroadcastById(1, 502);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.enqueued, 1);
  assert.equal(db.broadcastLogInserts.length, 1);
  assert.equal(enqueueCalls.length, 1);

  // Simulate a double-click / retried POST — same broadcastId, no new recipients.
  const second = await sendBroadcastById(1, 502);

  assert.equal(second.statusCode, 200);
  assert.equal(second.body.alreadySent, true);
  assert.equal(second.body.enqueued, 0);
  // Crucially: no NEW broadcast_logs rows or Meta sends were created for the
  // already-claimed broadcast — the single recipient from the first call is
  // never resent.
  assert.equal(db.broadcastLogInserts.length, 1);
  assert.equal(enqueueCalls.length, 1);
});

test('a broadcast already in SENDING status (e.g. picked up by the scheduler) rejects a concurrent manual send', async () => {
  const db = installDb({
    broadcastRow: {
      id: 503, workspace_id: 1, status: 'SENDING', from_number: '15550001111',
      recipient_numbers: [{ contact_number: '919000000004', name: 'D' }],
      message_type: 'text', body: 'hi',
    },
  });

  const { statusCode, body } = await sendBroadcastById(1, 503);

  assert.equal(statusCode, 200);
  assert.equal(body.alreadySent, true);
  assert.equal(db.broadcastLogInserts.length, 0);
  assert.equal(enqueueCalls.length, 0);
});

test('a not-found broadcast returns 404 without touching any recipients', async () => {
  const db = installDb({
    broadcastRow: { id: 504, workspace_id: 1, status: 'DRAFT', from_number: '15550001111', recipient_numbers: [], message_type: 'text', body: '' },
  });
  // Force the initial broadcast lookup to return nothing, simulating a
  // missing/foreign-workspace row — sendBroadcastById 404s before the claim
  // step even runs in this case.
  pool.query = async () => ({ rows: [] });
  pool.connect = async () => ({
    query: async (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
      return { rows: [] };
    },
    release: () => {},
  });

  const { statusCode, body } = await sendBroadcastById(1, 999);
  assert.equal(statusCode, 404);
  assert.ok(body.error);
  assert.equal(enqueueCalls.length, 0);
  void db;
});

