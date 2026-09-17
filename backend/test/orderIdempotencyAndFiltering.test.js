'use strict';

// Phase 7.10A — FIX 3 & FIX 5 (order side).
//
// FIX 3: createOrderFromWhatsappMessage() must be idempotent per
// (workspace_id, wa_message_id) — a redelivered Meta webhook for the same
// message must reuse the existing order and must NOT create duplicate
// order_items.
// FIX 5: listOrders() gains an optional whatsappAccountId filter, validated
// against the caller's own workspace, alongside the existing contactNumber
// filter.
//
// Same "no live Postgres" fake-db harness as test/orderService.test.js.
// The fake ON CONFLICT emulation below only models the exact partial
// unique index this phase adds — (workspace_id, wa_message_id) WHERE
// wa_message_id IS NOT NULL — not a general-purpose SQL engine.

const test = require('node:test');
const assert = require('node:assert/strict');

function makeFakeDb() {
  let nextId = 1;
  const orders = [];
  const orderItems = [];
  const accounts = [
    { id: 100, workspace_id: 10, access_token_encrypted: null, is_active: true },
    { id: 200, workspace_id: 20, access_token_encrypted: null, is_active: true },
  ];

  function query(sqlRaw, params = []) {
    const sql = sqlRaw.replace(/\s+/g, ' ').trim();

    // ── whatsapp_accounts ownership lookup (getAccountWithToken) ────────
    if (/^SELECT \* FROM coexistence\.whatsapp_accounts WHERE id = \$1 AND \(\$2::bigint IS NULL OR workspace_id = \$2\)$/i.test(sql)) {
      const [id, workspaceId] = params;
      const row = accounts.find(a => a.id === Number(id) && (workspaceId == null || a.workspace_id === workspaceId));
      return { rows: row ? [row] : [] };
    }

    // ── best-effort active-cart lookup inside createOrderFromWhatsappMessage ──
    if (/^SELECT id FROM coexistence\.carts/i.test(sql)) {
      return { rows: [] };
    }

    // ── orders: create (createOrderRecord), with the new ON CONFLICT ─────
    if (/^INSERT INTO coexistence\.orders/i.test(sql)) {
      const [workspaceId, whatsappAccountId, contactNumber, cartId, externalOrderId,
        waMessageId, orderNumber, currency, subtotal, source] = params;

      if (waMessageId != null) {
        const conflict = orders.find(o => o.workspace_id === workspaceId && o.wa_message_id === waMessageId);
        if (conflict) return { rows: [] }; // ON CONFLICT ... DO NOTHING
      }

      const row = {
        id: nextId++,
        workspace_id: workspaceId,
        whatsapp_account_id: whatsappAccountId,
        contact_number: contactNumber,
        cart_id: cartId,
        external_order_id: externalOrderId,
        wa_message_id: waMessageId,
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

    // ── orders: fetch-existing-on-conflict (FIX 3) ────────────────────────
    if (/^SELECT \* FROM coexistence\.orders WHERE workspace_id = \$1 AND wa_message_id = \$2$/i.test(sql)) {
      const [workspaceId, waMessageId] = params;
      const row = orders.find(o => o.workspace_id === workspaceId && o.wa_message_id === waMessageId);
      return { rows: row ? [row] : [] };
    }

    // ── orders: read by id + workspace (getOrderWithItems) ──────────────
    if (/^SELECT \* FROM coexistence\.orders WHERE id = \$1 AND workspace_id = \$2$/i.test(sql)) {
      const row = orders.find((o) => o.id === Number(params[0]) && o.workspace_id === params[1]);
      return { rows: row ? [row] : [] };
    }

    // ── orders: list (listOrders, FIX 5) ─────────────────────────────────
    if (/^SELECT \* FROM coexistence\.orders WHERE /i.test(sql) && /ORDER BY created_at DESC/i.test(sql)) {
      let rows = orders.filter(o => o.workspace_id === params[0]);
      const whereClause = sql.slice(sql.indexOf('WHERE') + 5, sql.indexOf('ORDER BY'));
      const conditions = whereClause.split('AND').map(s => s.trim()).filter(Boolean);
      let paramIdx = 1;
      for (const cond of conditions.slice(1)) {
        const val = params[paramIdx];
        if (cond.startsWith('contact_number')) rows = rows.filter(o => o.contact_number === val);
        else if (cond.startsWith('order_status')) rows = rows.filter(o => o.order_status === val);
        else if (cond.startsWith('payment_status')) rows = rows.filter(o => o.payment_status === val);
        else if (cond.startsWith('source')) rows = rows.filter(o => o.source === val);
        else if (cond.startsWith('whatsapp_account_id')) rows = rows.filter(o => o.whatsapp_account_id === val);
        paramIdx++;
      }
      return { rows };
    }
    if (/^SELECT COUNT\(\*\)/i.test(sql)) {
      return { rows: [{ count: String(orders.filter(o => o.workspace_id === params[0]).length) }] };
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

  function connect() {
    return Promise.resolve({
      query: (sql, params) => {
        if (/^BEGIN$|^COMMIT$|^ROLLBACK$/i.test(sql.trim())) return Promise.resolve({ rows: [] });
        return Promise.resolve(query(sql, params));
      },
      release: () => {},
    });
  }

  return { query, connect, orders, orderItems, accounts };
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
      delete require.cache[require.resolve('../src/services/cartService')];
      delete require.cache[require.resolve('../src/routes/whatsappAccounts')];
      const svc = require('../src/services/orderService');
      await run(svc, fake);
    } finally {
      pool.query = originalQuery;
      pool.connect = originalConnect;
    }
  };
}

function waOrder(retailerId = null) {
  return {
    catalog_id: 'cat-1',
    product_items: [
      { product_retailer_id: retailerId, quantity: 2, item_price: 25, currency: 'USD' },
    ],
    text: 'Order text',
  };
}

// ── FIX 3: idempotency ──────────────────────────────────────────────────

test('a redelivered WhatsApp order webhook (same message_id) creates only one order', withFakeDb(async (svc, fake) => {
  const first = await svc.createOrderFromWhatsappMessage(10, {
    whatsappAccountId: 100, contactNumber: '15551234567', waOrder: waOrder(), waMessageId: 'wamid.ORDER1',
  });
  const second = await svc.createOrderFromWhatsappMessage(10, {
    whatsappAccountId: 100, contactNumber: '15551234567', waOrder: waOrder(), waMessageId: 'wamid.ORDER1',
  });

  assert.equal(first.id, second.id, 'redelivery must return the same order');
  const ordersForMessage = fake.orders.filter(o => o.wa_message_id === 'wamid.ORDER1');
  assert.equal(ordersForMessage.length, 1, 'only one order row should exist for this message_id');
}));

test('a redelivered WhatsApp order webhook does not duplicate order_items', withFakeDb(async (svc, fake) => {
  await svc.createOrderFromWhatsappMessage(10, {
    whatsappAccountId: 100, contactNumber: '15551234567', waOrder: waOrder(), waMessageId: 'wamid.ORDER2',
  });
  await svc.createOrderFromWhatsappMessage(10, {
    whatsappAccountId: 100, contactNumber: '15551234567', waOrder: waOrder(), waMessageId: 'wamid.ORDER2',
  });

  const order = fake.orders.find(o => o.wa_message_id === 'wamid.ORDER2');
  const items = fake.orderItems.filter(it => it.order_id === order.id);
  assert.equal(items.length, 1, 'order_items must not be duplicated on redelivery');
}));

test('two different message_ids create two separate orders', withFakeDb(async (svc, fake) => {
  await svc.createOrderFromWhatsappMessage(10, {
    whatsappAccountId: 100, contactNumber: '15551234567', waOrder: waOrder(), waMessageId: 'wamid.A',
  });
  await svc.createOrderFromWhatsappMessage(10, {
    whatsappAccountId: 100, contactNumber: '15551234567', waOrder: waOrder(), waMessageId: 'wamid.B',
  });
  assert.equal(fake.orders.length, 2);
}));

test('idempotency is scoped per workspace, not global (FIX 3 must not use a global-unique key)', withFakeDb(async (svc, fake) => {
  await svc.createOrderFromWhatsappMessage(10, {
    whatsappAccountId: 100, contactNumber: '15551234567', waOrder: waOrder(), waMessageId: 'wamid.SHARED',
  });
  // A different workspace legitimately reusing the same message_id string
  // (e.g. two tenants both forwarded the same n8n batch) must get its own
  // order, not be silently deduped against workspace 10's.
  await svc.createOrderFromWhatsappMessage(20, {
    whatsappAccountId: 200, contactNumber: '15559998888', waOrder: waOrder(), waMessageId: 'wamid.SHARED',
  });
  const withSharedId = fake.orders.filter(o => o.wa_message_id === 'wamid.SHARED');
  assert.equal(withSharedId.length, 2);
  assert.deepEqual(withSharedId.map(o => o.workspace_id).sort(), [10, 20]);
}));

// ── FIX 5: order filtering by contact + WhatsApp account ─────────────────

test('listOrders filters by contactNumber and whatsappAccountId together', withFakeDb(async (svc) => {
  await svc.createOrderFromWhatsappMessage(10, {
    whatsappAccountId: 100, contactNumber: '15551111111', waOrder: waOrder(), waMessageId: 'wamid.L1',
  });
  await svc.createOrderFromWhatsappMessage(10, {
    whatsappAccountId: 100, contactNumber: '15552222222', waOrder: waOrder(), waMessageId: 'wamid.L2',
  });

  const result = await svc.listOrders(10, { contactNumber: '15551111111', whatsappAccountId: 100 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].contact_number, '15551111111');
}));

test('listOrders with only contactNumber (no whatsappAccountId) keeps working exactly as before', withFakeDb(async (svc) => {
  await svc.createOrderFromWhatsappMessage(10, {
    whatsappAccountId: 100, contactNumber: '15553333333', waOrder: waOrder(), waMessageId: 'wamid.L3',
  });
  const result = await svc.listOrders(10, { contactNumber: '15553333333' });
  assert.equal(result.items.length, 1);
}));

// ── Cross-workspace isolation ────────────────────────────────────────────

test('listOrders rejects a whatsappAccountId belonging to another workspace', withFakeDb(async (svc) => {
  await assert.rejects(
    () => svc.listOrders(10, { whatsappAccountId: 200 }),
    (err) => err.status === 400
  );
}));

test('listOrders never returns another workspace\'s orders for the same contact number', withFakeDb(async (svc) => {
  await svc.createOrderFromWhatsappMessage(10, {
    whatsappAccountId: 100, contactNumber: '15554444444', waOrder: waOrder(), waMessageId: 'wamid.ISO1',
  });
  await svc.createOrderFromWhatsappMessage(20, {
    whatsappAccountId: 200, contactNumber: '15554444444', waOrder: waOrder(), waMessageId: 'wamid.ISO2',
  });

  const resultA = await svc.listOrders(10, { contactNumber: '15554444444' });
  assert.equal(resultA.items.length, 1);
  assert.equal(resultA.items[0].workspace_id, 10);
}));