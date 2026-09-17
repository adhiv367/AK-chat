'use strict';

// Phase 8B-2 — focused trial-status logic test only.
// No real Postgres: pool.query is monkey-patched on the shared '../src/db'
// singleton, same approach as test/usersSeatLimit.test.js /
// test/planChangeRequests.test.js.
//
// Asserts:
//   1. entitlementService.checkLimit() treats 'trialing' exactly like
//      'active' (allowed, not billing_status_blocked), for both an
//      under-limit and an at/over-limit workspace.
//   2. 'suspended' / 'cancelled' are still blocked (unchanged).
//   3. 'past_due' still allowed but not specially favored (unchanged).
//   4. billingService.applyBillingEvent() accepts 'trialing' as a valid
//      webhook status (previously would throw) and resets
//      cancel_at_period_end like 'active' does.
//   5. billingService.applyBillingEvent() still rejects a bogus status.

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/db');
const { checkLimit, LIMIT_TYPES } = require('../src/services/entitlementService');
const { applyBillingEvent } = require('../src/services/billingService');

function mockEntitlementDb({ status, limits, currentSeats }) {
  pool.query = async (sql) => {
    if (/FROM coexistence\.workspace_billing/.test(sql)) {
      return {
        rows: [{
          status, plan_id: 1, current_period_end: null, cancel_at_period_end: false,
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

test('Phase 8B-2: trialing behaves like active for entitlement checks', async () => {
  const originalQuery = pool.query;
  try {
    // Under limit: trialing allowed, same as active
    mockEntitlementDb({ status: 'trialing', limits: { max_seats: 5 }, currentSeats: 2 });
    let result = await checkLimit(1, LIMIT_TYPES.SEATS);
    assert.equal(result.allowed, true);
    assert.notEqual(result.reason, 'billing_status_blocked');

    mockEntitlementDb({ status: 'active', limits: { max_seats: 5 }, currentSeats: 2 });
    let activeResult = await checkLimit(1, LIMIT_TYPES.SEATS);
    assert.equal(activeResult.allowed, result.allowed);

    // At limit: trialing denied by numeric cap, same as active (not by status)
    mockEntitlementDb({ status: 'trialing', limits: { max_seats: 5 }, currentSeats: 5 });
    result = await checkLimit(1, LIMIT_TYPES.SEATS);
    assert.equal(result.allowed, false);
    assert.notEqual(result.reason, 'billing_status_blocked');

    // suspended / cancelled: still blocked outright (unchanged)
    for (const blockedStatus of ['suspended', 'cancelled']) {
      mockEntitlementDb({ status: blockedStatus, limits: { max_seats: 5 }, currentSeats: 0 });
      result = await checkLimit(1, LIMIT_TYPES.SEATS);
      assert.equal(result.allowed, false);
      assert.equal(result.reason, 'billing_status_blocked');
    }

    // past_due: still allowed, unchanged
    mockEntitlementDb({ status: 'past_due', limits: { max_seats: 5 }, currentSeats: 2 });
    result = await checkLimit(1, LIMIT_TYPES.SEATS);
    assert.equal(result.allowed, true);
    assert.notEqual(result.reason, 'billing_status_blocked');
  } finally {
    pool.query = originalQuery;
  }
});

test('Phase 8B-2: billingService.applyBillingEvent accepts trialing status', async () => {
  const originalQuery = pool.query;
  try {
    let updateSql = null;
    let updateParams = null;
    const fakeClient = {
      query: async (sql, params) => {
        if (/UPDATE coexistence\.workspace_billing/.test(sql)) {
          updateSql = sql;
          updateParams = params;
          return { rows: [{ id: 1, status: 'trialing' }] };
        }
        return { rows: [] };
      },
    };

    const row = await applyBillingEvent(fakeClient, { workspaceId: 1, status: 'trialing' });
    assert.ok(row);
    assert.match(updateSql, /cancel_at_period_end = false/);
    assert.ok(updateParams.includes('trialing'));

    // Bogus status still rejected
    await assert.rejects(
      () => applyBillingEvent(fakeClient, { workspaceId: 1, status: 'not_a_real_status' }),
      /Invalid billing status from webhook/
    );
  } finally {
    pool.query = originalQuery;
  }
});
