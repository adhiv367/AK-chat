'use strict';

// Phase 8F-3 — focused tests for the pilot feature gate on POST /campaigns.
//
// Same DB-stubbing technique as test/entitlementFeature.test.js: stub
// '../src/db' with an in-memory fake before requiring middleware/access.js
// (requirePermission) and entitlementService.js (hasFeature, required
// lazily inside requireFeature). permissions.js is real/unmocked — it's
// pure role->page logic with no DB calls.

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
  1: { status: 'active', plan_key: 'growth', limits: { max_seats: 20, features: { sample_feature_a: true } } },
  2: { status: 'active', plan_key: 'free', limits: { max_seats: 2, features: { sample_feature_a: false } } },
  3: { status: 'active', plan_key: 'starter', limits: { max_seats: 5, features: { sample_feature_a: true } } },
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

// mockRes' json() also signals `onResponded` — needed because a denying
// middleware (e.g. requirePermission rejecting VIEWER) responds directly
// and never calls next(), so the response itself (not a next() call) is
// the only completion signal in that path.
function mockRes(onResponded) {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; if (onResponded) onResponded(); return this; },
  };
}

// Runs the exact two-middleware chain wired onto POST /campaigns:
// requirePermission('campaign-studio') then requireFeature(SAMPLE_FEATURE_A).
async function runCampaignCreateChain(req) {
  let reachedHandler = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const res = mockRes(() => resolveDone());

  requirePermission('campaign-studio')(req, res, async () => {
    await requireFeature(FEATURE_KEYS.SAMPLE_FEATURE_A)(req, res, () => {
      reachedHandler = true;
      resolveDone();
    });
    resolveDone(); // requireFeature responded (denied) without calling next()
  });

  await done;
  return { res, reachedHandler };
}

test('feature enabled on workspace plan → route handler is reached', async () => {
  const req = { user: { id: 10 }, workspace: { id: 1, role: 'MANAGER' } };
  const { res, reachedHandler } = await runCampaignCreateChain(req);
  assert.equal(reachedHandler, true);
  assert.equal(res.statusCode, null);
});

test('feature disabled on workspace plan → blocked with feature_unavailable, handler never reached', async () => {
  const req = { user: { id: 10 }, workspace: { id: 2, role: 'MANAGER' } };
  const { res, reachedHandler } = await runCampaignCreateChain(req);
  assert.equal(reachedHandler, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'feature_unavailable');
});

test('existing role/permission denial still works — VIEWER blocked before the feature gate even runs', async () => {
  // Workspace 1 has the feature enabled, proving VIEWER is denied by
  // requirePermission itself, not incidentally by the feature gate.
  const req = { user: { id: 11 }, workspace: { id: 1, role: 'VIEWER' } };
  const { res, reachedHandler } = await runCampaignCreateChain(req);
  assert.equal(reachedHandler, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'Forbidden'); // requirePermission's own message, not feature_unavailable
});

test('workspace isolation — same user role, two workspaces with different feature state never leak', async () => {
  const reqEnabled = { user: { id: 10 }, workspace: { id: 3, role: 'MANAGER' } };
  const reqDisabled = { user: { id: 10 }, workspace: { id: 2, role: 'MANAGER' } };
  const [a, b] = await Promise.all([
    runCampaignCreateChain(reqEnabled),
    runCampaignCreateChain(reqDisabled),
  ]);
  assert.equal(a.reachedHandler, true);
  assert.equal(b.reachedHandler, false);
  assert.equal(b.res.statusCode, 403);
});

test('requireFeature fails closed when there is no workspace on the request', async () => {
  const req = { user: { id: 10 } }; // no req.workspace
  const res = mockRes();
  let nexted = false;
  await requireFeature(FEATURE_KEYS.SAMPLE_FEATURE_A)(req, res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
});


