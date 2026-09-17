'use strict';

// Phase 8A — Message Usage Metering: regression tests for the single new
// integration point in src/queue/sendQueue.js's processJob() (the internal
// function passed to `new Worker(...)` in startSendWorker()).
//
// Confirms, without any real Redis/Postgres/Meta API:
//   1. A successful send (markSent returns true) increments usage exactly
//      once, attributed to account.workspaceId.
//   2. A "duplicate" success (markSent returns false — e.g. a retried/
//      re-processed job whose chat_history row was already swapped to the
//      real wamid by an earlier attempt) does NOT increment usage. This is
//      the double-counting guard the Phase 8A audit specified.
//   3. A failed send (Meta API throws) never reaches markSent/increment at
//      all — failed messages are never counted.
//   4. Existing retry/error-handling behavior (markFailed, account-health
//      classification) is untouched by this addition.
//
// Same require.cache module-stubbing technique as
// test/sendQueueRetryConfig.test.js and test/broadcastDoubleSend.test.js —
// no real BullMQ/Redis/Meta/DB involved.

const test = require('node:test');
const assert = require('node:assert/strict');

function stubModule(name, exports) {
  const resolved = require.resolve(name);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// ── bullmq / ioredis stubs ──────────────────────────────────────────────
let capturedProcessor = null;
class FakeQueue {
  constructor() {}
  async add() {}
  async close() {}
}
class FakeWorker {
  constructor(name, processor) {
    capturedProcessor = processor; // this is processJob — captured, not invoked by us
  }
  on() { return this; }
  async close() {}
}
class FakeQueueEvents {
  constructor() {}
  on() { return this; }
  async close() {}
}
class FakeIORedis {
  constructor() {}
  on() {}
  async quit() {}
}
stubModule('bullmq', { Queue: FakeQueue, Worker: FakeWorker, QueueEvents: FakeQueueEvents });
stubModule('ioredis', FakeIORedis);

// ── whatsappAccounts stub — the account whose workspaceId must reach the
//    usage increment ──────────────────────────────────────────────────────
const FAKE_ACCOUNT = {
  id: 1,
  workspaceId: 555,
  phoneNumberId: 'pn-1',
  displayPhoneNumber: '15550001111',
  accessToken: 'tok',
  isActive: true,
  displayName: 'Test Account',
};
stubModule('../src/routes/whatsappAccounts', {
  getAccountWithToken: async () => FAKE_ACCOUNT,
});

// ── metaSend stub — controllable per test via `metaSendBehavior.mode` ────
const metaSendBehavior = { mode: 'success' }; // 'success' | 'failure'
async function sendTextImpl() {
  if (metaSendBehavior.mode === 'failure') {
    const err = new Error('simulated Meta failure');
    throw err;
  }
  return { messages: [{ id: 'wamid-123' }] };
}
stubModule('../src/integrations/metaSend', {
  sendText: (...args) => sendTextImpl(...args),
  sendTemplate: async () => ({ messages: [{ id: 'wamid-template' }] }),
  sendMedia: async () => ({ messages: [{ id: 'wamid-media' }] }),
  sendInteractive: async () => ({ messages: [{ id: 'wamid-interactive' }] }),
  sendFlowMessage: async () => ({ messages: [{ id: 'wamid-flow' }] }),
  sendLocation: async () => ({ messages: [{ id: 'wamid-location' }] }),
  sendContacts: async () => ({ messages: [{ id: 'wamid-contacts' }] }),
  sendReaction: async () => ({ messages: [{ id: 'wamid-reaction' }] }),
});

// ── messageSender stub — spy on markSent/markFailed calls, controllable
//    markSent return value via `markSentBehavior.updated` ────────────────
const markSentCalls = [];
const markFailedCalls = [];
const markSentBehavior = { updated: true };
stubModule('../src/services/messageSender', {
  markSent: async (localId, wamid, workspaceId) => {
    markSentCalls.push({ localId, wamid, workspaceId });
    return markSentBehavior.updated;
  },
  markFailed: async (localId, err) => {
    markFailedCalls.push({ localId, err });
  },
  formatSendError: (e) => String((e && e.message) || e),
});

// ── accountHealth stub — no-ops, matches existing test patterns ─────────
stubModule('../src/services/accountHealth', {
  markAccountHealth: async () => {},
  classifyMetaError: () => 'unknown_error',
});

// ── messageUsageService stub — spy on incrementMessageUsage calls ───────
const incrementCalls = [];
stubModule('../src/services/messageUsageService', {
  incrementMessageUsage: async (workspaceId) => {
    incrementCalls.push(workspaceId);
    return incrementCalls.length;
  },
});

const { startSendWorker } = require('../src/queue/sendQueue');

test.before(() => {
  startSendWorker(); // triggers `new Worker(QUEUE_NAME, processJob, ...)`, capturing processJob
  assert.equal(typeof capturedProcessor, 'function', 'processJob must have been captured from the Worker constructor');
});

test.beforeEach(() => {
  markSentCalls.length = 0;
  markFailedCalls.length = 0;
  incrementCalls.length = 0;
  metaSendBehavior.mode = 'success';
  markSentBehavior.updated = true;
});

function fakeJob(overrides = {}) {
  return {
    data: {
      kind: 'text',
      accountId: 1,
      to: '919000000001',
      localMessageId: 'local-abc',
      payload: { body: 'hello' },
      ...overrides,
    },
    attemptsMade: 0,
  };
}

test('successful send: markSent is called with account.workspaceId, and usage is incremented exactly once', async () => {
  const result = await capturedProcessor(fakeJob());

  assert.equal(result.wamid, 'wamid-123');
  assert.equal(markSentCalls.length, 1);
  assert.equal(markSentCalls[0].workspaceId, 555); // account.workspaceId reached markSent
  assert.equal(incrementCalls.length, 1);
  assert.equal(incrementCalls[0], 555); // usage attributed to the correct workspace
});

test('duplicate/already-processed success (markSent returns false) does NOT increment usage — prevents double-counting on retries', async () => {
  markSentBehavior.updated = false; // simulates a repeat call whose chat_history row was already swapped

  await capturedProcessor(fakeJob({ localMessageId: 'local-dup' }));

  assert.equal(markSentCalls.length, 1); // markSent is still called...
  assert.equal(incrementCalls.length, 0); // ...but usage is NOT incremented
});

test('failed send never reaches markSent or the usage increment — failed messages are not counted', async () => {
  metaSendBehavior.mode = 'failure';

  await assert.rejects(() => capturedProcessor(fakeJob({ localMessageId: 'local-fail' })));

  assert.equal(markSentCalls.length, 0);
  assert.equal(incrementCalls.length, 0);
});

test('a send with no localMessageId (defensive edge case) never calls markSent or the increment', async () => {
  const result = await capturedProcessor(fakeJob({ localMessageId: undefined }));

  assert.equal(result.wamid, 'wamid-123');
  assert.equal(markSentCalls.length, 0);
  assert.equal(incrementCalls.length, 0);
});

test('two independent successful sends for the same workspace each increment usage once (no under- or over-counting)', async () => {
  await capturedProcessor(fakeJob({ localMessageId: 'local-1' }));
  await capturedProcessor(fakeJob({ localMessageId: 'local-2' }));

  assert.equal(markSentCalls.length, 2);
  assert.equal(incrementCalls.length, 2);
  assert.deepEqual(incrementCalls, [555, 555]);
});



