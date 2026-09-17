'use strict';

// Phase 8B-5 — focused tests for trial fields on the existing
// GET /workspaces/:id/billing endpoint. No new route/service is added;
// this exercises the field passthrough added to routes/billing.js.
// Same no-real-Postgres mock-pool approach as test/planChangeRequests.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/db');
const { router } = require('../src/routes/billing');

const PLAN = { id: 1, key: 'free', name: 'Free', is_public: true, limits: { max_seats: 2, max_whatsapp_accounts: 1, max_contacts: 250 } };

function makeDb(scenario) {
  async function dispatch(sql, params) {
    // loadMembershipOrPlatformAdmin -> getMembership()
    if (/workspace_members/.test(sql) && /workspace_role/.test(sql)) {
      if (scenario.notMember) return { rows: [] };
      return { rows: [{ id: scenario.workspaceId, name: 'Test WS', slug: 'test-ws', status: 'active', created_at: new Date(), onboarding_completed: true, workspace_role: scenario.membershipRole || 'OWNER' }] };
    }

    // GET billing: getWorkspaceEntitlements / getBillingRow
    if (/FROM coexistence\.workspace_billing wb\s*\n\s*JOIN coexistence\.plans p/.test(sql)) {
      return {
        rows: [{
          status: scenario.status || 'active', plan_id: PLAN.id, current_period_end: null, cancel_at_period_end: false,
          plan_key: PLAN.key, plan_name: PLAN.name, limits: PLAN.limits,
          workspace_id: scenario.workspaceId, provider_customer_id: null, provider_subscription_id: null,
          trial_started_at: scenario.trialStartedAt || null, trial_ends_at: scenario.trialEndsAt || null,
        }],
      };
    }

    // listPublicPlans
    if (/SELECT key, name, limits FROM coexistence\.plans WHERE is_public = true/.test(sql)) {
      return { rows: [{ key: PLAN.key, name: PLAN.name, limits: PLAN.limits }] };
    }

    // countActiveSeats / countWhatsappAccounts / countContacts
    if (/SELECT COUNT\(\*\)::int AS n/.test(sql)) {
      return { rows: [{ n: 0 }] };
    }

    return { rows: [] };
  }
  return { query: dispatch, connect: async () => ({ query: dispatch, release: () => {} }) };
}

function installDb(scenario) {
  const mock = makeDb(scenario);
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  pool.query = mock.query;
  pool.connect = mock.connect;
  return { restore() { pool.query = originalQuery; pool.connect = originalConnect; } };
}

// Minimal Express route-chain runner, same pattern as planChangeRequests.test.js.
function callRoute(routerToUse, method, path, req) {
  const layer = routerToUse.stack.find(l => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      body: undefined,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; resolve(this); return this; },
    };
    let idx = 0;
    function next(err) {
      if (err) return reject(err);
      idx += 1;
      if (idx >= stack.length) return;
      Promise.resolve(stack[idx].handle(req, res, next)).catch(reject);
    }
    Promise.resolve(stack[0].handle(req, res, next)).catch(reject);
  });
}

function makeReq({ userRole = 'OWNER', params = { id: '42' } } = {}) {
  return { user: { id: 1, username: 'kavin', role: userRole }, params, body: {} };
}

// 1. Trial workspace returns trial information.
test('GET billing — trial workspace returns status, trialStartedAt, trialEndsAt', async () => {
  const started = new Date('2026-09-01T00:00:00Z');
  const ends = new Date('2026-09-15T00:00:00Z');
  const db = installDb({ workspaceId: 42, membershipRole: 'OWNER', status: 'trialing', trialStartedAt: started, trialEndsAt: ends });
  try {
    const res = await callRoute(router, 'get', '/workspaces/:id/billing', makeReq({ userRole: 'OWNER', params: { id: '42' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'trialing');
    assert.equal(res.body.trialStartedAt, started);
    assert.equal(res.body.trialEndsAt, ends);
  } finally { db.restore(); }
});

// 2. Non-trial workspace still works, with null trial fields.
test('GET billing — non-trial (active) workspace still works, trial fields null', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'OWNER', status: 'active' });
  try {
    const res = await callRoute(router, 'get', '/workspaces/:id/billing', makeReq({ userRole: 'OWNER', params: { id: '42' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'active');
    assert.equal(res.body.trialStartedAt, null);
    assert.equal(res.body.trialEndsAt, null);
    // Existing billing behavior (plan/usage shape) is unchanged.
    assert.equal(res.body.plan.key, PLAN.key);
    assert.ok(res.body.usage);
  } finally { db.restore(); }
});

// 3. Cross-workspace access is blocked (non-member, non-platform-admin -> 404).
test('GET billing — cross-workspace access is blocked for a non-member', async () => {
  const db = installDb({ workspaceId: 77, notMember: true });
  try {
    const res = await callRoute(router, 'get', '/workspaces/:id/billing', makeReq({ userRole: 'OWNER', params: { id: '77' } }));
    assert.equal(res.statusCode, 404);
  } finally { db.restore(); }
});