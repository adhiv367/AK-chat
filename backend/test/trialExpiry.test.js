'use strict';

// Phase 8B-3 — focused trial expiry logic test only.
// No real Postgres: pool.query is monkey-patched on the shared '../src/db'
// singleton, same approach as test/trialStatusLogic.test.js.
//
// Asserts:
//   1. Active trial (trial_ends_at in the future) -> still 'trialing',
//      allowed, no UPDATE issued.
//   2. Expired trial (trial_ends_at in the past) -> checkLimit() reports
//      'suspended' and blocks, AND an UPDATE ... SET status='suspended'
//      scoped to that workspace was issued.
//   3. Trialing with NULL trial_ends_at -> never expires, stays 'trialing',
//      allowed, no UPDATE issued.
//   4. suspended/cancelled/active/past_due behavior unchanged (no
//      trial_ends_at handling touches them; no UPDATE issued for them).
//   5. Workspace isolation: the expiry UPDATE is scoped to the exact
//      workspace_id passed in, never a different one.

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/db');
const { checkLimit, LIMIT_TYPES } = require('../src/services/entitlementService');

function mockDb({ status, trialEndsAt, limits, currentSeats }, updateLog) {
  pool.query = async (sql, params) => {
    if (/UPDATE coexistence\.workspace_billing/.test(sql)) {
      updateLog.push({ sql, params });
      return { rows: [] };
    }
    if (/FROM coexistence\.workspace_billing/.test(sql)) {
      return {
        rows: [{
          status, plan_id: 1, current_period_end: null, cancel_at_period_end: false,
          trial_ends_at: trialEndsAt,
          plan_key: 'starter', plan_name: 'Starter', limits,
        }],
      };
    }
    if (/FROM coexistence\.workspace_members/.test(sql) && /COUNT/i.test(sql)) {
      return { rows: [{ n: currentSeats }] };
    }
    return { rows: [] };
  };
}

const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 24 * 60 * 60 * 1000);
const LIMITS = { max_seats: 5 };

test('Phase 8B-3: active trial before expiry stays trialing, no expiry write', async () => {
  const originalQuery = pool.query;
  try {
    const updateLog = [];
    mockDb({ status: 'trialing', trialEndsAt: FUTURE, limits: LIMITS, currentSeats: 2 }, updateLog);
    const result = await checkLimit(42, LIMIT_TYPES.SEATS);
    assert.equal(result.allowed, true);
    assert.equal(result.status, 'trialing');
    assert.equal(updateLog.length, 0, 'no expiry UPDATE should run before trial_ends_at');
  } finally {
    pool.query = originalQuery;
  }
});

test('Phase 8B-3: expired trial moves to suspended and is blocked', async () => {
  const originalQuery = pool.query;
  try {
    const updateLog = [];
    mockDb({ status: 'trialing', trialEndsAt: PAST, limits: LIMITS, currentSeats: 2 }, updateLog);
    const result = await checkLimit(42, LIMIT_TYPES.SEATS);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'billing_status_blocked');
    assert.equal(result.status, 'suspended');

    assert.equal(updateLog.length, 1, 'expected exactly one expiry UPDATE');
    assert.match(updateLog[0].sql, /SET status = 'suspended'/);
    assert.match(updateLog[0].sql, /WHERE workspace_id = \$1 AND status = 'trialing'/);
  } finally {
    pool.query = originalQuery;
  }
});

test('Phase 8B-3: trialing with NULL trial_ends_at never expires', async () => {
  const originalQuery = pool.query;
  try {
    const updateLog = [];
    mockDb({ status: 'trialing', trialEndsAt: null, limits: LIMITS, currentSeats: 2 }, updateLog);
    const result = await checkLimit(42, LIMIT_TYPES.SEATS);
    assert.equal(result.allowed, true);
    assert.equal(result.status, 'trialing');
    assert.equal(updateLog.length, 0, 'NULL trial_ends_at must never trigger expiry');
  } finally {
    pool.query = originalQuery;
  }
});

test('Phase 8B-3: existing active/past_due/suspended/cancelled behavior unchanged', async () => {
  const originalQuery = pool.query;
  try {
    for (const status of ['active', 'past_due', 'suspended', 'cancelled']) {
      const updateLog = [];
      mockDb({ status, trialEndsAt: null, limits: LIMITS, currentSeats: 2 }, updateLog);
      const result = await checkLimit(42, LIMIT_TYPES.SEATS);
      assert.equal(updateLog.length, 0, `no expiry UPDATE should ever run for status=${status}`);
      if (status === 'suspended' || status === 'cancelled') {
        assert.equal(result.allowed, false);
        assert.equal(result.reason, 'billing_status_blocked');
      } else {
        assert.equal(result.allowed, true);
      }
      assert.equal(result.status, status);
    }
  } finally {
    pool.query = originalQuery;
  }
});

test('Phase 8B-3: expiry UPDATE is scoped to the exact workspace passed in', async () => {
  const originalQuery = pool.query;
  try {
    const updateLog = [];
    mockDb({ status: 'trialing', trialEndsAt: PAST, limits: LIMITS, currentSeats: 0 }, updateLog);
    await checkLimit(777, LIMIT_TYPES.SEATS);
    assert.equal(updateLog.length, 1);
    assert.deepEqual(updateLog[0].params, [777], 'expiry UPDATE must be parameterized to only the requested workspace');
  } finally {
    pool.query = originalQuery;
  }
});


