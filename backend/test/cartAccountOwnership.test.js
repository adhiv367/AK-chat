'use strict';

// Phase 7.10A — FIX 4 & FIX 5 (cart side).
//
// FIX 4: getOrCreateActiveCart() must reject a whatsappAccountId that
// belongs to a different workspace (or doesn't exist), rather than trusting
// it blindly.
// FIX 5: listCarts() gains an optional whatsappAccountId filter, alongside
// contactNumber — existing contactNumber-only callers keep working, and a
// supplied whatsappAccountId is validated + never leaks cross-workspace.
//
// Same "no live Postgres" fake-db harness as test/orderService.test.js:
// pool.query is monkey-patched with a small in-memory model of exactly the
// SQL cartService.js (and the whatsapp_accounts ownership lookup it now
// reuses) issues.

const test = require('node:test');
const assert = require('node:assert/strict');

function makeFakeDb() {
  let nextId = 1;
  const carts = [];

  // Two WhatsApp accounts in two different workspaces.
  const accounts = [
    { id: 100, workspace_id: 10, access_token_encrypted: null, is_active: true },
    { id: 200, workspace_id: 20, access_token_encrypted: null, is_active: true },
  ];

  async function query(sqlRaw, params = []) {
    const sql = sqlRaw.replace(/\s+/g, ' ').trim();

    // ── whatsapp_accounts ownership lookup (getAccountWithToken) ────────
    if (/^SELECT \* FROM coexistence\.whatsapp_accounts WHERE id = \$1 AND \(\$2::bigint IS NULL OR workspace_id = \$2\)$/i.test(sql)) {
      const [id, workspaceId] = params;
      const row = accounts.find(a => a.id === Number(id) && (workspaceId == null || a.workspace_id === workspaceId));
      return { rows: row ? [row] : [] };
    }

    // ── carts: find active for contact+account ───────────────────────────
    if (/^SELECT \* FROM coexistence\.carts\s+WHERE workspace_id = \$1 AND contact_number = \$2 AND status = 'active'/i.test(sql)) {
      const [workspaceId, contactNumber, whatsappAccountId] = params;
      const row = carts.find(c =>
        c.workspace_id === workspaceId && c.contact_number === contactNumber && c.status === 'active' &&
        (whatsappAccountId == null ? c.whatsapp_account_id == null : c.whatsapp_account_id === whatsappAccountId)
      );
      return { rows: row ? [row] : [] };
    }

    // ── carts: create ─────────────────────────────────────────────────
    if (/^INSERT INTO coexistence\.carts/i.test(sql)) {
      const [workspaceId, whatsappAccountId, contactNumber] = params;
      const row = {
        id: nextId++, workspace_id: workspaceId, whatsapp_account_id: whatsappAccountId,
        contact_number: contactNumber, status: 'active', currency: null, total_amount: 0,
        created_at: new Date(), updated_at: new Date(),
      };
      carts.push(row);
      return { rows: [row] };
    }

    // ── carts: read by id (getCartWithItems) ─────────────────────────────
    if (/^SELECT \* FROM coexistence\.carts WHERE id = \$1 AND workspace_id = \$2$/i.test(sql)) {
      const row = carts.find(c => c.id === Number(params[0]) && c.workspace_id === params[1]);
      return { rows: row ? [row] : [] };
    }

    // ── carts: list (listCarts) ─────────────────────────────────────────
    if (/^SELECT \* FROM coexistence\.carts WHERE /i.test(sql)) {
      // Rebuild the WHERE-clause filtering generically: workspace_id is
      // always $1; remaining params match in the same order they were
      // pushed by listCarts (contactNumber, status, whatsappAccountId —
      // whichever were supplied).
      let rows = carts.filter(c => c.workspace_id === params[0]);
      const whereClause = sql.slice(sql.indexOf('WHERE') + 5, sql.indexOf('ORDER BY'));
      const conditions = whereClause.split('AND').map(s => s.trim()).filter(Boolean);
      let paramIdx = 1; // params[0] is workspace_id
      for (const cond of conditions.slice(1)) {
        const val = params[paramIdx];
        if (cond.startsWith('contact_number')) rows = rows.filter(c => c.contact_number === val);
        else if (cond.startsWith('status')) rows = rows.filter(c => c.status === val);
        else if (cond.startsWith('whatsapp_account_id')) rows = rows.filter(c => c.whatsapp_account_id === val);
        paramIdx++;
      }
      return { rows };
    }

    // ── cart_items: read (getCartWithItems join) ──────────────────────────
    if (/^SELECT ci\.\*/i.test(sql)) {
      return { rows: [] };
    }

    throw new Error(`Unhandled fake SQL: ${sql}`);
  }

  return { query, carts, accounts };
}

