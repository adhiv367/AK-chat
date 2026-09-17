'use strict';

// AK Chat Zoho — "Connected -> Needs reauthentication (again, after the
// stale-domain fix)" regression suite.
//
// Root cause (this phase): a webhook-triggered Lead/Note sync and the
// background reconciliation scheduler (zohoReconciliationScheduler.js,
// every 60s) can both decide the same connection's token needs refreshing
// at virtually the same moment. Zoho ROTATES (and invalidates the prior)
// refresh token on every successful /oauth/v2/token exchange, so whichever
// concurrent caller loses the race sends an already-invalidated refresh
// token and gets back a genuine-looking invalid_grant/invalid_code for a
// connection that is, in fact, perfectly healthy a moment later. Before
// this fix that was indistinguishable from an actually-revoked grant and
// wrongly flipped zoho_connections.status to 'reauth_required' — with NO
// navigation, NO manual reconnect, and no stale zoho_api_domain involved,
// which is exactly why it kept reproducing after the earlier
// stale-domain fix (a different, unrelated bug).
//
// Two layers of defense are exercised here:
//   1. zohoTokenService.refreshConnectionToken — an in-process per-
//      connectionId mutex (only one real Zoho refresh call in flight at a
//      time for a given connection) PLUS an optimistic-concurrency check:
//      before condemning a refresh_token as genuinely dead, re-read the
//      row and compare its refresh_token_encrypted to the one we actually
//      sent Zoho. A mismatch proves a concurrent refresh already rotated
//      it — the connection is fine, not proof the grant is dead.
//   2. zohoLeadService.withAccessToken's own "second 401 -> reauth_required"
//      path (the exact source of the literal error string
//      "Zoho rejected access token twice (401)") gets the same treatment,
//      comparing access_token_encrypted instead.
//
// Same no-live-Postgres / no-live-Zoho approach as the rest of the Zoho
// test suite: pool.query is monkey-patched and global.fetch is stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

process.env.AKCHAT_ENCRYPTION_KEY = process.env.AKCHAT_ENCRYPTION_KEY || nodeCrypto.randomBytes(24).toString('hex');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-zoho-concurrent-refresh-tests';
process.env.ZOHO_CLIENT_ID = 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = 'test-client-secret';
process.env.ZOHO_REDIRECT_URI = 'https://app.example.test/api/integrations/zoho/callback';

const { encrypt } = require('../src/util/crypto');

const WORKSPACE_ID = 1;
const WA_ACCOUNT_ID = 5;
const RAW_CONTACT_NUMBER = '+91 99999 99999';
const OWNED_WA_ACCOUNT = { rows: [{ id: WA_ACCOUNT_ID }] };

function freshTokenService() {
  for (const modName of ['zohoTokenService']) {
    delete require.cache[require.resolve(`../src/services/${modName}`)];
  }
  return require('../src/services/zohoTokenService');
}

function freshLeadService() {
  for (const modName of ['zohoLeadService', 'zohoConnectionService', 'zohoTokenService', 'zohoOAuthService', 'contactSyncService']) {
    delete require.cache[require.resolve(`../src/services/${modName}`)];
  }
  return require('../src/services/zohoLeadService');
}

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

function zohoSuccessResponse(id) {
  return { ok: true, status: 200, json: async () => ({ data: [{ code: 'SUCCESS', status: 'success', details: { id } }] }) };
}

// ── A. transient Zoho failure never marks reauth_required ─────────────────
test('A. refreshConnectionToken: a transient (5xx) refresh failure leaves the connection untouched — never reauth_required', async () => {
  const pool = require('../src/db');
  const original = pool.query;
  const encryptedRefreshToken = encrypt('still-good-refresh-token');
  const queries = [];
  pool.query = async (sql, params) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    queries.push({ sql: normalized, params });
    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE id/i.test(normalized)) {
      return { rows: [{ id: 20, refresh_token_encrypted: encryptedRefreshToken, zoho_data_center: 'in' }] };
    }
    return { rows: [] };
  };
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  try {
    const svc = freshTokenService();
    await assert.rejects(svc.refreshConnectionToken(20));
    assert.ok(!queries.some((q) => /status = 'reauth_required'/.test(q.sql)), 'a transient 5xx must never mark reauth_required');
  } finally {
    pool.query = original;
    global.fetch = originalFetch;
  }
});

