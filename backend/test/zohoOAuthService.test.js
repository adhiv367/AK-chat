'use strict';

// Phase 8B Part 1 — Zoho OAuth service tests. Mocks global fetch (same
// approach as any Zoho HTTP call in this file) — no real Zoho account or
// network access required, mirroring test/zohoSchema.test.js's no-live-
// Postgres approach for the DB side.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-zoho-oauth-tests';
process.env.ZOHO_CLIENT_ID = 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = 'test-client-secret';
process.env.ZOHO_REDIRECT_URI = 'https://app.example.com/api/zoho/oauth/callback';

const zohoOAuthService = require('../src/services/zohoOAuthService');

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

// ── State generation / validation ───────────────────────────────────────

test('generateState requires workspaceId and whatsappAccountId', () => {
  assert.throws(() => zohoOAuthService.generateState({ whatsappAccountId: 5 }), /workspaceId/);
  assert.throws(() => zohoOAuthService.generateState({ workspaceId: 1 }), /whatsappAccountId/);
});

test('generateState -> validateState round-trips workspaceId/whatsappAccountId', () => {
  const state = zohoOAuthService.generateState({ workspaceId: 42, whatsappAccountId: 7 });
  const decoded = zohoOAuthService.validateState(state);
  assert.equal(decoded.workspaceId, 42);
  assert.equal(decoded.whatsappAccountId, 7);
});

test('validateState rejects missing state', () => {
  assert.throws(() => zohoOAuthService.validateState(), /Missing or malformed/);
  assert.throws(() => zohoOAuthService.validateState(''), /Missing or malformed/);
});

test('validateState rejects tampered state', () => {
  const state = zohoOAuthService.generateState({ workspaceId: 1, whatsappAccountId: 2 });
  const tampered = state.slice(0, -2) + (state.slice(-2) === 'AA' ? 'BB' : 'AA');
  assert.throws(() => zohoOAuthService.validateState(tampered), /Invalid or expired/);
});

test('validateState rejects expired state', () => {
  const jwt = require('jsonwebtoken');
  const expired = jwt.sign(
    { purpose: 'zoho_oauth_state', wsId: 1, waId: 2, nonce: 'x' },
    process.env.JWT_SECRET,
    { expiresIn: -10 }
  );
  assert.throws(() => zohoOAuthService.validateState(expired), /Invalid or expired/);
});

test('validateState rejects wrong purpose (e.g. a state minted for a different OAuth flow)', () => {
  const jwt = require('jsonwebtoken');
  const wrongPurpose = jwt.sign(
    { purpose: 'ig_oauth_state', wsId: 1, waId: 2, nonce: 'x' },
    process.env.JWT_SECRET,
    { expiresIn: '10m' }
  );
  assert.throws(() => zohoOAuthService.validateState(wrongPurpose), /wrong purpose/);
});

test('validateState rejects malformed/incomplete payload (missing waId)', () => {
  const jwt = require('jsonwebtoken');
  const malformed = jwt.sign(
    { purpose: 'zoho_oauth_state', wsId: 1, nonce: 'x' },
    process.env.JWT_SECRET,
    { expiresIn: '10m' }
  );
  assert.throws(() => zohoOAuthService.validateState(malformed), /missing required fields/);
});

// ── Datacenter resolution ────────────────────────────────────────────────

test('resolveDatacenter accepts com/eu/in and falls back to com for unknown values', () => {
  assert.equal(zohoOAuthService.resolveDatacenter('eu'), 'eu');
  assert.equal(zohoOAuthService.resolveDatacenter('in'), 'in');
  assert.equal(zohoOAuthService.resolveDatacenter('com'), 'com');
  assert.equal(zohoOAuthService.resolveDatacenter('nonexistent'), 'com');
  assert.equal(zohoOAuthService.resolveDatacenter(undefined), 'com');
});

