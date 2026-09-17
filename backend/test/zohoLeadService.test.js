'use strict';

// Phase 8C Part 1 — Zoho Lead service tests. Mocks pool.query on the shared
// '../src/db' singleton (same approach as test/zohoConnectionService.test.js
// and test/zohoTokenService.test.js) and mocks global fetch for all Zoho CRM
// HTTP calls (same approach as test/zohoOAuthService.test.js). No live
// Postgres and no real Zoho account required.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

process.env.AKCHAT_ENCRYPTION_KEY = process.env.AKCHAT_ENCRYPTION_KEY || nodeCrypto.randomBytes(24).toString('hex');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-zoho-lead-tests';
process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REDIRECT_URI = process.env.ZOHO_REDIRECT_URI || 'https://app.example.com/api/zoho/oauth/callback';

const { encrypt } = require('../src/util/crypto');

const WORKSPACE_ID = 1;
const WA_ACCOUNT_ID = 5;
const RAW_CONTACT_NUMBER = '+91 99999 99999';
const NORMALIZED_CONTACT_NUMBER = '919999999999';

const OWNED_WA_ACCOUNT = { rows: [{ id: WA_ACCOUNT_ID }] };

function connectedConnectionRow(overrides = {}) {
  return {
    id: 10,
    workspace_id: WORKSPACE_ID,
    whatsapp_account_id: WA_ACCOUNT_ID,
    status: 'connected',
    zoho_api_domain: 'https://www.zohoapis.in',
    zoho_data_center: 'in',
    access_token_encrypted: encrypt('valid-access-token'),
    refresh_token_encrypted: encrypt('valid-refresh-token'),
    token_expires_at: new Date(Date.now() + 60 * 60 * 1000), // 1h out, not expired
    ...overrides,
  };
}

// Reusable base query router: satisfies every query zohoConnectionService /
// zohoTokenService issue underneath zohoLeadService, so each test only has
// to override the zoho_lead_links-specific branches it cares about.
function baseRouter({ connectionRow = connectedConnectionRow() } = {}) {
  return (sql, params) => {
    if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED_WA_ACCOUNT;
    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE workspace_id/i.test(sql)) {
      return { rows: [connectionRow] };
    }
    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE id/i.test(sql)) {
      return { rows: [connectionRow] };
    }
    if (/^UPDATE coexistence\.zoho_connections SET last_success_at/i.test(sql)) {
      return { rows: [connectionRow] };
    }
    return undefined;
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

// ── Name handling (pure functions) ───────────────────────────────────────

test('splitName: "Ravi Kumar" -> First_Name=Ravi, Last_Name=Kumar', withMockedEnv({ queryHandler: () => undefined, fetchHandler: () => { throw new Error('no fetch expected'); } }, async (svc) => {
  const result = svc.splitName('Ravi Kumar');
  assert.equal(result.firstName, 'Ravi');
  assert.equal(result.lastName, 'Kumar');
}));

test('splitName: single token "Kumar" -> Last_Name=Kumar, no invented First_Name', withMockedEnv({ queryHandler: () => undefined, fetchHandler: () => { throw new Error('no fetch expected'); } }, async (svc) => {
  const result = svc.splitName('Kumar');
  assert.equal(result.firstName, null);
  assert.equal(result.lastName, 'Kumar');
}));

test('splitName: empty/missing name -> both null (never invents a name)', withMockedEnv({ queryHandler: () => undefined, fetchHandler: () => { throw new Error('no fetch expected'); } }, async (svc) => {
  assert.deepEqual(svc.splitName(''), { firstName: null, lastName: null });
  assert.deepEqual(svc.splitName(undefined), { firstName: null, lastName: null });
}));

test('buildLeadFields falls back to contactNumber as Last_Name when no name is supplied (never fakes a surname)', withMockedEnv({ queryHandler: () => undefined, fetchHandler: () => { throw new Error('no fetch expected'); } }, async (svc) => {
  const fields = svc.buildLeadFields({ contactNumber: NORMALIZED_CONTACT_NUMBER });
  assert.equal(fields.Last_Name, NORMALIZED_CONTACT_NUMBER);
  assert.equal(fields.First_Name, undefined);
}));

