'use strict';

// Phase 8B Part 1 — Zoho token service tests. Mocks pool.query on the
// shared '../src/db' singleton (same approach as test/zohoSchema.test.js)
// and mocks global fetch for the Zoho HTTP calls made via
// zohoOAuthService.exchangeCodeForToken/refreshAccessToken. No live
// Postgres or real Zoho account required.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

process.env.AKCHAT_ENCRYPTION_KEY = process.env.AKCHAT_ENCRYPTION_KEY || nodeCrypto.randomBytes(24).toString('hex');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-zoho-token-tests';
process.env.ZOHO_CLIENT_ID = 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = 'test-client-secret';
process.env.ZOHO_REDIRECT_URI = 'https://app.example.com/api/zoho/oauth/callback';

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

function withMockedFetch(response, run) {
  return async () => {
    const original = global.fetch;
    global.fetch = async () => ({
      ok: response.ok !== false,
      json: async () => response.body,
    });
    try {
      await run();
    } finally {
      global.fetch = original;
    }
  };
}

// ── Expiry helpers ────────────────────────────────────────────────────────

test('computeExpiresAt returns a future Date offset by expires_in seconds', withMockedPool(() => undefined, async (svc) => {
  const before = Date.now();
  const expiresAt = svc.computeExpiresAt(3600);
  assert.ok(expiresAt instanceof Date);
  assert.ok(expiresAt.getTime() > before);
  assert.ok(expiresAt.getTime() <= before + 3601 * 1000);
}));

test('computeExpiresAt returns null for missing/invalid expires_in', withMockedPool(() => undefined, async (svc) => {
  assert.equal(svc.computeExpiresAt(undefined), null);
  assert.equal(svc.computeExpiresAt(0), null);
  assert.equal(svc.computeExpiresAt(-5), null);
  assert.equal(svc.computeExpiresAt('not-a-number'), null);
}));

test('isExpired treats null expiry as expired', withMockedPool(() => undefined, async (svc) => {
  assert.equal(svc.isExpired(null), true);
}));

test('isExpired is true for a past timestamp and false for a comfortably future one', withMockedPool(() => undefined, async (svc) => {
  assert.equal(svc.isExpired(new Date(Date.now() - 1000)), true);
  assert.equal(svc.isExpired(new Date(Date.now() + 10 * 60 * 1000)), false);
}));

test('isExpired applies the safety margin — a token expiring in 10s counts as expired', withMockedPool(() => undefined, async (svc) => {
  assert.equal(svc.isExpired(new Date(Date.now() + 10 * 1000)), true);
}));

// ── Encrypted storage round-trip ────────────────────────────────────────

test('atomicTokenUpdate stores access/refresh tokens only as encrypted columns, never plaintext', withMockedPool((sql, params, queries) => undefined, async (svc, queries) => {
  await svc.atomicTokenUpdate(1, {
    accessToken: 'plaintext-access-token',
    refreshToken: 'plaintext-refresh-token',
    expiresAt: new Date(),
    status: 'connected',
  });

  const update = queries.find((q) => /^UPDATE coexistence\.zoho_connections/i.test(q.sql));
  assert.ok(update, 'expected a single UPDATE statement');
  assert.match(update.sql, /access_token_encrypted = \$/);
  assert.match(update.sql, /refresh_token_encrypted = \$/);
  // The plaintext value must never appear verbatim in the query params sent
  // to encrypt-then-store — every token param should differ from the input.
  for (const p of update.params) {
    if (typeof p === 'string') {
      assert.notEqual(p, 'plaintext-access-token');
      assert.notEqual(p, 'plaintext-refresh-token');
    }
  }
}));

test('atomicTokenUpdate omits refreshToken from the UPDATE when not provided (never clobbers stored refresh token)', withMockedPool(() => undefined, async (svc, queries) => {
  await svc.atomicTokenUpdate(1, { accessToken: 'new-access-token' });
  const update = queries.find((q) => /^UPDATE coexistence\.zoho_connections/i.test(q.sql));
  assert.doesNotMatch(update.sql, /refresh_token_encrypted/);
}));

