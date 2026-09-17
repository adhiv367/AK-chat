'use strict';

// Phase 5C — Manual Billing / Zero Payment Gateway tests.
//
// Same no-real-Postgres approach as test/usersSeatLimit.test.js: pool.query
// / pool.connect are monkey-patched on the shared '../src/db' singleton, and
// route handlers are invoked directly against the router's internal stack
// (no supertest/http). This exercises loadMembership -> requireWorkspaceRole
// -> handler exactly as index.js wires it, without needing a live database.

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/db');
const { router } = require('../src/routes/billing');
const { getUsageExceedingPlanLimits } = require('../src/services/entitlementService');

const PLANS = {
  free: { id: 1, key: 'free', name: 'Free', is_public: true, limits: { max_seats: 2, max_whatsapp_accounts: 1, max_contacts: 250 } },
  starter: { id: 2, key: 'starter', name: 'Starter', is_public: true, limits: { max_seats: 5, max_whatsapp_accounts: 2, max_contacts: 2500 } },
  growth: { id: 3, key: 'growth', name: 'Growth', is_public: true, limits: { max_seats: 20, max_whatsapp_accounts: 5, max_contacts: 25000 } },
  legacy_unlimited: { id: 4, key: 'legacy_unlimited', name: 'Legacy (Grandfathered)', is_public: false, limits: { max_seats: null, max_whatsapp_accounts: null, max_contacts: null } },
};

// ─── query-dispatch mock ──────────────────────────────────────────────────
function makeDb(scenario) {
  const calls = [];
  async function dispatch(sql, params) {
    calls.push({ sql, params });

    // loadMembership -> getMembership()
    if (/FROM coexistence\.workspace_members wm\s*\n\s*JOIN coexistence\.workspaces w/.test(sql) || (/workspace_members/.test(sql) && /workspace_role/.test(sql))) {
      if (scenario.notMember) return { rows: [] };
      return { rows: [{ id: scenario.workspaceId, name: 'Test WS', slug: 'test-ws', status: 'active', created_at: new Date(), onboarding_completed: true, workspace_role: scenario.membershipRole || 'OWNER' }] };
    }

    // loadMembershipOrPlatformAdmin (platform-admin path) -> getActiveWorkspaceById()
    // No JOIN against workspace_members/workspace_role — a plain lookup
    // against coexistence.workspaces by id only.
    if (/FROM coexistence\.workspaces\s*\n\s*WHERE id = \$1 AND status = 'active'/.test(sql)) {
      if (scenario.workspaceMissing) return { rows: [] };
      return { rows: [{ id: scenario.workspaceId, name: 'Test WS', slug: 'test-ws', status: 'active', created_at: new Date(), onboarding_completed: true }] };
    }

    // getPlanByKey
    const planMatch = /SELECT \* FROM coexistence\.plans WHERE key = \$1/.test(sql);
    if (planMatch) {
      const key = params[0];
      const plan = Object.values(PLANS).find(p => p.key === key);
      return { rows: plan ? [plan] : [] };
    }

    // GET billing: getWorkspaceEntitlements / getBillingRow — both join
    // workspace_billing + plans; distinguish by the SELECT list.
    if (/FROM coexistence\.workspace_billing wb\s*\n\s*JOIN coexistence\.plans p/.test(sql)) {
      const plan = PLANS[scenario.currentPlanKey || 'free'];
      return {
        rows: [{
          status: 'active', plan_id: plan.id, current_period_end: null, cancel_at_period_end: false,
          plan_key: plan.key, plan_name: plan.name, limits: plan.limits,
          workspace_id: scenario.workspaceId, provider_customer_id: null, provider_subscription_id: null,
        }],
      };
    }

    // GET billing: listPublicPlans
    if (/SELECT key, name, limits FROM coexistence\.plans WHERE is_public = true/.test(sql)) {
      return { rows: Object.values(PLANS).filter(p => p.is_public).map(p => ({ key: p.key, name: p.name, limits: p.limits })) };
    }

    // requestPlanChange: existing pending check
    if (/FROM coexistence\.plan_change_requests\s*\n\s*WHERE workspace_id = \$1 AND status = 'pending'/.test(sql)) {
      return { rows: scenario.existingPending ? [{ id: 999 }] : [] };
    }

    // requestPlanChange: insert
    if (/INSERT INTO coexistence\.plan_change_requests/.test(sql)) {
      return { rows: [{ id: 100, workspace_id: params[0], requested_plan_id: params[1], requested_by: params[2], status: 'pending', created_at: new Date() }] };
    }

    // listPlanChangeRequests
    if (/FROM coexistence\.plan_change_requests r\s*\n\s*JOIN coexistence\.plans p/.test(sql)) {
      return { rows: scenario.requestHistory || [] };
    }

    // seat/whatsapp/contact counters (getUsageExceedingPlanLimits / checkLimit)
    if (/FROM coexistence\.workspace_members/.test(sql) && /COUNT/i.test(sql)) {
      return { rows: [{ n: scenario.currentSeats ?? 0 }] };
    }
    if (/FROM coexistence\.whatsapp_accounts/.test(sql) && /COUNT/i.test(sql)) {
      return { rows: [{ n: scenario.currentWhatsapp ?? 0 }] };
    }
    if (/FROM coexistence\.contacts/.test(sql) && /COUNT/i.test(sql)) {
      return { rows: [{ n: scenario.currentContacts ?? 0 }] };
    }

    // applyPlanToWorkspace
    if (/UPDATE coexistence\.workspace_billing/.test(sql) && /RETURNING \*/.test(sql)) {
      if (scenario.noBillingRow) return { rows: [] };
      return { rows: [{ workspace_id: params[1], plan_id: params[0], status: 'active' }] };
    }

    // resolve pending request on admin set-plan
    if (/UPDATE coexistence\.plan_change_requests\s*\n\s*SET status = 'approved'/.test(sql)) {
      return { rows: [] };
    }

    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(sql)) {
      return { rows: [] };
    }
    if (/INSERT INTO coexistence\.user_audit_log/.test(sql)) {
      return { rows: [] };
    }
    return { rows: [] };
  }
  return {
    calls,
    query: dispatch,
    connect: async () => ({ query: dispatch, release: () => {} }),
  };
}

