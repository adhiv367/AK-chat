'use strict';

// Phase 8B-6 — focused tests for platform-admin trial controls
// (POST /workspaces/:id/billing/admin/trial). Same no-real-Postgres
// mock-pool approach as test/planChangeRequests.test.js and
// test/billingTrialStatus.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/db');
const { router } = require('../src/routes/billing');

function makeDb(scenario) {
  async function dispatch(sql, params) {
    // loadMembershipOrPlatformAdmin — platform-admin path (no membership row)
    if (/FROM coexistence\.workspaces\s*\n\s*WHERE id = \$1 AND status = 'active'/.test(sql)) {
      if (scenario.workspaceMissing) return { rows: [] };
      return { rows: [{ id: scenario.workspaceId, name: 'Test WS', slug: 'test-ws', status: 'active', created_at: new Date(), onboarding_completed: true }] };
    }
    // loadMembershipOrPlatformAdmin — plain membership path
    if (/workspace_members/.test(sql) && /workspace_role/.test(sql)) {
      if (scenario.notMember) return { rows: [] };
      return { rows: [{ id: scenario.workspaceId, name: 'Test WS', slug: 'test-ws', status: 'active', created_at: new Date(), onboarding_completed: true, workspace_role: scenario.membershipRole || 'OWNER' }] };
    }
    // adminStartOrRestartTrial
    if (/SET status = 'trialing'/.test(sql)) {
      if (scenario.noBillingRow) return { rows: [] };
      return { rows: [{ workspace_id: params[0], status: 'trialing', trial_started_at: new Date(), trial_ends_at: new Date(Date.now() + Number(params[1]) * 86400000) }] };
    }
    // adminEndTrial
    if (/SET status = 'suspended'/.test(sql)) {
      if (scenario.notTrialing) return { rows: [] };
      return { rows: [{ workspace_id: params[0], status: 'suspended', trial_started_at: scenario.trialStartedAt || new Date(), trial_ends_at: new Date() }] };
    }
    if (/INSERT INTO coexistence\.user_audit_log/.test(sql)) return { rows: [] };
    return { rows: [] };
  }
  return { query: dispatch, connect: async () => ({ query: dispatch, release: () => {} }) };
}

function installDb(scenario) {
  const mock = makeDb(scenario);
  const originalQuery = pool.query;
  pool.query = mock.query;
  return { restore() { pool.query = originalQuery; } };
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

function makeReq({ userRole = 'OWNER', body = {}, params = { id: '42' } } = {}) {
  return { user: { id: 1, username: 'kavin', role: userRole }, params, body };
}

const PATH = '/workspaces/:id/billing/admin/trial';

// 1. Platform admin can start/restart a trial.
test('POST admin/trial — platform admin can start a trial', async () => {
  const db = installDb({ workspaceId: 42 });
  try {
    const res = await callRoute(router, 'post', PATH, makeReq({ userRole: 'admin', body: { action: 'start' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'trialing');
    assert.ok(res.body.trialEndsAt);
  } finally { db.restore(); }
});

test('POST admin/trial — platform admin can restart a trial with a custom duration', async () => {
  const db = installDb({ workspaceId: 42 });
  try {
    const res = await callRoute(router, 'post', PATH, makeReq({ userRole: 'admin', body: { action: 'restart', durationDays: 30 } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'trialing');
  } finally { db.restore(); }
});

// 2. Platform admin can end an active trial.
test('POST admin/trial — platform admin can end an active trial', async () => {
  const db = installDb({ workspaceId: 42 });
  try {
    const res = await callRoute(router, 'post', PATH, makeReq({ userRole: 'admin', body: { action: 'end' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'suspended');
  } finally { db.restore(); }
});
test('POST admin/trial — ending a non-trialing workspace is rejected with 409', async () => {
  const db = installDb({ workspaceId: 42, notTrialing: true });
  try {
    const res = await callRoute(router, 'post', PATH, makeReq({ userRole: 'admin', body: { action: 'end' } }));
    assert.equal(res.statusCode, 409);
  } finally { db.restore(); }
});
// 3. Workspace OWNER/ADMIN (real membership, not platform admin) is rejected.
test('POST admin/trial — workspace OWNER member is rejected with 403', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'OWNER' });
  try {
    const res = await callRoute(router, 'post', PATH, makeReq({ userRole: 'OWNER', body: { action: 'start' } }));
    assert.equal(res.statusCode, 403);
  } finally { db.restore(); }
});
test('POST admin/trial — workspace ADMIN member is rejected with 403', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'ADMIN' });
  try {
    const res = await callRoute(router, 'post', PATH, makeReq({ userRole: 'ADMIN', body: { action: 'end' } }));
    assert.equal(res.statusCode, 403);
  } finally { db.restore(); }
});
// 4. Non-admin, non-member user is rejected (404 — same not-a-member path).
test('POST admin/trial — non-admin, non-member user is rejected with 404', async () => {
  const db = installDb({ workspaceId: 77, notMember: true });
  try {
    const res = await callRoute(router, 'post', PATH, makeReq({ userRole: 'OWNER', params: { id: '77' }, body: { action: 'start' } }));
    assert.equal(res.statusCode, 404);
  } finally { db.restore(); }
});
// 5. Workspace isolation — platform admin targeting a missing workspace gets 404.
test('POST admin/trial — platform admin targeting a missing/inactive workspace gets 404', async () => {
  const db = installDb({ workspaceId: 999, workspaceMissing: true });
  try {
    const res = await callRoute(router, 'post', PATH, makeReq({ userRole: 'admin', params: { id: '999' }, body: { action: 'start' } }));
    assert.equal(res.statusCode, 404);
  } finally { db.restore(); }
});
// 6. Invalid action is rejected without touching the database (existing
//    behavior / input validation).
test('POST admin/trial — invalid action is rejected with 400', async () => {
  const db = installDb({ workspaceId: 42 });
  try {
    const res = await callRoute(router, 'post', PATH, makeReq({ userRole: 'admin', body: { action: 'delete' } }));
    assert.equal(res.statusCode, 400);
  } finally { db.restore(); }
});