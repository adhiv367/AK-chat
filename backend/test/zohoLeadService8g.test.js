'use strict';

// Phase 8G — additional zohoLeadService tests: the drop-unsupported-field
// fallback (createLead/updateLead + extraFields), extraFields precedence
// vs. standard fields, and confirming that createLead resolves a
// DIFFERENT WhatsApp account's connection independently (never falls back
// to another account's connection — the core 8G isolation guarantee).
// Same mocking approach as test/zohoLeadService.test.js (pool.query +
// global.fetch mocked, no live Postgres/Zoho required).

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

process.env.AKCHAT_ENCRYPTION_KEY = process.env.AKCHAT_ENCRYPTION_KEY || nodeCrypto.randomBytes(24).toString('hex');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-zoho-lead-8g-tests';
process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REDIRECT_URI = process.env.ZOHO_REDIRECT_URI || 'https://app.example.com/api/zoho/oauth/callback';

const { encrypt } = require('../src/util/crypto');

const WORKSPACE_ID = 1;
const WA_ACCOUNT_A = 5;
const WA_ACCOUNT_B = 6;
const RAW_CONTACT_NUMBER = '+91 99999 99999';
const NORMALIZED_CONTACT_NUMBER = '919999999999';

function connectionRow(whatsappAccountId, overrides = {}) {
  return {
    id: 100 + whatsappAccountId,
    workspace_id: WORKSPACE_ID,
    whatsapp_account_id: whatsappAccountId,
    status: 'connected',
    zoho_api_domain: `https://www.zohoapis.in/${whatsappAccountId}`,
    zoho_data_center: 'in',
    access_token_encrypted: encrypt(`valid-access-token-${whatsappAccountId}`),
    refresh_token_encrypted: encrypt(`valid-refresh-token-${whatsappAccountId}`),
    token_expires_at: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides,
  };
}

function withMockedEnv({ queryHandler, fetchHandler }, run) {
  return async () => {
    const pool = require('../src/db');
    const originalQuery = pool.query;
    const originalFetch = global.fetch;
    const queries = [];

    pool.query = async (sql, params) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      queries.push({ sql: normalized, params });
      const result = queryHandler(normalized, params, queries);
      return result !== undefined ? result : { rows: [] };
    };

    let fetchCalls = [];
    global.fetch = async (url, opts) => {
      fetchCalls.push({ url, opts });
      return fetchHandler(url, opts, fetchCalls);
    };

    try {
      for (const modName of ['zohoLeadService', 'zohoConnectionService', 'zohoTokenService', 'zohoOAuthService', 'contactSyncService']) {
        delete require.cache[require.resolve(`../src/services/${modName}`)];
      }
      const svc = require('../src/services/zohoLeadService');
      await run(svc, queries, fetchCalls);
    } finally {
      pool.query = originalQuery;
      global.fetch = originalFetch;
    }
  };
}

function zohoSuccessResponse(id) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: [{ code: 'SUCCESS', status: 'success', details: { id } }] }),
  };
}

function zohoInvalidFieldResponse(apiName) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: [{ code: 'INVALID_DATA', status: 'error', message: 'invalid field', details: { api_name: apiName } }],
    }),
  };
}

// ── extraFields precedence ────────────────────────────────────────────────

test('buildLeadFields: standard fields always win over a colliding extraFields key', withMockedEnv({ queryHandler: () => undefined, fetchHandler: () => { throw new Error('no fetch expected'); } }, async (svc) => {
  const fields = svc.buildLeadFields({
    name: 'Ravi Kumar',
    contactNumber: NORMALIZED_CONTACT_NUMBER,
    extraFields: { Last_Name: 'Should_Never_Win', Roof_Type_Custom: 'Metal' },
  });
  assert.equal(fields.Last_Name, 'Kumar'); // standard field wins
  assert.equal(fields.Roof_Type_Custom, 'Metal'); // dynamic field still applied
}));

test('buildUpdateFields: extraFields alone are enough to produce a non-empty update payload', () => {
  const svc = require('../src/services/zohoLeadService');
  const fields = svc.buildUpdateFields({ extraFields: { Roof_Type_Custom: 'Shingle' } });
  assert.deepEqual(fields, { Roof_Type_Custom: 'Shingle' });
});

// ── Unsupported-field fallback (spec §6) ──────────────────────────────────