test('buildLeadFields maps standard fields correctly', withMockedEnv({ queryHandler: () => undefined, fetchHandler: () => { throw new Error('no fetch expected'); } }, async (svc) => {
  const fields = svc.buildLeadFields({
    name: 'Ravi Kumar',
    place: 'Namakkal',
    email: 'ravi@example.com',
    interestSummary: 'Interested in roofing sheets',
    contactNumber: NORMALIZED_CONTACT_NUMBER,
  });
  assert.equal(fields.First_Name, 'Ravi');
  assert.equal(fields.Last_Name, 'Kumar');
  assert.equal(fields.City, 'Namakkal');
  assert.equal(fields.Email, 'ravi@example.com');
  assert.equal(fields.Description, 'Interested in roofing sheets');
  assert.equal(fields.Phone, NORMALIZED_CONTACT_NUMBER);
  assert.equal(fields.Mobile, NORMALIZED_CONTACT_NUMBER);
}));

test('buildUpdateFields only includes explicitly supplied fields, never blanks out with null/empty', withMockedEnv({ queryHandler: () => undefined, fetchHandler: () => { throw new Error('no fetch expected'); } }, async (svc) => {
  const fields = svc.buildUpdateFields({ place: 'Erode', email: '', name: undefined });
  assert.deepEqual(fields, { City: 'Erode' });
}));

// ── CREATE flow ───────────────────────────────────────────────────────────

test('createLead: successful creation calls Zoho once, inserts a synced link, returns safe result', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^INSERT INTO coexistence\.zoho_lead_links/i.test(sql)) {
      assert.equal(params[3], NORMALIZED_CONTACT_NUMBER); // normalized, not raw
      return { rows: [{ id: 99, workspace_id: WORKSPACE_ID, whatsapp_account_id: WA_ACCOUNT_ID, contact_number: NORMALIZED_CONTACT_NUMBER, status: 'pending' }] };
    }
    if (/^UPDATE coexistence\.zoho_lead_links SET zoho_lead_id/i.test(sql)) {
      assert.equal(params[1], 'zoho-lead-123');
      return { rows: [{ id: 99, workspace_id: WORKSPACE_ID, whatsapp_account_id: WA_ACCOUNT_ID, contact_number: NORMALIZED_CONTACT_NUMBER, status: 'synced', zoho_lead_id: 'zoho-lead-123' }] };
    }
    return baseRouter()(sql, params);
  },
  fetchHandler: (url, opts) => {
    assert.match(url, /\/crm\/v2\/Leads$/);
    assert.equal(opts.method, 'POST');
    const body = JSON.parse(opts.body);
    assert.equal(body.data[0].Last_Name, 'Kumar');
    return zohoSuccessResponse('zoho-lead-123');
  },
}, async (svc, queries, fetchCalls) => {
  const result = await svc.createLead({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    name: 'Kumar',
    place: 'Namakkal',
  });
  assert.equal(result.zohoLeadId, 'zoho-lead-123');
  assert.equal(result.created, true);
  assert.equal(fetchCalls.length, 1);
}));

test('createLead: required Last_Name uses contactNumber when name is entirely absent', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^INSERT INTO coexistence\.zoho_lead_links/i.test(sql)) {
      return { rows: [{ id: 99, workspace_id: WORKSPACE_ID, whatsapp_account_id: WA_ACCOUNT_ID, contact_number: NORMALIZED_CONTACT_NUMBER, status: 'pending' }] };
    }
    if (/^UPDATE coexistence\.zoho_lead_links SET zoho_lead_id/i.test(sql)) {
      return { rows: [{ id: 99, status: 'synced', zoho_lead_id: 'lead-1' }] };
    }
    return baseRouter()(sql, params);
  },
  fetchHandler: (url, opts) => {
    const body = JSON.parse(opts.body);
    assert.equal(body.data[0].Last_Name, NORMALIZED_CONTACT_NUMBER);
    return zohoSuccessResponse('lead-1');
  },
}, async (svc) => {
  await svc.createLead({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER });
}));

