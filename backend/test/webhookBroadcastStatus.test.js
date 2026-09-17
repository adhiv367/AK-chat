'use strict';

// Regression tests for Phase 6 Part 3B: Meta webhook `failed` status receipts
// must propagate into coexistence.broadcast_logs (status + error_message),
// not just coexistence.chat_history. See src/routes/webhook.js, the
// `message_type === 'status'` branch of POST /webhook/whatsapp.
//
// No real Postgres/Redis is used — pool.connect()/pool.query() are
// monkey-patched on the shared '../src/db' singleton, and the BullMQ-backed
// queue modules webhook.js pulls in at require-time are stubbed out, same
// approach as test/broadcastStatus.test.js.

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

// webhook.js requires these at load time; several open real BullMQ/ioredis
// connections or hit external APIs. None of the status-webhook logic under
// test here touches them, so stub with no-ops.
stubModule('../src/queue/sendQueue', { enqueueSend: async () => {} });
stubModule('../src/queue/mediaQueue', { enqueueMediaDownload: async () => {} });
stubModule('../src/services/mediaDownloader', { markPending: async () => {}, MEDIA_TYPES: new Set() });
stubModule('../src/services/productAutomation', { findProduct: async () => null });
stubModule('../src/services/shopifyService', { getProduct: async () => null });
stubModule('../src/services/aiReplyService', { generateReply: async () => null });
stubModule('../src/engine/automationEngine', { evaluateTriggers: async () => {}, resumeAutomation: async () => {} });
stubModule('../src/services/automationGuard', { hasManualReplyTag: async () => false });
stubModule('../src/services/messageSender', { resolveAccount: async () => null, insertPendingRow: async () => null });
stubModule('../src/services/imagePrep', { prepareProductImage: async () => null });
stubModule('../src/integrations/metaSend', { uploadMedia: async () => null });

const pool = require('../src/db');
const { router } = require('../src/routes/webhook');

// Pull the POST /webhook/whatsapp handler straight off the router stack, same
// "no supertest/http needed" pattern used by the other route-level tests.
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