test('getDatacenterConfig returns distinct accounts/api base URLs per datacenter', () => {
  const com = zohoOAuthService.getDatacenterConfig('com');
  const eu = zohoOAuthService.getDatacenterConfig('eu');
  const inDc = zohoOAuthService.getDatacenterConfig('in');
  assert.notEqual(com.accountsBaseUrl, eu.accountsBaseUrl);
  assert.notEqual(com.accountsBaseUrl, inDc.accountsBaseUrl);
  assert.match(com.accountsBaseUrl, /accounts\.zoho\.com/);
  assert.match(eu.accountsBaseUrl, /accounts\.zoho\.eu/);
  assert.match(inDc.accountsBaseUrl, /accounts\.zoho\.in/);
});

// ── Authorization URL ─────────────────────────────────────────────────────

test('getAuthUrl builds a URL against the resolved datacenter with client_id/redirect_uri/state', () => {
  const state = zohoOAuthService.generateState({ workspaceId: 1, whatsappAccountId: 2 });
  const url = zohoOAuthService.getAuthUrl(state, { dc: 'eu' });
  assert.match(url, /^https:\/\/accounts\.zoho\.eu\/oauth\/v2\/auth\?/);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('client_id'), 'test-client-id');
  assert.equal(parsed.searchParams.get('redirect_uri'), process.env.ZOHO_REDIRECT_URI);
  assert.equal(parsed.searchParams.get('state'), state);
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('access_type'), 'offline');
});

test('getAuthUrl throws when ZOHO_CLIENT_ID is not configured', () => {
  const original = process.env.ZOHO_CLIENT_ID;
  delete process.env.ZOHO_CLIENT_ID;
  try {
    assert.throws(() => zohoOAuthService.getAuthUrl('state'), /ZOHO_CLIENT_ID/);
  } finally {
    process.env.ZOHO_CLIENT_ID = original;
  }
});

// ── Phase 8K FIX — Notes scope gap ───────────────────────────────────────
// Root cause: Part 2 added Zoho Note creation (POST
// /crm/v2/Leads/{id}/Notes) but the OAuth scope list was never updated to
// request Notes permission, so every Note create call 401'd regardless of
// token validity — the token simply never had the Notes module granted.
// These assert the default authorization URL now requests the minimal
// (CREATE-only, never .ALL) Notes scope, alongside the existing Lead/org/
// users scopes, unchanged.
test('getAuthUrl requests the Notes CREATE scope by default, alongside the existing Lead/org/users scopes', () => {
  const state = zohoOAuthService.generateState({ workspaceId: 1, whatsappAccountId: 2 });
  const url = zohoOAuthService.getAuthUrl(state, { dc: 'eu' });
  const parsed = new URL(url);
  const scopes = parsed.searchParams.get('scope').split(',');

  assert.ok(scopes.includes('ZohoCRM.modules.notes.CREATE'), 'must request Notes CREATE scope');
  // Existing scopes must still be present, unchanged — additive only.
  assert.ok(scopes.includes('ZohoCRM.modules.leads.ALL'), 'must still request the existing Leads scope');
  assert.ok(scopes.includes('ZohoCRM.org.READ'), 'must still request the existing org READ scope');
  assert.ok(scopes.includes('ZohoCRM.users.READ'), 'must still request the existing users READ scope');
});

test('getAuthUrl never requests the broad ZohoCRM.modules.ALL scope (least-privilege: Notes CREATE only)', () => {
  const state = zohoOAuthService.generateState({ workspaceId: 1, whatsappAccountId: 2 });
  const url = zohoOAuthService.getAuthUrl(state, { dc: 'eu' });
  const parsed = new URL(url);
  const scopes = parsed.searchParams.get('scope').split(',');

  assert.ok(!scopes.includes('ZohoCRM.modules.ALL'), 'must never request the broad modules.ALL scope');
});

test('getAuthUrl: an explicit scopes override still works and is not silently replaced by the new default', () => {
  const state = zohoOAuthService.generateState({ workspaceId: 1, whatsappAccountId: 2 });
  const url = zohoOAuthService.getAuthUrl(state, { dc: 'eu', scopes: ['ZohoCRM.org.READ'] });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('scope'), 'ZohoCRM.org.READ');
});

// ── Token exchange ────────────────────────────────────────────────────────

test('exchangeCodeForToken returns the token payload on success', withMockedFetch(
  { ok: true, body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, api_domain: 'https://www.zohoapis.com' } },
  async () => {
    const data = await zohoOAuthService.exchangeCodeForToken('good-code');
    assert.equal(data.access_token, 'at-1');
    assert.equal(data.refresh_token, 'rt-1');
  }
));