test('atomicTokenUpdate is a no-op (no query) when nothing to update', withMockedPool(() => undefined, async (svc, queries) => {
  await svc.atomicTokenUpdate(1, {});
  assert.equal(queries.length, 0);
}));

test('getDecryptedAccessToken decrypts the stored ciphertext back to the original value', withMockedPool((sql) => {
  if (/^SELECT \* FROM coexistence\.zoho_connections WHERE id/i.test(sql)) {
    const { encrypt } = require('../src/util/crypto');
    return { rows: [{ id: 1, access_token_encrypted: encrypt('my-access-token'), refresh_token_encrypted: null }] };
  }
}, async (svc) => {
  const token = await svc.getDecryptedAccessToken(1);
  assert.equal(token, 'my-access-token');
}));

test('getDecryptedAccessToken throws when the connection does not exist', withMockedPool(() => ({ rows: [] }), async (svc) => {
  await assert.rejects(svc.getDecryptedAccessToken(999), /not found/);
}));

// ── exchangeAndStoreTokens ───────────────────────────────────────────────

test('exchangeAndStoreTokens exchanges the code and atomically stores the result', withMockedFetch(
  { ok: true, body: { access_token: 'at-x', refresh_token: 'rt-x', expires_in: 3600, api_domain: 'https://www.zohoapis.com', scope: 'ZohoCRM.modules.leads.ALL' } },
  withMockedPool(() => undefined, async (svc, queries) => {
    const result = await svc.exchangeAndStoreTokens(7, 'auth-code');
    assert.equal(result.apiDomain, 'https://www.zohoapis.com');
    const update = queries.find((q) => /^UPDATE coexistence\.zoho_connections/i.test(q.sql));
    assert.match(update.sql, /status = \$/);
    assert.ok(update.params.includes('connected'));
  })
));

// ── Refresh ───────────────────────────────────────────────────────────────

test('refreshConnectionToken refreshes and stores the new access token', withMockedFetch(
  { ok: true, body: { access_token: 'at-refreshed', expires_in: 3600, api_domain: 'https://www.zohoapis.com' } },
  withMockedPool((sql) => {
    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE id/i.test(sql)) {
      const { encrypt } = require('../src/util/crypto');
      return { rows: [{ id: 5, refresh_token_encrypted: encrypt('stored-refresh-token'), zoho_data_center: 'com' }] };
    }
  }, async (svc) => {
    const newAccessToken = await svc.refreshConnectionToken(5);
    assert.equal(newAccessToken, 'at-refreshed');
  })
));

test('refreshConnectionToken marks the connection reauth_required and rethrows on refresh failure', withMockedFetch(
  // Reauth-loop root-cause FIX: 'invalid_token' is not a real Zoho
  // refresh-grant error code and was never legitimate grounds for
  // reauth_required — this test previously encoded the exact over-broad
  // "any data.error is permanent" bug this fix removes. 'invalid_grant' is
  // the real Zoho code for an expired/revoked/already-consumed refresh
  // token, i.e. genuine grant invalidation, which is exactly what this
  // test is meant to verify still results in reauth_required.
  { ok: false, body: { error: 'invalid_grant' } },
  (() => {
    // Encrypted ONCE and reused for every read of this row — real Postgres
    // returns the same stored ciphertext on repeated reads of an unchanged
    // row; encrypting fresh per call (AES-GCM uses a random IV each time)
    // would make two reads of the "same" row look like a concurrent
    // rotation to the concurrent-refresh-race FIX's own detection, and
    // wrongly suppress this genuine-failure assertion.
    const encryptedRefreshToken = require('../src/util/crypto').encrypt('revoked-refresh-token');
    return withMockedPool((sql) => {
      if (/^SELECT \* FROM coexistence\.zoho_connections WHERE id/i.test(sql)) {
        return { rows: [{ id: 5, refresh_token_encrypted: encryptedRefreshToken, zoho_data_center: 'com' }] };
      }
    }, async (svc, queries) => {
      await assert.rejects(svc.refreshConnectionToken(5), /invalid_grant/);
      const errorUpdate = queries.find((q) => /status = 'reauth_required'/.test(q.sql));
      assert.ok(errorUpdate, "expected a status='reauth_required' UPDATE on refresh failure");
      assert.match(errorUpdate.sql, /last_error = \$/);
    });
  })()
));

