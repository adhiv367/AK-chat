'use strict';

// Phase 8G-2 — focused tests for read-only WhatsApp message usage display
// on the existing GET /workspaces/:id/billing endpoint. No new route/service
// is added; this exercises the usage.messages field added to
// routes/billing.js, which reuses messageUsageService.countMessagesThisMonth()
// exactly as entitlementService's other USAGE_COUNTERS entries are reused.
// Same no-real-Postgres mock-pool approach as test/billingTrialStatus.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/db');
const { router } = require('../src/routes/billing');

const PLAN_WITH_QUOTA = {
  id: 1, key: 'pro', name: 'Pro', is_public: true,
  limits: { max_seats: 5, max_whatsapp_accounts: 3, max_contacts: 5000, monthly_message_quota: 1000 },
};
const PLAN_UNLIMITED = {
  id: 2, key: 'legacy_unlimited', name: 'Legacy Unlimited', is_public: false,
  limits: { max_seats: null, max_whatsapp_accounts: null, max_contacts: null }, // monthly_message_quota absent
};

function makeDb(scenario) {
  async function dispatch(sql, params) {
    // loadMembershipOrPlatformAdmin -> getMembership()
    if (/workspace_members/.test(sql) && /workspace_role/.test(sql)) {
      if (scenario.notMember) return { rows: [] };
      return { rows: [{ id: scenario.workspaceId, name: 'Test WS', slug: 'test-ws', status: 'active', created_at: new Date(), onboarding_completed: true, workspace_role: scenario.membershipRole || 'OWNER' }] };
    }

    // GET billing: getWorkspaceEntitlements / getBillingRow
    if (/FROM coexistence\.workspace_billing wb\s*\n\s*JOIN coexistence\.plans p/.test(sql)) {
      const plan = scenario.plan || PLAN_WITH_QUOTA;
      return {
        rows: [{
          status: scenario.status || 'active', plan_id: plan.id, current_period_end: null, cancel_at_period_end: false,
          plan_key: plan.key, plan_name: plan.name, limits: plan.limits,
          workspace_id: scenario.workspaceId, provider_customer_id: null, provider_subscription_id: null,
          trial_started_at: null, trial_ends_at: null,
        }],
      };
    }

    // listPublicPlans
    if (/SELECT key, name, limits FROM coexistence\.plans WHERE is_public = true/.test(sql)) {
      return { rows: [{ key: PLAN_WITH_QUOTA.key, name: PLAN_WITH_QUOTA.name, limits: PLAN_WITH_QUOTA.limits }] };
    }

    // countActiveSeats / countWhatsappAccounts / countContacts
    if (/SELECT COUNT\(\*\)::int AS n/.test(sql)) {
      return { rows: [{ n: 0 }] };
    }

    // messageUsageService.countMessagesThisMonth
    if (/SELECT message_count FROM coexistence\.workspace_message_usage/.test(sql)) {
      // Assert workspace isolation: the query must be scoped to the
      // requested workspace's id, never leak another workspace's usage.
      assert.equal(params[0], scenario.workspaceId);
      if (scenario.noUsageRow) return { rows: [] };
      return { rows: [{ message_count: scenario.messageCount }] };
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

// 1. Message usage is displayed correctly.
test('GET billing — usage.messages.used reflects countMessagesThisMonth()', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'OWNER', plan: PLAN_WITH_QUOTA, messageCount: 250 });
  try {
    const res = await callRoute(router, 'get', '/workspaces/:id/billing', makeReq({ params: { id: '42' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.usage.messages.used, 250);
  } finally { db.restore(); }
});

// 2. Quota is displayed correctly.
test('GET billing — usage.messages.quota reflects plan limits.monthly_message_quota', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'OWNER', plan: PLAN_WITH_QUOTA, messageCount: 250 });
  try {
    const res = await callRoute(router, 'get', '/workspaces/:id/billing', makeReq({ params: { id: '42' } }));
    assert.equal(res.body.usage.messages.quota, 1000);
  } finally { db.restore(); }
});

// 3. Remaining calculation.
test('GET billing — usage.messages.remaining = quota - used', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'OWNER', plan: PLAN_WITH_QUOTA, messageCount: 250 });
  try {
    const res = await callRoute(router, 'get', '/workspaces/:id/billing', makeReq({ params: { id: '42' } }));
    assert.equal(res.body.usage.messages.remaining, 750);
  } finally { db.restore(); }
});

// 3b. Remaining never goes negative even if usage exceeds quota (read-only
// display — no enforcement anywhere blocks the overage from happening).
test('GET billing — usage.messages.remaining floors at 0 when over quota', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'OWNER', plan: PLAN_WITH_QUOTA, messageCount: 1500 });
  try {
    const res = await callRoute(router, 'get', '/workspaces/:id/billing', makeReq({ params: { id: '42' } }));
    assert.equal(res.body.usage.messages.used, 1500);
    assert.equal(res.body.usage.messages.remaining, 0);
  } finally { db.restore(); }
});

// 4. Zero usage.
test('GET billing — zero usage this month returns used: 0, remaining: quota', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'OWNER', plan: PLAN_WITH_QUOTA, noUsageRow: true });
  try {
    const res = await callRoute(router, 'get', '/workspaces/:id/billing', makeReq({ params: { id: '42' } }));
    assert.equal(res.body.usage.messages.used, 0);
    assert.equal(res.body.usage.messages.remaining, 1000);
  } finally { db.restore(); }
});

// 5. Unlimited/null quota handled safely (no crash, remaining is null).
test('GET billing — plan with no monthly_message_quota key -> quota: null, remaining: null', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'OWNER', plan: PLAN_UNLIMITED, messageCount: 42 });
  try {
    const res = await callRoute(router, 'get', '/workspaces/:id/billing', makeReq({ params: { id: '42' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.usage.messages.used, 42);
    assert.equal(res.body.usage.messages.quota, null);
    assert.equal(res.body.usage.messages.remaining, null);
  } finally { db.restore(); }
});

// 6. Workspace isolation — the counter query is scoped to the requesting
// workspace's id (asserted inside dispatch() above); this test just
// exercises a different workspace id to make sure that assertion runs.
test('GET billing — message usage query is scoped to the requested workspace', async () => {
  const db = installDb({ workspaceId: 77, membershipRole: 'OWNER', plan: PLAN_WITH_QUOTA, messageCount: 10 });
  try {
    const res = await callRoute(router, 'get', '/workspaces/:id/billing', makeReq({ params: { id: '77' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.usage.messages.used, 10);
  } finally { db.restore(); }
});

// 7. Existing billing UI/response fields unchanged (seats/WA/contacts/plan/trial).
test('GET billing — existing usage fields (seats/whatsappAccounts/contacts) and plan/trial are unchanged', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'OWNER', plan: PLAN_WITH_QUOTA, messageCount: 5 });
  try {
    const res = await callRoute(router, 'get', '/workspaces/:id/billing', makeReq({ params: { id: '42' } }));
    assert.equal(res.body.usage.seats, 0);
    assert.equal(res.body.usage.whatsappAccounts, 0);
    assert.equal(res.body.usage.contacts, 0);
    assert.equal(res.body.plan.key, PLAN_WITH_QUOTA.key);
    assert.equal(res.body.trialStartedAt, null);
    assert.equal(res.body.trialEndsAt, null);
  } finally { db.restore(); }
});