// ── B. 401 + successful refresh + successful retry remains connected ──────
test('B. refreshConnectionToken: a single successful refresh returns a fresh token and records status=connected', async () => {
  const pool = require('../src/db');
  const original = pool.query;
  const encryptedRefreshToken = encrypt('still-good-refresh-token');
  const queries = [];
  pool.query = async (sql, params) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    queries.push({ sql: normalized, params });
    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE id/i.test(normalized)) {
      return { rows: [{ id: 21, refresh_token_encrypted: encryptedRefreshToken, zoho_data_center: 'in' }] };
    }
    return { rows: [{ id: 21 }] };
  };
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ access_token: 'brand-new-token', expires_in: 3600, api_domain: 'https://www.zohoapis.in' }) });
  try {
    const svc = freshTokenService();
    const token = await svc.refreshConnectionToken(21);
    assert.equal(token, 'brand-new-token');
    const statusWrite = queries.find((q) => /status = \$/.test(q.sql));
    assert.ok(statusWrite.params.includes('connected'));
    assert.ok(!queries.some((q) => /status = 'reauth_required'/.test(q.sql)));
  } finally {
    pool.query = original;
    global.fetch = originalFetch;
  }
});

// ── C. genuine invalid grant -> reauth_required (unchanged) ───────────────
test('C. refreshConnectionToken: Zoho explicitly rejecting the grant, with no concurrent rotation, still marks reauth_required', async () => {
  const pool = require('../src/db');
  const original = pool.query;
  const encryptedRefreshToken = encrypt('actually-revoked-token'); // SAME ciphertext on every read — no rotation happened
  const queries = [];
  pool.query = async (sql, params) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    queries.push({ sql: normalized, params });
    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE id/i.test(normalized)) {
      return { rows: [{ id: 22, refresh_token_encrypted: encryptedRefreshToken, zoho_data_center: 'in' }] };
    }
    return { rows: [] };
  };
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) });
  try {
    const svc = freshTokenService();
    await assert.rejects(svc.refreshConnectionToken(22), /invalid_grant/);
    assert.ok(queries.some((q) => /status = 'reauth_required'/.test(q.sql)), 'a genuinely revoked grant (no rotation) must still mark reauth_required');
  } finally {
    pool.query = original;
    global.fetch = originalFetch;
  }
});

// ── D. concurrent refreshes cannot incorrectly mark a valid connection ────
test('D1. refreshConnectionToken: concurrent calls for the SAME connection share one in-flight Zoho request (in-process mutex)', async () => {
  const pool = require('../src/db');
  const original = pool.query;
  const encryptedRefreshToken = encrypt('shared-refresh-token');
  pool.query = async (sql) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE id/i.test(normalized)) {
      return { rows: [{ id: 30, refresh_token_encrypted: encryptedRefreshToken, zoho_data_center: 'in' }] };
    }
    return { rows: [{ id: 30 }] };
  };
  const originalFetch = global.fetch;
  let tokenEndpointCalls = 0;
  global.fetch = async (url) => {
    if (/oauth\/v2\/token/.test(url)) {
      tokenEndpointCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20)); // force overlap
      return { ok: true, json: async () => ({ access_token: 'refreshed-once', expires_in: 3600, api_domain: 'https://www.zohoapis.in' }) };
    }
    throw new Error('unexpected fetch');
  };
  try {
    const svc = freshTokenService();
    const [tokenA, tokenB] = await Promise.all([svc.refreshConnectionToken(30), svc.refreshConnectionToken(30)]);
    assert.equal(tokenA, 'refreshed-once');
    assert.equal(tokenB, 'refreshed-once');
    assert.equal(tokenEndpointCalls, 1, 'two concurrent refreshes for the same connection must only hit Zoho once');
  } finally {
    pool.query = original;
    global.fetch = originalFetch;
  }
});

test('D2. refreshConnectionToken: if a concurrent refresh already rotated the refresh token, a resulting invalid_grant is treated as transient, never reauth_required', async () => {
  const pool = require('../src/db');
  const original = pool.query;
  const originalToken = encrypt('token-we-are-about-to-use');
  const rotatedToken = encrypt('token-a-concurrent-refresh-already-installed');
  let selectCalls = 0;
  const queries = [];
  pool.query = async (sql, params) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    queries.push({ sql: normalized, params });
    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE id/i.test(normalized)) {
      selectCalls += 1;
      // First read (before our refresh attempt) sees the token we're about
      // to send Zoho; the recheck (after Zoho rejects it) sees that a
      // sibling request already rotated it — simulating the actual race.
      return { rows: [{ id: 31, refresh_token_encrypted: selectCalls === 1 ? originalToken : rotatedToken, zoho_data_center: 'in' }] };
    }
    return { rows: [] };
  };
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) });
  try {
    const svc = freshTokenService();
    await assert.rejects(svc.refreshConnectionToken(31), (err) => {
      assert.equal(err.transient, true, 'a lost race must be treated as transient/retryable, not permanent');
      return true;
    });
    assert.ok(!queries.some((q) => /status = 'reauth_required'/.test(q.sql)), 'losing a refresh-token race must never mark reauth_required');
  } finally {
    pool.query = original;
    global.fetch = originalFetch;
  }
});

