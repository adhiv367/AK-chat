'use strict';

// Phase 7.9 Batch 2 — regression tests for engine/automationEngine.js's
// 'product' and 'catalog' directType branches.
//
// Before this batch these branches trusted node.directData.catalog_id
// (a free-text field a workspace user could type anything into, sourced
// from the browser) directly into the outgoing Meta payload. They now
// mirror routes/messages.js's POST /messages/send-product and
// /messages/send-catalog exactly: only a workspace-scoped internal
// product id is read off the node (dd.productId / dd.thumbnailProductId),
// and the Meta catalog id + the product's retailer id are both resolved
// SERVER-SIDE via services/whatsappProductMessage.js — never taken from
// stored node data.
//
// No real Postgres/BullMQ/Meta is used: pool.query is monkey-patched
// (same approach as test/messageSenderMarkFailed.test.js) and
// services/messageSender.js, queue/sendQueue.js and
// services/whatsappProductMessage.js are patched on their shared,
// require-cached module.exports objects, since automationEngine.js
// requires all three lazily (inline, inside the branch) rather than at
// module load time — patching the same cached object before calling
// executeMessageNode is therefore sufficient, no proxyquire/jest.mock
// needed.

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/db');
const messageSender = require('../src/services/messageSender');
const sendQueue = require('../src/queue/sendQueue');
const whatsappProductMessage = require('../src/services/whatsappProductMessage');
const { executeMessageNode } = require('../src/engine/automationEngine');

const WORKSPACE_ID = 42;
const ACCOUNT = { id: 7, phoneNumberId: 'pnid-7' };

function installDb() {
  const originalQuery = pool.query;
  // logStep() issues two queries against pool via the `client` argument
  // executeMessageNode is called with — here we just pass `pool` itself
  // as the "client", same as how a real pg PoolClient is used elsewhere.
  pool.query = async (sql) => {
    if (/SELECT workspace_id FROM coexistence\.automation_executions/i.test(sql)) {
      return { rows: [{ workspace_id: WORKSPACE_ID }] };
    }
    if (/INSERT INTO coexistence\.automation_execution_steps/i.test(sql)) {
      return { rows: [{ id: 1 }] };
    }
    return { rows: [] };
  };
  return { restore() { pool.query = originalQuery; } };
}

function installMessageSender() {
  const original = { resolveAccount: messageSender.resolveAccount, insertPendingRow: messageSender.insertPendingRow };
  messageSender.resolveAccount = async () => ({ account: ACCOUNT, error: null });
  messageSender.insertPendingRow = async () => 'local-test-id';
  return {
    restore() {
      messageSender.resolveAccount = original.resolveAccount;
      messageSender.insertPendingRow = original.insertPendingRow;
    },
  };
}

function installSendQueue() {
  const original = sendQueue.enqueueSend;
  const calls = [];
  sendQueue.enqueueSend = async (job) => { calls.push(job); };
  return { calls, restore() { sendQueue.enqueueSend = original; } };
}

function installWhatsappProductMessage({ product = null, thumbnailProduct = null, catalogId = 'meta-catalog-resolved' } = {}) {
  const original = {
    resolveProductForMessage: whatsappProductMessage.resolveProductForMessage,
    resolveCatalogForAccount: whatsappProductMessage.resolveCatalogForAccount,
    resolveRetailerId: whatsappProductMessage.resolveRetailerId,
  };
  const calls = { resolveProductForMessage: [], resolveCatalogForAccount: [] };
  whatsappProductMessage.resolveProductForMessage = async (workspaceId, opts) => {
    calls.resolveProductForMessage.push({ workspaceId, opts });
    const match = [product, thumbnailProduct].find(p => p && String(p.id) === String(opts.id));
    if (!match) throw new whatsappProductMessage.NotFoundError('product not found');
    return match;
  };
  whatsappProductMessage.resolveCatalogForAccount = async (workspaceId, accountId) => {
    calls.resolveCatalogForAccount.push({ workspaceId, accountId });
    return catalogId;
  };
  // resolveRetailerId is a pure function — left untouched (same real
  // implementation as production, exercising the actual fallback chain).
  return {
    calls,
    restore() {
      whatsappProductMessage.resolveProductForMessage = original.resolveProductForMessage;
      whatsappProductMessage.resolveCatalogForAccount = original.resolveCatalogForAccount;
      whatsappProductMessage.resolveRetailerId = original.resolveRetailerId;
    },
  };
}

function baseNode(overrides) {
  return {
    id: 'node-1',
    type: 'message',
    messageMode: 'direct',
    whatsappAccountId: ACCOUNT.id,
    ...overrides,
  };
}

function baseContext(overrides) {
  return {
    workspace_id: WORKSPACE_ID,
    contact_number: '919876543210',
    contact: { name: 'Test Contact' },
    trigger_data: { wa_number: '918888888888' },
    ...overrides,
  };
}

