'use strict';

// Regression tests for the Zoho "recurring reauthentication" fix.
//
// Root causes fixed (see routes/integrations/zoho.js, zohoTokenService.js,
// zohoOAuthService.js for the inline comments marked "Reauth-loop FIX" /
// "Datacenter-persistence FIX"):
//
//   1. The OAuth callback's best-effort ORG lookup (a call fully separate
//      from the token exchange that had already succeeded) called
//      recordError() on any failure, which unconditionally set
//      status='error' — and both /status and /sync-status treated
//      status==='error' as "needs reauthentication" identically to
//      status==='reauth_required'. A transient/rate-limited org lookup
//      right after a successful connect therefore showed "Needs
//      reauthentication" in the UI immediately.
//   2. zoho_data_center/zoho_api_domain were only ever persisted as a
//      side-effect of that SAME org lookup succeeding, so a failed lookup
//      also left the connection's datacenter unset — causing every future
//      refresh/API call to silently default to the 'com' datacenter,
//      which is wrong for e.g. an India-region connection.
//   3. zohoTokenService.refreshConnectionToken marked ANY refresh-attempt
//      failure (including transient network/5xx/rate-limit failures
//      reaching Zoho's own token endpoint) as reauth_required, identically
//      to a genuinely revoked refresh token.
//
// Same no-live-Postgres / no-live-Zoho approach as the existing
// test/zohoTokenService.test.js and test/zohoRoutes.test.js: pool.query is
// monkey-patched and global.fetch is stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

process.env.AKCHAT_ENCRYPTION_KEY = process.env.AKCHAT_ENCRYPTION_KEY || nodeCrypto.randomBytes(24).toString('hex');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-zoho-reauth-fix-tests';
process.env.ZOHO_CLIENT_ID = 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = 'test-client-secret';
process.env.ZOHO_REDIRECT_URI = 'https://app.example.test/api/integrations/zoho/callback';

// ── zohoTokenService-level helpers (mirrors test/zohoTokenService.test.js) ──

function withMockedPool(rowsByQuery, run) {
  return async () => {
    const pool = require('../src/db');
    const queries = [];
    const original = pool.query;
    pool.query = async (sql, params) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      queries.push({ sql: normalized, params });
      const handler = rowsByQuery(normalized, params, queries);
      return handler !== undefined ? handler : { rows: [] };
    };
    try {
      delete require.cache[require.resolve('../src/services/zohoTokenService')];
      const svc = require('../src/services/zohoTokenService');
      await run(svc, queries);
    } finally {
      pool.query = original;
    }
  };
}

function withMockedFetch(responder, run) {
  return async () => {
    const original = global.fetch;
    global.fetch = typeof responder === 'function'
      ? responder
      : async () => ({ ok: responder.ok !== false, status: responder.status, json: async () => responder.body });
    try {
      await run();
    } finally {
      global.fetch = original;
    }
  };
}

// ── A. expired access token + valid refresh token -> automatic refresh, ───
//    no reauth_required ────────────────────────────────────────────────────
test('A. ensureValidAccessToken silently refreshes an expired token and leaves status connected (no reauth)', withMockedFetch(
  { ok: true, body: { access_token: 'fresh-at', expires_in: 3600, api_domain: 'https://www.zohoapis.in' } },
  withMockedPool((sql) => {
    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE id/i.test(sql)) {
      const { encrypt } = require('../src/util/crypto');
      return {
        rows: [{
          id: 42,
          status: 'connected',
          access_token_encrypted: encrypt('stale-at'),
          refresh_token_encrypted: encrypt('good-refresh-token'),
          token_expires_at: new Date(Date.now() - 5000), // already expired
          zoho_data_center: 'in',
        }],
      };
    }
  }, async (svc, queries) => {
    const token = await svc.ensureValidAccessToken(42);
    assert.equal(token, 'fresh-at');
    const reauthWrite = queries.find((q) => /status = 'reauth_required'/.test(q.sql));
    assert.equal(reauthWrite, undefined, 'a routine expiry-triggered refresh must never mark reauth_required');
    const statusWrite = queries.find((q) => /^UPDATE coexistence\.zoho_connections SET /i.test(q.sql) && /status = \$/.test(q.sql));
    assert.ok(statusWrite);
    assert.ok(statusWrite.params.includes('connected'), 'connection must remain/return to connected after a silent refresh');
  })
));

// ── B. successful refresh clears a stale reauth_required status ───────────
test('B. refreshConnectionToken flips a stale reauth_required connection back to connected on success', withMockedFetch(
  { ok: true, body: { access_token: 'recovered-at', expires_in: 3600 } },
  withMockedPool((sql) => {
    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE id/i.test(sql)) {
      const { encrypt } = require('../src/util/crypto');
      return {
        rows: [{
          id: 9,
          status: 'reauth_required', // stale from a previous, now-resolved issue
          refresh_token_encrypted: encrypt('still-good-refresh-token'),
          zoho_data_center: 'com',
        }],
      };
    }
  }, async (svc, queries) => {
    const token = await svc.refreshConnectionToken(9);
    assert.equal(token, 'recovered-at');
    const update = queries.find((q) => /^UPDATE coexistence\.zoho_connections SET /i.test(q.sql) && /status = \$/.test(q.sql));
    assert.ok(update.params.includes('connected'), 'a successful refresh must clear reauth_required back to connected');
  })
));

