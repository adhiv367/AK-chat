'use strict';

// Phase 7.8 — Orders: orderService status-update tests.
//
// Scope: only the NEW Phase 7.8 surface — updateOrderStatus()/cancelOrder().
// checkout()/createOrderFromWhatsappMessage() are Phase 7.7, frozen, and
// exercised here only as fixtures (to get an order row to update), not
// re-tested for their own behaviour.
//
// Same "no live Postgres" fake-db harness as test/productService.test.js:
// pool.query is monkey-patched with a small in-memory model of exactly the
// SQL orderService.js issues. Every isolation test below uses at least two
// workspaces (never a single hardcoded tenant), per repo convention.

const test = require('node:test');
const assert = require('node:assert/strict');

function makeFakeDb() {
  let nextId = 1;
  const orders = [];
  const orderItems = [];

  function query(sqlRaw, params = []) {
    const sql = sqlRaw.replace(/\s+/g, ' ').trim();

    // ── orders: create (createOrderRecord) ──────────────────────────────
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
        shipping_name: null, shipping_address: null, shipping_city: null,
        shipping_state: null, shipping_postal_code: null, shipping_country: null,
        shipping_phone: null,
        shopify_order_id: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      orders.push(row);
      return { rows: [row] };
    }

    // ── orders: read by id + workspace (getOrderWithItems) ──────────────
    if (/^SELECT \* FROM coexistence\.orders WHERE id = \$1 AND workspace_id = \$2$/i.test(sql)) {
      const row = orders.find((o) => o.id === Number(params[0]) && o.workspace_id === params[1]);
      return { rows: row ? [row] : [] };
    }

    // ── orders: Phase 7.8 status update ──────────────────────────────────
    if (/^UPDATE coexistence\.orders SET /i.test(sql)) {
      // Last two params are always (id, workspaceId) per updateOrderStatus().
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

    // ── order_items: create ──────────────────────────────────────────────
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

    // ── order_items: read by order ────────────────────────────────────────
    if (/^SELECT \* FROM coexistence\.order_items WHERE order_id = \$1 ORDER BY created_at ASC$/i.test(sql)) {
      return { rows: orderItems.filter((it) => it.order_id === Number(params[0])) };
    }

    throw new Error(`Unhandled fake SQL: ${sql}`);
  }

  // A fake transactional client — matches pool.connect()'s shape
  // (BEGIN/COMMIT/ROLLBACK are no-ops against this in-memory model; every
  // real statement is routed through the same `query` fn above).
  function connect() {
    return Promise.resolve({
      query: (sql, params) => {
        if (/^BEGIN$|^COMMIT$|^ROLLBACK$/i.test(sql.trim())) return Promise.resolve({ rows: [] });
        return Promise.resolve(query(sql, params));
      },
      release: () => {},
    });
  }

  return { query, connect, orders, orderItems };
}

function withFakeDb(run) {
  return async () => {
    const pool = require('../src/db');
    const fake = makeFakeDb();
    const originalQuery = pool.query;
    const originalConnect = pool.connect;
    pool.query = fake.query;
    pool.connect = fake.connect;
    try {
      delete require.cache[require.resolve('../src/services/orderService')];
      const svc = require('../src/services/orderService');
      await run(svc, fake);
    } finally {
      pool.query = originalQuery;
      pool.connect = originalConnect;
    }
  };
}

// Directly creates an order row via the fake db, bypassing checkout()/
// createOrderFromWhatsappMessage() (Phase 7.7, frozen, not under test here)
// so each test gets a minimal fixture without depending on cartService.
async function seedOrder(svc, fake, workspaceId, overrides = {}) {
  const { rows } = await fake.query(
    `INSERT INTO coexistence.orders
        (workspace_id, whatsapp_account_id, contact_number, cart_id, external_order_id,
         order_number, currency, subtotal, total_amount, payment_status, fulfillment_status,
         order_status, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,'pending','unfulfilled','open',$9)`,
    [
      workspaceId, null, overrides.contactNumber || '15550001111', null, null,
      'WA-TEST', 'USD', 100, overrides.source || 'manual',
    ]
  );
  const order = rows[0];
  await fake.query(
    `INSERT INTO coexistence.order_items
        (order_id, product_id, variant_id, product_name, sku, quantity, unit_price, total_price)`,
    [order.id, null, null, 'Test Product', 'SKU-1', 2, 50, 100]
  );
  return order;
}

// ── updateOrderStatus ──────────────────────────────────────────────────

test('updateOrderStatus updates order_status only, leaving other fields untouched', withFakeDb(async (svc, fake) => {
  const order = await seedOrder(svc, fake, 10);
  const updated = await svc.updateOrderStatus(10, order.id, { orderStatus: 'closed' });
  assert.equal(updated.order_status, 'closed');
  assert.equal(updated.payment_status, 'pending');
  assert.equal(updated.fulfillment_status, 'unfulfilled');
}));