test('createLead: phone normalization treats +919999999999 and 919999999999 as the same identity', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^INSERT INTO coexistence\.zoho_lead_links/i.test(sql)) {
      assert.equal(params[3], NORMALIZED_CONTACT_NUMBER);
      return { rows: [{ id: 1, status: 'pending' }] };
    }
    if (/^UPDATE coexistence\.zoho_lead_links SET zoho_lead_id/i.test(sql)) {
      return { rows: [{ id: 1, status: 'synced', zoho_lead_id: 'lead-x' }] };
    }
    return baseRouter()(sql, params);
  },
  fetchHandler: () => zohoSuccessResponse('lead-x'),
}, async (svc) => {
  await svc.createLead({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: '+919999999999', name: 'Kumar' });
  await svc.createLead({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: '919999999999', name: 'Kumar' });
}));

test('createLead: resolves the connection via zohoConnectionService (workspace isolation enforced upstream)', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) {
      assert.deepEqual(params, [WA_ACCOUNT_ID, WORKSPACE_ID]);
      return { rows: [] }; // not owned
    }
    return undefined;
  },
  fetchHandler: () => { throw new Error('must not call Zoho when account is not owned'); },
}, async (svc) => {
  await assert.rejects(
    svc.createLead({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, name: 'Kumar' }),
    (err) => err.status === 404
  );
}));

test('createLead: rejects when the Zoho connection is disconnected', withMockedEnv({
  queryHandler: baseRouter({ connectionRow: connectedConnectionRow({ status: 'disconnected' }) }),
  fetchHandler: () => { throw new Error('must not call Zoho'); },
}, async (svc) => {
  await assert.rejects(
    svc.createLead({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, name: 'Kumar' }),
    /disconnected/
  );
}));

// ── DUPLICATE / idempotency ────────────────────────────────────────────

test('createLead: existing synced link returns the existing Lead instead of creating another (no Zoho call)', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^INSERT INTO coexistence\.zoho_lead_links/i.test(sql)) return { rows: [] }; // conflict
    if (/^SELECT \* FROM coexistence\.zoho_lead_links WHERE workspace_id/i.test(sql)) {
      return { rows: [{ id: 5, workspace_id: WORKSPACE_ID, whatsapp_account_id: WA_ACCOUNT_ID, contact_number: NORMALIZED_CONTACT_NUMBER, status: 'synced', zoho_lead_id: 'already-linked' }] };
    }
    return baseRouter()(sql, params);
  },
  fetchHandler: () => { throw new Error('must not call Zoho for an already-linked contact'); },
}, async (svc, _queries, fetchCalls) => {
  const result = await svc.createLead({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, name: 'Kumar' });
  assert.equal(result.zohoLeadId, 'already-linked');
  assert.equal(result.created, false);
  assert.equal(fetchCalls.length, 0);
}));

test('createLead: concurrent create for the same identity — the loser sees a clear in-progress error, never a second Zoho call', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^INSERT INTO coexistence\.zoho_lead_links/i.test(sql)) return { rows: [] }; // conflict (another request won the race)
    if (/^SELECT \* FROM coexistence\.zoho_lead_links WHERE workspace_id/i.test(sql)) {
      return { rows: [{ id: 5, status: 'pending', zoho_lead_id: null }] }; // winner hasn't finished yet
    }
    return baseRouter()(sql, params);
  },
  fetchHandler: () => { throw new Error('loser must never call Zoho'); },
}, async (svc, _queries, fetchCalls) => {
  await assert.rejects(
    svc.createLead({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, name: 'Kumar' }),
    (err) => err.status === 409
  );
  assert.equal(fetchCalls.length, 0);
}));

