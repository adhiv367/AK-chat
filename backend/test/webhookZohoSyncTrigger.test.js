'use strict';

// Regression tests for: "incoming WhatsApp message -> existing message
// storage -> existing AI/reply flow -> automatically trigger Zoho sync".
// See src/routes/webhook.js (the new Zoho-sync trigger block inside the
// incoming-message loop of POST /webhook/whatsapp) and
// src/services/zohoSyncService.js (syncConversationToZoho, reused as-is
// and NOT re-implemented here).
//
// No real Postgres/Redis/network is used — pool.connect()/pool.query() are
// monkey-patched on the shared '../src/db' singleton, and every module
// webhook.js pulls in at require-time that would otherwise open a real
// connection or hit an external API is stubbed, same approach as
// test/webhookBroadcastStatus.test.js and test/webhookStatusOrdering.test.js.
// AI_BRIDGE_ENABLED is forced off (env read once at webhook.js require time)
// so tests never attempt the real akchat-whatsapp-bot HTTP call.

process.env.AI_BRIDGE_ENABLED = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Phase 7.11B: the webhook route now fail-closes (501) when META_APP_SECRET
// is unset and rejects (403) an unsigned/incorrectly-signed body — see
// src/util/webhookSignature.js. These tests exercise logic *inside* the
// handler (post-signature-check), so they must present a validly signed
// request, exactly like test/securityAuthorization.test.js does.
process.env.META_APP_SECRET = 'test-app-secret';

function stubModule(relPath, exports) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stubModule('../src/queue/sendQueue', { enqueueSend: async () => {} });
stubModule('../src/queue/mediaQueue', { enqueueMediaDownload: async () => {} });
stubModule('../src/services/mediaDownloader', { markPending: async () => {}, MEDIA_TYPES: new Set() });
stubModule('../src/services/productAutomation', { findProduct: async () => null });
stubModule('../src/services/shopifyService', { getProduct: async () => null });
stubModule('../src/services/aiReplyService', { generateReply: async () => null });
// resumeAutomation/evaluateTriggers are spies (not just no-ops) so the new
// paused-automation tests can assert exact call counts/args alongside the
// Zoho sync spy, and so pre-existing tests can assert their counts are
// unaffected by the Zoho-block relocation.
const resumeAutomationCalls = [];
const evaluateTriggersCalls = [];
stubModule('../src/engine/automationEngine', {
  evaluateTriggers: async (record) => { evaluateTriggersCalls.push(record); },
  resumeAutomation: async (poolArg, executionId, record) => { resumeAutomationCalls.push({ executionId, record }); },
});
stubModule('../src/services/automationGuard', { hasManualReplyTag: (tags) => Array.isArray(tags) && tags.includes('Manual Reply') });
stubModule('../src/services/imagePrep', { prepareProductImage: async () => null });
stubModule('../src/integrations/metaSend', { uploadMedia: async () => null });

// ── Fake WhatsApp accounts, keyed by phone_number_id ─────────────────────
// Two distinct accounts/workspaces so tests can prove account A's incoming
// message never selects account B's Zoho connection (isolation, item D).
const ACCOUNTS = {
  '111': { id: 5, workspaceId: 1, displayName: 'Acct A', displayPhoneNumber: '15550001111', phoneNumberId: '111', accessToken: 'tok-a', isActive: true },
  '222': { id: 6, workspaceId: 2, displayName: 'Acct B', displayPhoneNumber: '15550002222', phoneNumberId: '222', accessToken: 'tok-b', isActive: true },
};

const resolveAccountCalls = [];
stubModule('../src/services/messageSender', {
  resolveAccount: async ({ fromPhoneNumber }) => {
    resolveAccountCalls.push(fromPhoneNumber);
    const acc = ACCOUNTS[fromPhoneNumber];
    if (!acc) return { error: `No account for ${fromPhoneNumber}` };
    return { account: acc };
  },
  insertPendingRow: async () => 'local-1',
});

// ── syncConversationToZoho spy ────────────────────────────────────────────
// Reused exactly as exported — never reimplemented. Swapped out per-test so
// each test can assert on exactly what webhook.js passed it.
const zohoSyncService = require('../src/services/zohoSyncService');
let syncCalls;
let syncImpl;
zohoSyncService.syncConversationToZoho = async (params) => {
  syncCalls.push(params);
  if (syncImpl) return syncImpl(params);
  return { synced: true, reason: null, lead: { zohoLeadId: 'lead-1' }, note: null, partial: false };
};