test('refreshConnectionToken marks reauth_required when no refresh token is stored at all', withMockedPool((sql) => {
  if (/^SELECT \* FROM coexistence\.zoho_connections WHERE id/i.test(sql)) {
    return { rows: [{ id: 6, refresh_token_encrypted: null }] };
  }
}, async (svc, queries) => {
  await assert.rejects(svc.refreshConnectionToken(6), /No refresh token/);
  const errorUpdate = queries.find((q) => /status = 'reauth_required'/.test(q.sql));
  assert.ok(errorUpdate);
}));

// ── ensureValidAccessToken ────────────────────────────────────────────────
test('ensureValidAccessToken returns the stored token without refreshing when not expired', withMockedPool((sql) => {
  if (/^SELECT \* FROM coexistence\.zoho_connections WHERE id/i.test(sql)) {
    const { encrypt } = require('../src/util/crypto');
    return {
      rows: [{
        id: 3,
        status: 'connected',
        access_token_encrypted: encrypt('still-valid-token'),
        token_expires_at: new Date(Date.now() + 30 * 60 * 1000),
      }],
    };
  }
}, async (svc, queries) => {
  const token = await svc.ensureValidAccessToken(3);
  assert.equal(token, 'still-valid-token');
  assert.equal(queries.filter((q) => /^UPDATE/i.test(q.sql)).length, 0, 'must not refresh when token is still valid');
}));

test('ensureValidAccessToken throws immediately when connection status is reauth_required', withMockedPool((sql) => {
  if (/^SELECT \* FROM coexistence\.zoho_connections WHERE id/i.test(sql)) {
    return { rows: [{ id: 4, status: 'reauth_required' }] };
  }
}, async (svc) => {
  await assert.rejects(svc.ensureValidAccessToken(4), /re-authentication/);
}));

test('ensureValidAccessToken throws immediately when connection status is the legacy error value (pre-Part-2 rows)', withMockedPool((sql) => {
  if (/^SELECT \* FROM coexistence\.zoho_connections WHERE id/i.test(sql)) {
    return { rows: [{ id: 4, status: 'error' }] };
  }
}, async (svc) => {
  await assert.rejects(svc.ensureValidAccessToken(4), /re-authentication/);
}));

test('ensureValidAccessToken refreshes when the stored token is expired', withMockedFetch(
  { ok: true, body: { access_token: 'at-fresh', expires_in: 3600 } },
  withMockedPool((sql) => {
    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE id/i.test(sql)) {
      const { encrypt } = require('../src/util/crypto');
      return {
        rows: [{
          id: 8,
          status: 'connected',
          access_token_encrypted: encrypt('stale-token'),
          refresh_token_encrypted: encrypt('a-refresh-token'),
          token_expires_at: new Date(Date.now() - 1000),
          zoho_data_center: 'com',
        }],
      };
    }
  }, async (svc) => {
    const token = await svc.ensureValidAccessToken(8);
    assert.equal(token, 'at-fresh');
  })
));
// ── Security: tokens never logged/serialized by this module ─────────────
test('exchangeAndStoreTokens does not return the raw access/refresh token values', withMockedFetch(
  { ok: true, body: { access_token: 'super-secret-at', refresh_token: 'super-secret-rt', expires_in: 3600, api_domain: 'https://www.zohoapis.com' } },
  withMockedPool(() => undefined, async (svc) => {
    const result = await svc.exchangeAndStoreTokens(9, 'code');
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /super-secret-at/);
    assert.doesNotMatch(serialized, /super-secret-rt/);
  })
));