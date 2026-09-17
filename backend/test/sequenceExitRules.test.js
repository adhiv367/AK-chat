'use strict';

// Phase 7E — Exit Conditions: unit tests for the pure rule-matching logic
// in src/util/sequenceExitRules.js. A fake `pool` (plain object with a
// `query` function) is injected directly — this file never touches
// sequenceScheduler.js, so no Redis/BullMQ stubbing is needed here (see
// test/sequenceSchedulerExitConditions.test.js for the scheduler-level
// integration tests, which do need that).

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateExitRules, formatExitReason, EXIT_RULE_TYPES } = require('../src/util/sequenceExitRules');

const WS = 7;
const CONTACT = '919876543210';
const ENROLLED_AT = new Date('2026-08-01T00:00:00Z');

// ── fake pool ────────────────────────────────────────────────────────────
// Dispatches the exact two query shapes evaluateExitRules issues: a
// contacts.tags lookup and a chat_history incoming-since-enrollment lookup.
function makeFakePool({ contactTags = [], hasReplySince = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      const s = sql.replace(/\s+/g, ' ').trim();
      if (/^SELECT tags FROM coexistence\.contacts/.test(s)) {
        const [workspaceId, contactNumber] = params;
        if (workspaceId !== WS || contactNumber !== CONTACT) return { rows: [] };
        return { rows: [{ tags: contactTags }] };
      }
      if (/^SELECT 1 FROM coexistence\.chat_history/.test(s)) {
        return { rows: hasReplySince ? [{ '?column?': 1 }] : [] };
      }
      throw new Error(`Unexpected query in fake pool: ${s}`);
    },
  };
}

function baseArgs(pool, exitRules) {
  return {
    pool,
    workspaceId: WS,
    contactNumber: CONTACT,
    enrolledAt: ENROLLED_AT,
    waNumber: '911234567890',
    exitRules,
  };
}

// 1. has_tag match
test('has_tag: contact carries the tag -> matches', async () => {
  const pool = makeFakePool({ contactTags: ['unsubscribed'] });
  const rule = await evaluateExitRules(baseArgs(pool, [{ type: 'has_tag', tag: 'unsubscribed' }]));
  assert.deepEqual(rule, { type: 'has_tag', tag: 'unsubscribed' });
});

// 2. has_tag non-match
test('has_tag: contact does not carry the tag -> no match', async () => {
  const pool = makeFakePool({ contactTags: ['vip'] });
  const rule = await evaluateExitRules(baseArgs(pool, [{ type: 'has_tag', tag: 'unsubscribed' }]));
  assert.equal(rule, null);
});

// 3. not_has_tag match
test('not_has_tag: contact lacks the tag -> matches', async () => {
  const pool = makeFakePool({ contactTags: [] });
  const rule = await evaluateExitRules(baseArgs(pool, [{ type: 'not_has_tag', tag: 'vip' }]));
  assert.deepEqual(rule, { type: 'not_has_tag', tag: 'vip' });
});

// 4. not_has_tag non-match
test('not_has_tag: contact carries the tag -> no match', async () => {
  const pool = makeFakePool({ contactTags: ['vip'] });
  const rule = await evaluateExitRules(baseArgs(pool, [{ type: 'not_has_tag', tag: 'vip' }]));
  assert.equal(rule, null);
});

// 5. replied_since_enrollment after enrollment
test('replied_since_enrollment: an incoming message after enrolled_at -> matches', async () => {
  const pool = makeFakePool({ hasReplySince: true });
  const rule = await evaluateExitRules(baseArgs(pool, [{ type: 'replied_since_enrollment' }]));
  assert.deepEqual(rule, { type: 'replied_since_enrollment' });
});

// 6. reply before enrollment (fake pool models "no row found" — the SQL
// itself enforces timestamp > enrolled_at, so a pre-enrollment reply is
// indistinguishable from "no reply" at this layer, which is correct).
test('replied_since_enrollment: no incoming message after enrolled_at -> no match', async () => {
  const pool = makeFakePool({ hasReplySince: false });
  const rule = await evaluateExitRules(baseArgs(pool, [{ type: 'replied_since_enrollment' }]));
  assert.equal(rule, null);
});

