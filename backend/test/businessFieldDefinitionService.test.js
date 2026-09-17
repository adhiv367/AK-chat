'use strict';

// Phase 8E — Dynamic Business Fields: field-definition service tests.
// Mocked pool.query, same pattern as test/zohoConnectionService.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

function withMockedPool(handler, run) {
  return async () => {
    const pool = require('../src/db');
    const queries = [];
    const original = pool.query;
    pool.query = async (sql, params) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      queries.push({ sql: normalized, params });
      const result = handler(normalized, params, queries);
      return result !== undefined ? result : { rows: [] };
    };
    try {
      delete require.cache[require.resolve('../src/services/businessFieldDefinitionService')];
      delete require.cache[require.resolve('../src/db/businessFieldDefinitionsSchema')];
      const svc = require('../src/services/businessFieldDefinitionService');
      await run(svc, queries);
    } finally {
      pool.query = original;
    }
  };
}

const OWNED = { rows: [{ id: 5 }] };
const NOT_OWNED = { rows: [] };

function row(overrides = {}) {
  return {
    id: 1,
    workspace_id: 10,
    whatsapp_account_id: 5,
    field_key: 'roof_type',
    field_label: 'Roof Type',
    description: null,
    field_type: 'text',
    is_required: false,
    field_scope: 'business_specific',
    field_config: {},
    zoho_target: null,
    extraction_key: null,
    extraction_instruction: null,
    is_active: true,
    display_order: 0,
    config_version: 1,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// ── Ownership / isolation ───────────────────────────────────────────────

test('listFieldDefinitions rejects a whatsappAccountId not owned by the workspace (cross-workspace access)', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return NOT_OWNED;
}, async (svc) => {
  await assert.rejects(
    () => svc.listFieldDefinitions(10, 999),
    (err) => { assert.equal(err.status, 404); return true; }
  );
}));

test('listFieldDefinitions scopes strictly by workspace_id AND whatsapp_account_id, ordered deterministically', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED;
  if (/^SELECT \* FROM coexistence\.zoho_field_mappings/i.test(sql)) return { rows: [row()] };
}, async (svc, queries) => {
  const result = await svc.listFieldDefinitions(10, 5);
  assert.equal(result.length, 1);
  assert.equal(result[0].fieldKey, 'roof_type');

  const listQuery = queries.find((q) => /^SELECT \* FROM coexistence\.zoho_field_mappings/i.test(q.sql));
  assert.match(listQuery.sql, /WHERE workspace_id = \$1 AND whatsapp_account_id = \$2/);
  assert.match(listQuery.sql, /ORDER BY display_order ASC, field_key ASC/);
  assert.deepEqual(listQuery.params, [10, 5]);
}));

// ── Field key validation ─────────────────────────────────────────────────

test('createFieldDefinition rejects an invalid field_key format', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED;
}, async (svc) => {
  await assert.rejects(
    () => svc.createFieldDefinition(10, 5, { fieldKey: 'Bad Key!', fieldLabel: 'Bad' }),
    (err) => { assert.equal(err.status, 400); return true; }
  );
}));

test('createFieldDefinition rejects missing fieldLabel', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED;
}, async (svc) => {
  await assert.rejects(() => svc.createFieldDefinition(10, 5, { fieldKey: 'roof_type' }));
}));

test('createFieldDefinition rejects an unsupported data type', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED;
}, async (svc) => {
  await assert.rejects(() =>
    svc.createFieldDefinition(10, 5, { fieldKey: 'weight', fieldLabel: 'Weight', fieldType: 'currency' })
  );
}));

// ── select/multiselect options ───────────────────────────────────────────

test('createFieldDefinition requires non-empty options for select', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED;
}, async (svc) => {
  await assert.rejects(() =>
    svc.createFieldDefinition(10, 5, { fieldKey: 'roof_type', fieldLabel: 'Roof Type', fieldType: 'select' })
  );
  await assert.rejects(() =>
    svc.createFieldDefinition(10, 5, { fieldKey: 'roof_type', fieldLabel: 'Roof Type', fieldType: 'select', fieldConfig: { options: [] } })
  );
}));