test('product message: resolves catalog id + retailer id server-side, ignoring any stored catalog_id/product_retailer_id', async () => {
  const db = installDb();
  const ms = installMessageSender();
  const sq = installSendQueue();
  const product = { id: 501, name: 'Test Product', sku: 'SKU-501', retailer_id: null };
  const wpm = installWhatsappProductMessage({ product, catalogId: 'server-resolved-catalog' });
  try {
    const node = baseNode({
      directType: 'product',
      directData: {
        productId: 501,
        // These two would previously have been trusted verbatim — they
        // must now be completely ignored by the engine.
        catalog_id: 'evil-client-supplied-catalog-id',
        product_retailer_id: 'evil-client-supplied-retailer-id',
      },
    });

    await executeMessageNode(pool, 999, node, baseContext());

    assert.equal(wpm.calls.resolveProductForMessage.length, 1);
    assert.deepEqual(wpm.calls.resolveProductForMessage[0], { workspaceId: WORKSPACE_ID, opts: { id: 501 } });
    assert.equal(wpm.calls.resolveCatalogForAccount.length, 1);
    assert.deepEqual(wpm.calls.resolveCatalogForAccount[0], { workspaceId: WORKSPACE_ID, accountId: ACCOUNT.id });

    assert.equal(sq.calls.length, 1);
    const interactive = sq.calls[0].payload.interactive;
    assert.equal(interactive.type, 'product');
    assert.equal(interactive.action.catalog_id, 'server-resolved-catalog');
    assert.equal(interactive.action.product_retailer_id, 'SKU-501');
    // Never leaked into the payload
    assert.notEqual(interactive.action.catalog_id, 'evil-client-supplied-catalog-id');
    assert.notEqual(interactive.action.product_retailer_id, 'evil-client-supplied-retailer-id');
  } finally {
    db.restore(); ms.restore(); sq.restore(); wpm.restore();
  }
});

test('product message: throws when no product is selected on the node', async () => {
  const db = installDb();
  const ms = installMessageSender();
  const sq = installSendQueue();
  const wpm = installWhatsappProductMessage({});
  try {
    const node = baseNode({ directType: 'product', directData: {} });
    await assert.rejects(
      executeMessageNode(pool, 999, node, baseContext()),
      /no product selected/i
    );
    assert.equal(sq.calls.length, 0);
  } finally {
    db.restore(); ms.restore(); sq.restore(); wpm.restore();
  }
});

test('catalog message: validates a connected catalog server-side and never places catalog_id from node data in the payload', async () => {
  const db = installDb();
  const ms = installMessageSender();
  const sq = installSendQueue();
  const wpm = installWhatsappProductMessage({ catalogId: 'server-resolved-catalog' });
  try {
    const node = baseNode({
      directType: 'catalog',
      directData: { body: 'Check out our catalog!', catalog_id: 'evil-client-supplied-catalog-id' },
    });

    await executeMessageNode(pool, 999, node, baseContext());

    assert.equal(wpm.calls.resolveCatalogForAccount.length, 1);
    assert.equal(sq.calls.length, 1);
    const interactive = sq.calls[0].payload.interactive;
    assert.equal(interactive.type, 'catalog_message');
    assert.equal(interactive.body.text, 'Check out our catalog!');
    // No thumbnail selected -> no parameters block at all
    assert.equal(interactive.action.parameters, undefined);
  } finally {
    db.restore(); ms.restore(); sq.restore(); wpm.restore();
  }
});

test('catalog message: resolves an optional thumbnail product to its retailer id, workspace-scoped', async () => {
  const db = installDb();
  const ms = installMessageSender();
  const sq = installSendQueue();
  const thumbnailProduct = { id: 777, name: 'Thumb Product', sku: null, retailer_id: 'RET-777' };
  const wpm = installWhatsappProductMessage({ thumbnailProduct, catalogId: 'server-resolved-catalog' });
  try {
    const node = baseNode({
      directType: 'catalog',
      directData: { body: 'Browse now', thumbnailProductId: 777 },
    });

    await executeMessageNode(pool, 999, node, baseContext());

    assert.equal(wpm.calls.resolveProductForMessage.length, 1);
    assert.deepEqual(wpm.calls.resolveProductForMessage[0], { workspaceId: WORKSPACE_ID, opts: { id: 777 } });

    const interactive = sq.calls[0].payload.interactive;
    assert.equal(interactive.action.parameters.thumbnail_product_retailer_id, 'RET-777');
  } finally {
    db.restore(); ms.restore(); sq.restore(); wpm.restore();
  }
});

test('catalog message: a thumbnail product belonging to another workspace 404s instead of leaking', async () => {
  const db = installDb();
  const ms = installMessageSender();
  const sq = installSendQueue();
  const wpm = installWhatsappProductMessage({ catalogId: 'server-resolved-catalog' }); // no product registered -> NotFoundError
  try {
    const node = baseNode({
      directType: 'catalog',
      directData: { body: 'Browse now', thumbnailProductId: 999999 },
    });

    await assert.rejects(
      executeMessageNode(pool, 999, node, baseContext()),
      whatsappProductMessage.NotFoundError
    );
    assert.equal(sq.calls.length, 0);
  } finally {
    db.restore(); ms.restore(); sq.restore(); wpm.restore();
  }
});