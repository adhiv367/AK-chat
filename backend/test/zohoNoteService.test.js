'use strict';

// Phase 8C Part 2 — Zoho Note service tests. Same approach as
// test/zohoLeadService.test.js: pool.query mocked on the shared '../src/db'
// singleton, global.fetch stubbed for all Zoho CRM HTTP calls. No live
// Postgres and no real Zoho account required.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

process.env.AKCHAT_ENCRYPTION_KEY = process.env.AKCHAT_ENCRYPTION_KEY || nodeCrypto.randomBytes(24).toString('hex');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-zoho-note-tests';
process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REDIRECT_URI = process.env.ZOHO_REDIRECT_URI || 'https://app.example.com/api/zoho/oauth/callback';

const { encrypt } = require('../src/util/crypto');

const WORKSPACE_ID = 1;
const WA_ACCOUNT_ID = 5;
const RAW_CONTACT_NUMBER = '+91 99999 99999';
const NORMALIZED_CONTACT_NUMBER = '919999999999';
const ZOHO_LEAD_ID = 'zoho-lead-123';

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
    token_expires_at: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides,
  };
}

function linkedLeadRow(overrides = {}) {
  return {
    id: 77,
    workspace_id: WORKSPACE_ID,
    whatsapp_account_id: WA_ACCOUNT_ID,
    contact_number: NORMALIZED_CONTACT_NUMBER,
    zoho_lead_id: ZOHO_LEAD_ID,
    status: 'synced',
    ...overrides,
  };
}

// Reusable base router — satisfies every query zohoLeadService.resolveConnectionRow
// / the lead-link lookup issue underneath zohoNoteService, so each test only
// overrides the zoho_lead_notes-specific branches it cares about.
function baseRouter({ connectionRow = connectedConnectionRow(), linkRow = linkedLeadRow() } = {}) {
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
    if (/^SELECT \* FROM coexistence\.zoho_lead_links/i.test(sql)) {
      return { rows: linkRow ? [linkRow] : [] };
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
      for (const modName of ['zohoNoteService', 'zohoLeadService', 'zohoConnectionService', 'zohoTokenService', 'zohoOAuthService', 'contactSyncService']) {
        delete require.cache[require.resolve(`../src/services/${modName}`)];
      }
      const svc = require('../src/services/zohoNoteService');
      await run(svc, queries, fetchCalls);
    } finally {
      pool.query = originalQuery;
      global.fetch = originalFetch;
    }
  };
}

function zohoNoteSuccessResponse(id) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: [{ code: 'SUCCESS', status: 'success', details: { id } }] }),
  };
}

function zohoErrorResponse(status, code) {
  return {
    ok: false,
    status,
    json: async () => ({ data: [{ code, status: 'error', message: code }] }),
  };
}

// ── computeIdempotencyKey (pure) ──────────────────────────────────────────

test('computeIdempotencyKey is deterministic for the same title/content', withMockedEnv({ queryHandler: () => undefined, fetchHandler: () => { throw new Error('no fetch expected'); } }, async (svc) => {
  const a = svc.computeIdempotencyKey('Interested', 'Wants a quote for roofing sheets');
  const b = svc.computeIdempotencyKey('Interested', 'Wants a quote for roofing sheets');
  assert.equal(a, b);
}));

test('computeIdempotencyKey differs for different content', withMockedEnv({ queryHandler: () => undefined, fetchHandler: () => { throw new Error('no fetch expected'); } }, async (svc) => {
  const a = svc.computeIdempotencyKey('Interested', 'Wants roofing sheets');
  const b = svc.computeIdempotencyKey('Interested', 'Wants steel pipes');
  assert.notEqual(a, b);
}));

// ── CREATE flow ────────────────────────────────────────────────────────────

