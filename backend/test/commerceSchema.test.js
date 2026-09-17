'use strict';

// Phase 7.2 — Commerce DB Foundation: schema-foundation tests.
//
// Same no-real-Postgres approach as test/zohoSchema.test.js: pool.query is
// monkey-patched on the shared '../src/db' singleton and every issued SQL
// statement is captured, then asserted against — no live Postgres reachable
// from this sandbox.

const test = require('node:test');
const assert = require('node:assert/strict');

function withMockedPool(run) {
  return async () => {
    const pool = require('../src/db');
    const queries = [];
    const originalQuery = pool.query;
    pool.query = async (sql, params) => {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return { rows: [] };
    };
    try {
      delete require.cache[require.resolve('../src/db/commerceSchema')];
      const commerceSchema = require('../src/db/commerceSchema');
      await run(commerceSchema, queries);
    } finally {
      pool.query = originalQuery;
    }
  };
}

const EXPECTED_TABLES = [
  'coexistence.products',
  'coexistence.product_variants',
  'coexistence.collections',
  'coexistence.product_collections',
  'coexistence.inventory_levels',
  'coexistence.carts',
  'coexistence.cart_items',
  'coexistence.orders',
  'coexistence.order_items',
  'coexistence.shopify_connections',
  'coexistence.shopify_sync_state',
  'coexistence.meta_catalog_connections',
];

// ── Schema creation ─────────────────────────────────────────────────────

test('ensureCommerceTables creates all twelve tables, idempotently', withMockedPool(async (schema, queries) => {
  await schema.ensureCommerceTables();

  const createStmts = queries.filter((q) => /^CREATE TABLE IF NOT EXISTS/i.test(q.sql));
  const tables = createStmts.map((q) => q.sql.match(/CREATE TABLE IF NOT EXISTS (coexistence\.\w+)/i)[1]);

  assert.deepEqual(
    [...new Set(tables)].sort(),
    [...EXPECTED_TABLES].sort(),
    'must create exactly the twelve commerce foundation tables'
  );

  for (const stmt of createStmts) {
    assert.match(stmt.sql, /CREATE TABLE IF NOT EXISTS/i);
  }
}));

test('ensureCommerceTables is safe to call twice in a row (idempotent startup)', withMockedPool(async (schema) => {
  await schema.ensureCommerceTables();
  await assert.doesNotReject(schema.ensureCommerceTables());
}));

test('ensureCommerceTables never issues UPDATE or DELETE against existing data', withMockedPool(async (schema, queries) => {
  await schema.ensureCommerceTables();
  for (const q of queries) {
    assert.doesNotMatch(q.sql, /^UPDATE\s+coexistence/i, `unexpected UPDATE: ${q.sql}`);
    assert.doesNotMatch(q.sql, /^DELETE\s+FROM/i, `unexpected DELETE: ${q.sql}`);
  }
}));

test('ensureCommerceTables never ALTERs any pre-existing table (only CREATE/INDEX/trigger DDL on its own tables)', withMockedPool(async (schema, queries) => {
  await schema.ensureCommerceTables();
  const alteredTables = queries
    .filter((q) => /^ALTER TABLE/i.test(q.sql))
    .map((q) => q.sql.match(/ALTER TABLE\s+(coexistence\.\w+)/i)[1]);
  const unexpectedAlters = alteredTables.filter((t) => !EXPECTED_TABLES.includes(t));
  assert.deepEqual(unexpectedAlters, [], 'must not ALTER any table other than the ones this schema file itself owns');
}));

// ── workspace_id isolation ──────────────────────────────────────────────

test('every tenant-owned commerce table requires NOT NULL workspace_id, FK to coexistence.workspaces ON DELETE CASCADE', withMockedPool(async (schema, queries) => {
  await schema.ensureCommerceTables();
  const tenantOwnedTables = [
    'products', 'collections', 'inventory_levels', 'carts', 'orders',
    'shopify_connections', 'shopify_sync_state', 'meta_catalog_connections',
  ];
  for (const table of tenantOwnedTables) {
    const create = queries.find((q) => new RegExp(`CREATE TABLE IF NOT EXISTS coexistence\\.${table}\\b`, 'i').test(q.sql)).sql;
    assert.match(
      create,
      /workspace_id\s+BIGINT NOT NULL\s+REFERENCES coexistence\.workspaces\(id\) ON DELETE CASCADE/i,
      `${table} must require workspace_id FK CASCADE`
    );
  }
}));