function installDb(scenario) {
  const mock = makeDb(scenario);
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  pool.query = mock.query;
  pool.connect = mock.connect;
  return { calls: mock.calls, restore() { pool.query = originalQuery; pool.connect = originalConnect; } };
}

// ─── minimal Express route-chain runner (no supertest/http needed) ───────
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

function makeReq({ userRole = 'OWNER', body = {}, params = { id: '42' } } = {}) {
  return {
    user: { id: 1, username: 'kavin', role: userRole },
    params,
    body,
  };
}

// 1. OWNER can request Starter.
test('POST request-plan-change — OWNER can request Starter', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'OWNER' });
  try {
    const res = await callRoute(router, 'post', '/workspaces/:id/billing/request-plan-change', makeReq({ body: { planKey: 'starter' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'pending');
    assert.equal(res.body.requestedPlan.key, 'starter');
  } finally { db.restore(); }
});

// 2. OWNER can request Growth.
test('POST request-plan-change — OWNER can request Growth', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'OWNER' });
  try {
    const res = await callRoute(router, 'post', '/workspaces/:id/billing/request-plan-change', makeReq({ body: { planKey: 'growth' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.requestedPlan.key, 'growth');
  } finally { db.restore(); }
});

// 3. Non-OWNER cannot request a plan change.
test('POST request-plan-change — ADMIN membership role is rejected (OWNER only)', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'ADMIN' });
  try {
    const res = await callRoute(router, 'post', '/workspaces/:id/billing/request-plan-change', makeReq({ body: { planKey: 'starter' } }));
    assert.equal(res.statusCode, 403);
  } finally { db.restore(); }
});

// 4. Duplicate pending request behavior is handled correctly.
test('POST request-plan-change — duplicate pending request is rejected with 409', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'OWNER', existingPending: true });
  try {
    const res = await callRoute(router, 'post', '/workspaces/:id/billing/request-plan-change', makeReq({ body: { planKey: 'starter' } }));
    assert.equal(res.statusCode, 409);
    assert.ok(!db.calls.some(c => /INSERT INTO coexistence\.plan_change_requests/.test(c.sql)),
      'must not insert a second pending request');
  } finally { db.restore(); }
});

