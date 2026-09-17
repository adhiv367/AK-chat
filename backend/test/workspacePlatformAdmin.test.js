'use strict';

// Phase 5C — Platform Admin vs Workspace Admin.
//
// Same no-real-Postgres approach as test/planChangeRequests.test.js: pool.query
// / pool.connect are monkey-patched on the shared '../src/db' singleton, and
// route handlers are invoked directly against the router's internal stack
// (no supertest/http, no attachWorkspace middleware — req.workspace /
// req.workspaces are set explicitly per test the same way index.js's
// attachWorkspace would after resolveActiveWorkspace()).

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/db');
const { router } = require('../src/routes/workspace');

const MEMBERSHIPS = {
  kavin: [
    { id: 1, name: 'Invi Creation', slug: 'invi-creation', status: 'active', created_at: new Date(), onboarding_completed: true, workspace_role: 'OWNER' },
  ],
  saasUser: [
    { id: 2, name: 'SaaS Test Workspace', slug: 'saas-test-workspace', status: 'active', created_at: new Date(), onboarding_completed: true, workspace_role: 'OWNER' },
  ],
};

const ALL_WORKSPACES = [
  { id: 1, name: 'Invi Creation', slug: 'invi-creation', status: 'active', created_at: new Date(), onboarding_completed: true },
  { id: 2, name: 'SaaS Test Workspace', slug: 'saas-test-workspace', status: 'active', created_at: new Date(), onboarding_completed: true },
];

