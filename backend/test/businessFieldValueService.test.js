'use strict';

// Phase 8E — Dynamic Business Fields: customer-value storage tests.
// Mocked pool.query, same pattern as the other 8E test files.

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
      delete require.cache[require.resolve('../src/services/businessFieldValueService')];
      delete require.cache[require.resolve('../src/services/businessFieldDefinitionService')];
      const svc = require('../src/services/businessFieldValueService');
      await run(svc, queries);
    } finally {
      pool.query = original;
    }
  };
}
const OWNED = { rows: [{ id: 5 }] };

function def(overrides = {}) {
  return {
    id: 1,
    workspace_id: 10,
    whatsapp_account_id: 5,
    field_key: 'roof_type',
    field_label: 'Roof Type',
    description: null,
    field_type: 'select',
    is_required: false,
    field_scope: 'business_specific',
    field_config: { options: ['Metal', 'Shingle'] },
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

test('getContactBusinessFieldValues returns {} for a contact with no stored business fields', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED;
  if (/^SELECT custom_fields FROM coexistence\.contacts/i.test(sql)) return { rows: [{ custom_fields: { isRetarget: true } }] };
}, async (svc) => {
  const values = await svc.getContactBusinessFieldValues(10, 5, 42);
  assert.deepEqual(values, {});
}));

test('getContactBusinessFieldValues reads only this whatsapp account\'s namespace, not another account\'s', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED;
  if (/^SELECT custom_fields FROM coexistence\.contacts/i.test(sql)) {
    return { rows: [{ custom_fields: { business_fields: { '5': { roof_type: 'Metal' }, '99': { pipe_name: 'PVC' } } } }] };
  }
}, async (svc) => {
  const values = await svc.getContactBusinessFieldValues(10, 5, 42);
  assert.deepEqual(values, { roof_type: 'Metal' });
}));

test('getContactBusinessFieldValues throws 404 for a contact outside the workspace', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED;
  if (/^SELECT custom_fields FROM coexistence\.contacts/i.test(sql)) return { rows: [] };
}, async (svc) => {
  await assert.rejects(
    () => svc.getContactBusinessFieldValues(10, 5, 999),
    (err) => { assert.equal(err.status, 404); return true; }
  );
}));
test('setContactBusinessFieldValues rejects a value for a field that is not a configured active definition', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED;
  if (/^SELECT id, custom_fields FROM coexistence\.contacts/i.test(sql)) return { rows: [{ id: 42, custom_fields: {} }] };
  if (/^SELECT \* FROM coexistence\.zoho_field_mappings/i.test(sql)) return { rows: [] };
}, async (svc) => {
  await assert.rejects(
    () => svc.setContactBusinessFieldValues(10, 5, 42, { made_up_field: 'x' }),
    (err) => { assert.equal(err.status, 400); return true; }
  );
}));
test('setContactBusinessFieldValues rejects a select value outside the allowed options', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED;
  if (/^SELECT id, custom_fields FROM coexistence\.contacts/i.test(sql)) return { rows: [{ id: 42, custom_fields: {} }] };
  if (/^SELECT \* FROM coexistence\.zoho_field_mappings/i.test(sql)) return { rows: [def()] };
}, async (svc) => {
  await assert.rejects(() => svc.setContactBusinessFieldValues(10, 5, 42, { roof_type: 'Thatch' }));
}));

test('setContactBusinessFieldValues rejects null for a required field', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED;
  if (/^SELECT id, custom_fields FROM coexistence\.contacts/i.test(sql)) return { rows: [{ id: 42, custom_fields: {} }] };
  if (/^SELECT \* FROM coexistence\.zoho_field_mappings/i.test(sql)) return { rows: [def({ is_required: true, field_type: 'text', field_config: {} })] };
}, async (svc) => {
  await assert.rejects(() => svc.setContactBusinessFieldValues(10, 5, 42, { roof_type: null }));
}));

test('setContactBusinessFieldValues writes via jsonb_set under business_fields.<account>, preserving other keys', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED;
  if (/^SELECT id, custom_fields FROM coexistence\.contacts/i.test(sql)) {
    return { rows: [{ id: 42, custom_fields: { isRetarget: true, business_fields: { '99': { pipe_name: 'PVC' } } } }] };
  }
  if (/^SELECT \* FROM coexistence\.zoho_field_mappings/i.test(sql)) return { rows: [def()] };
  if (/^UPDATE coexistence\.contacts/i.test(sql)) {
    return { rows: [{ custom_fields: { isRetarget: true, business_fields: { '5': { roof_type: 'Metal' }, '99': { pipe_name: 'PVC' } } } }] };
  }
}, async (svc, queries) => {
  const result = await svc.setContactBusinessFieldValues(10, 5, 42, { roof_type: 'Metal' });
  assert.deepEqual(result, { roof_type: 'Metal' });

  const update = queries.find((q) => /^UPDATE coexistence\.contacts/i.test(q.sql));
  // Phase 6.6 bug fix: jsonb_set(..., create_missing=true) only creates the
  // FINAL key of a path — it does NOT create missing intermediate objects,
  // so a brand-new contact (custom_fields = '{}') silently no-ops instead
  // of adding "business_fields". The service now reconstructs the full
  // custom_fields object in JS (spreading the existing value first, so
  // every other key/account is preserved) and writes it with a plain
  // assignment — see setContactBusinessFieldValues's inline comment.
  assert.match(update.sql, /SET\s+custom_fields = \$3::jsonb/);
  assert.match(update.sql, /WHERE id = \$1 AND workspace_id = \$2/);
  assert.deepEqual(JSON.parse(update.params[2]), {
    isRetarget: true,
    business_fields: {
      '5': { roof_type: 'Metal' },
      '99': { pipe_name: 'PVC' },
    },
  });
}));

test('setContactBusinessFieldValues throws 404 for a contact outside the workspace', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED;
  if (/^SELECT id, custom_fields FROM coexistence\.contacts/i.test(sql)) return { rows: [] };
}, async (svc) => {
  await assert.rejects(
    () => svc.setContactBusinessFieldValues(10, 5, 999, {}),
    (err) => { assert.equal(err.status, 404); return true; }
  );
}));