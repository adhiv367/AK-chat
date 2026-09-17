'use strict';

// Phase 7.3 — Product Catalog route tests.
//
// Same "no live Postgres, no supertest/http" harness as
// test/usersSeatLimit.test.js: pool.query is monkey-patched and the route
// handler chain (requirePermission('products') -> handler) is invoked
// directly against router.stack. This exercises the actual permission gate,
// not just the service layer.

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/db');
const { router } = require('../src/routes/products');

function makeFakeDb() {
  let nextId = 1;
  const products = [];
  const variants = [];

  async function query(sqlRaw, params = []) {
    const sql = sqlRaw.replace(/\s+/g, ' ').trim();

    if (/^SELECT role, permissions FROM coexistence\.akchat_users WHERE id = \$1$/i.test(sql)) {
      return { rows: [{ role: params[0] === 1 ? 'OWNER' : 'VIEWER', permissions: null }] };
    }
    if (/^SELECT p\.\* FROM coexistence\.products p WHERE/i.test(sql)) {
      const rows = products.filter((p) => p.workspace_id === params[0]);
      const limit = params[params.length - 2];
      const offset = params[params.length - 1];
      return { rows: rows.slice(offset, offset + limit) };
    }
    if (/^SELECT COUNT\(\*\)::int AS count FROM coexistence\.products p WHERE/i.test(sql)) {
      return { rows: [{ count: products.filter((p) => p.workspace_id === params[0]).length }] };
    }
    if (/^SELECT \* FROM coexistence\.products WHERE id = \$1 AND workspace_id = \$2$/i.test(sql)) {
      const row = products.find((p) => p.id === Number(params[0]) && p.workspace_id === params[1]);
      return { rows: row ? [row] : [] };
    }
    if (/^SELECT id FROM coexistence\.products WHERE id = \$1 AND workspace_id = \$2$/i.test(sql)) {
      const row = products.find((p) => p.id === Number(params[0]) && p.workspace_id === params[1]);
      return { rows: row ? [{ id: row.id }] : [] };
    }
    if (/^INSERT INTO coexistence\.products \(/i.test(sql)) {
      const columns = sql.match(/\(([^)]+)\)/)[1].split(',').map((s) => s.trim());
      const row = { id: nextId++, created_at: new Date(), updated_at: new Date() };
      columns.forEach((col, idx) => { row[col] = params[idx]; });
      products.push(row);
      return { rows: [row] };
    }
    if (/^UPDATE coexistence\.products/i.test(sql)) {
      const id = Number(params[0]);
      const workspaceId = params[1];
      const row = products.find((p) => p.id === id && p.workspace_id === workspaceId);
      if (!row) return { rows: [] };
      if (/SET status = 'archived'/i.test(sql)) {
        row.status = 'archived';
      }
      return { rows: [row] };
    }
    if (/^SELECT \* FROM coexistence\.product_variants WHERE product_id = \$1 ORDER BY id ASC$/i.test(sql)) {
      return { rows: variants.filter((v) => v.product_id === Number(params[0])) };
    }

    return { rows: [] };
  }

  return { query, products, variants };
}

function installDb() {
  const fake = makeFakeDb();
  const original = pool.query;
  pool.query = fake.query;
  return { fake, restore() { pool.query = original; } };
}

// Minimal Express route-chain runner — same shape as test/usersSeatLimit.test.js.
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

function ownerReq(workspaceId, extra = {}) {
  return { user: { id: 1, role: 'OWNER' }, workspace: { id: workspaceId, role: 'OWNER' }, params: {}, query: {}, body: {}, ...extra };
}

function viewerReq(workspaceId, extra = {}) {
  return { user: { id: 2, role: 'VIEWER' }, workspace: { id: workspaceId, role: 'VIEWER' }, params: {}, query: {}, body: {}, ...extra };
}

test('OWNER can list products for their workspace', async () => {
  const db = installDb();
  try {
    const res = await callRoute(router, 'get', '/products', ownerReq(10));
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.body.items));
  } finally { db.restore(); }
});

test('VIEWER is forbidden from the products page (no "products" permission by default)', async () => {
  const db = installDb();
  try {
    const res = await callRoute(router, 'get', '/products', viewerReq(10));
    assert.equal(res.statusCode, 403);
  } finally { db.restore(); }
});

test('OWNER can create a product; workspace_id is taken from req.workspace, never the body', async () => {
  const db = installDb();
  try {
    const req = ownerReq(10, { body: { name: 'Trojan Product', workspace_id: 99999 } });
    const res = await callRoute(router, 'post', '/products', req);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.workspace_id, 10, 'server-derived workspace_id must win over any client-supplied value');
  } finally { db.restore(); }
});

test('POST /products with no name returns 400', async () => {
  const db = installDb();
  try {
    const res = await callRoute(router, 'post', '/products', ownerReq(10, { body: {} }));
    assert.equal(res.statusCode, 400);
  } finally { db.restore(); }
});

test('GET /products/:id for another workspace\'s product returns 404, not another workspace\'s data', async () => {
  const db = installDb();
  try {
    const created = await callRoute(router, 'post', '/products', ownerReq(2002, { body: { name: 'Workspace B product' } }));
    const productId = created.body.id;

    const res = await callRoute(router, 'get', '/products/:id', ownerReq(1001, { params: { id: String(productId) } }));
    assert.equal(res.statusCode, 404);
  } finally { db.restore(); }
});

test('DELETE /products/:id archives rather than 404s a real row, and rejects a cross-workspace id', async () => {
  const db = installDb();
  try {
    const created = await callRoute(router, 'post', '/products', ownerReq(10, { body: { name: 'To Archive' } }));
    const productId = created.body.id;

    const otherWorkspace = await callRoute(router, 'delete', '/products/:id', ownerReq(2002, { params: { id: String(productId) } }));
    assert.equal(otherWorkspace.statusCode, 404);

    const sameWorkspace = await callRoute(router, 'delete', '/products/:id', ownerReq(10, { params: { id: String(productId) } }));
    assert.equal(sameWorkspace.statusCode, 200);
    assert.equal(sameWorkspace.body.product.status, 'archived');
  } finally { db.restore(); }
});

test('GET /products/:id/variants for a product outside the workspace returns 404', async () => {
  const db = installDb();
  try {
    const created = await callRoute(router, 'post', '/products', ownerReq(2002, { body: { name: 'B product' } }));
    const res = await callRoute(router, 'get', '/products/:id/variants', ownerReq(1001, { params: { id: String(created.body.id) } }));
    assert.equal(res.statusCode, 404);
  } finally { db.restore(); }
});