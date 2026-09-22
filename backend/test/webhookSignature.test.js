'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { safeEqual, verifyMetaSignature, verifyForwardSecret } = require('../src/util/webhookSignature');

// Build a mock Express req with the given signature header + raw body buffer.
function mockReq(header, raw) {
  return {
    rawBody: raw == null ? raw : Buffer.from(raw),
    get(name) { return name.toLowerCase() === 'x-hub-signature-256' ? header : undefined; },
  };
}

function sign(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}

test('safeEqual is true for equal strings, false otherwise', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false); // different lengths
  assert.equal(safeEqual('', ''), true);
});

test('verifyMetaSignature returns null when META_APP_SECRET is unset', () => {
  delete process.env.META_APP_SECRET;
  assert.equal(verifyMetaSignature(mockReq('sha256=whatever', '{}')), null);
});

test('verifyMetaSignature returns true for a correctly signed body', () => {
  process.env.META_APP_SECRET = 'top-secret-app-secret';
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
  const req = mockReq(sign('top-secret-app-secret', body), body);
  assert.equal(verifyMetaSignature(req), true);
  delete process.env.META_APP_SECRET;
});

test('verifyMetaSignature returns false for a forged/wrong signature', () => {
  process.env.META_APP_SECRET = 'top-secret-app-secret';
  const body = '{"object":"whatsapp_business_account"}';
  // Signed with the WRONG secret → must be rejected.
  const req = mockReq(sign('attacker-guess', body), body);
  assert.equal(verifyMetaSignature(req), false);
  delete process.env.META_APP_SECRET;
});

test('verifyMetaSignature returns false when the header is missing or malformed', () => {
  process.env.META_APP_SECRET = 'top-secret-app-secret';
  const body = '{}';
  assert.equal(verifyMetaSignature(mockReq('', body)), false);
  assert.equal(verifyMetaSignature(mockReq('md5=abc', body)), false);
  delete process.env.META_APP_SECRET;
});

test('verifyMetaSignature returns false when the raw body is absent', () => {
  process.env.META_APP_SECRET = 'top-secret-app-secret';
  assert.equal(verifyMetaSignature(mockReq(sign('top-secret-app-secret', '{}'), null)), false);
  delete process.env.META_APP_SECRET;
});

// ── verifyForwardSecret (local dev mirror bridge) ──────────────────────
// Build a mock Express req exposing only an X-Akchat-Forward-Secret header,
// mirroring how routes/webhook.js reads it (case-insensitive header name).
function mockForwardReq(headerValue) {
  return {
    get(name) { return name.toLowerCase() === 'x-akchat-forward-secret' ? headerValue : undefined; },
  };
}

test('verifyForwardSecret returns false when no secret is configured on this instance', () => {
  assert.equal(verifyForwardSecret(mockForwardReq('anything'), undefined), false);
  assert.equal(verifyForwardSecret(mockForwardReq('anything'), ''), false);
});

test('verifyForwardSecret returns false when the header is absent', () => {
  assert.equal(verifyForwardSecret(mockForwardReq(undefined), 'shared-secret'), false);
});

test('verifyForwardSecret returns true only for a matching header', () => {
  assert.equal(verifyForwardSecret(mockForwardReq('shared-secret'), 'shared-secret'), true);
  assert.equal(verifyForwardSecret(mockForwardReq('wrong-secret'), 'shared-secret'), false);
});

