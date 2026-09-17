'use strict';

// Phase 7.13B — regression coverage for 7.13A-3.
//
// The frontend (Sidebar.jsx / App.jsx) already gates the entire Automations
// page — list, detail, and executions — behind the 'chatbot-builder'
// permission, and every mutating route in routes/chatbots.js already
// required it. The four GET routes were the one gap: workspace isolation
// was correct, but any authenticated workspace member — including a role
// with no 'chatbot-builder' permission (VIEWER/AGENT — see permissions.js) —
// could still read automation configs and execution history.
//
// This test asserts:
//   - a role WITHOUT 'chatbot-builder' (VIEWER) is now rejected (403) on
//     all four previously-ungated GET routes
//   - a role WITH 'chatbot-builder' (MANAGER) still gets normal (200)
//     responses, scoped to its own workspace
//   - cross-workspace access stays blocked (404, not another workspace's
//     data) exactly as before this phase
//
// Same "no live Postgres" fake-db harness as test/ordersRoutes.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/db');
const { router } = require('../src/routes/chatbots');

function makeFakeDb() {
  const chatbots = [
    { id: 1, workspace_id: 10, name: 'Bot A', description: null, status: 'active', trigger_type: 'keyword', config: {}, created_at: new Date(), updated_at: new Date() },
    { id: 2, workspace_id: 20, name: 'Bot B', description: null, status: 'active', trigger_type: 'keyword', config: {}, created_at: new Date(), updated_at: new Date() },
  ];
  const executions = [
    { id: 100, automation_id: 1, status: 'completed', trigger_type: 'keyword', trigger_data: {}, contact_number: '15550001111', started_at: new Date(), completed_at: new Date(), error_message: null, created_at: new Date() },
  ];

  async function query(sqlRaw, params = []) {
    const sql = sqlRaw.replace(/\s+/g, ' ').trim();

    // requirePermission's per-user role/permissions lookup.
    if (/^SELECT role, permissions FROM coexistence\.akchat_users WHERE id = \$1$/i.test(sql)) {
      const [id] = params;
      const role = id === 1 ? 'MANAGER' : id === 2 ? 'VIEWER' : 'VIEWER';
      return { rows: [{ role, permissions: null }] };
    }

    if (/^SELECT id, name, description, status, trigger_type, config, created_at, updated_at\s+FROM coexistence\.chatbots\s+WHERE workspace_id = \$1/i.test(sql)) {
      const [workspaceId] = params;
      return { rows: chatbots.filter(c => c.workspace_id === workspaceId) };
    }

    if (/^SELECT id, name, description, status, trigger_type, config, created_at, updated_at\s+FROM coexistence\.chatbots WHERE id = \$1 AND workspace_id = \$2/i.test(sql)) {
      const [id, workspaceId] = params;
      const row = chatbots.find(c => c.id === Number(id) && c.workspace_id === workspaceId);
      return { rows: row ? [row] : [] };
    }

    if (/^SELECT id FROM coexistence\.chatbots WHERE id = \$1 AND workspace_id = \$2$/i.test(sql)) {
      const [id, workspaceId] = params;
      const row = chatbots.find(c => c.id === Number(id) && c.workspace_id === workspaceId);
      return { rows: row ? [{ id: row.id }] : [] };
    }

    if (/^SELECT COUNT\(\*\) FROM coexistence\.automation_executions e WHERE e\.automation_id = \$1/i.test(sql)) {
      const [automationId] = params;
      return { rows: [{ count: String(executions.filter(e => e.automation_id === Number(automationId)).length) }] };
    }

    if (/^SELECT e\.id, e\.automation_id, e\.status, e\.trigger_type, e\.trigger_data, e\.contact_number,\s*e\.started_at, e\.completed_at, e\.error_message, e\.created_at\s*FROM coexistence\.automation_executions e\s*WHERE e\.automation_id = \$1/i.test(sql)) {
      const [automationId] = params;
      return { rows: executions.filter(e => e.automation_id === Number(automationId)) };
    }

    if (/^SELECT e\.id, e\.automation_id, e\.status, e\.trigger_type, e\.trigger_data, e\.contact_number,\s*e\.started_at, e\.completed_at, e\.error_message, e\.created_at\s*FROM coexistence\.automation_executions e\s*JOIN coexistence\.chatbots c ON c\.id = e\.automation_id\s*WHERE e\.id = \$1 AND c\.workspace_id = \$2/i.test(sql)) {
      const [execId, workspaceId] = params;
      const exec = executions.find(e => e.id === Number(execId));
      const bot = exec && chatbots.find(c => c.id === exec.automation_id && c.workspace_id === workspaceId);
      return { rows: bot ? [exec] : [] };
    }

    if (/^SELECT id, execution_id, node_id, node_type, node_name/i.test(sql)) {
      return { rows: [] };
    }

    return { rows: [] };
  }

  return { query, chatbots, executions };
}