// 5. Global admin can manually set a plan.
test('POST set-plan — global admin (role=admin) can set the plan', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'ADMIN', currentSeats: 1, currentWhatsapp: 0, currentContacts: 10 });
  try {
    const res = await callRoute(router, 'post', '/workspaces/:id/billing/set-plan', makeReq({ userRole: 'admin', body: { planKey: 'starter' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.plan.key, 'starter');
    assert.ok(db.calls.some(c => /UPDATE coexistence\.workspace_billing/.test(c.sql)));
  } finally { db.restore(); }
});

// 6. Non-admin cannot manually set a plan.
test('POST set-plan — non-admin global role is rejected with 403', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'MANAGER' });
  try {
    const res = await callRoute(router, 'post', '/workspaces/:id/billing/set-plan', makeReq({ userRole: 'MANAGER', body: { planKey: 'starter' } }));
    assert.equal(res.statusCode, 403);
    assert.ok(!db.calls.some(c => /UPDATE coexistence\.workspace_billing/.test(c.sql)));
  } finally { db.restore(); }
});

// 7. Downgrade rejected when seat usage exceeds target.
test('POST set-plan — downgrade rejected when seat usage exceeds target (Free)', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'ADMIN', currentSeats: 4, currentWhatsapp: 0, currentContacts: 0 });
  try {
    const res = await callRoute(router, 'post', '/workspaces/:id/billing/set-plan', makeReq({ userRole: 'admin', body: { planKey: 'free' } }));
    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /exceeds the plan limits/);
    assert.ok(!db.calls.some(c => /UPDATE coexistence\.workspace_billing/.test(c.sql)),
      'no write on rejected downgrade');
  } finally { db.restore(); }
});

// 8. Downgrade rejected when contact usage exceeds target.
test('POST set-plan — downgrade rejected when contact usage exceeds target', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'ADMIN', currentSeats: 1, currentWhatsapp: 0, currentContacts: 5000 });
  try {
    const res = await callRoute(router, 'post', '/workspaces/:id/billing/set-plan', makeReq({ userRole: 'admin', body: { planKey: 'starter' } }));
    assert.equal(res.statusCode, 409);
    assert.ok(!db.calls.some(c => /UPDATE coexistence\.workspace_billing/.test(c.sql)));
  } finally { db.restore(); }
});

// 9. Downgrade rejected when WhatsApp account usage exceeds target.
test('POST set-plan — downgrade rejected when WhatsApp account usage exceeds target', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'ADMIN', currentSeats: 1, currentWhatsapp: 3, currentContacts: 0 });
  try {
    const res = await callRoute(router, 'post', '/workspaces/:id/billing/set-plan', makeReq({ userRole: 'admin', body: { planKey: 'free' } }));
    assert.equal(res.statusCode, 409);
    assert.ok(!db.calls.some(c => /UPDATE coexistence\.workspace_billing/.test(c.sql)));
  } finally { db.restore(); }
});

// 10. Downgrade succeeds when usage fits.
test('POST set-plan — downgrade succeeds when usage fits within target', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'ADMIN', currentSeats: 1, currentWhatsapp: 1, currentContacts: 100 });
  try {
    const res = await callRoute(router, 'post', '/workspaces/:id/billing/set-plan', makeReq({ userRole: 'admin', body: { planKey: 'free' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.plan.key, 'free');
  } finally { db.restore(); }
});

// 11. Plan actually changes in workspace_billing after successful admin action.
test('POST set-plan — writes the new plan_id onto workspace_billing', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'ADMIN', currentSeats: 1, currentWhatsapp: 0, currentContacts: 0 });
  try {
    await callRoute(router, 'post', '/workspaces/:id/billing/set-plan', makeReq({ userRole: 'admin', body: { planKey: 'growth' } }));
    const update = db.calls.find(c => /UPDATE coexistence\.workspace_billing/.test(c.sql));
    assert.ok(update);
    assert.equal(update.params[0], PLANS.growth.id);
  } finally { db.restore(); }
});