// ─── query-dispatch mock ──────────────────────────────────────────────────
function makeDb(scenario) {
  const calls = [];
  async function dispatch(sql, params) {
    calls.push({ sql, params });

    // getWorkspacesForUser() — membership-joined list, ORDER BY wm.id ASC,
    // no WHERE workspace_id — matched by presence of "wm.id ASC" and
    // absence of a workspace_id param filter beyond user_id.
    if (/FROM coexistence\.workspace_members wm\s*\n\s*JOIN coexistence\.workspaces w/.test(sql) && /ORDER BY wm\.id ASC/.test(sql)) {
      return { rows: (scenario.memberships || []).map(m => ({ ...m })) };
    }

    // getMembership() — single workspace + user, filtered by workspace_id.
    if (/FROM coexistence\.workspace_members wm\s*\n\s*JOIN coexistence\.workspaces w/.test(sql) && /wm\.workspace_id = \$2/.test(sql)) {
      const wsId = params[1];
      const match = (scenario.memberships || []).find(m => String(m.id) === String(wsId));
      return { rows: match ? [{ ...match }] : [] };
    }

    // getAllActiveWorkspaces() — plain workspaces table, no :id filter.
    if (/FROM coexistence\.workspaces\s*\n\s*WHERE status = 'active'/.test(sql)) {
      return { rows: scenario.allWorkspaces || [] };
    }

    // getActiveWorkspaceById() — plain workspaces table, filtered by id.
    if (/FROM coexistence\.workspaces\s*\n\s*WHERE id = \$1 AND status = 'active'/.test(sql)) {
      const match = (scenario.allWorkspaces || []).find(w => String(w.id) === String(params[0]));
      return { rows: match ? [{ ...match }] : [] };
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
  const cookiesSet = {};
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      body: undefined,
      cookies: cookiesSet,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; resolve(this); return this; },
      cookie(name, value) { cookiesSet[name] = value; return this; },
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

function makeReq({ userId = 1, userRole = 'OWNER', body = {}, params = { id: '1' }, workspace = null, workspaces = null } = {}) {
  return {
    user: { id: userId, username: 'user', role: userRole },
    params,
    body,
    workspace,
    workspaces,
  };
}

// 1. Normal workspace selector (GET /workspaces) shows ONLY actual
//    memberships, for EVERY caller — including a platform admin. Platform
//    Admin's ability to see every workspace lives on a separate endpoint
//    (GET /platform-admin/workspaces, tested below) — see Phase 5C
//    section 8 ("Do NOT put all workspaces back into the normal workspace
//    selector").
test('GET /workspaces — platform admin (role=admin) still sees only their own actual memberships', async () => {
  const db = installDb({ memberships: MEMBERSHIPS.kavin, allWorkspaces: ALL_WORKSPACES });
  try {
    const res = await callRoute(router, 'get', '/workspaces', makeReq({ userId: 10, userRole: 'admin' }));
    assert.equal(res.statusCode, 200);
    const names = res.body.map(w => w.name).sort();
    assert.deepEqual(names, ['Invi Creation'], 'platform admin normal selector must not expand to every workspace');
  } finally { db.restore(); }
});

// 1b. GET /platform-admin/workspaces IS the separate mechanism that lists
//     every active workspace, platform-admin only.
test('GET /platform-admin/workspaces — platform admin sees every active workspace', async () => {
  const db = installDb({ memberships: MEMBERSHIPS.kavin, allWorkspaces: ALL_WORKSPACES });
  try {
    const res = await callRoute(router, 'get', '/platform-admin/workspaces', makeReq({ userId: 10, userRole: 'admin' }));
    assert.equal(res.statusCode, 200);
    const names = res.body.map(w => w.name).sort();
    assert.deepEqual(names, ['Invi Creation', 'SaaS Test Workspace']);
  } finally { db.restore(); }
});

// 1c. GET /platform-admin/workspaces 403s for a normal customer, even a
//     workspace OWNER/ADMIN.
test('GET /platform-admin/workspaces — normal customer (workspace OWNER) gets 403', async () => {
  const db = installDb({ memberships: MEMBERSHIPS.saasUser, allWorkspaces: ALL_WORKSPACES });
  try {
    const res = await callRoute(router, 'get', '/platform-admin/workspaces', makeReq({ userId: 20, userRole: 'OWNER' }));
    assert.equal(res.statusCode, 403);
  } finally { db.restore(); }
});

// 2. Normal customer only receives their own workspaces (item L2).
test('GET /workspaces — normal customer only sees workspaces they belong to', async () => {
  const db = installDb({ memberships: MEMBERSHIPS.saasUser, allWorkspaces: ALL_WORKSPACES });
  try {
    const res = await callRoute(router, 'get', '/workspaces', makeReq({ userId: 20, userRole: 'OWNER' }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].name, 'SaaS Test Workspace');
    assert.ok(!res.body.some(w => w.name === 'Invi Creation'), 'must not leak other tenants');
  } finally { db.restore(); }
});

// 3. Platform admin can switch to a workspace without workspace_members membership (item L3).
test('POST /workspaces/:id/switch — platform admin can switch into a workspace they are not a member of', async () => {
  const db = installDb({ memberships: MEMBERSHIPS.kavin, allWorkspaces: ALL_WORKSPACES });
  try {
    const res = await callRoute(router, 'post', '/workspaces/:id/switch', makeReq({ userId: 10, userRole: 'admin', params: { id: '2' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.id, 2);
    assert.equal(res.body.name, 'SaaS Test Workspace');
    assert.equal(res.body.isActive, true);
  } finally { db.restore(); }
});

// 4. Normal customer cannot switch to another workspace (item L4).
test('POST /workspaces/:id/switch — normal customer cannot switch to a workspace they do not belong to', async () => {
  const db = installDb({ memberships: MEMBERSHIPS.saasUser, allWorkspaces: ALL_WORKSPACES });
  try {
    const res = await callRoute(router, 'post', '/workspaces/:id/switch', makeReq({ userId: 20, userRole: 'OWNER', params: { id: '1' } }));
    assert.equal(res.statusCode, 404);
  } finally { db.restore(); }
});

// 5. Platform admin switching to a nonexistent/inactive workspace gets 404, not a crash.
test('POST /workspaces/:id/switch — platform admin targeting a missing workspace gets 404', async () => {
  const db = installDb({ memberships: MEMBERSHIPS.kavin, allWorkspaces: ALL_WORKSPACES });
  try {
    const res = await callRoute(router, 'post', '/workspaces/:id/switch', makeReq({ userId: 10, userRole: 'admin', params: { id: '999' } }));
    assert.equal(res.statusCode, 404);
  } finally { db.restore(); }
});

// 6. No fake membership row is ever created for the platform admin during switch.
test('POST /workspaces/:id/switch — platform admin switch never inserts a workspace_members row', async () => {
  const db = installDb({ memberships: MEMBERSHIPS.kavin, allWorkspaces: ALL_WORKSPACES });
  try {
    await callRoute(router, 'post', '/workspaces/:id/switch', makeReq({ userId: 10, userRole: 'admin', params: { id: '2' } }));
    assert.ok(!db.calls.some(c => /INSERT INTO coexistence\.workspace_members/.test(c.sql)));
  } finally { db.restore(); }
});

// 7. A workspace-level OWNER/ADMIN (global role OWNER/ADMIN, not literal
//    'admin') is still treated as a normal customer for listing — confirms
//    isPlatformAdmin() and isAdmin() are not conflated in this route.
test('GET /workspaces — a workspace OWNER (global role "OWNER") is not treated as platform admin', async () => {
  const db = installDb({ memberships: MEMBERSHIPS.saasUser, allWorkspaces: ALL_WORKSPACES });
  try {
    const res = await callRoute(router, 'get', '/workspaces', makeReq({ userId: 20, userRole: 'OWNER' }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.length, 1);
  } finally { db.restore(); }
});