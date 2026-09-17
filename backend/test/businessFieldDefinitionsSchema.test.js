'use strict';

// Phase 8E — Dynamic Business Fields: schema-migration tests. Same
// no-real-Postgres mocked-pool approach as test/zohoSchema.test.js.

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
      delete require.cache[require.resolve('../src/db/businessFieldDefinitionsSchema')];
      const schema = require('../src/db/businessFieldDefinitionsSchema');
      await run(schema, queries);
    } finally {
      pool.query = originalQuery;
    }
  };
}

test('ensureBusinessFieldDefinitionColumns only ALTERs zoho_field_mappings, never CREATEs/DROPs a table', withMockedPool(async (schema, queries) => {
  await schema.ensureBusinessFieldDefinitionColumns();

  assert.ok(queries.length > 0, 'should issue at least one statement');
  for (const q of queries) {
    assert.doesNotMatch(q.sql, /^CREATE TABLE/i, 'must never create a new table (spec: reuse zoho_field_mappings)');
    assert.doesNotMatch(q.sql, /^DROP TABLE/i);
    if (/^ALTER TABLE/i.test(q.sql)) {
      assert.match(q.sql, /coexistence\.zoho_field_mappings/i, 'every ALTER TABLE must target zoho_field_mappings only');
    }
  }
}));

test('ensureBusinessFieldDefinitionColumns adds every 8E column additively (IF NOT EXISTS)', withMockedPool(async (schema, queries) => {
  await schema.ensureBusinessFieldDefinitionColumns();

  const addColumnStmts = queries.filter((q) => /^ALTER TABLE .* ADD COLUMN IF NOT EXISTS/i.test(q.sql));
  const columns = addColumnStmts.map((q) => q.sql.match(/ADD COLUMN IF NOT EXISTS (\w+)/i)[1]);

  assert.deepEqual(
    columns.sort(),
    ['config_version', 'description', 'extraction_instruction', 'extraction_key', 'field_scope', 'is_required'].sort()
  );
}));

test('ensureBusinessFieldDefinitionColumns adds CHECK constraints for field_type and field_scope', withMockedPool(async (schema, queries) => {
  await schema.ensureBusinessFieldDefinitionColumns();

  const addFieldType = queries.find((q) => /ADD CONSTRAINT zoho_field_mappings_field_type_check/i.test(q.sql));
  assert.ok(addFieldType, 'must add a field_type CHECK constraint');
  for (const t of schema.BUSINESS_FIELD_TYPES) {
    assert.match(addFieldType.sql, new RegExp(`'${t}'`));
  }

  const addFieldScope = queries.find((q) => /ADD CONSTRAINT zoho_field_mappings_field_scope_check/i.test(q.sql));
  assert.ok(addFieldScope, 'must add a field_scope CHECK constraint');
  for (const s of schema.BUSINESS_FIELD_SCOPES) {
    assert.match(addFieldScope.sql, new RegExp(`'${s}'`));
  }

  // DROP-then-ADD idempotent-migration pattern, same convention as
  // zoho_connections_status_check in zohoSchema.js.
  const dropFieldType = queries.find((q) => /DROP CONSTRAINT IF EXISTS zoho_field_mappings_field_type_check/i.test(q.sql));
  assert.ok(dropFieldType, 'must DROP IF EXISTS before ADD, for safe re-runs');
}));

test('ensureBusinessFieldDefinitionColumns creates a lookup index for active/ordered listing', withMockedPool(async (schema, queries) => {
  await schema.ensureBusinessFieldDefinitionColumns();

  const idx = queries.find((q) => /CREATE INDEX IF NOT EXISTS idx_zoho_field_mappings_account_active_order/i.test(q.sql));
  assert.ok(idx);
  assert.match(idx.sql, /workspace_id, whatsapp_account_id, is_active, display_order/);
}));

test('BUSINESS_FIELD_TYPES matches the exact 8E-required set', () => {
  const schema = require('../src/db/businessFieldDefinitionsSchema');
  assert.deepEqual(schema.BUSINESS_FIELD_TYPES.sort(), ['boolean', 'date', 'multiselect', 'number', 'select', 'text'].sort());
});