test('createLead: an unsupported custom field is dropped and the Lead still succeeds (never fails the whole Lead)', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return { rows: [{ id: WA_ACCOUNT_A }] };
    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE workspace_id/i.test(sql)) return { rows: [connectionRow(WA_ACCOUNT_A)] };
    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE id/i.test(sql)) return { rows: [connectionRow(WA_ACCOUNT_A)] };
    if (/^INSERT INTO coexistence\.zoho_lead_links/i.test(sql)) {
      return { rows: [{ id: 99, workspace_id: WORKSPACE_ID, whatsapp_account_id: WA_ACCOUNT_A, contact_number: NORMALIZED_CONTACT_NUMBER, status: 'pending' }] };
    }
    if (/^UPDATE coexistence\.zoho_lead_links SET zoho_lead_id/i.test(sql)) {
      return { rows: [{ id: 99, status: 'synced', zoho_lead_id: 'lead-ok', contact_number: NORMALIZED_CONTACT_NUMBER }] };
    }
    return undefined;
  },
  fetchHandler: (url, opts, fetchCalls) => {
    const body = JSON.parse(opts.body);
    if (fetchCalls.length === 1) {
      // First attempt includes the unsupported field -> Zoho rejects it.
      assert.equal(body.data[0].Unsupported_Custom_Field, 'value-x');
      return zohoInvalidFieldResponse('Unsupported_Custom_Field');
    }
    // Retry must have dropped exactly the offending field and nothing else.
    assert.equal(body.data[0].Unsupported_Custom_Field, undefined);
    assert.equal(body.data[0].Last_Name, 'Kumar');
    return zohoSuccessResponse('lead-ok');
  },
}, async (svc, queries, fetchCalls) => {
  const result = await svc.createLead({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_A,
    contactNumber: RAW_CONTACT_NUMBER,
    name: 'Kumar',
    extraFields: { Unsupported_Custom_Field: 'value-x' },
  });

  assert.equal(result.zohoLeadId, 'lead-ok');
  assert.equal(fetchCalls.length, 2); // one failed attempt + one successful retry
  assert.deepEqual(result.droppedFields, [{ apiName: 'Unsupported_Custom_Field', value: 'value-x' }]);
}));

test('createLead: a validation failure NOT tied to a specific field is never silently swallowed', withMockedEnv({
  queryHandler: (sql) => {
    if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return { rows: [{ id: WA_ACCOUNT_A }] };
    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE workspace_id/i.test(sql)) return { rows: [connectionRow(WA_ACCOUNT_A)] };
    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE id/i.test(sql)) return { rows: [connectionRow(WA_ACCOUNT_A)] };
    if (/^INSERT INTO coexistence\.zoho_lead_links/i.test(sql)) {
      return { rows: [{ id: 99, workspace_id: WORKSPACE_ID, whatsapp_account_id: WA_ACCOUNT_A, contact_number: NORMALIZED_CONTACT_NUMBER, status: 'pending' }] };
    }
    if (/^UPDATE coexistence\.zoho_lead_links SET status = 'failed'/i.test(sql)) return { rows: [] };
    return undefined;
  },
  fetchHandler: () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ code: 'MANDATORY_NOT_FOUND', status: 'error', message: 'a mandatory field is missing', details: {} }] }),
  }),
}, async (svc) => {
  await assert.rejects(
    () => svc.createLead({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_A, contactNumber: RAW_CONTACT_NUMBER, name: 'Kumar' }),
    (err) => err.zohoStatus === 400
  );
}));

// ── Per-number connection isolation (spec §3, §9) ─────────────────────────

test('createLead: two different WhatsApp accounts each use their OWN connection, never cross over', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return { rows: [{ id: params[0] }] };
    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE workspace_id/i.test(sql)) {
      return { rows: [connectionRow(params[1])] };
    }
    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE id = \$1$/i.test(sql)) {
      const accountId = params[0] - 100;
      return { rows: [connectionRow(accountId)] };
    }
    if (/^INSERT INTO coexistence\.zoho_lead_links/i.test(sql)) {
      return { rows: [{ id: 900 + params[1], workspace_id: WORKSPACE_ID, whatsapp_account_id: params[1], contact_number: NORMALIZED_CONTACT_NUMBER, status: 'pending' }] };
    }
    if (/^UPDATE coexistence\.zoho_lead_links SET zoho_lead_id/i.test(sql)) {
      return { rows: [{ id: 900, status: 'synced', zoho_lead_id: params[1] }] };
    }
    return undefined;
  },
  fetchHandler: (url) => {
    // Each account's Lead create call must hit ITS OWN api_domain — proof
    // the correct per-number connection was resolved, not a shared/default
    // one (spec §3 "Number A must never use Number B's Zoho credentials").
    if (url.startsWith(`https://www.zohoapis.in/${WA_ACCOUNT_A}`)) return zohoSuccessResponse('lead-A');
    if (url.startsWith(`https://www.zohoapis.in/${WA_ACCOUNT_B}`)) return zohoSuccessResponse('lead-B');
    throw new Error(`unexpected api domain in url: ${url}`);
  },
}, async (svc) => {
  const resultA = await svc.createLead({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_A, contactNumber: RAW_CONTACT_NUMBER, name: 'A One' });
  const resultB = await svc.createLead({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_B, contactNumber: RAW_CONTACT_NUMBER, name: 'B Two' });

  assert.equal(resultA.zohoLeadId, 'lead-A');
  assert.equal(resultB.zohoLeadId, 'lead-B');
}));