// 12. Pending request is resolved after approval.
test('POST set-plan — resolves the workspace pending plan_change_request', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'ADMIN', currentSeats: 1, currentWhatsapp: 0, currentContacts: 0 });
  try {
    await callRoute(router, 'post', '/workspaces/:id/billing/set-plan', makeReq({ userRole: 'admin', body: { planKey: 'starter' } }));
    assert.ok(db.calls.some(c => /UPDATE coexistence\.plan_change_requests[\s\S]*SET status = 'approved'/.test(c.sql)));
  } finally { db.restore(); }
});

// 13. Failed downgrade does not modify the active plan (transactional safety).
test('POST set-plan — failed downgrade issues no COMMIT-side write at all', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'ADMIN', currentSeats: 10, currentWhatsapp: 0, currentContacts: 0 });
  try {
    const res = await callRoute(router, 'post', '/workspaces/:id/billing/set-plan', makeReq({ userRole: 'admin', body: { planKey: 'free' } }));
    assert.equal(res.statusCode, 409);
    assert.ok(!db.calls.some(c => /BEGIN/i.test(c.sql)),
      'validation runs before the transaction ever opens, so no BEGIN either');
  } finally { db.restore(); }
});

// 14. legacy_unlimited remains unlimited (getUsageExceedingPlanLimits treats null limits as uncapped).
test('getUsageExceedingPlanLimits — legacy_unlimited (all-null limits) never flags usage as exceeding', async () => {
  const db = installDb({ currentSeats: 999, currentWhatsapp: 999, currentContacts: 999999 });
  try {
    const exceeding = await getUsageExceedingPlanLimits(42, PLANS.legacy_unlimited.limits);
    assert.deepEqual(exceeding, []);
  } finally { db.restore(); }
});