test('updateOrderStatus updates payment_status and fulfillment_status together', withFakeDb(async (svc, fake) => {
  const order = await seedOrder(svc, fake, 10);
  const updated = await svc.updateOrderStatus(10, order.id, {
    paymentStatus: 'paid',
    fulfillmentStatus: 'fulfilled',
  });
  assert.equal(updated.payment_status, 'paid');
  assert.equal(updated.fulfillment_status, 'fulfilled');
  assert.equal(updated.order_status, 'open', 'order_status untouched when not passed');
}));

test('updateOrderStatus returns the order with its items intact', withFakeDb(async (svc, fake) => {
  const order = await seedOrder(svc, fake, 10);
  const updated = await svc.updateOrderStatus(10, order.id, { orderStatus: 'closed' });
  assert.equal(updated.items.length, 1);
  assert.equal(updated.items[0].product_name, 'Test Product');
}));

test('updateOrderStatus rejects an invalid orderStatus', withFakeDb(async (svc, fake) => {
  const order = await seedOrder(svc, fake, 10);
  await assert.rejects(
    () => svc.updateOrderStatus(10, order.id, { orderStatus: 'bogus' }),
    (err) => err.status === 400
  );
}));

test('updateOrderStatus rejects an invalid paymentStatus', withFakeDb(async (svc, fake) => {
  const order = await seedOrder(svc, fake, 10);
  await assert.rejects(
    () => svc.updateOrderStatus(10, order.id, { paymentStatus: 'not-a-status' }),
    (err) => err.status === 400
  );
}));

test('updateOrderStatus rejects an invalid fulfillmentStatus', withFakeDb(async (svc, fake) => {
  const order = await seedOrder(svc, fake, 10);
  await assert.rejects(
    () => svc.updateOrderStatus(10, order.id, { fulfillmentStatus: 'not-a-status' }),
    (err) => err.status === 400
  );
}));

test('updateOrderStatus rejects an empty update (no fields passed)', withFakeDb(async (svc, fake) => {
  const order = await seedOrder(svc, fake, 10);
  await assert.rejects(
    () => svc.updateOrderStatus(10, order.id, {}),
    (err) => err.status === 400
  );
}));

test('updateOrderStatus requires a workspaceId', withFakeDb(async (svc) => {
  await assert.rejects(
    () => svc.updateOrderStatus(null, 1, { orderStatus: 'closed' }),
    (err) => err.status === 400
  );
}));

test('updateOrderStatus requires an orderId', withFakeDb(async (svc) => {
  await assert.rejects(
    () => svc.updateOrderStatus(10, null, { orderStatus: 'closed' }),
    (err) => err.status === 400
  );
}));

test('updateOrderStatus 404s for an order that does not exist', withFakeDb(async (svc) => {
  await assert.rejects(
    () => svc.updateOrderStatus(10, 999999, { orderStatus: 'closed' }),
    (err) => err.status === 404
  );
}));

// ── Workspace isolation (two tenants, never one hardcoded tenant) ───────

test('Workspace A cannot update Workspace B\'s order (404, not a cross-tenant write)', withFakeDb(async (svc, fake) => {
  const orderB = await seedOrder(svc, fake, 2002, { contactNumber: '15559998888' });
  await assert.rejects(
    () => svc.updateOrderStatus(1001, orderB.id, { orderStatus: 'closed' }),
    (err) => err.status === 404
  );
  // Confirm the row itself was never mutated by the rejected attempt.
  const stillOpen = fake.orders.find((o) => o.id === orderB.id);
  assert.equal(stillOpen.order_status, 'open');
}));

test('Workspace A updating its own order never affects Workspace B\'s otherwise-identical order', withFakeDb(async (svc, fake) => {
  const orderA = await seedOrder(svc, fake, 1001, { contactNumber: '15551112222' });
  const orderB = await seedOrder(svc, fake, 2002, { contactNumber: '15551112222' });

  await svc.updateOrderStatus(1001, orderA.id, { orderStatus: 'cancelled' });

  const refreshedB = await svc.getOrder(2002, orderB.id);
  assert.equal(refreshedB.order_status, 'open', 'Workspace B order untouched');
}));

// ── cancelOrder ───────────────────────────────────────────────────────

test('cancelOrder sets order_status to cancelled and leaves payment/fulfillment alone', withFakeDb(async (svc, fake) => {
  const order = await seedOrder(svc, fake, 10);
  const cancelled = await svc.cancelOrder(10, order.id);
  assert.equal(cancelled.order_status, 'cancelled');
  assert.equal(cancelled.payment_status, 'pending');
  assert.equal(cancelled.fulfillment_status, 'unfulfilled');
}));

test('cancelOrder 404s for a cross-workspace order id', withFakeDb(async (svc, fake) => {
  const orderB = await seedOrder(svc, fake, 2002);
  await assert.rejects(() => svc.cancelOrder(1001, orderB.id), (err) => err.status === 404);
}));