'use strict';

// Phase 7.5 — Meta Commerce Catalog Integration: schema-foundation tests.
// Same no-real-Postgres approach as test/commerceSchema.test.js: pool.query
// is monkey-patched and every issued SQL statement is captured and
// asserted against. NEVER connects to a real Postgres or Meta account.

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
      delete require.cache[require.resolve('../src/db/metaCatalogSchema')];
      const schema = require('../src/db/metaCatalogSchema');
      await run(schema, queries);
    } finally {
      pool.query = originalQuery;
    }
  };
}

test('ensureMetaCatalogConnectionsColumns only ALTERs the existing meta_catalog_connections table (never CREATEs it)', withMockedPool(async (schema, queries) => {
  await schema.ensureMetaCatalogConnectionsColumns();

  const creates = queries.filter((q) => /^CREATE TABLE/i.test(q.sql));
  assert.equal(creates.length, 0, 'must not create any new table');

  const alters = queries.filter((q) => /^ALTER TABLE coexistence\.meta_catalog_connections/i.test(q.sql));
  assert.ok(alters.length >= 6, 'expected at least 6 additive ALTERs');
  for (const q of alters) {
    assert.match(q.sql, /ADD COLUMN IF NOT EXISTS/i, `must be idempotent additive: ${q.sql}`);
  }

  const columns = alters.map((q) => q.sql.match(/ADD COLUMN IF NOT EXISTS (\w+)/i)[1]);
  assert.deepEqual(
    [...new Set(columns)].sort(),
    ['access_token_encrypted', 'business_id', 'connected_at', 'last_error', 'last_error_at', 'last_synced_at'].sort()
  );
}));

test('ensureProductMetaSyncColumns only ALTERs coexistence.products additively', withMockedPool(async (schema, queries) => {
  await schema.ensureProductMetaSyncColumns();

  const creates = queries.filter((q) => /^CREATE TABLE/i.test(q.sql));
  assert.equal(creates.length, 0, 'must not create any new table');

  const addCols = queries.filter((q) => /^ALTER TABLE coexistence\.products\s+ADD COLUMN IF NOT EXISTS/i.test(q.sql));
  const columns = addCols.map((q) => q.sql.match(/ADD COLUMN IF NOT EXISTS (\w+)/i)[1]);
  assert.deepEqual(
    [...new Set(columns)].sort(),
    ['meta_last_error', 'meta_last_synced_at', 'meta_sync_status'].sort()
  );

  const dropConstraint = queries.find((q) => /DROP CONSTRAINT IF EXISTS products_meta_sync_status_check/i.test(q.sql));
  const addConstraint = queries.find((q) => /ADD CONSTRAINT products_meta_sync_status_check/i.test(q.sql));
  assert.ok(dropConstraint, 'must drop-if-exists before re-adding the CHECK constraint (idempotent widen pattern)');
  assert.ok(addConstraint, 'must re-add the CHECK constraint');
  assert.match(addConstraint.sql, /'not_synced'/);
  assert.match(addConstraint.sql, /'pending'/);
  assert.match(addConstraint.sql, /'synced'/);
  assert.match(addConstraint.sql, /'error'/);
}));

test('ensureMetaCatalogSyncLogTable creates exactly one new table, additively, with FKs to existing tables', withMockedPool(async (schema, queries) => {
  await schema.ensureMetaCatalogSyncLogTable();

  const creates = queries.filter((q) => /^CREATE TABLE IF NOT EXISTS/i.test(q.sql));
  assert.equal(creates.length, 1, 'must create exactly one table');
  assert.match(creates[0].sql, /coexistence\.meta_catalog_sync_log/i);
  assert.match(creates[0].sql, /REFERENCES coexistence\.workspaces\(id\) ON DELETE CASCADE/i);
  assert.match(creates[0].sql, /REFERENCES coexistence\.whatsapp_accounts\(id\) ON DELETE SET NULL/i);
  assert.match(creates[0].sql, /REFERENCES coexistence\.meta_catalog_connections\(id\) ON DELETE CASCADE/i);

  // Never touches the Phase 7.4 inbound import log table.
  const touchesInboundLog = queries.some((q) => /coexistence\.catalog_sync_log\b/i.test(q.sql));
  assert.equal(touchesInboundLog, false, 'must never touch coexistence.catalog_sync_log');
}));

test('ensureMetaCatalogTables runs all three steps and touches no unrelated table', withMockedPool(async (schema, queries) => {
  await schema.ensureMetaCatalogTables();

  const touchedTables = new Set();
  for (const q of queries) {
    const m = q.sql.match(/coexistence\.(\w+)/g) || [];
    m.forEach((t) => touchedTables.add(t.replace('coexistence.', '')));
  }
  const forbidden = [
    'catalog_connections', 'catalog_sync_log', 'shopify_connections', 'shopify_sync_state',
    'product_variants', 'collections', 'inventory_levels', 'carts', 'cart_items', 'orders', 'order_items',
  ];
  for (const t of forbidden) {
    assert.equal(touchedTables.has(t), false, `must never touch coexistence.${t}`);
  }
  assert.ok(touchedTables.has('meta_catalog_connections'));
  assert.ok(touchedTables.has('products'));
  assert.ok(touchedTables.has('meta_catalog_sync_log'));
}));

test('running ensureMetaCatalogTables twice is idempotent (identical statement shape both times)', withMockedPool(async (schema) => {
  const pool = require('../src/db');
  const firstRunSql = [];
  const secondRunSql = [];
  const original = pool.query;
  pool.query = async (sql) => { firstRunSql.push(sql.replace(/\s+/g, ' ').trim()); return { rows: [] }; };
  await schema.ensureMetaCatalogTables();

  pool.query = async (sql) => { secondRunSql.push(sql.replace(/\s+/g, ' ').trim()); return { rows: [] }; };
  await schema.ensureMetaCatalogTables();

  pool.query = original;
  assert.deepEqual(firstRunSql, secondRunSql);
}));