test('createNote: successful creation calls Zoho once, inserts a synced row, returns safe result (no tokens)', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^INSERT INTO coexistence\.zoho_lead_notes/i.test(sql)) {
      assert.equal(params[3], ZOHO_LEAD_ID);
      assert.equal(params[4], NORMALIZED_CONTACT_NUMBER);
      return { rows: [{ id: 99, workspace_id: WORKSPACE_ID, whatsapp_account_id: WA_ACCOUNT_ID, zoho_lead_id: ZOHO_LEAD_ID, contact_number: NORMALIZED_CONTACT_NUMBER, status: 'pending' }] };
    }
    if (/^UPDATE coexistence\.zoho_lead_notes SET zoho_note_id/i.test(sql)) {
      assert.equal(params[1], 'zoho-note-1');
      return { rows: [{ id: 99, workspace_id: WORKSPACE_ID, whatsapp_account_id: WA_ACCOUNT_ID, zoho_lead_id: ZOHO_LEAD_ID, contact_number: NORMALIZED_CONTACT_NUMBER, status: 'synced', zoho_note_id: 'zoho-note-1' }] };
    }
    return baseRouter()(sql, params);
  },
  fetchHandler: (url, opts) => {
    assert.match(url, new RegExp(`/crm/v2/Leads/${ZOHO_LEAD_ID}/Notes$`));
    assert.equal(opts.method, 'POST');
    const body = JSON.parse(opts.body);
    assert.equal(body.data[0].Note_Content, 'Wants a quote for roofing sheets');
    assert.equal(body.data[0].Note_Title, 'Interested');
    return zohoNoteSuccessResponse('zoho-note-1');
  },
}, async (svc, _queries, fetchCalls) => {
  const result = await svc.createNote({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    title: 'Interested',
    content: 'Wants a quote for roofing sheets',
  });
  assert.equal(result.zohoNoteId, 'zoho-note-1');
  assert.equal(result.zohoLeadId, ZOHO_LEAD_ID);
  assert.equal(result.created, true);
  assert.equal(fetchCalls.length, 1);
  assert.equal(JSON.stringify(result).includes('token'), false);
}));

test('createNote: omits Note_Title when no title supplied', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^INSERT INTO coexistence\.zoho_lead_notes/i.test(sql)) {
      return { rows: [{ id: 1, status: 'pending' }] };
    }
    if (/^UPDATE coexistence\.zoho_lead_notes SET zoho_note_id/i.test(sql)) {
      return { rows: [{ id: 1, status: 'synced', zoho_note_id: 'n-1' }] };
    }
    return baseRouter()(sql, params);
  },
  fetchHandler: (url, opts) => {
    const body = JSON.parse(opts.body);
    assert.equal(body.data[0].Note_Title, undefined);
    assert.equal(body.data[0].Note_Content, 'Just content, no title');
    return zohoNoteSuccessResponse('n-1');
  },
}, async (svc) => {
  await svc.createNote({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, content: 'Just content, no title' });
}));

// ── Lead association / connection resolution ────────────────────────────

test('createNote: rejects when no linked Zoho Lead exists for this contact (never calls Zoho)', withMockedEnv({
  queryHandler: baseRouter({ linkRow: null }),
  fetchHandler: () => { throw new Error('must not call Zoho without a linked Lead'); },
}, async (svc) => {
  await assert.rejects(
    svc.createNote({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, content: 'hello' }),
    (err) => err.status === 404
  );
}));

test('createNote: rejects when the linked row has no zoho_lead_id yet (create still in flight)', withMockedEnv({
  queryHandler: baseRouter({ linkRow: linkedLeadRow({ zoho_lead_id: null, status: 'pending' }) }),
  fetchHandler: () => { throw new Error('must not call Zoho'); },
}, async (svc) => {
  await assert.rejects(
    svc.createNote({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, content: 'hello' }),
    (err) => err.status === 404
  );
}));

test('createNote: resolves the connection via zohoConnectionService (workspace isolation enforced upstream)', withMockedEnv({
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
    svc.createNote({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, content: 'hello' }),
    (err) => err.status === 404
  );
}));

test('createNote: WhatsApp-account isolation — a link belonging to a different account is never matched (query itself is scoped)', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^SELECT \* FROM coexistence\.zoho_lead_links/i.test(sql)) {
      assert.deepEqual(params, [WORKSPACE_ID, WA_ACCOUNT_ID, NORMALIZED_CONTACT_NUMBER]);
      return { rows: [] };
    }
    return baseRouter({ linkRow: null })(sql, params);
  },
  fetchHandler: () => { throw new Error('must not call Zoho'); },
}, async (svc) => {
  await assert.rejects(
    svc.createNote({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, content: 'hello' }),
    (err) => err.status === 404
  );
}));

