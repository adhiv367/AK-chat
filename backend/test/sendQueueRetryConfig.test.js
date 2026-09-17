'use strict';

// Regression tests for Phase 6 Part 3C, Step 1/5/8: verifies the retry
// configuration and job-identity dedup that ALREADY exist in
// src/queue/sendQueue.js (max attempts, exponential backoff, and a
// deterministic jobId derived from localMessageId so a duplicate enqueue
// call for the same optimistic row can't create a second BullMQ job).
//
// bullmq's Queue/Worker/QueueEvents and ioredis are stubbed out entirely —
// no real Redis is used or required. This only exercises sendQueue.js's own
// enqueue-time logic (enqueueSend), not an end-to-end send.

const test = require('node:test');
const assert = require('node:assert/strict');

function stubModule(name, exports) {
  const resolved = require.resolve(name);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const addCalls = [];
class FakeQueue {
  constructor(name, opts) { this.name = name; this.opts = opts; }
  async add(jobName, jobData, addOpts) { addCalls.push({ jobName, jobData, addOpts }); }
  async close() {}
}
class FakeWorker {
  constructor() {}
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
// sendQueue.js also pulls these in at load time.
stubModule('../src/routes/whatsappAccounts', { getAccountWithToken: async () => null });
stubModule('../src/integrations/metaSend', {
  sendText: async () => {}, sendTemplate: async () => {}, sendMedia: async () => {},
  sendInteractive: async () => {}, sendLocation: async () => {}, sendContacts: async () => {}, sendReaction: async () => {},
});
stubModule('../src/services/messageSender', { markSent: async () => {}, markFailed: async () => {}, formatSendError: (e) => String(e) });
stubModule('../src/services/accountHealth', {
  markAccountHealth: async () => {},
  classifyMetaError: (err) => {
    if (!err) return 'unknown_error';
    if (err.status === 401 || err.metaError?.code === 190) return 'invalid_token';
    if (err.status === 429 || err.metaError?.code === 4 || err.metaError?.code === 80007) return 'rate_limited';
    return 'unknown_error';
  },
});

const { enqueueSend } = require('../src/queue/sendQueue');

test('enqueueSend uses the existing bounded attempts + exponential backoff config (no new retry system introduced)', async () => {
  addCalls.length = 0;
  await enqueueSend({ kind: 'text', accountId: 1, to: '919000000001', localMessageId: 'local-abc', payload: { body: 'hi' } });

  assert.equal(addCalls.length, 1);
  const { addOpts } = addCalls[0];
  // Default is 4 (process.env.SEND_QUEUE_ATTEMPTS not set in test env) —
  // bounded, so a permanently-failing recipient (e.g. Meta 131042) cannot
  // retry forever.
  assert.equal(addOpts.attempts, 4);
  assert.deepEqual(addOpts.backoff, { type: 'exponential', delay: 1500 });
});

test('enqueueSend derives a deterministic jobId from localMessageId — a duplicate enqueue for the same optimistic row reuses the same BullMQ job identity', async () => {
  addCalls.length = 0;
  await enqueueSend({ kind: 'text', accountId: 1, to: '919000000002', localMessageId: 'local-dup-1', payload: { body: 'hi' } });
  await enqueueSend({ kind: 'text', accountId: 1, to: '919000000002', localMessageId: 'local-dup-1', payload: { body: 'hi' } });

  assert.equal(addCalls.length, 2);
  assert.equal(addCalls[0].addOpts.jobId, addCalls[1].addOpts.jobId);
  assert.equal(addCalls[0].addOpts.jobId, 'send-local-dup-1');
  // (BullMQ itself, not this test, is what actually dedupes same-jobId adds —
  // this only proves sendQueue.js constructs the identity correctly; see
  // Step 8's doc comment in routes/broadcasts.js for the whole-broadcast
  // level guard, which is what this repo was actually missing.)
});

test('two different recipients/localMessageIds never collide on jobId', async () => {
  addCalls.length = 0;
  await enqueueSend({ kind: 'text', accountId: 1, to: '919000000003', localMessageId: 'local-r1', payload: { body: 'hi' } });
  await enqueueSend({ kind: 'text', accountId: 1, to: '919000000004', localMessageId: 'local-r2', payload: { body: 'hi' } });

  assert.notEqual(addCalls[0].addOpts.jobId, addCalls[1].addOpts.jobId);
});


