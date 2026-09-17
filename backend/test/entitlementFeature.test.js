'use strict';

// Phase 8F-2 — focused tests for entitlementService.hasFeature().
//
// src/db.js builds a real pg Pool at require-time, so (same technique as
// test/messageUsageService.test.js) we stub '../src/db' with an in-memory
// fake BEFORE requiring entitlementService.js, rather than touching a real
// database. This file only exercises the new hasFeature() mechanism — it
// does not re-run the existing checkLimit()/limitExceededResponse suite in
// test/entitlementService.test.js, per the "focused tests, no full suite"
// instruction.

const test = require('node:test');
const assert = require('node:assert/strict');

function stubModule(name, exports) {
  const resolved = require.resolve(name);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// workspaceId -> { status, plan_key, plan_name, limits }
const WORKSPACES = {
  1: { status: 'active', plan_key: 'growth', plan_name: 'Growth', limits: { max_seats: 20, features: { sample_feature_a: true } } },
  2: { status: 'active', plan_key: 'free', plan_name: 'Free', limits: { max_seats: 2, features: { sample_feature_a: false } } },
  3: { status: 'active', plan_key: 'starter', plan_name: 'Starter', limits: { max_seats: 5 } }, // no `features` key at all
};

const fakePool = {
  async query(sql, params) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('SELECT wb.status')) {
      const [workspaceId] = params;
      const ws = WORKSPACES[workspaceId];
      if (!ws) return { rows: [] };
      return {
        rows: [{
          status: ws.status,
          plan_id: workspaceId,
          current_period_end: null,
          cancel_at_period_end: false,
          trial_ends_at: null,
          plan_key: ws.plan_key,
          plan_name: ws.plan_name,
          limits: ws.limits,
        }],
      };
    }
    throw new Error(`Unexpected query in fakePool: ${normalized}`);
  },
};

stubModule('../src/db', fakePool);

const { hasFeature, FEATURE_KEYS } = require('../src/services/entitlementService');

test('hasFeature: returns true when the workspace plan explicitly enables the feature', async () => {
  const result = await hasFeature(1, FEATURE_KEYS.SAMPLE_FEATURE_A);
  assert.equal(result, true);
});

test('hasFeature: returns false when the workspace plan explicitly disables the feature', async () => {
  const result = await hasFeature(2, FEATURE_KEYS.SAMPLE_FEATURE_A);
  assert.equal(result, false);
});

test('hasFeature: returns false for an unknown feature key (not present in plan.limits.features)', async () => {
  const result = await hasFeature(1, 'totally_unknown_feature');
  assert.equal(result, false);
});

test('hasFeature: returns false when the plan has no `features` object at all (no throw)', async () => {
  const result = await hasFeature(3, FEATURE_KEYS.SAMPLE_FEATURE_A);
  assert.equal(result, false);
});

test('hasFeature: workspace isolation — workspace 1 (enabled) and workspace 2 (disabled) never leak into each other', async () => {
  const [ws1, ws2] = await Promise.all([
    hasFeature(1, FEATURE_KEYS.SAMPLE_FEATURE_A),
    hasFeature(2, FEATURE_KEYS.SAMPLE_FEATURE_A),
  ]);
  assert.equal(ws1, true);
  assert.equal(ws2, false);
});

test('hasFeature: unresolvable workspace (no billing row) fails closed to false, not true', async () => {
  const result = await hasFeature(999, FEATURE_KEYS.SAMPLE_FEATURE_A);
  assert.equal(result, false);
});

test('hasFeature: missing workspaceId or featureKey fails closed to false', async () => {
  assert.equal(await hasFeature(null, FEATURE_KEYS.SAMPLE_FEATURE_A), false);
  assert.equal(await hasFeature(1, null), false);
});

// Existing numeric limits (max_seats etc.) must be completely unaffected by
// the new `features` sub-object living alongside them in the same JSONB.
test('existing numeric limits are preserved and unaffected by `features`', async () => {
  const { getWorkspaceEntitlements } = require('../src/services/entitlementService');
  const ent1 = await getWorkspaceEntitlements(1);
  assert.equal(ent1.limits.max_seats, 20);
  assert.equal(ent1.planKey, 'growth');

  const ent3 = await getWorkspaceEntitlements(3);
  assert.equal(ent3.limits.max_seats, 5);
  assert.equal(ent3.limits.features, undefined);
});