test('createNote: rejects when the Zoho connection is disconnected', withMockedEnv({
  queryHandler: baseRouter({ connectionRow: connectedConnectionRow({ status: 'disconnected' }) }),
  fetchHandler: () => { throw new Error('must not call Zoho'); },
}, async (svc) => {
  await assert.rejects(
    svc.createNote({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, content: 'hello' }),
    /disconnected/
  );
}));

// ── DUPLICATE / idempotency ────────────────────────────────────────────────

test('createNote: identical (title, content) resubmitted returns the existing synced Note instead of creating another (no Zoho call)', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^INSERT INTO coexistence\.zoho_lead_notes/i.test(sql)) return { rows: [] }; // conflict
    if (/^SELECT \* FROM coexistence\.zoho_lead_notes WHERE workspace_id/i.test(sql)) {
      return { rows: [{ id: 5, workspace_id: WORKSPACE_ID, whatsapp_account_id: WA_ACCOUNT_ID, zoho_lead_id: ZOHO_LEAD_ID, contact_number: NORMALIZED_CONTACT_NUMBER, status: 'synced', zoho_note_id: 'already-created' }] };
    }
    return baseRouter()(sql, params);
  },
  fetchHandler: () => { throw new Error('must not call Zoho for a duplicate submission'); },
}, async (svc, _queries, fetchCalls) => {
  const result = await svc.createNote({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, title: 'Interested', content: 'Wants a quote' });
  assert.equal(result.zohoNoteId, 'already-created');
  assert.equal(result.created, false);
  assert.equal(fetchCalls.length, 0);
}));

test('createNote: a different (title, content) for the same Lead is NOT treated as a duplicate (different idempotency key)', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^INSERT INTO coexistence\.zoho_lead_notes/i.test(sql)) {
      return { rows: [{ id: 6, status: 'pending' }] };
    }
    if (/^UPDATE coexistence\.zoho_lead_notes SET zoho_note_id/i.test(sql)) {
      return { rows: [{ id: 6, status: 'synced', zoho_note_id: 'n-2' }] };
    }
    return baseRouter()(sql, params);
  },
  fetchHandler: () => zohoNoteSuccessResponse('n-2'),
}, async (svc, _queries, fetchCalls) => {
  const result = await svc.createNote({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, title: 'Interested', content: 'A brand-new note body' });
  assert.equal(result.created, true);
  assert.equal(fetchCalls.length, 1);
}));

test('createNote: explicit idempotencyKey is honored over the derived (title, content) hash', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^INSERT INTO coexistence\.zoho_lead_notes/i.test(sql)) {
      assert.equal(params[5], 'event-42');
      return { rows: [{ id: 7, status: 'pending' }] };
    }
    if (/^UPDATE coexistence\.zoho_lead_notes SET zoho_note_id/i.test(sql)) {
      return { rows: [{ id: 7, status: 'synced', zoho_note_id: 'n-3' }] };
    }
    return baseRouter()(sql, params);
  },
  fetchHandler: () => zohoNoteSuccessResponse('n-3'),
}, async (svc) => {
  await svc.createNote({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, content: 'hello', idempotencyKey: 'event-42' });
}));

test('createNote: pending-but-unsynced row (crashed mid-flight) is rejected as in-progress, never re-creates', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^INSERT INTO coexistence\.zoho_lead_notes/i.test(sql)) return { rows: [] }; // conflict
    if (/^SELECT \* FROM coexistence\.zoho_lead_notes WHERE workspace_id/i.test(sql)) {
      return { rows: [{ id: 8, status: 'pending', zoho_note_id: null }] };
    }
    return baseRouter()(sql, params);
  },
  fetchHandler: () => { throw new Error('must not call Zoho'); },
}, async (svc) => {
  await assert.rejects(
    svc.createNote({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, content: 'hello' }),
    (err) => err.status === 409
  );
}));

