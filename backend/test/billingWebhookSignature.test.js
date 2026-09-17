'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyBillingSignature, DEFAULT_HEADER } = require('../src/util/billingWebhookSignature');

function mockReq(header, raw) {
  return {
    rawBody: raw == null ? raw : Buffer.from(raw),
    get(name) { return name.toLowerCase() === DEFAULT_HEADER ? header : undefined; },
  };
}

function sign(secret, body) {
  return crypto.createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}

test('verifyBillingSignature returns null when secret is unset (fail-closed at call site)', () => {
  delete process.env.BILLING_WEBHOOK_SECRET;
  assert.equal(verifyBillingSignature(mockReq('whatever', '{}')), null);
});

test('verifyBillingSignature accepts a valid signature', () => {
  process.env.BILLING_WEBHOOK_SECRET = 'test-secret';
  const body = JSON.stringify({ type: 'subscription.updated' });
  const sig = sign('test-secret', body);
  assert.equal(verifyBillingSignature(mockReq(sig, body)), true);
  delete process.env.BILLING_WEBHOOK_SECRET;
});

test('verifyBillingSignature rejects a tampered body', () => {
  process.env.BILLING_WEBHOOK_SECRET = 'test-secret';
  const sig = sign('test-secret', JSON.stringify({ type: 'a' }));
  const req = mockReq(sig, JSON.stringify({ type: 'b' })); // body changed after signing
  assert.equal(verifyBillingSignature(req), false);
  delete process.env.BILLING_WEBHOOK_SECRET;
});

test('verifyBillingSignature rejects a wrong-secret signature', () => {
  process.env.BILLING_WEBHOOK_SECRET = 'real-secret';
  const body = '{"type":"x"}';
  const sig = sign('wrong-secret', body);
  assert.equal(verifyBillingSignature(mockReq(sig, body)), false);
  delete process.env.BILLING_WEBHOOK_SECRET;
});
test('verifyBillingSignature rejects when header or body missing', () => {
  process.env.BILLING_WEBHOOK_SECRET = 'test-secret';
  assert.equal(verifyBillingSignature(mockReq('', '{}')), false);
  assert.equal(verifyBillingSignature(mockReq('abc', null)), false);
  delete process.env.BILLING_WEBHOOK_SECRET;
});