function installDb() {
  const fake = makeFakeDb();
  const original = pool.query;
  pool.query = fake.query;
  return { fake, restore() { pool.query = original; } };
}

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

// user.id 1 -> MANAGER (has 'chatbot-builder' by default — see permissions.js
// MANAGER_PAGES). user.id 2 -> VIEWER (does NOT have it — VIEWER_PAGES).
function managerReq(workspaceId, extra = {}) {
  return { user: { id: 1, role: 'MANAGER' }, workspace: { id: workspaceId, role: 'MANAGER' }, params: {}, query: {}, body: {}, ...extra };
}
function viewerReq(workspaceId, extra = {}) {
  return { user: { id: 2, role: 'VIEWER' }, workspace: { id: workspaceId, role: 'VIEWER' }, params: {}, query: {}, body: {}, ...extra };
}

const GET_ROUTES = [
  { path: '/chatbots', params: {} },
  { path: '/chatbots/:id', params: { id: '1' } },
  { path: '/chatbots/:id/executions', params: { id: '1' } },
  { path: '/executions/:id', params: { id: '100' } },
];

// ── 5. Chatbot GET authorization matches the intended permission model ──

for (const { path, params } of GET_ROUTES) {
  test(`7.13A-3: VIEWER (no chatbot-builder) is now forbidden from GET ${path}`, async () => {
    const db = installDb();
    try {
      const res = await callRoute(router, 'get', path, viewerReq(10, { params }));
      assert.equal(res.statusCode, 403, `expected 403 for VIEWER on GET ${path}`);
    } finally { db.restore(); }
  });

  test(`7.13A-3: MANAGER (has chatbot-builder) still gets a normal response on GET ${path}`, async () => {
    const db = installDb();
    try {
      const res = await callRoute(router, 'get', path, managerReq(10, { params }));
      assert.notEqual(res.statusCode, 403, `MANAGER should not be forbidden on GET ${path}`);
    } finally { db.restore(); }
  });
}

// ── 6. Cross-workspace chatbot access remains blocked ───────────────────

test('7.13A-3: a MANAGER in workspace 20 cannot read workspace 10\'s chatbot by id (404, not data)', async () => {
  const db = installDb();
  try {
    const res = await callRoute(router, 'get', '/chatbots/:id', managerReq(20, { params: { id: '1' } }));
    assert.equal(res.statusCode, 404);
  } finally { db.restore(); }
});

test('7.13A-3: GET /chatbots only returns the caller\'s own workspace automations', async () => {
  const db = installDb();
  try {
    const res = await callRoute(router, 'get', '/chatbots', managerReq(10));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].id, 1);
  } finally { db.restore(); }
});

// ── 7. Existing chatbot functionality remains intact ────────────────────

test('7.13A-3: GET /chatbots/:id still returns the automation for an authorized same-workspace MANAGER', async () => {
  const db = installDb();
  try {
    const res = await callRoute(router, 'get', '/chatbots/:id', managerReq(10, { params: { id: '1' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.id, 1);
    assert.equal(res.body.name, 'Bot A');
  } finally { db.restore(); }
});

test('7.13A-3: GET /executions/:id still returns execution detail with steps for an authorized MANAGER', async () => {
  const db = installDb();
  try {
    const res = await callRoute(router, 'get', '/executions/:id', managerReq(10, { params: { id: '100' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.id, 100);
    assert.ok(Array.isArray(res.body.steps));
  } finally { db.restore(); }
});

test('7.13A-3: mutating routes (POST/PUT/DELETE) are unaffected — still require chatbot-builder as before', async () => {
  const db = installDb();
  try {
    const res = await callRoute(router, 'post', '/chatbots', viewerReq(10, { body: { name: 'x' } }));
    assert.equal(res.statusCode, 403);
  } finally { db.restore(); }
});