test('createFieldDefinition rejects duplicate options', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED;
}, async (svc) => {
  await assert.rejects(() =>
    svc.createFieldDefinition(10, 5, {
      fieldKey: 'roof_type',
      fieldLabel: 'Roof Type',
      fieldType: 'select',
      fieldConfig: { options: ['Metal', 'Metal'] },
    })
  );
}));

test('createFieldDefinition ignores options supplied for a non-select type', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED;
  if (/^INSERT INTO coexistence\.zoho_field_mappings/i.test(sql)) return { rows: [row({ field_type: 'text', field_config: {} })] };
}, async (svc, queries) => {
  await svc.createFieldDefinition(10, 5, {
    fieldKey: 'length',
    fieldLabel: 'Length',
    fieldType: 'text',
    fieldConfig: { options: ['ignored'] },
  });
  const insertQuery = queries.find((q) => /^INSERT INTO coexistence\.zoho_field_mappings/i.test(q.sql));
  const fieldConfigParam = insertQuery.params[8];
  assert.equal(JSON.parse(fieldConfigParam).options, undefined);
}));

test('createFieldDefinition accepts valid select options and persists them in field_config', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED;
  if (/^INSERT INTO coexistence\.zoho_field_mappings/i.test(sql)) return { rows: [row({ field_type: 'select', field_config: { options: ['Metal', 'Shingle'] } })] };
}, async (svc, queries) => {
  const created = await svc.createFieldDefinition(10, 5, {
    fieldKey: 'roof_type',
    fieldLabel: 'Roof Type',
    fieldType: 'select',
    fieldConfig: { options: ['Metal', 'Shingle'] },
  });
  assert.deepEqual(created.fieldConfig.options, ['Metal', 'Shingle']);

  const insertQuery = queries.find((q) => /^INSERT INTO coexistence\.zoho_field_mappings/i.test(q.sql));
  assert.deepEqual(insertQuery.params[1], 5, 'whatsapp_account_id must be bound as a query param, not string-interpolated');
}));

// ── Duplicate key handling ────────────────────────────────────────────────

test('createFieldDefinition surfaces a friendly 400 when the DB unique constraint fires', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED;
  if (/^INSERT INTO coexistence\.zoho_field_mappings/i.test(sql)) {
    const err = new Error('duplicate key value violates unique constraint "uq_zoho_field_mappings_key"');
    err.code = '23505';
    throw err;
  }
}, async (svc) => {
  await assert.rejects(
    () => svc.createFieldDefinition(10, 5, { fieldKey: 'roof_type', fieldLabel: 'Roof Type' }),
    (err) => { assert.equal(err.status, 400); assert.match(err.message, /already exists/i); return true; }
  );
}));

// ── Update: field_key immutability ────────────────────────────────────────

test('updateFieldDefinition rejects an attempt to change field_key', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED;
  if (/^SELECT \* FROM coexistence\.zoho_field_mappings/i.test(sql)) return { rows: [row()] };
}, async (svc) => {
  await assert.rejects(
    () => svc.updateFieldDefinition(10, 5, 1, { fieldKey: 'different_key' }),
    (err) => { assert.equal(err.status, 400); return true; }
  );
}));

test('updateFieldDefinition bumps config_version on every update', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED;
  if (/^SELECT \* FROM coexistence\.zoho_field_mappings/i.test(sql)) return { rows: [row()] };
  if (/^UPDATE coexistence\.zoho_field_mappings SET/i.test(sql)) return { rows: [row({ config_version: 2, field_label: 'New Label' })] };
}, async (svc, queries) => {
  const updated = await svc.updateFieldDefinition(10, 5, 1, { fieldLabel: 'New Label' });
  assert.equal(updated.configVersion, 2);
  const updateQuery = queries.find((q) => /^UPDATE coexistence\.zoho_field_mappings SET/i.test(q.sql));
  assert.match(updateQuery.sql, /config_version = config_version \+ 1/);
}));