// ── E. background reconciliation cannot incorrectly mark a valid connection ──
// Exercises zohoLeadService.withAccessToken's "second 401 -> reauth_required"
// path — the literal source of "Zoho rejected access token twice (401)" —
// with a concurrent access-token rotation happening between our refresh and
// our retry (e.g. the reconciliation scheduler refreshing the same
// connection again in that window).
test('E. createLead: a concurrent refresh between our refresh and our retry is detected and never marks reauth_required', async () => {
  const pool = require('../src/db');
  const original = pool.query;
  let connectionSelectCalls = 0;
  const tokenAfterOurRefresh = encrypt('token-our-refresh-installed');
  const tokenAfterSomeoneElsesLaterRefresh = encrypt('token-a-sibling-request-installed-after-ours');
  const queries = [];
  pool.query = async (sql, params) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    queries.push({ sql: normalized, params });
    if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(normalized)) return OWNED_WA_ACCOUNT;
    if (/^INSERT INTO coexistence\.zoho_lead_links/i.test(normalized)) return { rows: [{ id: 1, status: 'pending' }] };
    if (/^UPDATE coexistence\.zoho_connections SET access_token_encrypted/i.test(normalized)) return { rows: [{ id: 10 }] };
    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE workspace_id/i.test(normalized)) {
      connectionSelectCalls += 1;
      if (connectionSelectCalls === 1) {
        // Initial connection resolution (resolveConnectionRow) — token
        // already expired so ensureValidAccessToken will refresh it below.
        return { rows: [{ id: 10, workspace_id: WORKSPACE_ID, whatsapp_account_id: WA_ACCOUNT_ID, status: 'connected', zoho_api_domain: 'https://www.zohoapis.in', zoho_data_center: 'in', access_token_encrypted: encrypt('will-401-on-first-call'), refresh_token_encrypted: encrypt('good-refresh-token'), token_expires_at: new Date(Date.now() + 60 * 60 * 1000) }] };
      }
      if (connectionSelectCalls === 2) {
        // getConnectionRowByOwnership right after OUR refresh succeeds.
        return { rows: [{ id: 10, zoho_api_domain: 'https://www.zohoapis.in', access_token_encrypted: tokenAfterOurRefresh }] };
      }
      // getConnectionRowByOwnership right before we would mark reauth —
      // a sibling request has, in the meantime, refreshed again.
      return { rows: [{ id: 10, zoho_api_domain: 'https://www.zohoapis.in', access_token_encrypted: tokenAfterSomeoneElsesLaterRefresh }] };
    }
    return { rows: [] };
  };
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (/oauth\/v2\/token/.test(url)) {
      return { ok: true, json: async () => ({ access_token: 'refreshed-access-token', expires_in: 3600, api_domain: 'https://www.zohoapis.in' }) };
    }
    // Every call to the Leads API 401s in this test — the point is that we
    // must never conclude "genuinely dead" once a concurrent rotation is
    // detected, regardless of how many times the call itself fails.
    return { ok: false, status: 401, json: async () => ({ code: 'INVALID_TOKEN' }) };
  };
  try {
    const svc = freshLeadService();
    await assert.rejects(
      svc.createLead({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, name: 'Kumar' })
    );
    assert.ok(!queries.some((q) => /reauth_required/i.test(q.sql)), 'a detected concurrent rotation must suppress the reauth_required write');
  } finally {
    pool.query = original;
    global.fetch = originalFetch;
  }
});

// ── F. a page/status read can never itself cause a reauth transition ──────
test('F. zohoConnectionService.getConnection is a pure read — it never issues an UPDATE', async () => {
  const pool = require('../src/db');
  const original = pool.query;
  const queries = [];
  pool.query = async (sql, params) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    queries.push({ sql: normalized, params });
    if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(normalized)) return OWNED_WA_ACCOUNT;
    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE workspace_id/i.test(normalized)) {
      return { rows: [connectedConnectionRow()] };
    }
    return { rows: [] };
  };
  try {
    delete require.cache[require.resolve('../src/services/zohoConnectionService')];
    const svc = require('../src/services/zohoConnectionService');
    const result = await svc.getConnection(WORKSPACE_ID, WA_ACCOUNT_ID);
    assert.equal(result.status, 'connected');
    assert.ok(!queries.some((q) => /^UPDATE/i.test(q.sql)), 'reading connection status must never write anything');
  } finally {
    pool.query = original;
  }
});

