'use strict';

// Phase 8F-6 — focused tests for the Sequence Studio plan-feature gate.
//
// Mirrors the Phase 8F-3 campaignFeatureGate.test.js pattern: stub '../src/db'
// with an in-memory fake before requiring middleware/access.js
// (requirePermission) and entitlementService.js (hasFeature, required
// lazily inside requireFeature). permissions.js is real/unmocked.

const test = require('node:test');
const assert = require('node:assert/strict');

function stubModule(name, exports) {
  const resolved = require.resolve(name);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// userId -> akchat_users row (for requirePermission)
const USERS = {
  10: { role: 'MANAGER', permissions: null },
  11: { role: 'VIEWER', permissions: null },
};

// workspaceId -> billing/plan row (for hasFeature via entitlementService)
const WORKSPACES = {
  1: { status: 'active', plan_key: 'growth', limits: { max_seats: 20, features: { sequence_studio: true } } },
  2: { status: 'active', plan_key: 'free', limits: { max_seats: 2, features: { sequence_studio: false } } },
  3: { status: 'active', plan_key: 'starter', limits: { max_seats: 5, features: { sequence_studio: true } } },
};

const fakePool = {
  async query(sql, params) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('SELECT role, permissions FROM coexistence.akchat_users')) {
      const [userId] = params;
      const u = USERS[userId];
      return { rows: u ? [u] : [] };
    }
    if (normalized.startsWith('SELECT wb.status')) {
      const [workspaceId] = params;
      const ws = WORKSPACES[workspaceId];
      if (!ws) return { rows: [] };
      return {
        rows: [{
          status: ws.status, plan_id: workspaceId, current_period_end: null,
          cancel_at_period_end: false, trial_ends_at: null,
          plan_key: ws.plan_key, plan_name: ws.plan_key, limits: ws.limits,
        }],
      };
    }
    throw new Error(`Unexpected query in fakePool: ${normalized}`);
  },
};

stubModule('../src/db', fakePool);

const { requirePermission, requireFeature } = require('../src/middleware/access');
const { FEATURE_KEYS } = require('../src/services/entitlementService');

function mockRes(onResponded) {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; if (onResponded) onResponded(); return this; },
  };
}

// Runs the exact two-middleware chain now wired onto every Sequence Studio
// route: requirePermission('sequence-studio') then requireFeature(SEQUENCE_STUDIO).
async function runSequenceStudioChain(req) {
  let reachedHandler = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const res = mockRes(() => resolveDone());

  requirePermission('sequence-studio')(req, res, async () => {
    await requireFeature(FEATURE_KEYS.SEQUENCE_STUDIO)(req, res, () => {
      reachedHandler = true;
      resolveDone();
    });
    resolveDone(); // requireFeature responded (denied) without calling next()
  });

  await done;
  return { res, reachedHandler };
}

test('feature enabled on workspace plan → Sequence Studio route handler is reached', async () => {
  const req = { user: { id: 10 }, workspace: { id: 1, role: 'MANAGER' } };
  const { res, reachedHandler } = await runSequenceStudioChain(req);
  assert.equal(reachedHandler, true);
  assert.equal(res.statusCode, null);
});

test('feature disabled on workspace plan → blocked with feature_unavailable, handler never reached', async () => {
  const req = { user: { id: 10 }, workspace: { id: 2, role: 'MANAGER' } };
  const { res, reachedHandler } = await runSequenceStudioChain(req);
  assert.equal(reachedHandler, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'feature_unavailable');
});

test('existing sequence-studio permission denial still works — VIEWER blocked before the feature gate even runs', async () => {
  // Workspace 1 has the feature enabled, proving VIEWER is denied by
  // requirePermission itself, not incidentally by the feature gate.
  const req = { user: { id: 11 }, workspace: { id: 1, role: 'VIEWER' } };
  const { res, reachedHandler } = await runSequenceStudioChain(req);
  assert.equal(reachedHandler, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'Forbidden'); // requirePermission's own message, not feature_unavailable
});

test('workspace isolation — same user role, two workspaces with different feature state never leak', async () => {
  const reqEnabled = { user: { id: 10 }, workspace: { id: 3, role: 'MANAGER' } };
  const reqDisabled = { user: { id: 10 }, workspace: { id: 2, role: 'MANAGER' } };
  const [a, b] = await Promise.all([
    runSequenceStudioChain(reqEnabled),
    runSequenceStudioChain(reqDisabled),
  ]);
  assert.equal(a.reachedHandler, true);
  assert.equal(b.reachedHandler, false);
  assert.equal(b.res.statusCode, 403);
});

test('requireFeature fails closed when there is no workspace on the request', async () => {
  const req = { user: { id: 10 } }; // no req.workspace
  const res = mockRes();
  let nexted = false;
  await requireFeature(FEATURE_KEYS.SEQUENCE_STUDIO)(req, res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
});