const pool = require('../src/db');
const { router } = require('../src/routes/webhook');

const postLayer = router.stack.find(
  l => l.route && l.route.path === '/webhook/whatsapp' && l.route.methods.post
);
const postHandler = postLayer.route.stack[0].handle;

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    type() { return this; },
    send(v) { this.body = v; return this; },
  };
}

// Configurable per-test via setPausedRows(). Defaults to "nothing paused"
// so all pre-existing tests keep exercising the fresh-trigger path exactly
// as before.
let pausedRowsToReturn = [];
function setPausedRows(rows) { pausedRowsToReturn = rows; }

function installDb() {
  async function dispatch(sql) {
    // Contacts lookup (manual-reply-tag / agent-reply-time guard) — no tags,
    // no prior agent reply, so the (stubbed) AI-reply path always proceeds.
    if (/SELECT tags, last_agent_reply_at FROM coexistence\.contacts/i.test(sql)) {
      return { rows: [] };
    }
    // Paused-automation-execution lookup — configurable per test via
    // setPausedRows(); defaults to "nothing paused" so the fresh
    // incoming-message path (and the Zoho trigger, now placed before this
    // check) always runs for existing tests.
    if (/SELECT id FROM coexistence\.automation_executions/i.test(sql)) {
      return { rows: pausedRowsToReturn };
    }
    // verify-token lookup (GET handler only, unused here) + any other read.
    return { rows: [], rowCount: 0 };
  }

  pool.connect = async () => ({
    query: async (sql, params) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
      return dispatch(sql, params);
    },
    release: () => {},
  });
  pool.query = async (sql, params) => dispatch(sql, params);
}

