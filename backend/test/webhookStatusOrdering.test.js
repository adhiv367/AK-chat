'use strict';

// Regression tests for Phase 6 Part 3B: Meta webhook status receipts
// (sent/delivered/read/failed) must be idempotent and must never let an
// out-of-order or duplicate webhook event downgrade a chat_history row's
// status (e.g. read -> delivered). See src/routes/webhook.js, the
// `message_type === 'status'` branch of POST /webhook/whatsapp, and the
// CASE-based rank guard added to that UPDATE.
//
// This mock DB evaluates the guard's rank logic in JS (mirroring the SQL
// CASE expression exactly) since no real Postgres is available here — same
// approach as test/webhookBroadcastStatus.test.js.

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
stubModule('../src/engine/automationEngine', { evaluateTriggers: async () => {}, resumeAutomation: async () => {} });
stubModule('../src/services/automationGuard', { hasManualReplyTag: async () => false });
stubModule('../src/services/messageSender', { resolveAccount: async () => null, insertPendingRow: async () => null });
stubModule('../src/services/imagePrep', { prepareProductImage: async () => null });
stubModule('../src/integrations/metaSend', { uploadMedia: async () => null });

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

const RANK = { read: 3, delivered: 2, sent: 1, failed: 1 };
function rank(status) { return RANK[status] ?? 0; }

// Mirrors the CASE-guarded UPDATE in src/routes/webhook.js exactly: only
// applies the new status when its rank is >= the current row's rank.
function installDb({ chatHistory = [] } = {}) {
  const updates = [];

  function applyChatHistoryUpdate(params) {
    const [status, messageId] = params;
    for (const row of chatHistory) {
      if (row.message_id === messageId && rank(status) >= rank(row.status)) {
        row.status = status;
      }
    }
    updates.push({ status, messageId });
  }

  async function dispatch(sql, params) {
    if (/UPDATE coexistence\.chat_history/i.test(sql)) {
      applyChatHistoryUpdate(params);
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE coexistence\.broadcast_logs/i.test(sql)) {
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

  return { chatHistory, updates };
}

function statusWebhookBody({ recipientId, waMessageId, status }) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: '111', display_phone_number: '15550001111' },
          statuses: [{
            id: waMessageId,
            recipient_id: recipientId,
            status,
            timestamp: String(Math.floor(Date.now() / 1000)),
          }],
        },
      }],
    }],
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

test('out-of-order duplicate "delivered" after "read" does not downgrade status', async () => {
  const db = installDb({ chatHistory: [{ message_id: 'wamid.READ1', status: 'sent' }] });

  await postWebhook(statusWebhookBody({ recipientId: '9190001', waMessageId: 'wamid.READ1', status: 'delivered' }));
  assert.equal(db.chatHistory[0].status, 'delivered');

  await postWebhook(statusWebhookBody({ recipientId: '9190001', waMessageId: 'wamid.READ1', status: 'read' }));
  assert.equal(db.chatHistory[0].status, 'read');

  // A duplicate/late 'delivered' event (Meta retry, or arrives after 'read'
  // due to network reordering) must NOT regress the row back to 'delivered'.
  await postWebhook(statusWebhookBody({ recipientId: '9190001', waMessageId: 'wamid.READ1', status: 'delivered' }));
  assert.equal(db.chatHistory[0].status, 'read');

  // Nor can a stray duplicate 'sent' regress it.
  await postWebhook(statusWebhookBody({ recipientId: '9190001', waMessageId: 'wamid.READ1', status: 'sent' }));
  assert.equal(db.chatHistory[0].status, 'read');
});

test('duplicate webhook for the same status is a harmless idempotent no-op', async () => {
  const db = installDb({ chatHistory: [{ message_id: 'wamid.DUP1', status: 'delivered' }] });

  await postWebhook(statusWebhookBody({ recipientId: '9190002', waMessageId: 'wamid.DUP1', status: 'delivered' }));
  assert.equal(db.chatHistory[0].status, 'delivered');
  assert.equal(db.updates.length, 1);
});

test('normal forward progression sent -> delivered -> read applies each update', async () => {
  const db = installDb({ chatHistory: [{ message_id: 'wamid.FWD1', status: 'sending' }] });

  await postWebhook(statusWebhookBody({ recipientId: '9190003', waMessageId: 'wamid.FWD1', status: 'sent' }));
  assert.equal(db.chatHistory[0].status, 'sent');

  await postWebhook(statusWebhookBody({ recipientId: '9190003', waMessageId: 'wamid.FWD1', status: 'delivered' }));
  assert.equal(db.chatHistory[0].status, 'delivered');

  await postWebhook(statusWebhookBody({ recipientId: '9190003', waMessageId: 'wamid.FWD1', status: 'read' }));
  assert.equal(db.chatHistory[0].status, 'read');
});

test('"failed" can supersede an optimistic "sent" row', async () => {
  const db = installDb({ chatHistory: [{ message_id: 'wamid.FAIL1', status: 'sent' }] });

  await postWebhook(statusWebhookBody({ recipientId: '9190004', waMessageId: 'wamid.FAIL1', status: 'failed' }));
  assert.equal(db.chatHistory[0].status, 'failed');
});

test('a stray "failed" cannot downgrade an already-delivered/read row', async () => {
  const db = installDb({ chatHistory: [{ message_id: 'wamid.FAIL2', status: 'read' }] });

  await postWebhook(statusWebhookBody({ recipientId: '9190005', waMessageId: 'wamid.FAIL2', status: 'failed' }));
  assert.equal(db.chatHistory[0].status, 'read');
});