// ── Zoho errors / token refresh / reauth ──────────────────────────────────

test('createNote: Zoho 401 triggers one refresh+retry via zohoLeadService.withAccessToken, then succeeds', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^INSERT INTO coexistence\.zoho_lead_notes/i.test(sql)) return { rows: [{ id: 1, status: 'pending' }] };
    if (/^UPDATE coexistence\.zoho_lead_notes SET zoho_note_id/i.test(sql)) return { rows: [{ id: 1, status: 'synced', zoho_note_id: 'n-retry' }] };
    if (/^UPDATE coexistence\.zoho_connections SET access_token_encrypted/i.test(sql) || /^UPDATE coexistence\.zoho_connections SET /i.test(sql)) {
      return { rows: [connectedConnectionRow()] };
    }
    return baseRouter()(sql, params);
  },
  fetchHandler: (() => {
    let call = 0;
    return (url) => {
      if (String(url).includes('/oauth/v2/token')) {
        return { ok: true, json: async () => ({ access_token: 'fresh-token', expires_in: 3600 }) };
      }
      call += 1;
      if (call === 1) return zohoErrorResponse(401, 'INVALID_TOKEN');
      return zohoNoteSuccessResponse('n-retry');
    };
  })(),
}, async (svc) => {
  const result = await svc.createNote({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, content: 'hello' });
  assert.equal(result.zohoNoteId, 'n-retry');
}));

test('createNote: Zoho 400 (validation error) is sanitized and marks the row failed', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^INSERT INTO coexistence\.zoho_lead_notes/i.test(sql)) return { rows: [{ id: 2, status: 'pending' }] };
    if (/^UPDATE coexistence\.zoho_lead_notes SET status = 'failed'/i.test(sql)) {
      assert.match(params[1], /400/);
      return { rows: [] };
    }
    return baseRouter()(sql, params);
  },
  fetchHandler: () => zohoErrorResponse(400, 'MANDATORY_NOT_FOUND'),
}, async (svc) => {
  await assert.rejects(
    svc.createNote({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, content: 'hello' }),
    (err) => err.zohoStatus === 400
  );
}));

test('createNote: Zoho 429 (rate limited) is surfaced and marks the row failed, no token leaked', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^INSERT INTO coexistence\.zoho_lead_notes/i.test(sql)) return { rows: [{ id: 3, status: 'pending' }] };
    if (/^UPDATE coexistence\.zoho_lead_notes SET status = 'failed'/i.test(sql)) return { rows: [] };
    return baseRouter()(sql, params);
  },
  fetchHandler: () => zohoErrorResponse(429, 'TOO_MANY_REQUESTS'),
}, async (svc) => {
  await assert.rejects(
    svc.createNote({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, content: 'hello' }),
    (err) => err.zohoStatus === 429
  );
}));

test('createNote: network failure never leaks internals and marks the row failed', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^INSERT INTO coexistence\.zoho_lead_notes/i.test(sql)) return { rows: [{ id: 4, status: 'pending' }] };
    if (/^UPDATE coexistence\.zoho_lead_notes SET status = 'failed'/i.test(sql)) return { rows: [] };
    return baseRouter()(sql, params);
  },
  fetchHandler: () => { throw new Error('ECONNRESET some internal detail'); },
}, async (svc) => {
  await assert.rejects(
    svc.createNote({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, content: 'hello' }),
    (err) => err.message === 'Network error contacting Zoho CRM' && err.zohoStatus === null
  );
}));

// ── Validation ──────────────────────────────────────────────────────────────

test('createNote: rejects missing content', withMockedEnv({ queryHandler: () => undefined, fetchHandler: () => { throw new Error('no fetch expected'); } }, async (svc) => {
  await assert.rejects(svc.createNote({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, content: '' }), /content is required/);
}));

test('createNote: rejects missing contactNumber', withMockedEnv({ queryHandler: () => undefined, fetchHandler: () => { throw new Error('no fetch expected'); } }, async (svc) => {
  await assert.rejects(svc.createNote({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: '', content: 'hello' }), /contactNumber is required/);
}));