test('exchangeCodeForToken throws on missing code', async () => {
  await assert.rejects(zohoOAuthService.exchangeCodeForToken(), /Missing authorization code/);
});

test('exchangeCodeForToken throws when Zoho returns an error body (even with HTTP 200)', withMockedFetch(
  { ok: true, body: { error: 'invalid_code' } },
  async () => {
    await assert.rejects(zohoOAuthService.exchangeCodeForToken('bad-code'), /invalid_code/);
  }
));

test('exchangeCodeForToken throws on non-2xx response', withMockedFetch(
  { ok: false, body: { error: 'invalid_client' } },
  async () => {
    await assert.rejects(zohoOAuthService.exchangeCodeForToken('code'), /invalid_client/);
  }
));

test('exchangeCodeForToken throws when required env vars are missing', async () => {
  const original = process.env.ZOHO_CLIENT_SECRET;
  delete process.env.ZOHO_CLIENT_SECRET;
  try {
    await assert.rejects(zohoOAuthService.exchangeCodeForToken('code'), /ZOHO_CLIENT_SECRET/);
  } finally {
    process.env.ZOHO_CLIENT_SECRET = original;
  }
});

test('refreshAccessToken returns a new access token on success', withMockedFetch(
  { ok: true, body: { access_token: 'at-2', expires_in: 3600, api_domain: 'https://www.zohoapis.com' } },
  async () => {
    const data = await zohoOAuthService.refreshAccessToken('some-refresh-token');
    assert.equal(data.access_token, 'at-2');
  }
));

test('refreshAccessToken throws on missing refresh token', async () => {
  await assert.rejects(zohoOAuthService.refreshAccessToken(), /Missing refresh token/);
});

test('refreshAccessToken throws on failure response', withMockedFetch(
  { ok: false, body: { error: 'invalid_token' } },
  async () => {
    await assert.rejects(zohoOAuthService.refreshAccessToken('revoked-token'), /invalid_token/);
  }
));

// ── No secrets leaked ────────────────────────────────────────────────────

test('generated state never contains the literal client secret', () => {
  const state = zohoOAuthService.generateState({ workspaceId: 1, whatsappAccountId: 2 });
  assert.doesNotMatch(state, new RegExp(process.env.ZOHO_CLIENT_SECRET));
});
// ── classifyRefreshFailure — reauth-loop root-cause FIX regression tests ──
// Task 7.F/G: only explicit Zoho grant-invalid error codes (invalid_grant,
// invalid_code) may classify as non-transient (reauth-worthy). Any other
// structured error body, or a 429/5xx, must classify as transient.

test('classifyRefreshFailure: invalid_grant is non-transient (genuine grant invalidation)', () => {
  const result = zohoOAuthService.classifyRefreshFailure({ status: 400 }, { error: 'invalid_grant' });
  assert.equal(result.transient, false);
});

test('classifyRefreshFailure: invalid_code is non-transient (genuine grant invalidation)', () => {
  const result = zohoOAuthService.classifyRefreshFailure({ status: 400 }, { error: 'invalid_code' });
  assert.equal(result.transient, false);
});

test('classifyRefreshFailure: an unrelated structured Zoho error is transient, not grant-invalid', () => {
  const result = zohoOAuthService.classifyRefreshFailure({ status: 400 }, { error: 'access_denied' });
  assert.equal(result.transient, true);
});

test('classifyRefreshFailure: 429 is transient regardless of body', () => {
  const result = zohoOAuthService.classifyRefreshFailure({ status: 429 }, { error: 'invalid_grant' });
  assert.equal(result.transient, true);
});

test('classifyRefreshFailure: 5xx is transient regardless of body', () => {
  const result = zohoOAuthService.classifyRefreshFailure({ status: 503 }, { error: 'invalid_grant' });
  assert.equal(result.transient, true);
});

test('classifyRefreshFailure: malformed/missing error body is transient (ambiguous, never force reconnect)', () => {
  const result = zohoOAuthService.classifyRefreshFailure({ status: 400 }, {});
  assert.equal(result.transient, true);
});