test('createLead: unique-link protection — INSERT uses the ON CONFLICT ON CONSTRAINT uq_zoho_lead_links_identity clause', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^INSERT INTO coexistence\.zoho_lead_links/i.test(sql)) {
      assert.match(sql, /ON CONFLICT ON CONSTRAINT uq_zoho_lead_links_identity DO NOTHING/);
      return { rows: [{ id: 1, status: 'pending' }] };
    }
    if (/^UPDATE coexistence\.zoho_lead_links SET zoho_lead_id/i.test(sql)) {
      return { rows: [{ id: 1, status: 'synced', zoho_lead_id: 'lead-y' }] };
    }
    return baseRouter()(sql, params);
  },
  fetchHandler: () => zohoSuccessResponse('lead-y'),
}, async (svc) => {
  await svc.createLead({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, name: 'Kumar' });
}));

// ── UPDATE flow ───────────────────────────────────────────────────────────

test('updateLead: updates the linked Lead rather than creating a second one', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^SELECT \* FROM coexistence\.zoho_lead_links WHERE workspace_id/i.test(sql)) {
      return { rows: [{ id: 5, workspace_id: WORKSPACE_ID, whatsapp_account_id: WA_ACCOUNT_ID, contact_number: NORMALIZED_CONTACT_NUMBER, status: 'synced', zoho_lead_id: 'lead-42' }] };
    }
    if (/^UPDATE coexistence\.zoho_lead_links SET status = 'synced'/i.test(sql)) {
      return { rows: [{ id: 5, status: 'synced', zoho_lead_id: 'lead-42' }] };
    }
    return baseRouter()(sql, params);
  },
  fetchHandler: (url, opts) => {
    assert.match(url, /\/crm\/v2\/Leads\/lead-42$/);
    assert.equal(opts.method, 'PUT');
    const body = JSON.parse(opts.body);
    assert.equal(body.data[0].City, 'Erode');
    return zohoSuccessResponse('lead-42');
  },
}, async (svc, _queries, fetchCalls) => {
  const result = await svc.updateLead({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, place: 'Erode' });
  assert.equal(result.zohoLeadId, 'lead-42');
  assert.equal(fetchCalls.length, 1);
}));

test('updateLead: only supplied fields are sent, null/empty values never sent (no erase of valid data)', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^SELECT \* FROM coexistence\.zoho_lead_links WHERE workspace_id/i.test(sql)) {
      return { rows: [{ id: 5, status: 'synced', zoho_lead_id: 'lead-42' }] };
    }
    if (/^UPDATE coexistence\.zoho_lead_links SET status = 'synced'/i.test(sql)) {
      return { rows: [{ id: 5, status: 'synced', zoho_lead_id: 'lead-42' }] };
    }
    return baseRouter()(sql, params);
  },
  fetchHandler: (url, opts) => {
    const body = JSON.parse(opts.body);
    assert.deepEqual(body.data[0], { id: 'lead-42', City: 'Erode' });
    return zohoSuccessResponse('lead-42');
  },
}, async (svc) => {
  await svc.updateLead({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, place: 'Erode', email: '', name: null });
}));

test('updateLead: no-op (nothing supplied) never calls Zoho', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^SELECT \* FROM coexistence\.zoho_lead_links WHERE workspace_id/i.test(sql)) {
      return { rows: [{ id: 5, status: 'synced', zoho_lead_id: 'lead-42' }] };
    }
    return baseRouter()(sql, params);
  },
  fetchHandler: () => { throw new Error('must not call Zoho with nothing to update'); },
}, async (svc, _queries, fetchCalls) => {
  const result = await svc.updateLead({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER });
  assert.equal(result.zohoLeadId, 'lead-42');
  assert.equal(fetchCalls.length, 0);
}));

test('updateLead: throws (404) when no existing link exists yet', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^SELECT \* FROM coexistence\.zoho_lead_links WHERE workspace_id/i.test(sql)) return { rows: [] };
    return baseRouter()(sql, params);
  },
  fetchHandler: () => { throw new Error('must not call Zoho'); },
}, async (svc) => {
  await assert.rejects(
    svc.updateLead({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, place: 'Erode' }),
    (err) => err.status === 404
  );
}));