function incomingTextBody({ phoneNumberId, displayPhoneNumber, waMessageId, fromNumber, text, name }) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: phoneNumberId, display_phone_number: displayPhoneNumber },
              contacts: name ? [{ wa_id: fromNumber, profile: { name } }] : [],
              messages: [
                {
                  id: waMessageId,
                  from: fromNumber,
                  type: 'text',
                  text: { body: text },
                  timestamp: String(Math.floor(Date.now() / 1000)),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function signedRequest(body) {
  const raw = Buffer.from(JSON.stringify(body));
  const signature = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(raw).digest('hex');
  return {
    body,
    rawBody: raw,
    get(name) { return name.toLowerCase() === 'x-hub-signature-256' ? signature : undefined; },
  };
}

async function postWebhook(body) {
  const req = signedRequest(body);
  const res = mockRes();
  await postHandler(req, res);
  return res;
}

test.beforeEach(() => {
  installDb();
  setPausedRows([]);
  syncCalls = [];
  syncImpl = null;
  resolveAccountCalls.length = 0;
  resumeAutomationCalls.length = 0;
  evaluateTriggersCalls.length = 0;
});

// A. Incoming eligible WhatsApp message triggers Zoho sync automatically.
test('incoming WhatsApp text message automatically triggers zohoSyncService.syncConversationToZoho', async () => {
  const res = await postWebhook(incomingTextBody({
    phoneNumberId: '111',
    displayPhoneNumber: '15550001111',
    waMessageId: 'wamid.T1',
    fromNumber: '919999999999',
    text: 'Hi, I need a roof quote',
    name: 'Ravi',
  }));

  assert.equal(res.statusCode, 200);
  // Give the fire-and-forget background trigger a tick to run.
  await new Promise((r) => setImmediate(r));
  assert.equal(syncCalls.length, 1);
});

// C. Correct workspaceId + whatsappAccountId are passed.
test('sync is called with the exact workspaceId/whatsappAccountId/contactNumber of the incoming message', async () => {
  await postWebhook(incomingTextBody({
    phoneNumberId: '111',
    displayPhoneNumber: '15550001111',
    waMessageId: 'wamid.T2',
    fromNumber: '919999999999',
    text: 'Hi there',
  }));
  await new Promise((r) => setImmediate(r));

  assert.equal(syncCalls.length, 1);
  assert.deepEqual(syncCalls[0], {
    workspaceId: 1,
    whatsappAccountId: 5,
    contactNumber: '919999999999',
  });
});

// D. Another WhatsApp account's Zoho connection cannot be selected.
test('a message on account B never resolves or syncs through account A\'s context', async () => {
  await postWebhook(incomingTextBody({
    phoneNumberId: '222',
    displayPhoneNumber: '15550002222',
    waMessageId: 'wamid.T3',
    fromNumber: '918888888888',
    text: 'Hello',
  }));
  await new Promise((r) => setImmediate(r));

  assert.equal(syncCalls.length, 1);
  assert.equal(syncCalls[0].workspaceId, 2);
  assert.equal(syncCalls[0].whatsappAccountId, 6);
  // resolveAccount was only ever asked to resolve THIS message's own
  // phone_number_id — never a different/fallback one.
  assert.deepEqual(resolveAccountCalls, ['222']);
});

// F. Zoho failure does not break the normal WhatsApp processing/reply.
test('a Zoho sync failure does not fail the webhook response', async () => {
  syncImpl = async () => { throw new Error('Zoho API is down'); };

  const res = await postWebhook(incomingTextBody({
    phoneNumberId: '111',
    displayPhoneNumber: '15550001111',
    waMessageId: 'wamid.T4',
    fromNumber: '919999999999',
    text: 'Hello again',
  }));

  // Webhook still acknowledges success even though the background Zoho
  // sync it kicked off will go on to reject.
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(syncCalls.length, 1);
});

// B. Incomplete/uncertain customer data does not create a Lead.
// (This is syncConversationToZoho's own existing §2 behavior — see
// test/zohoSyncService.test.js — the webhook trigger must not bypass it by
// e.g. passing extra params that skip the standard-fields check.)
test('sync trigger passes no extraction-skipping params -- incomplete extraction stays the sync service\'s call', async () => {
  syncImpl = async () => ({
    synced: false,
    reason: 'incomplete_extraction',
    lead: null,
    note: null,
    partial: false,
  });

  await postWebhook(incomingTextBody({
    phoneNumberId: '111',
    displayPhoneNumber: '15550001111',
    waMessageId: 'wamid.T5',
    fromNumber: '919999999999',
    text: 'just browsing',
  }));
  await new Promise((r) => setImmediate(r));

  assert.equal(syncCalls.length, 1);
  // Only the three identity params are passed -- webhook.js does not (and
  // must not) forward anything that could short-circuit the eligibility
  // check inside syncConversationToZoho.
  assert.deepEqual(Object.keys(syncCalls[0]).sort(), ['contactNumber', 'whatsappAccountId', 'workspaceId']);
});

// E. Duplicate webhook/message processing cannot create duplicate Leads.
test('duplicate delivery of the same webhook triggers sync each time but relies on the service\'s own Lead idempotency', async () => {
  const body = incomingTextBody({
    phoneNumberId: '111',
    displayPhoneNumber: '15550001111',
    waMessageId: 'wamid.DUP',
    fromNumber: '919999999999',
    text: 'Repeat me',
  });

  await postWebhook(body);
  await new Promise((r) => setImmediate(r));
  await postWebhook(body); // Meta/n8n may redeliver the same webhook
  await new Promise((r) => setImmediate(r));

  // webhook.js itself is not the idempotency boundary (it never was, even
  // for chat_history -- ON CONFLICT there already handles redelivery); it
  // simply calls through both times with identical identity params, and
  // zohoSyncService.syncConversationToZoho's own getLinkedLead/idempotency
  // (covered in test/zohoSyncService.test.js) is what prevents a duplicate
  // Lead. Assert webhook.js passes the SAME identity both times.
  assert.equal(syncCalls.length, 2);
  assert.deepEqual(syncCalls[0], syncCalls[1]);
});

// Account resolve failure (e.g. unregistered phone_number_id) must not
// throw out of the handler or block the webhook response.
test('an unresolvable account skips the Zoho sync without failing the webhook', async () => {
  const res = await postWebhook(incomingTextBody({
    phoneNumberId: '999-unregistered',
    displayPhoneNumber: '15559999999',
    waMessageId: 'wamid.T6',
    fromNumber: '917777777777',
    text: 'Hi',
  }));

  assert.equal(res.statusCode, 200);
  await new Promise((r) => setImmediate(r));
  assert.equal(syncCalls.length, 0);
});

// ── Phase 8 fix regression tests ──────────────────────────────────────────
// Prior bug: the Zoho sync block lived AFTER the paused-automation
// check/continue, so any inbound message for a contact with an active
// paused automation resumed the automation and skipped Zoho sync entirely.
// The fix moves the Zoho sync block above that check so it always fires
// exactly once per incoming record.

// G. Active paused automation: resumeAutomation runs AND Zoho sync still
// fires exactly once (the exact bug scenario).
test('an active paused automation resumes the automation AND still triggers Zoho sync exactly once', async () => {
  setPausedRows([{ id: 42 }]);

  const res = await postWebhook(incomingTextBody({
    phoneNumberId: '111',
    displayPhoneNumber: '15550001111',
    waMessageId: 'wamid.PAUSED1',
    fromNumber: '919999999999',
    text: 'continuing the flow',
  }));
  await new Promise((r) => setImmediate(r));

  assert.equal(res.statusCode, 200);
  // Automation was resumed as before.
  assert.equal(resumeAutomationCalls.length, 1);
  assert.equal(resumeAutomationCalls[0].executionId, 42);
  // Zoho sync still fired exactly once, with the correct identity.
  assert.equal(syncCalls.length, 1);
  assert.deepEqual(syncCalls[0], {
    workspaceId: 1,
    whatsappAccountId: 5,
    contactNumber: '919999999999',
  });
  // Paused-automation path still `continue`s past fresh-trigger logic --
  // evaluateTriggers (which lives after that continue) must NOT run.
  assert.equal(evaluateTriggersCalls.length, 0);
});

// H. Expired paused automation: falls through to the normal fresh-trigger
// path (resumeAutomation not called), Zoho sync + evaluateTriggers both run.
// The paused-execution SQL filters on `expires_at>NOW()`, so an expired row
// is modeled here simply as "the query returns no rows" (the same as no
// paused row ever having existed) -- that's the real behavior of the guard.
test('an expired paused automation falls through to the normal path -- Zoho sync + evaluateTriggers both run', async () => {
  setPausedRows([]); // expired rows are excluded by the SQL's own WHERE clause

  await postWebhook(incomingTextBody({
    phoneNumberId: '111',
    displayPhoneNumber: '15550001111',
    waMessageId: 'wamid.EXPIRED1',
    fromNumber: '919999999999',
    text: 'fresh message',
  }));
  await new Promise((r) => setImmediate(r));

  assert.equal(resumeAutomationCalls.length, 0);
  assert.equal(syncCalls.length, 1);
  assert.equal(evaluateTriggersCalls.length, 1);
});

// I. Multiple paused rows for the same contact: Zoho sync fires exactly
// once (not once per paused row) -- guards against accidentally moving the
// sync call inside the `for (const p of pausedRows)` loop.
test('multiple paused rows for the same contact still trigger Zoho sync exactly once', async () => {
  setPausedRows([{ id: 10 }, { id: 11 }, { id: 12 }]);

  await postWebhook(incomingTextBody({
    phoneNumberId: '111',
    displayPhoneNumber: '15550001111',
    waMessageId: 'wamid.PAUSEDMULTI',
    fromNumber: '919999999999',
    text: 'still going',
  }));
  await new Promise((r) => setImmediate(r));

  assert.equal(resumeAutomationCalls.length, 3);
  assert.deepEqual(resumeAutomationCalls.map((c) => c.executionId), [10, 11, 12]);
  assert.equal(syncCalls.length, 1);
});

// J. No paused row (existing default path): behavior is unchanged --
// exactly one Zoho sync call and exactly one evaluateTriggers call.
test('no paused automation: existing fresh-trigger behavior (Zoho sync + evaluateTriggers) is unchanged', async () => {
  setPausedRows([]);

  await postWebhook(incomingTextBody({
    phoneNumberId: '111',
    displayPhoneNumber: '15550001111',
    waMessageId: 'wamid.NOPAUSE1',
    fromNumber: '919999999999',
    text: 'hello',
  }));
  await new Promise((r) => setImmediate(r));

  assert.equal(resumeAutomationCalls.length, 0);
  assert.equal(syncCalls.length, 1);
  assert.equal(evaluateTriggersCalls.length, 1);
});