'use strict';

// Phase 8E-3 — focused audit tests for gaps found in the subscription
// lifecycle: (1) POST /billing/webhook's ON CONFLICT DO NOTHING dedup path
// was previously only exercised indirectly (via the DB constraint
// comment) — never at the route level. (2) applyBillingEvent() was only
// tested for accepting 'trialing' and rejecting a bogus status, not for
// the actual active→past_due / active→cancelled transitions themselves.
// No production code is touched — this file only adds coverage.
//
// Same no-live-Postgres approach as test/cancellationFinalization.test.js:
// pool.connect is monkey-patched, and the 'manual' provider's
// mapWebhookEvent (normally a hard throw — "manual provider does not
// receive webhooks") is monkey-patched on the *same* PROVIDERS.manual
// object instance that routes/billing.js already holds a reference to via
// getProvider(), so no source file changes.

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/db');
const billingService = require('../src/services/billingService');
const { webhookRouter } = require('../src/routes/billing');

const webhookLayer = webhookRouter.stack.find(
  (l) => l.route && l.route.path === '/billing/webhook' && l.route.methods.post
);
const webhookHandler = webhookLayer.route.stack[0].handle;

function mockReq({ body, header, raw }) {
  return {
    body,
    rawBody: raw != null ? Buffer.from(raw) : Buffer.from(JSON.stringify(body)),
    get(name) {
      return name.toLowerCase() === 'x-billing-signature' ? header : undefined;
    },
  };
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function withSignedSecret(fn) {
  process.env.BILLING_WEBHOOK_SECRET = 'test-secret';
  return fn().finally(() => { delete process.env.BILLING_WEBHOOK_SECRET; });
}

function sign(raw) {
  return require('crypto').createHmac('sha256', 'test-secret').update(Buffer.from(raw)).digest('hex');
}

// Patch the 'manual' provider's mapWebhookEvent in place (same object
// getProvider() returns to routes/billing.js) so the route can be driven
// end-to-end without a real payment provider being wired up.
function withMappedEvent(mappedEvent, fn) {
  const provider = billingService.getProvider();
  const original = provider.mapWebhookEvent;
  provider.mapWebhookEvent = () => mappedEvent;
  return fn().finally(() => { provider.mapWebhookEvent = original; });
}

test('POST /billing/webhook — first delivery inserts + applies the event', async () => {
  const raw = JSON.stringify({ id: 'evt_1' });
  let insertCalled = false;
  let applyUpdateRan = false;

  const dispatch = async (sql, params) => {
    if (/INSERT INTO coexistence\.billing_events/.test(sql)) {
      insertCalled = true;
      return { rows: [{ id: 555 }] }; // not a conflict — first delivery
    }
    if (/UPDATE coexistence\.workspace_billing/.test(sql)) {
      applyUpdateRan = true;
      assert.ok(params.includes('past_due'));
      return { rows: [{ id: 42, status: 'past_due' }] };
    }
    if (/UPDATE coexistence\.billing_events SET workspace_id/.test(sql)) {
      return { rows: [] };
    }
    return { rows: [] };
  };
  const client = { query: dispatch, release: () => {} };
  const originalConnect = pool.connect;
  pool.connect = async () => client;

  await withSignedSecret(() =>
    withMappedEvent(
      { type: 'subscription.updated', providerEventId: 'evt_1', workspaceId: 42, status: 'past_due' },
      async () => {
        const req = mockReq({ body: { id: 'evt_1' }, header: sign(raw), raw });
        const res = mockRes();
        await webhookHandler(req, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.ok, true);
        assert.notEqual(res.body.duplicate, true);
      }
    )
  ).finally(() => { pool.connect = originalConnect; });

  assert.equal(insertCalled, true);
  assert.equal(applyUpdateRan, true);
});

test('POST /billing/webhook — redelivered event (same provider_event_id) is a no-op, applyBillingEvent not called again', async () => {
  let applyUpdateRan = false;
  const dispatch = async (sql) => {
    if (/INSERT INTO coexistence\.billing_events/.test(sql)) {
      return { rows: [] }; // ON CONFLICT DO NOTHING matched zero rows — duplicate
    }
    if (/UPDATE coexistence\.workspace_billing/.test(sql)) {
      applyUpdateRan = true;
      return { rows: [{ id: 42, status: 'past_due' }] };
    }
    return { rows: [] };
  };
  const client = { query: dispatch, release: () => {} };
  const originalConnect = pool.connect;
  pool.connect = async () => client;

  const raw = JSON.stringify({ id: 'evt_1' });
  await withSignedSecret(() =>
    withMappedEvent(
      { type: 'subscription.updated', providerEventId: 'evt_1', workspaceId: 42, status: 'past_due' },
      async () => {
        const req = mockReq({ body: { id: 'evt_1' }, header: sign(raw), raw });
        const res = mockRes();
        await webhookHandler(req, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.duplicate, true);
      }
    )
  ).finally(() => { pool.connect = originalConnect; });

  assert.equal(applyUpdateRan, false, 'a duplicate delivery must never re-apply the billing event');
});

test('POST /billing/webhook — unsigned/invalid signature is rejected before any DB write', async () => {
  let anyQuery = false;
  const originalConnect = pool.connect;
  pool.connect = async () => ({ query: async () => { anyQuery = true; return { rows: [] }; }, release: () => {} });

  await withSignedSecret(async () => {
    const req = mockReq({ body: { id: 'evt_x' }, header: 'not-the-right-signature', raw: JSON.stringify({ id: 'evt_x' }) });
    const res = mockRes();
    await webhookHandler(req, res);
    assert.equal(res.statusCode, 401);
  }).finally(() => { pool.connect = originalConnect; });

  assert.equal(anyQuery, false);
});

// ── applyBillingEvent(): explicit status-transition coverage ──────────────
// The existing trialStatusLogic test only exercises 'trialing'; these fill
// in the two transitions named in the 8E-3 checklist directly.

test('applyBillingEvent — active → past_due writes status and does NOT clear cancel_at_period_end', async () => {
  let sql, params;
  const fakeClient = {
    query: async (s, p) => {
      if (/UPDATE coexistence\.workspace_billing/.test(s)) { sql = s; params = p; return { rows: [{ id: 1, status: 'past_due' }] }; }
      return { rows: [] };
    },
  };
  const row = await billingService.applyBillingEvent(fakeClient, { workspaceId: 1, status: 'past_due' });
  assert.ok(row);
  assert.ok(params.includes('past_due'));
  assert.doesNotMatch(sql, /cancel_at_period_end = false/);
});

test('applyBillingEvent — active → cancelled writes status', async () => {
  let sql, params;
  const fakeClient = {
    query: async (s, p) => {
      if (/UPDATE coexistence\.workspace_billing/.test(s)) { sql = s; params = p; return { rows: [{ id: 1, status: 'cancelled' }] }; }
      return { rows: [] };
    },
  };
  const row = await billingService.applyBillingEvent(fakeClient, { workspaceId: 1, status: 'cancelled' });
  assert.ok(row);
  assert.ok(params.includes('cancelled'));
  assert.doesNotMatch(sql, /cancel_at_period_end = false/);
});

test('applyBillingEvent — status: active resets cancel_at_period_end (unchanged prior behavior)', async () => {
  let sql;
  const fakeClient = {
    query: async (s, p) => {
      if (/UPDATE coexistence\.workspace_billing/.test(s)) { sql = s; return { rows: [{ id: 1, status: 'active' }] }; }
      return { rows: [] };
    },
  };
  await billingService.applyBillingEvent(fakeClient, { workspaceId: 1, status: 'active' });
  assert.match(sql, /cancel_at_period_end = false/);
});