// 15. GET plan-requests returns newest-first history (as provided by the service query's ORDER BY).
test('GET plan-requests — returns request history for ADMIN+', async () => {
  const history = [
    { id: 2, status: 'pending', requested_plan_key: 'growth', requested_plan_name: 'Growth', note: null, created_at: new Date('2026-08-20'), resolved_at: null, resolved_by: null },
    { id: 1, status: 'approved', requested_plan_key: 'starter', requested_plan_name: 'Starter', note: null, created_at: new Date('2026-08-01'), resolved_at: new Date('2026-08-02'), resolved_by: 1 },
  ];
  const db = installDb({ workspaceId: 42, membershipRole: 'ADMIN', requestHistory: history });
  try {
    const res = await callRoute(router, 'get', '/workspaces/:id/billing/plan-requests', makeReq({ userRole: 'ADMIN' }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.requests.length, 2);
    assert.equal(res.body.requests[0].requestedPlan.key, 'growth');
  } finally { db.restore(); }
});

// Extra: getUsageExceedingPlanLimits reports each exceeding dimension.
test('getUsageExceedingPlanLimits — flags each dimension independently', async () => {
  const db = installDb({ currentSeats: 3, currentWhatsapp: 2, currentContacts: 300 });
  try {
    const exceeding = await getUsageExceedingPlanLimits(42, PLANS.free.limits);
    const types = exceeding.map(e => e.limitType).sort();
    assert.deepEqual(types, ['max_contacts', 'max_seats', 'max_whatsapp_accounts'].sort());
  } finally { db.restore(); }
});

// ─── Phase 5C — Platform Admin vs Workspace Admin ────────────────────────
// Platform Admin (global legacy role 'admin') must be able to reach
// GET billing / POST set-plan for a workspace it is NOT a member of, with
// no fake workspace_members row involved. A normal workspace OWNER/ADMIN
// member must still be rejected from set-plan (403, not a membership
// error) — see routes/billing.js loadMembershipOrPlatformAdmin.

// 17. Platform admin can GET billing for a workspace without membership.
test('GET billing — platform admin can read billing without workspace membership', async () => {
  const db = installDb({ workspaceId: 77, notMember: true, currentSeats: 1, currentWhatsapp: 0, currentContacts: 5 });
  try {
    const res = await callRoute(router, 'get', '/workspaces/:id/billing', makeReq({ userRole: 'admin', params: { id: '77' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.canSetPlanDirectly, true);
  } finally { db.restore(); }
});

// 18. Normal (non-platform-admin, non-member) user cannot GET billing for another workspace.
test('GET billing — non-member, non-platform-admin user is rejected with 404', async () => {
  const db = installDb({ workspaceId: 77, notMember: true });
  try {
    const res = await callRoute(router, 'get', '/workspaces/:id/billing', makeReq({ userRole: 'OWNER', params: { id: '77' } }));
    assert.equal(res.statusCode, 404);
  } finally { db.restore(); }
});

// 19. canSetPlanDirectly is false for a plain workspace OWNER/ADMIN member
//     (isPlatformAdmin, not isAdmin — a workspace-level OWNER must never see
//     the admin plan-management control on their own workspace).
test('GET billing — canSetPlanDirectly is false for a workspace OWNER member (global role OWNER, not platform admin)', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'OWNER', currentSeats: 1, currentWhatsapp: 0, currentContacts: 0 });
  try {
    const res = await callRoute(router, 'get', '/workspaces/:id/billing', makeReq({ userRole: 'OWNER', params: { id: '42' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.canSetPlanDirectly, false);
  } finally { db.restore(); }
});

// 20. Platform admin can set Starter for a workspace without membership.
test('POST set-plan — platform admin sets Starter for a workspace without membership', async () => {
  const db = installDb({ workspaceId: 77, notMember: true, currentSeats: 1, currentWhatsapp: 0, currentContacts: 5 });
  try {
    const res = await callRoute(router, 'post', '/workspaces/:id/billing/set-plan', makeReq({ userRole: 'admin', params: { id: '77' }, body: { planKey: 'starter' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.plan.key, 'starter');
  } finally { db.restore(); }
});

// 21. Platform admin can set Growth for a workspace without membership.
test('POST set-plan — platform admin sets Growth for a workspace without membership', async () => {
  const db = installDb({ workspaceId: 77, notMember: true, currentSeats: 1, currentWhatsapp: 0, currentContacts: 5 });
  try {
    const res = await callRoute(router, 'post', '/workspaces/:id/billing/set-plan', makeReq({ userRole: 'admin', params: { id: '77' }, body: { planKey: 'growth' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.plan.key, 'growth');
  } finally { db.restore(); }
});

// 22. Normal OWNER (a real member, global role OWNER) still cannot call set-plan directly.
test('POST set-plan — a workspace OWNER member is rejected with 403 (not platform admin)', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'OWNER' });
  try {
    const res = await callRoute(router, 'post', '/workspaces/:id/billing/set-plan', makeReq({ userRole: 'OWNER', params: { id: '42' }, body: { planKey: 'starter' } }));
    assert.equal(res.statusCode, 403);
    assert.ok(!db.calls.some(c => /UPDATE coexistence\.workspace_billing/.test(c.sql)));
  } finally { db.restore(); }
});

// 23. Normal ADMIN (a real member, global role ADMIN) still cannot call set-plan directly.
test('POST set-plan — a workspace ADMIN member is rejected with 403 (not platform admin)', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'ADMIN' });
  try {
    const res = await callRoute(router, 'post', '/workspaces/:id/billing/set-plan', makeReq({ userRole: 'ADMIN', params: { id: '42' }, body: { planKey: 'starter' } }));
    assert.equal(res.statusCode, 403);
    assert.ok(!db.calls.some(c => /UPDATE coexistence\.workspace_billing/.test(c.sql)));
  } finally { db.restore(); }
});

// 24. Platform admin targeting a workspace that doesn't exist / isn't active gets 404, not a crash.
test('POST set-plan — platform admin targeting a missing/inactive workspace gets 404', async () => {
  const db = installDb({ workspaceMissing: true });
  try {
    const res = await callRoute(router, 'post', '/workspaces/:id/billing/set-plan', makeReq({ userRole: 'admin', params: { id: '999' }, body: { planKey: 'starter' } }));
    assert.equal(res.statusCode, 404);
  } finally { db.restore(); }
});