// replied_since_enrollment with no resolvable waNumber never matches (and
// never throws) rather than crashing the tick.
test('replied_since_enrollment: no waNumber resolved -> no match, no error', async () => {
  const pool = makeFakePool({ hasReplySince: true });
  const args = baseArgs(pool, [{ type: 'replied_since_enrollment' }]);
  args.waNumber = null;
  const rule = await evaluateExitRules(args);
  assert.equal(rule, null);
  assert.ok(!pool.calls.some((c) => /chat_history/.test(c.sql)));
});

// 7. multiple rules, one matches (OR semantics)
test('multiple rules: one matches -> that rule is returned', async () => {
  const pool = makeFakePool({ contactTags: ['vip'] });
  const rule = await evaluateExitRules(
    baseArgs(pool, [
      { type: 'has_tag', tag: 'unsubscribed' },
      { type: 'not_has_tag', tag: 'vip' },
      { type: 'has_tag', tag: 'vip' },
    ])
  );
  assert.deepEqual(rule, { type: 'has_tag', tag: 'vip' });
});

// 8. multiple rules, none match
test('multiple rules: none match -> no match', async () => {
  const pool = makeFakePool({ contactTags: ['vip'] });
  const rule = await evaluateExitRules(
    baseArgs(pool, [
      { type: 'has_tag', tag: 'unsubscribed' },
      { type: 'not_has_tag', tag: 'vip' },
    ])
  );
  assert.equal(rule, null);
});

// 9. empty exit_rules
test('empty exit_rules array -> no match, no queries issued', async () => {
  const pool = makeFakePool();
  const rule = await evaluateExitRules(baseArgs(pool, []));
  assert.equal(rule, null);
  assert.equal(pool.calls.length, 0);
});

test('non-array exit_rules (defensive) -> no match, no queries issued', async () => {
  const pool = makeFakePool();
  const rule = await evaluateExitRules(baseArgs(pool, null));
  assert.equal(rule, null);
  assert.equal(pool.calls.length, 0);
});

// 10. unknown rule type ignored
test('unknown rule type is ignored safely, remaining rules still evaluated', async () => {
  const pool = makeFakePool({ contactTags: ['unsubscribed'] });
  const rule = await evaluateExitRules(
    baseArgs(pool, [{ type: 'contact_status_changed', value: 'x' }, { type: 'has_tag', tag: 'unsubscribed' }])
  );
  assert.deepEqual(rule, { type: 'has_tag', tag: 'unsubscribed' });
});

// 11. malformed rule ignored (missing tag / not an object / null)
test('malformed rules (missing tag, non-object, null) are ignored safely', async () => {
  const pool = makeFakePool({ contactTags: ['unsubscribed'] });
  const rule = await evaluateExitRules(
    baseArgs(pool, [null, 'not-an-object', { type: 'has_tag' }, { type: 'has_tag', tag: 'unsubscribed' }])
  );
  assert.deepEqual(rule, { type: 'has_tag', tag: 'unsubscribed' });
});

// DB error during evaluation propagates (caller — sequenceScheduler.js —
// is responsible for catching this and leaving the enrollment active; see
// the scheduler-level test file for that behavior).
test('a pool.query error propagates to the caller rather than being swallowed', async () => {
  const pool = { query: async () => { throw new Error('connection reset'); } };
  await assert.rejects(
    () => evaluateExitRules(baseArgs(pool, [{ type: 'has_tag', tag: 'x' }])),
    /connection reset/
  );
});

// workspace isolation for tag lookup — a different workspace_id must not
// see this contact's tags.
test('has_tag: workspace isolation — a contact in another workspace never matches', async () => {
  const pool = makeFakePool({ contactTags: ['unsubscribed'] });
  const args = baseArgs(pool, [{ type: 'has_tag', tag: 'unsubscribed' }]);
  args.workspaceId = 999; // different workspace than the fake pool's seeded contact
  const rule = await evaluateExitRules(args);
  assert.equal(rule, null);
});

// formatExitReason
test('formatExitReason: tag rules include the tag name; replied rule does not', () => {
  assert.equal(formatExitReason({ type: 'has_tag', tag: 'unsubscribed' }), 'has_tag:unsubscribed');
  assert.equal(formatExitReason({ type: 'not_has_tag', tag: 'vip' }), 'not_has_tag:vip');
  assert.equal(formatExitReason({ type: 'replied_since_enrollment' }), 'replied_since_enrollment');
});

test('EXIT_RULE_TYPES is exactly the three approved condition types', () => {
  assert.deepEqual([...EXIT_RULE_TYPES].sort(), ['has_tag', 'not_has_tag', 'replied_since_enrollment']);
});