// ── G. the correct .in datacenter/domain is preserved through a refresh ───
test('G. refreshConnectionToken: persists the India (.in) api_domain Zoho returns on refresh, never silently defaulting to .com', async () => {
  const pool = require('../src/db');
  const original = pool.query;
  const encryptedRefreshToken = encrypt('india-region-refresh-token');
  const queries = [];
  pool.query = async (sql, params) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    queries.push({ sql: normalized, params });
    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE id/i.test(normalized)) {
      return { rows: [{ id: 40, refresh_token_encrypted: encryptedRefreshToken, zoho_data_center: 'in', zoho_api_domain: 'https://www.zohoapis.in' }] };
    }
    return { rows: [{ id: 40 }] };
  };
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ access_token: 'india-token', expires_in: 3600, api_domain: 'https://www.zohoapis.in' }) });
  try {
    const svc = freshTokenService();
    await svc.refreshConnectionToken(40);
    const domainWrite = queries.find((q) => /zoho_api_domain = \$/.test(q.sql));
    assert.ok(domainWrite, 'expected zoho_api_domain to be persisted on refresh');
    assert.ok(domainWrite.params.includes('https://www.zohoapis.in'));
  } finally {
    pool.query = original;
    global.fetch = originalFetch;
  }
});
// ── H. a second API 401 with NO detectable race must still never reauth ───
// Root-cause regression: before this fix, withAccessToken marked
// reauth_required on a second 401 UNLESS it could positively detect a
// concurrent rotation. That "guilty until proven innocent" default is
// exactly backwards per the Task 2 gate — only an explicit invalid_grant/
// invalid_code from the OAuth *refresh* endpoint itself proves the grant is
// dead. Here the refresh succeeds cleanly (no race, no rotation by anyone
// else) and the very next API call still 401s — a transient/propagation
// condition on Zoho's side. This must never write reauth_required.
test('H. createLead: a second 401 with no concurrent rotation detected still never marks reauth_required', async () => {
  const pool = require('../src/db');
  const original = pool.query;
  let connectionSelectCalls = 0;
  const stableTokenAfterRefresh = encrypt('token-our-refresh-installed-and-nobody-else-touched-it');
  const queries = [];
  pool.query = async (sql, params) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    queries.push({ sql: normalized, params });
    if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(normalized)) return OWNED_WA_ACCOUNT;
    if (/^INSERT INTO coexistence\.zoho_lead_links/i.test(normalized)) return { rows: [{ id: 1, status: 'pending' }] };
    if (/^UPDATE coexistence\.zoho_connections SET access_token_encrypted/i.test(normalized)) return { rows: [{ id: 10 }] };
    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE workspace_id/i.test(normalized)) {
      connectionSelectCalls += 1;
      if (connectionSelectCalls === 1) {
        return { rows: [{ id: 10, workspace_id: WORKSPACE_ID, whatsapp_account_id: WA_ACCOUNT_ID, status: 'connected', zoho_api_domain: 'https://www.zohoapis.in', zoho_data_center: 'in', access_token_encrypted: encrypt('will-401-on-first-call'), refresh_token_encrypted: encrypt('good-refresh-token'), token_expires_at: new Date(Date.now() + 60 * 60 * 1000) }] };
      }
      // Every subsequent read (post-our-refresh check, pre-reauth-decision
      // check) sees the SAME token we just installed — nobody else touched
      // this connection. No race to detect, by design.
      return { rows: [{ id: 10, zoho_api_domain: 'https://www.zohoapis.in', access_token_encrypted: stableTokenAfterRefresh }] };
    }
    return { rows: [] };
  };
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (/oauth\/v2\/token/.test(url)) {
      return { ok: true, json: async () => ({ access_token: 'refreshed-access-token', expires_in: 3600, api_domain: 'https://www.zohoapis.in' }) };
    }
    return { ok: false, status: 401, json: async () => ({ code: 'INVALID_TOKEN' }) };
  };
  try {
    const svc = freshLeadService();
    await assert.rejects(
      svc.createLead({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, name: 'Kumar' })
    );
    assert.ok(!queries.some((q) => /reauth_required/i.test(q.sql)), 'a second 401 with no explicit grant-invalid evidence must never mark reauth_required');
  } finally {
    pool.query = original;
    global.fetch = originalFetch;
  }
});




