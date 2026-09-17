'use strict';

// entitlementService.js requires ../db, which builds a pg Pool — but pg
// connects lazily, so no DB is touched as long as we only exercise the pure
// helper (limitExceededResponse) here, same approach as test/access.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { limitExceededResponse, LIMIT_TYPES, USAGE_COUNTERS } = require('../src/services/entitlementService');
const { requireWorkspaceRole } = require('../src/middleware/access');
const { countMessagesThisMonth } = require('../src/services/messageUsageService');

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

test('limitExceededResponse shapes a numeric-limit result correctly', () => {
  const body = limitExceededResponse({
    limitType: LIMIT_TYPES.SEATS, current: 5, max: 5, planKey: 'free', status: 'active',
  });
  assert.equal(body.error, 'limit_reached');
  assert.equal(body.limitType, LIMIT_TYPES.SEATS);
  assert.equal(body.current, 5);
  assert.equal(body.max, 5);
  assert.match(body.message, /seats/i);
});

test('limitExceededResponse shapes a billing-status-blocked result correctly', () => {
  const body = limitExceededResponse({
    limitType: LIMIT_TYPES.CONTACTS, reason: 'billing_status_blocked', status: 'suspended', planKey: 'free',
  });
  assert.equal(body.reason, 'billing_status_blocked');
  assert.match(body.message, /suspended/);
});

test('limitExceededResponse shapes an entitlement_lookup_failed result correctly (fail-closed, no fake numbers)', () => {
  const body = limitExceededResponse({ limitType: LIMIT_TYPES.WHATSAPP_ACCOUNTS, reason: 'entitlement_lookup_failed' });
  assert.equal(body.error, 'limit_reached');
  assert.equal(body.current, null);
  assert.equal(body.max, null);
});

// Phase 5B-5 — billing management must be OWNER only; ADMIN must be denied.
// requireWorkspaceRole is the exact gate routes/billing.js uses.
test('requireWorkspaceRole(OWNER) allows OWNER', () => {
  const req = { membership: { role: 'OWNER' } };
  const res = mockRes();
  let nexted = false;
  requireWorkspaceRole('OWNER')(req, res, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(res.statusCode, null);
});

test('requireWorkspaceRole(OWNER) denies ADMIN', () => {
  const req = { membership: { role: 'ADMIN' } };
  const res = mockRes();
  let nexted = false;
  requireWorkspaceRole('OWNER')(req, res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
});

test('requireWorkspaceRole(OWNER) denies MANAGER, AGENT, VIEWER', () => {
  for (const role of ['MANAGER', 'AGENT', 'VIEWER']) {
    const req = { membership: { role } };
    const res = mockRes();
    let nexted = false;
    requireWorkspaceRole('OWNER')(req, res, () => { nexted = true; });
    assert.equal(nexted, false, `role=${role} must not pass`);
    assert.equal(res.statusCode, 403);
  }
});

test('requireWorkspaceRole rejects when there is no membership at all', () => {
  const req = {};
  const res = mockRes();
  let nexted = false;
  requireWorkspaceRole('OWNER')(req, res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
});

// Phase 8A — Message Usage Metering. These tests only confirm the counter
// is correctly registered, per the audit's explicit instruction not to
// change checkLimit()'s existing behavior/logic — no send path is wired to
// call checkLimit(MESSAGE_QUOTA, ...) yet, so there is no enforcement
// behavior to test here, only the registration itself.

test('LIMIT_TYPES.MESSAGE_QUOTA is unchanged ("monthly_message_quota") — matches the existing plan field', () => {
  assert.equal(LIMIT_TYPES.MESSAGE_QUOTA, 'monthly_message_quota');
});

test('USAGE_COUNTERS registers MESSAGE_QUOTA against messageUsageService.countMessagesThisMonth', () => {
  assert.equal(USAGE_COUNTERS[LIMIT_TYPES.MESSAGE_QUOTA], countMessagesThisMonth);
});

test('USAGE_COUNTERS still has all three pre-existing counters unchanged (SEATS/WHATSAPP_ACCOUNTS/CONTACTS)', () => {
  assert.equal(typeof USAGE_COUNTERS[LIMIT_TYPES.SEATS], 'function');
  assert.equal(typeof USAGE_COUNTERS[LIMIT_TYPES.WHATSAPP_ACCOUNTS], 'function');
  assert.equal(typeof USAGE_COUNTERS[LIMIT_TYPES.CONTACTS], 'function');
});