// ── Activate / deactivate ─────────────────────────────────────────────────

test('setFieldActive(false) scopes the UPDATE by workspace_id AND whatsapp_account_id', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED;
  if (/^UPDATE coexistence\.zoho_field_mappings/i.test(sql)) return { rows: [row({ is_active: false })] };
}, async (svc, queries) => {
  const updated = await svc.setFieldActive(10, 5, 1, false);
  assert.equal(updated.isActive, false);
  const q = queries.find((qq) => /^UPDATE coexistence\.zoho_field_mappings/i.test(qq.sql));
  assert.match(q.sql, /WHERE id = \$1 AND workspace_id = \$2 AND whatsapp_account_id = \$3/);
}));

test('setFieldActive throws 404 for a field belonging to another account/workspace', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED;
  if (/^UPDATE coexistence\.zoho_field_mappings/i.test(sql)) return { rows: [] };
}, async (svc) => {
  await assert.rejects(
    () => svc.setFieldActive(10, 5, 999, true),
    (err) => { assert.equal(err.status, 404); return true; }
  );
}));

// ── Delete: safe-delete gating ────────────────────────────────────────────

test('deleteFieldDefinition refuses to delete an active field (must deactivate first)', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED;
  if (/^SELECT \* FROM coexistence\.zoho_field_mappings/i.test(sql)) return { rows: [row({ is_active: true })] };
}, async (svc) => {
  await assert.rejects(
    () => svc.deleteFieldDefinition(10, 5, 1),
    (err) => { assert.equal(err.status, 400); assert.match(err.message, /[Dd]eactivate/); return true; }
  );
}));

test('deleteFieldDefinition refuses to delete an inactive field that still has stored customer values', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED;
  if (/^SELECT \* FROM coexistence\.zoho_field_mappings/i.test(sql)) return { rows: [row({ is_active: false })] };
  if (/^SELECT id FROM coexistence\.contacts/i.test(sql)) return { rows: [{ id: 42 }] };
}, async (svc) => {
  await assert.rejects(
    () => svc.deleteFieldDefinition(10, 5, 1),
    (err) => { assert.equal(err.status, 400); assert.match(err.message, /stored customer values/i); return true; }
  );
}));

test('deleteFieldDefinition succeeds for an inactive field with no stored values, scoped by workspace+account', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED;
  if (/^SELECT \* FROM coexistence\.zoho_field_mappings/i.test(sql)) return { rows: [row({ is_active: false })] };
  if (/^SELECT id FROM coexistence\.contacts/i.test(sql)) return { rows: [] };
  if (/^DELETE FROM coexistence\.zoho_field_mappings/i.test(sql)) return { rowCount: 1 };
}, async (svc, queries) => {
  const result = await svc.deleteFieldDefinition(10, 5, 1);
  assert.equal(result, true);
  const del = queries.find((q) => /^DELETE FROM coexistence\.zoho_field_mappings/i.test(q.sql));
  assert.match(del.sql, /WHERE id = \$1 AND workspace_id = \$2 AND whatsapp_account_id = \$3/);
}));

// ── Zoho target metadata (never claims a Zoho custom field exists) ───────

test('createFieldDefinition allows zoho_target to be omitted (AKChat-side-only field)', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED;
  if (/^INSERT INTO coexistence\.zoho_field_mappings/i.test(sql)) return { rows: [row({ zoho_target: null })] };
}, async (svc) => {
  const created = await svc.createFieldDefinition(10, 5, { fieldKey: 'pipe_name', fieldLabel: 'Pipe Name' });
  assert.equal(created.zohoTarget, null);
}));