test('updateLead: Lead-not-found (404 from Zoho) is surfaced clearly and marks the link failed', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^SELECT \* FROM coexistence\.zoho_lead_links WHERE workspace_id/i.test(sql)) {
      return { rows: [{ id: 5, status: 'synced', zoho_lead_id: 'lead-deleted' }] };
    }
    if (/^UPDATE coexistence\.zoho_lead_links SET status = 'failed'/i.test(sql)) {
      assert.match(params[1], /no longer exists/);
      return { rows: [{ id: 5 }] };
    }
    return baseRouter()(sql, params);
  },
  fetchHandler: () => ({ ok: false, status: 404, json: async () => ({ data: [{ code: 'RECORD_NOT_FOUND' }] }) }),
}, async (svc) => {
  await assert.rejects(
    svc.updateLead({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, place: 'Erode' }),
    (err) => err.status === 409 && /no longer exists/.test(err.message)
  );
}));

// ── TOKEN handling ────────────────────────────────────────────────────────

test('createLead: uses a valid (non-expired) token without refreshing', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^INSERT INTO coexistence\.zoho_lead_links/i.test(sql)) return { rows: [{ id: 1, status: 'pending' }] };
    if (/^UPDATE coexistence\.zoho_lead_links SET zoho_lead_id/i.test(sql)) return { rows: [{ id: 1, status: 'synced', zoho_lead_id: 'lead-z' }] };
    return baseRouter()(sql, params);
  },
  fetchHandler: (url, opts) => {
    assert.equal(opts.headers.Authorization, 'Zoho-oauthtoken valid-access-token');
    return zohoSuccessResponse('lead-z');
  },
}, async (svc) => {
  await svc.createLead({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, name: 'Kumar' });
}));

test('createLead: expired token is refreshed via zohoTokenService before calling Zoho Leads API', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^INSERT INTO coexistence\.zoho_lead_links/i.test(sql)) return { rows: [{ id: 1, status: 'pending' }] };
    if (/^UPDATE coexistence\.zoho_lead_links SET zoho_lead_id/i.test(sql)) return { rows: [{ id: 1, status: 'synced', zoho_lead_id: 'lead-w' }] };
    return baseRouter({ connectionRow: connectedConnectionRow({ token_expires_at: new Date(Date.now() - 60 * 1000) }) })(sql, params);
  },
  fetchHandler: (url, opts) => {
    // First fetch call in this flow is the OAuth refresh (zohoOAuthService),
    // second is the actual Leads API call carrying the refreshed token.
    if (/oauth\/v2\/token/.test(url)) {
      return { ok: true, json: async () => ({ access_token: 'refreshed-access-token', expires_in: 3600 }) };
    }
    assert.equal(opts.headers.Authorization, 'Zoho-oauthtoken refreshed-access-token');
    return zohoSuccessResponse('lead-w');
  },
}, async (svc) => {
  await svc.createLead({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, name: 'Kumar' });
}));

test('createLead: permanent refresh failure surfaces an error (reauth_required lifecycle preserved by zohoTokenService)', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^INSERT INTO coexistence\.zoho_lead_links/i.test(sql)) return { rows: [{ id: 1, status: 'pending' }] };
    if (/^UPDATE coexistence\.zoho_connections SET status = 'reauth_required'/i.test(sql)) return { rows: [{ id: 10 }] };
    if (/^UPDATE coexistence\.zoho_lead_links SET status = 'failed'/i.test(sql)) return { rows: [{ id: 1 }] };
    return baseRouter({ connectionRow: connectedConnectionRow({ token_expires_at: new Date(Date.now() - 60 * 1000) }) })(sql, params);
  },
  fetchHandler: (url) => {
    if (/oauth\/v2\/token/.test(url)) {
      return { ok: false, json: async () => ({ error: 'invalid_grant' }) };
    }
    throw new Error('must not reach the Leads API when refresh fails');
  },
}, async (svc) => {
  await assert.rejects(
    svc.createLead({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, name: 'Kumar' })
  );
}));