test('whatsapp_account_id, where present, is nullable and FKs coexistence.whatsapp_accounts ON DELETE SET NULL', withMockedPool(async (schema, queries) => {
  await schema.ensureCommerceTables();
  const tablesWithWhatsappAccount = ['products', 'carts', 'orders', 'meta_catalog_connections'];
  for (const table of tablesWithWhatsappAccount) {
    const create = queries.find((q) => new RegExp(`CREATE TABLE IF NOT EXISTS coexistence\\.${table}\\b`, 'i').test(q.sql)).sql;
    assert.match(
      create,
      /whatsapp_account_id\s+BIGINT\s+REFERENCES coexistence\.whatsapp_accounts\(id\) ON DELETE SET NULL/i,
      `${table} must have a nullable whatsapp_account_id FK SET NULL`
    );
  }
}));

// ── Foreign key cascades within the commerce schema ─────────────────────

test('product_variants, product_collections, cart_items, order_items cascade-delete via their parent FK', withMockedPool(async (schema, queries) => {
  await schema.ensureCommerceTables();

  const variants = queries.find((q) => /CREATE TABLE IF NOT EXISTS coexistence\.product_variants\b/i.test(q.sql)).sql;
  assert.match(variants, /product_id\s+BIGINT NOT NULL\s+REFERENCES coexistence\.products\(id\) ON DELETE CASCADE/i);

  const productCollections = queries.find((q) => /CREATE TABLE IF NOT EXISTS coexistence\.product_collections\b/i.test(q.sql)).sql;
  assert.match(productCollections, /product_id\s+BIGINT NOT NULL\s+REFERENCES coexistence\.products\(id\) ON DELETE CASCADE/i);
  assert.match(productCollections, /collection_id\s+BIGINT NOT NULL\s+REFERENCES coexistence\.collections\(id\) ON DELETE CASCADE/i);

  const cartItems = queries.find((q) => /CREATE TABLE IF NOT EXISTS coexistence\.cart_items\b/i.test(q.sql)).sql;
  assert.match(cartItems, /cart_id\s+BIGINT NOT NULL\s+REFERENCES coexistence\.carts\(id\) ON DELETE CASCADE/i);

  const orderItems = queries.find((q) => /CREATE TABLE IF NOT EXISTS coexistence\.order_items\b/i.test(q.sql)).sql;
  assert.match(orderItems, /order_id\s+BIGINT NOT NULL\s+REFERENCES coexistence\.orders\(id\) ON DELETE CASCADE/i);
}));

test('order_items keeps product_name/sku snapshots and SET NULLs product_id/variant_id on delete (order history survives product deletion)', withMockedPool(async (schema, queries) => {
  await schema.ensureCommerceTables();
  const create = queries.find((q) => /CREATE TABLE IF NOT EXISTS coexistence\.order_items\b/i.test(q.sql)).sql;
  assert.match(create, /product_id\s+BIGINT\s+REFERENCES coexistence\.products\(id\) ON DELETE SET NULL/i);
  assert.match(create, /variant_id\s+BIGINT\s+REFERENCES coexistence\.product_variants\(id\) ON DELETE SET NULL/i);
  assert.match(create, /product_name\s+TEXT NOT NULL/i);
  assert.match(create, /\bsku\s+TEXT/i);
}));

// ── Unique constraints for idempotent Shopify/Meta sync ────────────────

test('products enforces per-workspace UNIQUE shopify_product_id and meta_product_id for idempotent sync upserts', withMockedPool(async (schema, queries) => {
  await schema.ensureCommerceTables();
  const create = queries.find((q) => /CREATE TABLE IF NOT EXISTS coexistence\.products\b/i.test(q.sql)).sql;
  assert.match(create, /UNIQUE\s*\(workspace_id, shopify_product_id\)/i);
  assert.match(create, /UNIQUE\s*\(workspace_id, meta_product_id\)/i);
}));

test('collections enforces per-workspace UNIQUE shopify_collection_id', withMockedPool(async (schema, queries) => {
  await schema.ensureCommerceTables();
  const create = queries.find((q) => /CREATE TABLE IF NOT EXISTS coexistence\.collections\b/i.test(q.sql)).sql;
  assert.match(create, /UNIQUE\s*\(workspace_id, shopify_collection_id\)/i);
}));

test('product_collections enforces UNIQUE(product_id, collection_id)', withMockedPool(async (schema, queries) => {
  await schema.ensureCommerceTables();
  const create = queries.find((q) => /CREATE TABLE IF NOT EXISTS coexistence\.product_collections\b/i.test(q.sql)).sql;
  assert.match(create, /UNIQUE\s*\(product_id, collection_id\)/i);
}));

