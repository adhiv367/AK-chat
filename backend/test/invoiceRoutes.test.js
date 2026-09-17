'use strict';

// Phase 8C-3 — focused route tests only (invoice API routes).
// Same no-live-Postgres / no-supertest approach as
// test/planChangeRequests.test.js: pool.query is monkey-patched on the
// shared '../src/db' singleton, and route handlers are invoked directly
// against the router's internal stack. This exercises
// loadMembership -> requireWorkspaceRole -> handler -> invoiceService
// exactly as index.js wires it, without a live database.

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/db');
const { router } = require('../src/routes/invoices');

// ─── query-dispatch mock ──────────────────────────────────────────────────
function makeDb(scenario) {
  async function dispatch(sql, params) {
    // getMembership (loadMembership)
    if (/FROM coexistence\.workspace_members wm\s*\n\s*JOIN coexistence\.workspaces w/.test(sql)) {
      if (scenario.notMember) return { rows: [] };
      return { rows: [{ id: scenario.workspaceId, name: 'Test WS', slug: 'test-ws', status: 'active', created_at: new Date(), onboarding_completed: true, workspace_role: scenario.membershipRole || 'OWNER' }] };
    }
    // invoiceService.createInvoice
    if (/INSERT INTO coexistence\.workspace_invoices/.test(sql)) {
      if (scenario.duplicateInvoiceNumber) {
        const err = new Error('duplicate key value violates unique constraint "uq_workspace_invoices_invoice_number"');
        err.code = '23505';
        throw err;
      }
      return { rows: [{ id: 1, workspace_id: params[0], invoice_number: params[1], status: params[2], currency: params[3] }] };
    }
    // invoiceService.getInvoiceById / listWorkspaceInvoices
    if (/SELECT \* FROM coexistence\.workspace_invoices/.test(sql) && /WHERE id = \$1 AND workspace_id = \$2/.test(sql)) {
      if (scenario.invoiceMissing) return { rows: [] };
      return { rows: [{ id: Number(params[0]), workspace_id: params[1], status: 'draft' }] };
    }
    if (/SELECT \* FROM coexistence\.workspace_invoices/.test(sql) && /WHERE workspace_id = \$1/.test(sql)) {
      return { rows: scenario.invoices || [{ id: 1, workspace_id: params[0], status: 'draft' }] };
    }
    // invoiceService.updateInvoiceStatus
    if (/UPDATE coexistence\.workspace_invoices/.test(sql)) {
      if (scenario.invoiceMissing) return { rows: [] };
      return { rows: [{ id: Number(params[2]), workspace_id: params[3], status: params[0] }] };
    }
    if (/INSERT INTO coexistence\.user_audit_log/.test(sql)) return { rows: [] };
    return { rows: [] };
  }
  return { query: dispatch };
}

function installDb(scenario) {
  const mock = makeDb(scenario);
  const originalQuery = pool.query;
  pool.query = mock.query;
  return { restore() { pool.query = originalQuery; } };
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

function makeReq({ userRole = 'OWNER', body = {}, query = {}, params = { id: '42' } } = {}) {
  return { user: { id: 1, username: 'kavin', role: userRole }, params, body, query };
}

// 1. Create
test('POST invoices — OWNER can create an invoice', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'OWNER' });
  try {
    const res = await callRoute(router, 'post', '/workspaces/:id/invoices', makeReq({ body: { invoiceNumber: 'INV-001', currency: 'USD' } }));
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.invoice_number, 'INV-001');
    assert.equal(res.body.workspace_id, 42);
  } finally { db.restore(); }
});

// 2. Get
test('GET invoices/:invoiceId — ADMIN can fetch an invoice in their workspace', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'ADMIN' });
  try {
    const res = await callRoute(router, 'get', '/workspaces/:id/invoices/:invoiceId', makeReq({ userRole: 'ADMIN', params: { id: '42', invoiceId: '7' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.id, 7);
    assert.equal(res.body.workspace_id, 42);
  } finally { db.restore(); }
});

// 3. List
test('GET invoices — ADMIN can list workspace invoices', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'ADMIN', invoices: [{ id: 1, workspace_id: 42 }, { id: 2, workspace_id: 42 }] });
  try {
    const res = await callRoute(router, 'get', '/workspaces/:id/invoices', makeReq({ userRole: 'ADMIN' }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.invoices.length, 2);
  } finally { db.restore(); }
});

// 4. Update status
test('PATCH invoices/:invoiceId/status — OWNER can mark an invoice paid', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'OWNER' });
  try {
    const res = await callRoute(router, 'patch', '/workspaces/:id/invoices/:invoiceId/status', makeReq({ params: { id: '42', invoiceId: '7' }, body: { status: 'paid' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'paid');
  } finally { db.restore(); }
});

// 5. Workspace isolation — membership lookup is always scoped to :id, so a
// caller who isn't a member of workspace 42 gets 404, never another
// workspace's data.
test('workspace isolation — non-member of the target workspace gets 404, not another workspace\'s invoices', async () => {
  const db = installDb({ notMember: true });
  try {
    const res = await callRoute(router, 'get', '/workspaces/:id/invoices', makeReq({ userRole: 'ADMIN' }));
    assert.equal(res.statusCode, 404);
  } finally { db.restore(); }
});

// 6. Unauthorized / non-member access — VIEWER role is below OWNER for the
// mutating routes.
test('unauthorized — VIEWER cannot create an invoice (OWNER-only route)', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'VIEWER' });
  try {
    const res = await callRoute(router, 'post', '/workspaces/:id/invoices', makeReq({ userRole: 'VIEWER', body: { invoiceNumber: 'INV-002', currency: 'USD' } }));
    assert.equal(res.statusCode, 403);
  } finally { db.restore(); }
});

// 7. Invalid input
test('invalid input — missing invoiceNumber is rejected before hitting the service', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'OWNER' });
  try {
    const res = await callRoute(router, 'post', '/workspaces/:id/invoices', makeReq({ body: { currency: 'USD' } }));
    assert.equal(res.statusCode, 400);
  } finally { db.restore(); }
});

test('invalid input — bad status on PATCH is rejected with 400', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'OWNER' });
  try {
    const res = await callRoute(router, 'patch', '/workspaces/:id/invoices/:invoiceId/status', makeReq({ params: { id: '42', invoiceId: '7' }, body: { status: 'not_a_status' } }));
    assert.equal(res.statusCode, 400);
  } finally { db.restore(); }
});

// duplicate invoice number handled safely through the route too
test('duplicate invoice number — create returns a safe 409, not a raw DB error', async () => {
  const db = installDb({ workspaceId: 42, membershipRole: 'OWNER', duplicateInvoiceNumber: true });
  try {
    const res = await callRoute(router, 'post', '/workspaces/:id/invoices', makeReq({ body: { invoiceNumber: 'INV-001', currency: 'USD' } }));
    assert.equal(res.statusCode, 409);
    assert.ok(!/constraint/i.test(res.body.error));
  } finally { db.restore(); }
});

