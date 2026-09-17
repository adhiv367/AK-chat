'use strict';

// Phase 7.13B — regression coverage for 7.13A-1 (funnel categoryName / the
// full categories list) and 7.13A-2 (both "Lead Source" resolution call
// sites), both in routes/dashboard.js.
//
// Same "no live Postgres" fake-db harness used by test/ordersRoutes.test.js /
// test/cartAccountOwnership.test.js: pool.query is monkey-patched with a
// small in-memory model of exactly the SQL dashboard.js issues. Every query
// NOT explicitly about coexistence.categories gets a generic, safe default
// row ({}) so the rest of the handler (contacts/chat/messages aggregates,
// which this phase does not touch) runs to completion without needing a
// full production dataset — this test only asserts on the categories-related
// behavior the fix actually changed.

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/db');
const { router } = require('../src/routes/dashboard');

const LEAD_SOURCE_CATEGORY = process.env.LEAD_SOURCE_CATEGORY || 'Lead Source';

function makeFakeDb() {
  // Two workspaces, each with their own categories — including a
  // same-named "Lead Source" category in both, which is exactly the
  // collision 7.13A-2 is about.
  const categories = [
    { id: 'cat-ws10-a', name: LEAD_SOURCE_CATEGORY, workspace_id: 10, created_at: new Date('2024-01-01') },
    { id: 'cat-ws10-b', name: 'Hot Lead', workspace_id: 10, created_at: new Date('2024-01-02') },
    { id: 'cat-ws20-a', name: LEAD_SOURCE_CATEGORY, workspace_id: 20, created_at: new Date('2023-01-01') },
    { id: 'cat-ws20-b', name: 'Cold Lead', workspace_id: 20, created_at: new Date('2023-01-02') },
  ];

  const calls = []; // records every categories-related query, for assertions

  async function query(sqlRaw, params = []) {
    const sql = sqlRaw.replace(/\s+/g, ' ').trim();

    // ── connected WhatsApp numbers (getConnectedWaNumbers) ──────────────
    if (/^SELECT display_phone_number AS wa FROM coexistence\.whatsapp_accounts/i.test(sql)) {
      return { rows: [] };
    }

    // ── "Lead Source" resolution by name (7.13A-2 — both call sites use
    //    the exact same SQL shape) ───────────────────────────────────────
    if (/^SELECT id FROM coexistence\.categories WHERE LOWER\(name\) = LOWER\(\$1\) AND workspace_id = \$2/i.test(sql)) {
      calls.push({ kind: 'leadSourceByName', params });
      const [name, workspaceId] = params;
      const row = categories.find(
        c => c.name.toLowerCase() === String(name).toLowerCase() && c.workspace_id === workspaceId
      );
      return { rows: row ? [{ id: row.id }] : [] };
    }

    // ── funnel categoryName lookup by id (7.13A-1) ──────────────────────
    if (/^SELECT name FROM coexistence\.categories WHERE id = \$1 AND workspace_id = \$2/i.test(sql)) {
      calls.push({ kind: 'categoryNameById', params });
      const [id, workspaceId] = params;
      const row = categories.find(c => c.id === id && c.workspace_id === workspaceId);
      return { rows: row ? [{ name: row.name }] : [] };
    }

    // ── full categories list (7.13A-1) ──────────────────────────────────
    if (/^SELECT id, name FROM coexistence\.categories WHERE workspace_id = \$1 ORDER BY name/i.test(sql)) {
      calls.push({ kind: 'allCategories', params });
      const [workspaceId] = params;
      const rows = categories
        .filter(c => c.workspace_id === workspaceId)
        .map(c => ({ id: c.id, name: c.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { rows };
    }

    // Guard: any OTHER query mentioning coexistence.categories without both
    // an id/name filter AND a workspace_id filter is exactly the class of
    // bug 7.13A-1/7.13A-2 fixed — fail the test loudly rather than silently
    // falling through to the generic default below.
    if (/coexistence\.categories/i.test(sql) && !/workspace_id/i.test(sql)) {
      throw new Error(`Unscoped categories query reintroduced: ${sql}`);
    }

    // ── generic safe default for every other aggregate query this route
    //    issues (contacts/chat/messages counts, tag distribution, etc.) —
    //    none of these are touched by this phase, so a single empty-object
    //    row is enough for the handler to complete without crashing on
    //    direct property access (e.g. contactRow.total).
    return { rows: [{}] };
  }

  return { query, calls, categories };
}

function installDb() {
  const fake = makeFakeDb();
  const original = pool.query;
  pool.query = fake.query;
  return { fake, restore() { pool.query = original; } };
}

// Minimal Express route-chain runner — same shape as test/ordersRoutes.test.js.
function callRoute(routerToUse, method, path, req) {
  const layer = routerToUse.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
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

// A non-admin (MANAGER) request — funnel/category logic runs regardless of
// admin status, and using a non-admin request skips the heavy admin-only
// broadcasts/automations block, which this phase does not touch.
function managerReq(workspaceId, query = {}) {
  return { user: { id: 1, role: 'MANAGER' }, workspace: { id: workspaceId, role: 'MANAGER' }, params: {}, query, body: {} };
}

// ── 1. Dashboard category list cannot return categories from another workspace ──

test('7.13A-1: funnel.categories only includes the caller\'s own workspace categories', async () => {
  const db = installDb();
  try {
    const res = await callRoute(router, 'get', '/dashboard', managerReq(10));
    assert.equal(res.statusCode, 200);
    const ids = res.body.funnel.categories.map(c => c.id);
    assert.deepEqual(ids.sort(), ['cat-ws10-a', 'cat-ws10-b']);
    assert.ok(!ids.includes('cat-ws20-a') && !ids.includes('cat-ws20-b'), 'workspace 20 categories must not leak into workspace 10\'s response');
  } finally { db.restore(); }
});

test('7.13A-1: a different workspace sees only its own categories', async () => {
  const db = installDb();
  try {
    const res = await callRoute(router, 'get', '/dashboard', managerReq(20));
    assert.equal(res.statusCode, 200);
    const ids = res.body.funnel.categories.map(c => c.id);
    assert.deepEqual(ids.sort(), ['cat-ws20-a', 'cat-ws20-b']);
  } finally { db.restore(); }
});

// ── 2. Dashboard funnelCategory cannot resolve another workspace's category ──

test('7.13A-1: ?funnelCategory=<foreign id> never resolves to another workspace\'s category name', async () => {
  const db = installDb();
  try {
    // Workspace 10's caller supplies workspace 20's category id.
    const res = await callRoute(router, 'get', '/dashboard', managerReq(10, { funnelCategory: 'cat-ws20-a' }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.funnel.categoryId, 'cat-ws20-a'); // echoes back what was asked for
    assert.equal(res.body.funnel.categoryName, null, 'a foreign category id must resolve to null, never the other workspace\'s name');
  } finally { db.restore(); }
});

test('7.13A-1: funnelCategory belonging to the caller\'s own workspace still resolves correctly', async () => {
  const db = installDb();
  try {
    const res = await callRoute(router, 'get', '/dashboard', managerReq(10, { funnelCategory: 'cat-ws10-b' }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.funnel.categoryId, 'cat-ws10-b');
    assert.equal(res.body.funnel.categoryName, 'Hot Lead');
  } finally { db.restore(); }
});

// ── 3. Dashboard Lead Source resolution is workspace-scoped at both call sites ──

test('7.13A-2: GET /dashboard resolves "Lead Source" using this workspace\'s category, not another workspace\'s', async () => {
  const db = installDb();
  try {
    await callRoute(router, 'get', '/dashboard', managerReq(10));
    const call = db.fake.calls.find(c => c.kind === 'leadSourceByName');
    assert.ok(call, 'expected the workspace-scoped Lead Source lookup to run');
    assert.equal(call.params[1], 10, 'workspace_id must be passed as the second bind param');
  } finally { db.restore(); }
});

test('7.13A-2: GET /dashboard/details (metric=newLeads) resolves "Lead Source" scoped to the caller\'s workspace', async () => {
  const db = installDb();
  try {
    const req = managerReq(20, { metric: 'newLeads' });
    const res = await callRoute(router, 'get', '/dashboard/details', req);
    assert.equal(res.statusCode, 200);
    const call = db.fake.calls.find(c => c.kind === 'leadSourceByName' && c.params[1] === 20);
    assert.ok(call, 'expected /dashboard/details\' leadCat() to run the workspace-scoped lookup for workspace 20');
  } finally { db.restore(); }
});

test('7.13A-2: a request with no resolved workspace never runs an unscoped Lead Source lookup', async () => {
  const db = installDb();
  try {
    await callRoute(router, 'get', '/dashboard', { user: { id: 1, role: 'MANAGER' }, workspace: null, params: {}, query: {}, body: {} });
    const unscoped = db.fake.calls.find(c => c.kind === 'leadSourceByName' && c.params[1] == null);
    assert.equal(unscoped, undefined, 'no workspace must mean no Lead Source lookup runs at all (fail closed), never an unscoped one');
  } finally { db.restore(); }
});

// ── 4. Same-workspace dashboard behavior remains unchanged ─────────────

test('7.13A-1/2: same-workspace dashboard response shape is unchanged (KPIs + funnel still present)', async () => {
  const db = installDb();
  try {
    const res = await callRoute(router, 'get', '/dashboard', managerReq(10));
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.body.kpis));
    assert.ok(res.body.kpis.length >= 5, 'expected at least the 5 common KPI tiles');
    assert.ok('funnel' in res.body);
    assert.ok('tagDistribution' in res.body);
  } finally { db.restore(); }
});