test('createLead: retry after a mid-request refresh uses the FRESH zoho_api_domain, not the stale one captured before the refresh (domain-staleness FIX — root cause of Connected -> Needs reauthentication with a valid DB row)', withMockedEnv({
  queryHandler: (() => {
    let connectionSelectCalls = 0;
    return (sql, params) => {
      if (/^INSERT INTO coexistence\.zoho_lead_links/i.test(sql)) return { rows: [{ id: 1, status: 'pending' }] };
      if (/^UPDATE coexistence\.zoho_lead_links SET zoho_lead_id/i.test(sql)) return { rows: [{ id: 1, status: 'synced', zoho_lead_id: 'lead-fresh-domain' }] };
      // Every UPDATE atomicTokenUpdate/refreshConnectionToken issue while
      // persisting the refreshed token — must not fall through to {rows: []}.
      if (/^UPDATE coexistence\.zoho_connections SET access_token_encrypted/i.test(sql)) return { rows: [{ id: 10 }] };
      // The connection is loaded TWICE: once up-front by resolveConnectionRow
      // (stale/wrong domain — simulates a connection whose zoho_api_domain
      // was never correctly recorded), and once more by
      // getConnectionRowByOwnership right after the refresh succeeds (this
      // fix) — which must see the CORRECTED domain the refresh just wrote.
      if (/^SELECT \* FROM coexistence\.zoho_connections WHERE workspace_id/i.test(sql)) {
        connectionSelectCalls += 1;
        const domain = connectionSelectCalls === 1
          ? 'https://www.zohoapis.com'   // stale/wrong — captured before refresh
          : 'https://www.zohoapis.in';   // corrected — what the refresh just persisted
        return { rows: [connectedConnectionRow({ zoho_api_domain: domain })] };
      }
      return baseRouter()(sql, params);
    };
  })(),
  fetchHandler: (url, opts) => {
    if (/oauth\/v2\/token/.test(url)) {
      // Refresh succeeds and Zoho reports the corrected (.in) api_domain.
      return { ok: true, json: async () => ({ access_token: 'refreshed-access-token', expires_in: 3600, api_domain: 'https://www.zohoapis.in' }) };
    }
    if (url.startsWith('https://www.zohoapis.com')) {
      // The stale domain rejects even a perfectly valid token — this is
      // the genuine-looking "twice (401)" symptom that is really a domain
      // mismatch, not an invalid grant.
      return { ok: false, status: 401, json: async () => ({ code: 'INVALID_TOKEN' }) };
    }
    if (url.startsWith('https://www.zohoapis.in')) {
      assert.equal(opts.headers.Authorization, 'Zoho-oauthtoken refreshed-access-token');
      return zohoSuccessResponse('lead-fresh-domain');
    }
    throw new Error(`unexpected fetch to ${url}`);
  },
}, async (svc, queries) => {
  const result = await svc.createLead({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, name: 'Kumar' });
  assert.equal(result.zohoLeadId, 'lead-fresh-domain');
  // Must NEVER have marked the connection reauth_required — the fresh
  // domain retry succeeded, so this was never a real auth failure.
  assert.ok(!queries.some((q) => /reauth_required/i.test(q.sql)));
}));

test('createLead: rejects upfront when the connection already needs reauth (no wasted Zoho call)', withMockedEnv({
  queryHandler: baseRouter({ connectionRow: connectedConnectionRow({ status: 'reauth_required' }) }),
  fetchHandler: () => { throw new Error('must not call Zoho'); },
}, async (svc) => {
  await assert.rejects(
    svc.createLead({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, name: 'Kumar' }),
    /re-authentication/
  );
}));

// ── ERRORS ────────────────────────────────────────────────────────────────

const ERROR_CASES = [
  { status: 400, code: 'MANDATORY_NOT_FOUND' },
  { status: 403, code: 'PERMISSION_DENIED' },
  { status: 429, code: null },
];

