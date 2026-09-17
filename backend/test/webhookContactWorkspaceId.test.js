'use strict';

// Phase 7.10A — FIX 2 (webhook path): a brand-new contact created by
// POST /webhook/whatsapp must get workspace_id set immediately, resolved
// from the WhatsApp account that received the message (r.phone_number_id
// -> coexistence.whatsapp_accounts.workspace_id), not left NULL.
//
// Same isolated-webhook harness as test/webhookZohoSyncTrigger.test.js:
// every module webhook.js pulls in at require-time is stubbed so no real
// Postgres/Redis/network is touched; pool.connect()/pool.query() are
// monkey-patched with a small in-memory model of exactly the SQL this path
// issues.

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
stubModule('../src/engine/automationEngine', {
  evaluateTriggers: async () => {},
  resumeAutomation: async () => {},
});
stubModule('../src/services/automationGuard', { hasManualReplyTag: () => false });
stubModule('../src/services/imagePrep', { prepareProductImage: async () => null });
stubModule('../src/integrations/metaSend', { uploadMedia: async () => null });
stubModule('../src/services/messageSender', {
  resolveAccount: async () => ({ error: 'not used by this test' }),
  insertPendingRow: async () => 'local-1',
});
stubModule('../src/services/zohoSyncService', { syncConversationToZoho: async () => ({ synced: false }) });

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

// Two WhatsApp accounts in two different workspaces, keyed by phone_number_id.
const ACCOUNTS = {
  '111': { id: 5, workspace_id: 1, phone_number_id: '111' },
  '222': { id: 6, workspace_id: 2, phone_number_id: '222' },
};

let contacts;

function installDb() {
  contacts = [];

  async function dispatch(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (/SELECT tags, last_agent_reply_at FROM coexistence\.contacts/i.test(s)) {
      return { rows: [] };
    }
    if (/SELECT id FROM coexistence\.automation_executions/i.test(s)) {
      return { rows: [] };
    }
    // FIX 2's own workspace lookup.
    if (/SELECT workspace_id FROM coexistence\.whatsapp_accounts WHERE phone_number_id = \$1/i.test(s)) {
      const acc = ACCOUNTS[params[0]];
      return { rows: acc ? [{ workspace_id: acc.workspace_id }] : [] };
    }
    // Contact upsert.
    if (/^INSERT INTO coexistence\.contacts \(workspace_id, wa_number, contact_number, profile_name\)/i.test(s)) {
      const [workspaceId, waNumber, contactNumber, profileName] = params;
      const existing = contacts.find(c => c.wa_number === waNumber && c.contact_number === contactNumber);
      if (existing) {
        existing.profile_name = profileName;
        // ON CONFLICT ... workspace_id = COALESCE(existing, EXCLUDED)
        existing.workspace_id = existing.workspace_id ?? workspaceId;
      } else {
        contacts.push({ workspace_id: workspaceId, wa_number: waNumber, contact_number: contactNumber, profile_name: profileName });
      }
      return { rows: [] };
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
}

function incomingTextBodyWithName({ phoneNumberId, displayPhoneNumber, waMessageId, fromNumber, text, name }) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: phoneNumberId, display_phone_number: displayPhoneNumber },
          contacts: [{ wa_id: fromNumber, profile: { name } }],
          messages: [{
            id: waMessageId,
            from: fromNumber,
            type: 'text',
            text: { body: text },
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

test.beforeEach(() => installDb());

test('a brand-new contact created by an incoming webhook message gets workspace_id set immediately', async () => {
  const res = await postWebhook(incomingTextBodyWithName({
    phoneNumberId: '111',
    displayPhoneNumber: '15550001111',
    waMessageId: 'wamid.C1',
    fromNumber: '919999999999',
    text: 'Hi',
    name: 'Ravi',
  }));
  assert.equal(res.statusCode, 200);

  const contact = contacts.find(c => c.contact_number === '919999999999');
  assert.ok(contact, 'contact should have been created');
  assert.equal(contact.workspace_id, 1);
});

test('two workspaces\' new contacts each get their own workspace_id, never the other\'s', async () => {
  await postWebhook(incomingTextBodyWithName({
    phoneNumberId: '111',
    displayPhoneNumber: '15550001111',
    waMessageId: 'wamid.C2',
    fromNumber: '919999999999',
    text: 'Hi A',
    name: 'A Contact',
  }));
  await postWebhook(incomingTextBodyWithName({
    phoneNumberId: '222',
    displayPhoneNumber: '15550002222',
    waMessageId: 'wamid.C3',
    fromNumber: '918888888888',
    text: 'Hi B',
    name: 'B Contact',
  }));

  const a = contacts.find(c => c.contact_number === '919999999999');
  const b = contacts.find(c => c.contact_number === '918888888888');
  assert.equal(a.workspace_id, 1);
  assert.equal(b.workspace_id, 2);
});