test('cart_items enforces UNIQUE(cart_id, product_id, variant_id) cart/product/variant identity', withMockedPool(async (schema, queries) => {
  await schema.ensureCommerceTables();
  const create = queries.find((q) => /CREATE TABLE IF NOT EXISTS coexistence\.cart_items\b/i.test(q.sql)).sql;
  assert.match(create, /UNIQUE\s*\(cart_id, product_id, variant_id\)/i);
}));

test('orders enforces per-workspace UNIQUE external_order_id and shopify_order_id for idempotent order ingestion', withMockedPool(async (schema, queries) => {
  await schema.ensureCommerceTables();
  const create = queries.find((q) => /CREATE TABLE IF NOT EXISTS coexistence\.orders\b/i.test(q.sql)).sql;
  assert.match(create, /UNIQUE\s*\(workspace_id, external_order_id\)/i);
  assert.match(create, /UNIQUE\s*\(workspace_id, shopify_order_id\)/i);
}));

test('shopify_connections enforces UNIQUE(workspace_id, shop_domain)', withMockedPool(async (schema, queries) => {
  await schema.ensureCommerceTables();
  const create = queries.find((q) => /CREATE TABLE IF NOT EXISTS coexistence\.shopify_connections\b/i.test(q.sql)).sql;
  assert.match(create, /UNIQUE\s*\(workspace_id, shop_domain\)/i);
}));

test('shopify_sync_state enforces UNIQUE(connection_id, resource_type)', withMockedPool(async (schema, queries) => {
  await schema.ensureCommerceTables();
  const create = queries.find((q) => /CREATE TABLE IF NOT EXISTS coexistence\.shopify_sync_state\b/i.test(q.sql)).sql;
  assert.match(create, /UNIQUE\s*\(connection_id, resource_type\)/i);
}));

test('meta_catalog_connections enforces UNIQUE(workspace_id, whatsapp_account_id, catalog_id)', withMockedPool(async (schema, queries) => {
  await schema.ensureCommerceTables();
  const create = queries.find((q) => /CREATE TABLE IF NOT EXISTS coexistence\.meta_catalog_connections\b/i.test(q.sql)).sql;
  assert.match(create, /UNIQUE\s*\(workspace_id, whatsapp_account_id, catalog_id\)/i);
}));

// ── Secret handling ──────────────────────────────────────────────────────

test('shopify_connections stores the access token only as an *_encrypted TEXT column, never plaintext', withMockedPool(async (schema, queries) => {
  await schema.ensureCommerceTables();
  const create = queries.find((q) => /CREATE TABLE IF NOT EXISTS coexistence\.shopify_connections\b/i.test(q.sql)).sql;
  assert.match(create, /access_token_encrypted\s+TEXT/i);
  assert.doesNotMatch(create, /\baccess_token\s+TEXT/i, 'must not store a plaintext access_token column');
}));

test('util/crypto.js encrypt/decrypt (already used for WhatsApp/Zoho tokens) round-trips correctly, confirming it is reusable for Shopify tokens', () => {
  const { encrypt, decrypt } = require('../src/util/crypto');
  const secret = 'shopify-access-token-example-value';
  const ciphertext = encrypt(secret);
  assert.ok(ciphertext, 'encrypt should return a non-empty ciphertext');
  assert.notEqual(ciphertext, secret, 'ciphertext must not equal the plaintext');
  assert.equal(decrypt(ciphertext), secret, 'decrypt must recover the original plaintext');
});

// ── index.js wiring ──────────────────────────────────────────────────────

test('index.js wires ensureCommerceTables after ensureWorkspaceTables and ensureWhatsappAccountsSaasColumns', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

  assert.match(src, /require\('\.\/db\/commerceSchema'\)/, 'index.js must require commerceSchema');
  assert.match(src, /await ensureCommerceTables\(\)/, 'index.js must call ensureCommerceTables()');

  const workspaceIdx = src.indexOf('await ensureWorkspaceTables()');
  const whatsappIdx = src.indexOf('await ensureWhatsappAccountsSaasColumns()');
  const commerceIdx = src.indexOf('await ensureCommerceTables()');

  assert.ok(workspaceIdx !== -1 && whatsappIdx !== -1 && commerceIdx !== -1, 'all three calls must be present');
  assert.ok(commerceIdx > workspaceIdx, 'ensureCommerceTables must run after ensureWorkspaceTables');
  assert.ok(commerceIdx > whatsappIdx, 'ensureCommerceTables must run after ensureWhatsappAccountsSaasColumns');
});

// The Phase 7.2 "DB-foundation-only, no routes yet" scope guard above has
// been superseded: Commerce routes (routes/carts.js, routes/orders.js,
// etc.) are now a legitimate, intentionally-shipped part of Commerce
// functionality in a later phase. Asserting their absence would fail
// against correct, shipped behavior — so that guard has been removed
// rather than kept red.