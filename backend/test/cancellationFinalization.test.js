'use strict';

// Phase 8E-2 — focused tests for lazy manual-cancellation finalization.
// Mocks pool.query (same no-live-Postgres approach as
// test/invoiceService.test.js / test/trialSchema.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/db');

function withMockedPool(dispatch, fn) {
  const originalQuery = pool.query;
  pool.query = dispatch;
  return fn().finally(() => {
    pool.query = originalQuery;
  });
}

const past = new Date(Date.now() - 60 * 1000).toISOString();
const future = new Date(Date.now() + 60 * 1000).toISOString();

function billingRow(overrides = {}) {
  return {
    status: 'active',
    plan_id: 1,
    current_period_end: past,
    cancel_at_period_end: true,
    trial_ends_at: null,
    plan_key: 'starter',
    plan_name: 'Starter',
    limits: {},
    ...overrides,
  };
}

test('active subscription past period end → cancelled', async () => {
  let updateRan = false;
  await withMockedPool(async (sql, params) => {
    if (/SELECT wb\.status/.test(sql)) {
      return { rows: [billingRow()] };
    }
    if (/SET status = 'cancelled'/.test(sql)) {
      updateRan = true;
      assert.deepEqual(params, [42]);
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  }, async () => {
    const { getWorkspaceEntitlements } = require('../src/services/entitlementService');
    const ent = await getWorkspaceEntitlements(42);
    assert.equal(ent.status, 'cancelled');
  });
  assert.equal(updateRan, true);
});

test('trialing past period end → cancelled (not suspended by trial-expiry branch)', async () => {
  let updateRan = false;
  await withMockedPool(async (sql, params) => {
    if (/SELECT wb\.status/.test(sql)) {
      // trial_ends_at is null/future, so the trial-expiry branch does not
      // fire; cancellation finalization is what should move this workspace.
      return { rows: [billingRow({ status: 'trialing', trial_ends_at: future })] };
    }
    if (/SET status = 'cancelled'/.test(sql)) {
      updateRan = true;
      assert.deepEqual(params, [42]);
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  }, async () => {
    const { getWorkspaceEntitlements } = require('../src/services/entitlementService');
    const ent = await getWorkspaceEntitlements(42);
    assert.equal(ent.status, 'cancelled');
  });
  assert.equal(updateRan, true);
});

test('before period end → unchanged', async () => {
  await withMockedPool(async (sql) => {
    if (/SELECT wb\.status/.test(sql)) {
      return { rows: [billingRow({ current_period_end: future })] };
    }
    if (/SET status = 'cancelled'/.test(sql)) {
      throw new Error('finalize UPDATE must not run before current_period_end');
    }
    throw new Error(`unexpected query: ${sql}`);
  }, async () => {
    const { getWorkspaceEntitlements } = require('../src/services/entitlementService');
    const ent = await getWorkspaceEntitlements(42);
    assert.equal(ent.status, 'active');
  });
});

test('cancel_at_period_end=false → unchanged', async () => {
  await withMockedPool(async (sql) => {
    if (/SELECT wb\.status/.test(sql)) {
      return { rows: [billingRow({ cancel_at_period_end: false })] };
    }
    if (/SET status = 'cancelled'/.test(sql)) {
      throw new Error('finalize UPDATE must not run when no cancellation was requested');
    }
    throw new Error(`unexpected query: ${sql}`);
  }, async () => {
    const { getWorkspaceEntitlements } = require('../src/services/entitlementService');
    const ent = await getWorkspaceEntitlements(42);
    assert.equal(ent.status, 'active');
  });
});

test('NULL current_period_end → unchanged', async () => {
  await withMockedPool(async (sql) => {
    if (/SELECT wb\.status/.test(sql)) {
      return { rows: [billingRow({ current_period_end: null })] };
    }
    if (/SET status = 'cancelled'/.test(sql)) {
      throw new Error('finalize UPDATE must not run with a NULL current_period_end');
    }
    throw new Error(`unexpected query: ${sql}`);
  }, async () => {
    const { getWorkspaceEntitlements } = require('../src/services/entitlementService');
    const ent = await getWorkspaceEntitlements(42);
    assert.equal(ent.status, 'active');
  });
});

test('suspended/cancelled/past_due → unchanged (finalize UPDATE never called)', async () => {
  for (const status of ['suspended', 'cancelled', 'past_due']) {
    await withMockedPool(async (sql) => {
      if (/SELECT wb\.status/.test(sql)) {
        return { rows: [billingRow({ status })] };
      }
      if (/SET status = 'cancelled'/.test(sql)) {
        throw new Error(`finalize UPDATE must not run for status=${status}`);
      }
      throw new Error(`unexpected query: ${sql}`);
    }, async () => {
      const { getWorkspaceEntitlements } = require('../src/services/entitlementService');
      const ent = await getWorkspaceEntitlements(42);
      assert.equal(ent.status, status);
    });
  }
});

test('workspace isolation: finalize UPDATE is scoped to the calling workspace_id only', async () => {
  await withMockedPool(async (sql, params) => {
    if (/SELECT wb\.status/.test(sql)) {
      assert.deepEqual(params, [99]);
      return { rows: [billingRow()] };
    }
    if (/SET status = 'cancelled'/.test(sql)) {
      assert.match(sql, /WHERE workspace_id = \$1/);
      assert.deepEqual(params, [99]);
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  }, async () => {
    const { getWorkspaceEntitlements } = require('../src/services/entitlementService');
    const ent = await getWorkspaceEntitlements(99);
    assert.equal(ent.status, 'cancelled');
  });
});

test('concurrent/idempotent finalization: a second call is a harmless no-op', async () => {
  const { finalizeCancellationIfNeeded } = require('../src/services/entitlementService');

  // First call: DB row still matches the WHERE clause (status IN
  // ('active','trialing')) — row transitions.
  let calls = 0;
  await withMockedPool(async (sql, params) => {
    calls += 1;
    assert.match(sql, /SET status = 'cancelled'/);
    assert.match(sql, /WHERE workspace_id = \$1/);
    assert.match(sql, /AND status IN \('active', 'trialing'\)/);
    assert.deepEqual(params, [7]);
    return { rows: [] }; // UPDATE affects 0-or-more rows; caller doesn't branch on rowCount
  }, async () => {
    const status = await finalizeCancellationIfNeeded(7);
    assert.equal(status, 'cancelled');
  });
  assert.equal(calls, 1);

  // Second (racing/duplicate) call: the WHERE clause is the sole guard — a
  // real DB would match 0 rows this time since status is no longer
  // active/trialing. The query shape/params are identical either way,
  // proving the operation is safe to re-issue.
  await withMockedPool(async (sql, params) => {
    assert.match(sql, /SET status = 'cancelled'/);
    assert.deepEqual(params, [7]);
    return { rows: [] };
  }, async () => {
    const status = await finalizeCancellationIfNeeded(7);
    assert.equal(status, 'cancelled');
  });
});