// ── D. refresh-token invalid/revoked -> reauth_required (unchanged) ───────
test('D. refreshConnectionToken marks reauth_required when Zoho explicitly rejects the grant (invalid_code)', withMockedFetch(
  { ok: false, status: 400, body: { error: 'invalid_code' } },
  withMockedPool((() => {
    // Encrypted ONCE and reused for every read — this simulates the DB
    // returning the SAME stored ciphertext on repeated reads of an
    // unchanged row (what real Postgres does). Encrypting fresh per call
    // would produce a different ciphertext each time (AES-GCM uses a
    // random IV per encryption) and would be indistinguishable from the
    // concurrent-refresh-race FIX's own rotation signal, causing a false
    // "race detected" — this is not a real race, so the fixture must not
    // look like one.
    const encryptedRefreshToken = require('../src/util/crypto').encrypt('revoked-token');
    return (sql) => {
      if (/^SELECT \* FROM coexistence\.zoho_connections WHERE id/i.test(sql)) {
        return { rows: [{ id: 11, refresh_token_encrypted: encryptedRefreshToken, zoho_data_center: 'com' }] };
      }
    };
  })(), async (svc, queries) => {
    await assert.rejects(svc.refreshConnectionToken(11), /invalid_code/);
    const reauthWrite = queries.find((q) => /status = 'reauth_required'/.test(q.sql));
    assert.ok(reauthWrite, 'a genuinely revoked refresh token must still mark reauth_required');
  })
));

// ── New: transient refresh failures must NEVER mark reauth_required ──────
test('transient 500 from Zoho refresh endpoint does not mark reauth_required (must be retried, not reconnected)', withMockedFetch(
  { ok: false, status: 500, body: { message: 'internal error' } },
  withMockedPool((sql) => {
    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE id/i.test(sql)) {
      const { encrypt } = require('../src/util/crypto');
      return { rows: [{ id: 12, refresh_token_encrypted: encrypt('perfectly-good-token'), zoho_data_center: 'in' }] };
    }
  }, async (svc, queries) => {
    await assert.rejects(svc.refreshConnectionToken(12));
    const reauthWrite = queries.find((q) => /status = 'reauth_required'/.test(q.sql));
    assert.equal(reauthWrite, undefined, 'a transient Zoho 5xx must never force a reconnect');
  })
));

test('transient 429 rate limit from Zoho refresh endpoint does not mark reauth_required', withMockedFetch(
  { ok: false, status: 429, body: { message: 'too many requests' } },
  withMockedPool((sql) => {
    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE id/i.test(sql)) {
      const { encrypt } = require('../src/util/crypto');
      return { rows: [{ id: 13, refresh_token_encrypted: encrypt('perfectly-good-token'), zoho_data_center: 'in' }] };
    }
  }, async (svc, queries) => {
    await assert.rejects(svc.refreshConnectionToken(13));
    const reauthWrite = queries.find((q) => /status = 'reauth_required'/.test(q.sql));
    assert.equal(reauthWrite, undefined, 'a transient 429 must never force a reconnect');
  })
));

test('a network error reaching Zoho\'s refresh endpoint does not mark reauth_required', withMockedFetch(
  async () => { throw new Error('ECONNRESET'); },
  withMockedPool((sql) => {
    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE id/i.test(sql)) {
      const { encrypt } = require('../src/util/crypto');
      return { rows: [{ id: 14, refresh_token_encrypted: encrypt('perfectly-good-token'), zoho_data_center: 'in' }] };
    }
  }, async (svc, queries) => {
    await assert.rejects(svc.refreshConnectionToken(14));
    const reauthWrite = queries.find((q) => /status = 'reauth_required'/.test(q.sql));
    assert.equal(reauthWrite, undefined, 'a network failure must never force a reconnect');
  })
));

// ── E. reconnect replaces the old refresh token correctly ────────────────
test('E. exchangeAndStoreTokens (reconnect) stores the NEW refresh token, replacing the old one', withMockedFetch(
  { ok: true, body: { access_token: 'new-at', refresh_token: 'brand-new-refresh-token', expires_in: 3600, api_domain: 'https://www.zohoapis.in', scope: 'ZohoCRM.modules.leads.ALL,ZohoCRM.modules.notes.CREATE' } },
  withMockedPool(() => undefined, async (svc, queries) => {
    await svc.exchangeAndStoreTokens(21, 'fresh-auth-code', { dc: 'in' });
    const update = queries.find((q) => /^UPDATE coexistence\.zoho_connections SET /i.test(q.sql) && /refresh_token_encrypted = \$/.test(q.sql));
    assert.ok(update, 'reconnect must write a new refresh_token_encrypted value');
    const { decrypt } = require('../src/util/crypto');
    const idx = update.sql.match(/refresh_token_encrypted = \$(\d+)/)[1];
    const storedCipher = update.params[Number(idx) - 1];
    assert.equal(decrypt(storedCipher), 'brand-new-refresh-token');
  })
));

module.exports = { withMockedPool, withMockedFetch };
