'use strict';

// Phase 7.8 — Orders route tests.
//
// Same harness as test/productsRoutes.test.js: pool.query is monkey-patched
// and the route handler chain (requirePermission('orders') -> handler) is
// invoked directly against router.stack — no live Postgres, no supertest.
// Covers the full routes/orders.js surface (GET list, GET by id, and the
// new Phase 7.8 PATCH), with particular attention to permission gating and
// workspace isolation on the new write route.

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/db');
const { router } = require('../src/routes/orders');

function makeFakeDb() {
  let nextId = 1;
  const orders = [];
  const orderItems = [];

  async function query(sqlRaw, params = []) {
    const sql = sqlRaw.replace(/\s+/g, ' ').trim();

    if (/^SELECT role, permissions FROM coexistence\.akchat_users WHERE id = \$1$/i.test(sql)) {
      return { rows: [{ role: params[0] === 1 ? 'OWNER' : 'VIEWER', permissions: null }] };
    }

    if (/^INSERT INTO coexistence\.orders/i.test(sql)) {
      const [workspaceId, whatsappAccountId, contactNumber, cartId, externalOrderId,
        orderNumber, currency, subtotal, source] = params;
      const row = {
        id: nextId++,
        workspace_id: workspaceId,
        whatsapp_account_id: whatsappAccountId,
        contact_number: contactNumber,
        cart_id: cartId,
        external_order_id: externalOrderId,
        order_number: orderNumber,
        currency,
        subtotal,
        total_amount: subtotal,
        payment_status: 'pending',
        fulfillment_status: 'unfulfilled',
        order_status: 'open',
        source,
        created_at: new Date(),
        updated_at: new Date(),
      };
      orders.push(row);
      return { rows: [row] };
    }

    if (/^SELECT \* FROM coexistence\.orders WHERE workspace_id = \$1/i.test(sql)) {
      let rows = orders.filter((o) => o.workspace_id === params[0]);
      const limit = params[params.length - 2];
      const offset = params[params.length - 1];
      return { rows: rows.slice(offset, offset + limit) };
    }
    if (/^SELECT COUNT\(\*\)::int AS count FROM coexistence\.orders WHERE workspace_id = \$1/i.test(sql)) {
      return { rows: [{ count: orders.filter((o) => o.workspace_id === params[0]).length }] };
    }
    if (/^SELECT \* FROM coexistence\.orders WHERE id = \$1 AND workspace_id = \$2$/i.test(sql)) {
      const row = orders.find((o) => o.id === Number(params[0]) && o.workspace_id === params[1]);
      return { rows: row ? [row] : [] };
    }
    if (/^UPDATE coexistence\.orders SET /i.test(sql)) {
      const id = Number(params[params.length - 2]);
      const workspaceId = params[params.length - 1];
      const row = orders.find((o) => o.id === id && o.workspace_id === workspaceId);
      if (!row) return { rows: [] };
      const setSql = sql.match(/^UPDATE coexistence\.orders SET (.+) WHERE/i)[1];
      const assignments = setSql.split(',').map((s) => s.trim());
      let paramIdx = 0;
      assignments.forEach((assign) => {
        const col = assign.split('=')[0].trim();
        if (col === 'updated_at') { row.updated_at = new Date(); return; }
        row[col] = params[paramIdx];
        paramIdx++;
      });
      return { rows: [row] };
    }

    if (/^INSERT INTO coexistence\.order_items/i.test(sql)) {
      const [orderId, productId, variantId, productName, sku, quantity, unitPrice, totalPrice] = params;
      const row = {
        id: nextId++, order_id: orderId, product_id: productId, variant_id: variantId,
        product_name: productName, sku, quantity, unit_price: unitPrice, total_price: totalPrice,
        created_at: new Date(), updated_at: new Date(),
      };
      orderItems.push(row);
      return { rows: [row] };
    }
    if (/^SELECT \* FROM coexistence\.order_items WHERE order_id = \$1 ORDER BY created_at ASC$/i.test(sql)) {
      return { rows: orderItems.filter((it) => it.order_id === Number(params[0])) };
    }

    return { rows: [] };
  }

  return { query, orders, orderItems };
}

function installDb() {
  const fake = makeFakeDb();
  const original = pool.query;
  pool.query = fake.query;
  return { fake, restore() { pool.query = original; } };
}

// Minimal Express route-chain runner — same shape as test/productsRoutes.test.js.
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

async function seedOrder(db, workspaceId, contactNumber = '15550001111') {
  const { rows } = await db.query(
    `INSERT INTO coexistence.orders
        (workspace_id, whatsapp_account_id, contact_number, cart_id, external_order_id,
         order_number, currency, subtotal, total_amount, payment_status, fulfillment_status,
         order_status, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,'pending','unfulfilled','open',$9)`,
    [workspaceId, null, contactNumber, null, null, 'WA-TEST', 'USD', 100, 'manual']
  );
  return rows[0];
}