// Installs a fake pool.connect() transactional client + pool.query() that
// records every UPDATE against coexistence.broadcast_logs and
// coexistence.chat_history, and lets a test seed pre-existing rows.
function installDb({ broadcastLogs = [], chatHistory = [] } = {}) {
  const updates = [];

  function applyBroadcastLogUpdate(sql, params) {
    const setsFailed = /SET\s+status\s*=\s*'failed'/i.test(sql);
    if (setsFailed) {
      const [errorMessage, waMessageId] = params;
      for (const row of broadcastLogs) {
        if (row.wa_message_id === waMessageId) {
          row.status = 'failed';
          row.error_message = errorMessage;
        }
      }
      updates.push({ table: 'broadcast_logs', sql, params });
    }
  }

  function applyChatHistoryUpdate(sql, params) {
    const [status, messageId] = params;
    for (const row of chatHistory) {
      if (row.message_id === messageId) row.status = status;
    }
    updates.push({ table: 'chat_history', sql, params });
  }

  async function dispatch(sql, params) {
    if (/UPDATE coexistence\.chat_history/i.test(sql)) {
      applyChatHistoryUpdate(sql, params);
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE coexistence\.broadcast_logs/i.test(sql)) {
      applyBroadcastLogUpdate(sql, params);
      return { rows: [], rowCount: 1 };
    }
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

  return { broadcastLogs, chatHistory, updates };
}

function statusWebhookBody({ recipientId, waMessageId, status, errors }) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: '111', display_phone_number: '15550001111' },
              statuses: [
                {
                  id: waMessageId,
                  recipient_id: recipientId,
                  status,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  ...(errors ? { errors } : {}),
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

const META_131042_ERRORS = [
  {
    code: 131042,
    title: 'Business eligibility payment issue',
    message: 'Business eligibility payment issue',
  },
];

test('failed webhook flips a sent broadcast_logs row to failed + sets error_message', async () => {
  const db = installDb({
    broadcastLogs: [
      { id: 122, wa_message_id: 'wamid.AAA', status: 'sent', error_message: null },
    ],
    chatHistory: [{ message_id: 'wamid.AAA', status: 'sent' }],
  });

  const res = await postWebhook(statusWebhookBody({
    recipientId: '917904374551',
    waMessageId: 'wamid.AAA',
    status: 'failed',
    errors: META_131042_ERRORS,
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(db.broadcastLogs[0].status, 'failed');
  assert.match(db.broadcastLogs[0].error_message, /Business eligibility payment issue/);
  assert.match(db.broadcastLogs[0].error_message, /131042/);
  assert.equal(db.chatHistory[0].status, 'failed');
});

test('failed webhook does not touch unrelated broadcast_logs rows', async () => {
  const db = installDb({
    broadcastLogs: [
      { id: 122, wa_message_id: 'wamid.AAA', status: 'sent', error_message: null },
      { id: 123, wa_message_id: 'wamid.BBB', status: 'sent', error_message: null },
    ],
    chatHistory: [{ message_id: 'wamid.AAA', status: 'sent' }],
  });

  await postWebhook(statusWebhookBody({
    recipientId: '917904374551',
    waMessageId: 'wamid.AAA',
    status: 'failed',
    errors: META_131042_ERRORS,
  }));

  assert.equal(db.broadcastLogs[0].status, 'failed');
  assert.equal(db.broadcastLogs[1].status, 'sent');
  assert.equal(db.broadcastLogs[1].error_message, null);
});

test('sent/delivered/read webhooks leave broadcast_logs.status untouched (unchanged behavior)', async () => {
  for (const status of ['sent', 'delivered', 'read']) {
    const db = installDb({
      broadcastLogs: [{ id: 122, wa_message_id: 'wamid.CCC', status: 'sent', error_message: null }],
      chatHistory: [{ message_id: 'wamid.CCC', status: 'sent' }],
    });

    await postWebhook(statusWebhookBody({
      recipientId: '917904374551',
      waMessageId: 'wamid.CCC',
      status,
    }));

    // broadcast_logs is never written for non-failed receipts — delivered/read
    // continue to be derived from chat_history via the existing rollup join.
    assert.equal(db.broadcastLogs[0].status, 'sent');
    // chat_history still gets the granular status, same as before this fix.
    assert.equal(db.chatHistory[0].status, status);
  }
});

test('duplicate failed webhook for the same wa_message_id is idempotent', async () => {
  const db = installDb({
    broadcastLogs: [{ id: 122, wa_message_id: 'wamid.DDD', status: 'sent', error_message: null }],
    chatHistory: [{ message_id: 'wamid.DDD', status: 'sent' }],
  });

  const body = statusWebhookBody({
    recipientId: '917904374551',
    waMessageId: 'wamid.DDD',
    status: 'failed',
    errors: META_131042_ERRORS,
  });

  await postWebhook(body);
  const afterFirst = { ...db.broadcastLogs[0] };
  await postWebhook(body); // Meta retries webhooks; must not error or corrupt state

  assert.equal(db.broadcastLogs[0].status, 'failed');
  assert.equal(db.broadcastLogs[0].error_message, afterFirst.error_message);
});

test('failed webhook with no matching broadcast_logs row is a safe no-op', async () => {
  const db = installDb({
    broadcastLogs: [{ id: 122, wa_message_id: 'wamid.OTHER', status: 'sent', error_message: null }],
    chatHistory: [],
  });

  const res = await postWebhook(statusWebhookBody({
    recipientId: '919999999999',
    waMessageId: 'wamid.NOMATCH',
    status: 'failed',
    errors: META_131042_ERRORS,
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(db.broadcastLogs[0].status, 'sent'); // untouched
});