for (const { status, code } of ERROR_CASES) {
  test(`createLead: Zoho ${status} is sanitized into a safe error (no raw payload leaked)`, withMockedEnv({
    queryHandler: (sql, params) => {
      if (/^INSERT INTO coexistence\.zoho_lead_links/i.test(sql)) return { rows: [{ id: 1, status: 'pending' }] };
      if (/^UPDATE coexistence\.zoho_lead_links SET status = 'failed'/i.test(sql)) return { rows: [{ id: 1 }] };
      return baseRouter()(sql, params);
    },
    fetchHandler: () => ({
      ok: false,
      status,
      json: async () => ({ data: [{ code, message: 'some secret internal Zoho detail that must never leak', details: { api_name: 'Some_Field', sensitive: 'leaked-if-not-sanitized' } }] }),
    }),
  }, async (svc) => {
    await assert.rejects(svc.createLead({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, name: 'Kumar' }), (err) => {
      assert.equal(err.zohoStatus, status);
      assert.equal(err.message.includes('leaked-if-not-sanitized'), false);
      assert.equal(err.message.includes('secret internal'), false);
      return true;
    });
  }));
}

test('createLead: network failure is wrapped into a safe error', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^INSERT INTO coexistence\.zoho_lead_links/i.test(sql)) return { rows: [{ id: 1, status: 'pending' }] };
    if (/^UPDATE coexistence\.zoho_lead_links SET status = 'failed'/i.test(sql)) return { rows: [{ id: 1 }] };
    return baseRouter()(sql, params);
  },
  fetchHandler: () => { throw new Error('ECONNRESET some internal detail'); },
}, async (svc) => {
  await assert.rejects(svc.createLead({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, name: 'Kumar' }), (err) => {
    assert.equal(err.message.includes('ECONNRESET'), false);
    return true;
  });
}));

test('createLead: malformed (non-JSON) Zoho response is handled safely', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^INSERT INTO coexistence\.zoho_lead_links/i.test(sql)) return { rows: [{ id: 1, status: 'pending' }] };
    if (/^UPDATE coexistence\.zoho_lead_links SET status = 'failed'/i.test(sql)) return { rows: [{ id: 1 }] };
    return baseRouter()(sql, params);
  },
  fetchHandler: () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }),
}, async (svc) => {
  await assert.rejects(svc.createLead({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, name: 'Kumar' }));
}));

// ── SECURITY ──────────────────────────────────────────────────────────────

test('createLead: never includes an access/refresh token anywhere in the returned result', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^INSERT INTO coexistence\.zoho_lead_links/i.test(sql)) return { rows: [{ id: 1, status: 'pending' }] };
    if (/^UPDATE coexistence\.zoho_lead_links SET zoho_lead_id/i.test(sql)) return { rows: [{ id: 1, status: 'synced', zoho_lead_id: 'lead-secure' }] };
    return baseRouter()(sql, params);
  },
  fetchHandler: () => zohoSuccessResponse('lead-secure'),
}, async (svc) => {
  const result = await svc.createLead({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, name: 'Kumar' });
  assert.equal(JSON.stringify(result).includes('valid-access-token'), false);
  assert.equal(JSON.stringify(result).includes('valid-refresh-token'), false);
}));

test('createLead: a Zoho error response is never leaked raw into the thrown error message', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^INSERT INTO coexistence\.zoho_lead_links/i.test(sql)) return { rows: [{ id: 1, status: 'pending' }] };
    if (/^UPDATE coexistence\.zoho_lead_links SET status = 'failed'/i.test(sql)) return { rows: [{ id: 1 }] };
    return baseRouter()(sql, params);
  },
  fetchHandler: () => ({
    ok: false,
    status: 400,
    json: async () => ({ data: [{ code: 'INVALID_DATA', message: 'SUPER_SECRET_INTERNAL_ZOHO_TRACE_ID_998877' }] }),
  }),
}, async (svc) => {
  await assert.rejects(svc.createLead({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, name: 'Kumar' }), (err) => {
    assert.equal(err.message.includes('SUPER_SECRET_INTERNAL_ZOHO_TRACE_ID_998877'), false);
    return true;
  });
}));