// ── GET routes (pre-existing behaviour — regression coverage) ──────────

test('OWNER can list orders for their workspace', async () => {
  const db = installDb();
  try {
    await seedOrder(db.fake, 10);
    const res = await callRoute(router, 'get', '/orders', ownerReq(10));
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.body.items));
    assert.equal(res.body.items.length, 1);
  } finally { db.restore(); }
});

test('VIEWER is forbidden from the orders page (no "orders" permission by default)', async () => {
  const db = installDb();
  try {
    const res = await callRoute(router, 'get', '/orders', viewerReq(10));
    assert.equal(res.statusCode, 403);
  } finally { db.restore(); }
});

test('GET /orders/:id for another workspace\'s order returns 404, not another workspace\'s data', async () => {
  const db = installDb();
  try {
    const orderB = await seedOrder(db.fake, 2002);
    const res = await callRoute(router, 'get', '/orders/:id', ownerReq(1001, { params: { id: String(orderB.id) } }));
    assert.equal(res.statusCode, 404);
  } finally { db.restore(); }
});

// ── PATCH /orders/:id (Phase 7.8) ────────────────────────────────────────

test('OWNER can update order_status via PATCH', async () => {
  const db = installDb();
  try {
    const order = await seedOrder(db.fake, 10);
    const res = await callRoute(router, 'patch', '/orders/:id', ownerReq(10, {
      params: { id: String(order.id) },
      body: { orderStatus: 'closed' },
    }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.order_status, 'closed');
  } finally { db.restore(); }
});

test('OWNER can update paymentStatus and fulfillmentStatus together via PATCH', async () => {
  const db = installDb();
  try {
    const order = await seedOrder(db.fake, 10);
    const res = await callRoute(router, 'patch', '/orders/:id', ownerReq(10, {
      params: { id: String(order.id) },
      body: { paymentStatus: 'paid', fulfillmentStatus: 'fulfilled' },
    }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.payment_status, 'paid');
    assert.equal(res.body.fulfillment_status, 'fulfilled');
  } finally { db.restore(); }
});

test('PATCH /orders/:id with an invalid status returns 400', async () => {
  const db = installDb();
  try {
    const order = await seedOrder(db.fake, 10);
    const res = await callRoute(router, 'patch', '/orders/:id', ownerReq(10, {
      params: { id: String(order.id) },
      body: { orderStatus: 'not-a-real-status' },
    }));
    assert.equal(res.statusCode, 400);
  } finally { db.restore(); }
});

test('PATCH /orders/:id with no status fields returns 400', async () => {
  const db = installDb();
  try {
    const order = await seedOrder(db.fake, 10);
    const res = await callRoute(router, 'patch', '/orders/:id', ownerReq(10, {
      params: { id: String(order.id) },
      body: {},
    }));
    assert.equal(res.statusCode, 400);
  } finally { db.restore(); }
});

test('PATCH /orders/:id for a non-existent order returns 404', async () => {
  const db = installDb();
  try {
    const res = await callRoute(router, 'patch', '/orders/:id', ownerReq(10, {
      params: { id: '999999' },
      body: { orderStatus: 'closed' },
    }));
    assert.equal(res.statusCode, 404);
  } finally { db.restore(); }
});

test('VIEWER is forbidden from PATCH /orders/:id (write blocked by the same "orders" gate as reads)', async () => {
  const db = installDb();
  try {
    const order = await seedOrder(db.fake, 10);
    const res = await callRoute(router, 'patch', '/orders/:id', viewerReq(10, {
      params: { id: String(order.id) },
      body: { orderStatus: 'closed' },
    }));
    assert.equal(res.statusCode, 403);
  } finally { db.restore(); }
});

test('Workspace A cannot PATCH Workspace B\'s order (404, not a cross-tenant write) — workspace_id is never taken from the body', async () => {
  const db = installDb();
  try {
    const orderB = await seedOrder(db.fake, 2002, '15559998888');
    const res = await callRoute(router, 'patch', '/orders/:id', ownerReq(1001, {
      params: { id: String(orderB.id) },
      // Even if a malicious/buggy client sent a workspaceId in the body,
      // the route must never read it — getWorkspaceId() always derives
      // from req.workspace.
      body: { orderStatus: 'closed', workspaceId: 2002 },
    }));
    assert.equal(res.statusCode, 404);

    // Confirm Workspace B's row was genuinely untouched.
    const stillOpen = db.fake.orders.find((o) => o.id === orderB.id);
    assert.equal(stillOpen.order_status, 'open');
  } finally { db.restore(); }
});

test('PATCH does not require a request without a workspace context to crash the route (403, not 500)', async () => {
  const db = installDb();
  try {
    const req = { user: { id: 1, role: 'OWNER' }, workspace: null, params: { id: '1' }, query: {}, body: { orderStatus: 'closed' } };
    const res = await callRoute(router, 'patch', '/orders/:id', req);
    assert.equal(res.statusCode, 403);
  } finally { db.restore(); }
});