function withFakeDb(run) {
  return async () => {
    const pool = require('../src/db');
    const fake = makeFakeDb();
    const original = pool.query;
    pool.query = fake.query;
    try {
      delete require.cache[require.resolve('../src/services/cartService')];
      delete require.cache[require.resolve('../src/routes/whatsappAccounts')];
      const svc = require('../src/services/cartService');
      await run(svc, fake);
    } finally {
      pool.query = original;
    }
  };
}

// ── FIX 1 (numeric ID contract, exercised indirectly): a numeric
//    whatsappAccountId is accepted and stored on the created cart. ───────
test('getOrCreateActiveCart stores the numeric whatsappAccountId on a new cart', withFakeDb(async (svc) => {
  const cart = await svc.getOrCreateActiveCart(10, { contactNumber: '15551234567', whatsappAccountId: 100 });
  assert.equal(cart.whatsapp_account_id, 100);
  assert.equal(typeof cart.whatsapp_account_id, 'number');
}));

// ── FIX 4: cross-workspace whatsappAccountId is rejected ────────────────
test('getOrCreateActiveCart rejects a whatsappAccountId belonging to another workspace', withFakeDb(async (svc) => {
  // Account 200 belongs to workspace 20 — workspace 10 must not be able to
  // create/read a cart scoped to it.
  await assert.rejects(
    () => svc.getOrCreateActiveCart(10, { contactNumber: '15551234567', whatsappAccountId: 200 }),
    (err) => err.status === 400
  );
}));

test('getOrCreateActiveCart rejects a whatsappAccountId that does not exist at all', withFakeDb(async (svc) => {
  await assert.rejects(
    () => svc.getOrCreateActiveCart(10, { contactNumber: '15551234567', whatsappAccountId: 999999 }),
    (err) => err.status === 400
  );
}));

test('getOrCreateActiveCart succeeds with no whatsappAccountId (existing contactNumber-only callers keep working)', withFakeDb(async (svc) => {
  const cart = await svc.getOrCreateActiveCart(10, { contactNumber: '15551234567' });
  assert.equal(cart.whatsapp_account_id, null);
  assert.equal(cart.contact_number, '15551234567');
}));

// ── FIX 5: cart filtering by contact + WhatsApp account ─────────────────
test('listCarts filters by contactNumber and whatsappAccountId together', withFakeDb(async (svc) => {
  await svc.getOrCreateActiveCart(10, { contactNumber: '15551111111', whatsappAccountId: 100 });
  await svc.getOrCreateActiveCart(10, { contactNumber: '15552222222', whatsappAccountId: 100 });

  const rows = await svc.listCarts(10, { contactNumber: '15551111111', whatsappAccountId: 100 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].contact_number, '15551111111');
}));

test('listCarts with only contactNumber (no whatsappAccountId) keeps working exactly as before', withFakeDb(async (svc) => {
  await svc.getOrCreateActiveCart(10, { contactNumber: '15553333333', whatsappAccountId: 100 });
  const rows = await svc.listCarts(10, { contactNumber: '15553333333' });
  assert.equal(rows.length, 1);
}));

// ── Cross-workspace isolation ────────────────────────────────────────────
test('listCarts never leaks another workspace\'s carts, even via a same-numbered account id', withFakeDb(async (svc) => {
  await svc.getOrCreateActiveCart(10, { contactNumber: '15554444444', whatsappAccountId: 100 });
  await svc.getOrCreateActiveCart(20, { contactNumber: '15554444444', whatsappAccountId: 200 });

  const rowsForA = await svc.listCarts(10, { contactNumber: '15554444444' });
  assert.equal(rowsForA.length, 1);
  assert.equal(rowsForA[0].workspace_id, 10);

  await assert.rejects(
    () => svc.listCarts(10, { contactNumber: '15554444444', whatsappAccountId: 200 }),
    (err) => err.status === 400,
    'workspace 10 must not be able to filter by workspace 20\'s account id'
  );
}));