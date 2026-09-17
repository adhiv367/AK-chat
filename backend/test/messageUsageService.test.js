'use strict';

// Phase 8A — Message Usage Metering: messageUsageService.js unit tests.
//
// src/db.js builds a real pg Pool at require-time (module.exports = pool),
// so unlike entitlementService.js's pure-helper tests, this file must stub
// '../src/db' before requiring messageUsageService.js — otherwise `pool`
// would be a real (lazily-connecting) Pool and any .query() call here would
// hang/fail with no DB available in this test environment. Same
// require.cache stubbing technique already used by
// test/sendQueueRetryConfig.test.js for bullmq/ioredis/etc.

const test = require('node:test');
const assert = require('node:assert/strict');

function stubModule(name, exports) {
  const resolved = require.resolve(name);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// In-memory stand-in for coexistence.workspace_message_usage, keyed exactly
// like the real UNIQUE(workspace_id, period_start) constraint. Simulates
// only the two query shapes messageUsageService.js actually issues:
// the INSERT ... ON CONFLICT DO UPDATE upsert, and the plain SELECT.
const table = new Map();
const queries = [];

function key(workspaceId, periodStart) {
  return `${workspaceId}::${periodStart}`;
}

const fakePool = {
  async query(sql, params) {
    queries.push({ sql, params });
    const normalized = sql.replace(/\s+/g, ' ').trim();

    if (normalized.startsWith('INSERT INTO coexistence.workspace_message_usage')) {
      const [workspaceId, periodStart] = params;
      const k = key(workspaceId, periodStart);
      const current = table.get(k) || 0;
      const next = current + 1;
      table.set(k, next);
      return { rows: [{ message_count: String(next) }] }; // BIGINT -> string, like real pg
    }

    if (normalized.startsWith('SELECT message_count FROM coexistence.workspace_message_usage')) {
      const [workspaceId, periodStart] = params;
      const k = key(workspaceId, periodStart);
      const count = table.get(k);
      return { rows: count == null ? [] : [{ message_count: String(count) }] };
    }

    throw new Error(`fakePool: unexpected query: ${normalized}`);
  },
};

stubModule('../src/db', fakePool);

const {
  incrementMessageUsage,
  countMessagesThisMonth,
  currentUtcPeriodStart,
} = require('../src/services/messageUsageService');

test.beforeEach(() => {
  table.clear();
  queries.length = 0;
});

test('currentUtcPeriodStart returns the first day of the current UTC month as YYYY-MM-DD', () => {
  const now = new Date();
  const expected = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  assert.equal(currentUtcPeriodStart(), expected);
});

test('countMessagesThisMonth returns 0 for a workspace with no usage row yet (never null/undefined)', async () => {
  const count = await countMessagesThisMonth(42);
  assert.equal(count, 0);
});

test('incrementMessageUsage creates a row on first use and returns the new count', async () => {
  const result = await incrementMessageUsage(42);
  assert.equal(result, 1);
  assert.equal(await countMessagesThisMonth(42), 1);
});

test('incrementMessageUsage atomically increments an existing row (ON CONFLICT DO UPDATE)', async () => {
  await incrementMessageUsage(42);
  await incrementMessageUsage(42);
  const third = await incrementMessageUsage(42);
  assert.equal(third, 3);
  assert.equal(await countMessagesThisMonth(42), 3);
});

test('workspace isolation: incrementing one workspace never affects another workspace\'s count', async () => {
  await incrementMessageUsage(1);
  await incrementMessageUsage(1);
  await incrementMessageUsage(2);

  assert.equal(await countMessagesThisMonth(1), 2);
  assert.equal(await countMessagesThisMonth(2), 1);
});

test('incrementMessageUsage / countMessagesThisMonth are scoped to the current UTC calendar month bucket', async () => {
  await incrementMessageUsage(7);
  const period = currentUtcPeriodStart();
  const insertCall = queries.find(q => q.sql.replace(/\s+/g, ' ').trim().startsWith('INSERT INTO coexistence.workspace_message_usage'));
  assert.equal(insertCall.params[1], period);
});

test('incrementMessageUsage returns null and does not throw when workspaceId is missing', async () => {
  const result = await incrementMessageUsage(null);
  assert.equal(result, null);
});

test('countMessagesThisMonth returns 0 (not null) when workspaceId is missing', async () => {
  const result = await countMessagesThisMonth(undefined);
  assert.equal(result, 0);
});

test('incrementMessageUsage never throws even if the underlying query fails (must never break the send path)', async () => {
  const resolved = require.resolve('../src/db');
  const original = require.cache[resolved].exports;
  require.cache[resolved].exports = {
    async query() { throw new Error('simulated DB outage'); },
  };
  try {
    // Re-require to pick up the swapped pool — Node caches the destructured
    // reference to `pool` inside messageUsageService.js's closure, so we
    // must bust its own cache entry too and re-require the service.
    const serviceResolved = require.resolve('../src/services/messageUsageService');
    delete require.cache[serviceResolved];
    const { incrementMessageUsage: incrementWithBrokenPool } = require('../src/services/messageUsageService');
    const result = await incrementWithBrokenPool(99);
    assert.equal(result, null); // swallowed, not thrown
  } finally {
    require.cache[resolved].exports = original;
    const serviceResolved = require.resolve('../src/services/messageUsageService');
    delete require.cache[serviceResolved];
  }
});