'use strict';

// Phase 7E — Exit Conditions: scheduler-level integration tests, exercising
// executeDueEnrollmentById() from src/services/sequenceScheduler.js
// directly.
//
// sequenceScheduler.js requires services/messageSender.js and
// queue/sendQueue.js at load time; the latter connects to Redis via
// BullMQ/ioredis at module scope. Same technique as
// test/sendQueueRetryConfig.test.js: both modules are stubbed out in
// require.cache BEFORE sequenceScheduler.js is required, so no real Redis
// connection is ever made and every send/account call is a spy we control.
//
// pool.query on the shared '../src/db' singleton is monkey-patched with a
// small in-memory dispatcher — same approach as test/sequences.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

function stubModule(name, exports) {
  const resolved = require.resolve(name);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// 'pg' itself is stubbed too — this sandbox has no node_modules/network
// access to install the real driver, and src/db.js's exported pool.query
// is fully overridden by installDb() below in every test anyway, so a real
// Pool is never actually needed for these tests to be meaningful.
class FakePgPool {
  on() { return this; }
  async query() { throw new Error('FakePgPool.query should never be called directly — installDb() overrides pool.query'); }
  async connect() { throw new Error('FakePgPool.connect should never be called directly'); }
}
stubModule('pg', { Pool: FakePgPool });

// ── stub messageSender + sendQueue so sequenceScheduler.js never touches
//    Redis/BullMQ or a real WhatsApp account resolver ─────────────────────
const sendCalls = [];
let resolveAccountResult = { account: { displayPhoneNumber: '911234567890', id: 1, isActive: true, accessToken: 'tok' } };

stubModule('../src/services/messageSender', {
  resolveAccount: async () => resolveAccountResult,
  insertPendingRow: async (args) => { sendCalls.push({ kind: 'insertPendingRow', args }); return 'local-fake-id'; },
});
stubModule('../src/queue/sendQueue', {
  enqueueSend: async (args) => { sendCalls.push({ kind: 'enqueueSend', args }); },
});

const pool = require('../src/db');
const { executeDueEnrollmentById } = require('../src/services/sequenceScheduler');

const WS = 7;
const CONTACT = '919876543210';

// ── fake DB ─────────────────────────────────────────────────────────────
function installDb({ sequences = [], sequence_steps = [], sequence_enrollments = [], contacts = [], chat_history = [] } = {}) {
  const state = {
    sequences: sequences.slice(),
    sequence_steps: sequence_steps.slice(),
    sequence_enrollments: sequence_enrollments.slice(),
    contacts: contacts.slice(),
    sequence_step_executions: [],
    chat_history: chat_history.slice(),
  };
  const calls = [];
  const original = pool.query;

  pool.query = async (sql, params = []) => {
    calls.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();

    if (/^SELECT \* FROM coexistence\.sequence_enrollments WHERE id = \$1$/.test(s)) {
      const row = state.sequence_enrollments.find((r) => String(r.id) === String(params[0]));
      return { rows: row ? [row] : [] };
    }
    if (/^SELECT exit_rules FROM coexistence\.sequences WHERE id = \$1$/.test(s)) {
      const row = state.sequences.find((r) => String(r.id) === String(params[0]));
      return { rows: row ? [{ exit_rules: row.exit_rules }] : [] };
    }
    if (/^UPDATE coexistence\.sequence_enrollments\s+SET status = 'exited'/.test(s)) {
      const [id, exitReason] = params;
      const row = state.sequence_enrollments.find((r) => String(r.id) === String(id));
      if (row) {
        row.status = 'exited';
        row.exited_at = new Date();
        row.exit_reason = exitReason;
        row.current_step_id = null;
        row.next_due_at = null;
      }
      return { rows: [] };
    }
    if (/^SELECT tags FROM coexistence\.contacts/.test(s)) {
      const [workspaceId, contactNumber] = params;
      const row = state.contacts.find((c) => c.workspace_id === workspaceId && c.contact_number === contactNumber);
      return { rows: row ? [{ tags: row.tags }] : [] };
    }
    if (/^SELECT 1 FROM coexistence\.chat_history/.test(s)) {
      const [waNumber, contactNumber, enrolledAt] = params;
      const match = state.chat_history.some(
        (m) => m.wa_number === waNumber && m.contact_number === contactNumber &&
               m.direction === 'incoming' && m.timestamp.getTime() > enrolledAt.getTime()
      );
      return { rows: match ? [{ '?column?': 1 }] : [] };
    }
    if (/^SELECT \* FROM coexistence\.sequence_steps WHERE id = \$1 AND sequence_id = \$2$/.test(s)) {
      const [id, sequenceId] = params;
      const row = state.sequence_steps.find((r) => String(r.id) === String(id) && String(r.sequence_id) === String(sequenceId));
      return { rows: row ? [row] : [] };
    }
    if (/^SELECT id FROM coexistence\.sequence_step_executions/.test(s)) {
      const [enrollmentId, stepId] = params;
      const rows = state.sequence_step_executions.filter(
        (e) => String(e.enrollment_id) === String(enrollmentId) && String(e.step_id) === String(stepId) && ['sent', 'skipped'].includes(e.status)
      );
      return { rows };
    }
    if (/^INSERT INTO coexistence\.sequence_step_executions/.test(s)) {
      const row = { id: state.sequence_step_executions.length + 1, enrollment_id: params[0], step_id: params[1], status: params[2] || 'skipped' };
      state.sequence_step_executions.push(row);
      return { rows: [row] };
    }
    if (/^UPDATE coexistence\.sequence_enrollments\s+SET status = 'completed'/.test(s)) {
      const row = state.sequence_enrollments.find((r) => String(r.id) === String(params[0]));
      if (row) { row.status = 'completed'; row.completed_at = new Date(); row.current_step_id = null; row.next_due_at = null; }
      return { rows: [] };
    }
    if (/^SELECT id, step_order, step_type, delay_value, delay_unit FROM coexistence\.sequence_steps WHERE sequence_id = \$1 AND step_order > \$2/.test(s)) {
      const [sequenceId, currentOrder] = params;
      const rows = state.sequence_steps
        .filter((r) => String(r.sequence_id) === String(sequenceId) && r.step_order > currentOrder)
        .sort((a, b) => a.step_order - b.step_order);
      return { rows: rows.slice(0, 1) };
    }
    if (/^UPDATE coexistence\.sequence_enrollments\s+SET current_step_id/.test(s)) {
      const row = state.sequence_enrollments.find((r) => String(r.id) === String(params[0]));
      if (row) { row.current_step_id = params[1]; row.next_due_at = params[2]; }
      return { rows: [] };
    }

    throw new Error(`Unexpected query in fake pool: ${s}`);
  };

  return {
    state,
    calls,
    restore() { pool.query = original; },
  };
}

function seedEnrollment(overrides = {}) {
  return {
    id: 1, workspace_id: WS, sequence_id: 1, contact_number: CONTACT,
    status: 'active', current_step_id: 20, next_due_at: new Date(),
    enrolled_at: new Date('2026-08-01T00:00:00Z'), completed_at: null, exited_at: null, exit_reason: null,
    ...overrides,
  };
}

function seedSequence(exitRules) {
  return { id: 1, workspace_id: WS, exit_rules: exitRules };
}

function seedDelayStep() {
  return { id: 20, sequence_id: 1, step_order: 1, step_type: 'delay', template_id: null, delay_value: 1, delay_unit: 'hours' };
}
function seedMessageStep() {
  return { id: 20, sequence_id: 1, step_order: 1, step_type: 'message', template_id: 55, variable_mapping: {} };
}

test.beforeEach(() => { sendCalls.length = 0; resolveAccountResult = { account: { displayPhoneNumber: '911234567890' } }; });

// 12. DB error during exit evaluation -> enrollment remains active
test('DB error while loading exit_rules leaves the enrollment active for the next tick', async () => {
  const db = installDb({ sequence_enrollments: [seedEnrollment()] }); // no matching sequence row -> exit_rules query returns [] rows -> fine actually
  // Force a genuine error instead: monkeypatch again to throw on the exit_rules query specifically.
  const original = pool.query;
  pool.query = async (sql, params) => {
    if (/exit_rules FROM coexistence\.sequences/.test(sql)) throw new Error('connection reset');
    return original(sql, params);
  };
  try {
    await executeDueEnrollmentById(1);
    const row = db.state.sequence_enrollments[0];
    assert.equal(row.status, 'active');
    assert.equal(row.exited_at, null);
  } finally { pool.query = original; db.restore(); }
});

// 13. exited enrollment never executes another step
test('an already-exited enrollment is never processed', async () => {
  const db = installDb({
    sequences: [seedSequence([{ type: 'has_tag', tag: 'unsubscribed' }])],
    sequence_steps: [seedDelayStep()],
    sequence_enrollments: [seedEnrollment({ status: 'exited' })],
  });
  try {
    await executeDueEnrollmentById(1);
    assert.equal(db.calls.length, 1); // only the initial enrollment SELECT
    assert.equal(db.state.sequence_step_executions.length, 0);
  } finally { db.restore(); }
});

// 14. paused enrollment never evaluates exit rules
test('a paused enrollment never evaluates exit rules', async () => {
  const db = installDb({
    sequences: [seedSequence([{ type: 'has_tag', tag: 'unsubscribed' }])],
    sequence_steps: [seedDelayStep()],
    sequence_enrollments: [seedEnrollment({ status: 'paused' })],
    contacts: [{ workspace_id: WS, contact_number: CONTACT, tags: ['unsubscribed'] }],
  });
  try {
    await executeDueEnrollmentById(1);
    assert.ok(!db.calls.some((c) => /sequences WHERE id/.test(c.sql)));
    assert.equal(db.state.sequence_enrollments[0].status, 'paused');
  } finally { db.restore(); }
});

// 17 / 18. exit happens before a message send; no execution row created
test('has_tag match on a message step exits before any send, no execution row written', async () => {
  const db = installDb({
    sequences: [seedSequence([{ type: 'has_tag', tag: 'unsubscribed' }])],
    sequence_steps: [seedMessageStep()],
    sequence_enrollments: [seedEnrollment()],
    contacts: [{ workspace_id: WS, contact_number: CONTACT, tags: ['unsubscribed'] }],
  });
  try {
    await executeDueEnrollmentById(1);
    const row = db.state.sequence_enrollments[0];
    assert.equal(row.status, 'exited');
    assert.equal(sendCalls.length, 0); // never reached insertPendingRow/enqueueSend
    assert.equal(db.state.sequence_step_executions.length, 0);
  } finally { db.restore(); }
});

// 19. exit_reason is persisted correctly
test('exit_reason is persisted in the "type:tag" format for tag rules', async () => {
  const db = installDb({
    sequences: [seedSequence([{ type: 'not_has_tag', tag: 'vip' }])],
    sequence_steps: [seedDelayStep()],
    sequence_enrollments: [seedEnrollment()],
    contacts: [{ workspace_id: WS, contact_number: CONTACT, tags: [] }],
  });
  try {
    await executeDueEnrollmentById(1);
    assert.equal(db.state.sequence_enrollments[0].exit_reason, 'not_has_tag:vip');
  } finally { db.restore(); }
});

test('exit_reason for replied_since_enrollment has no tag suffix', async () => {
  const db = installDb({
    sequences: [seedSequence([{ type: 'replied_since_enrollment' }])],
    sequence_steps: [seedDelayStep()],
    sequence_enrollments: [seedEnrollment()],
    chat_history: [{ wa_number: '911234567890', contact_number: CONTACT, direction: 'incoming', timestamp: new Date('2026-08-02T00:00:00Z') }],
  });
  try {
    await executeDueEnrollmentById(1);
    assert.equal(db.state.sequence_enrollments[0].exit_reason, 'replied_since_enrollment');
  } finally { db.restore(); }
});

// 20. duplicate scheduler execution cannot double-exit
test('calling executeDueEnrollmentById twice for the same enrollment only exits it once', async () => {
  const db = installDb({
    sequences: [seedSequence([{ type: 'has_tag', tag: 'unsubscribed' }])],
    sequence_steps: [seedDelayStep()],
    sequence_enrollments: [seedEnrollment()],
    contacts: [{ workspace_id: WS, contact_number: CONTACT, tags: ['unsubscribed'] }],
  });
  try {
    await executeDueEnrollmentById(1);
    const exitedAtFirst = db.state.sequence_enrollments[0].exited_at;
    const callsAfterFirst = db.calls.length;

    await executeDueEnrollmentById(1); // second, "duplicate" tick
    assert.equal(db.state.sequence_enrollments[0].status, 'exited');
    assert.equal(db.state.sequence_enrollments[0].exited_at, exitedAtFirst); // untouched second time
    // Second call only re-reads the enrollment (status !== 'active') and returns.
    assert.equal(db.calls.length, callsAfterFirst + 1);
  } finally { db.restore(); }
});

// No exit rules -> unchanged behavior (normal advance to next step/no-op)
test('empty exit_rules on the sequence -> normal execution proceeds unaffected', async () => {
  const db = installDb({
    sequences: [seedSequence([])],
    sequence_steps: [seedDelayStep()],
    sequence_enrollments: [seedEnrollment()],
  });
  try {
    await executeDueEnrollmentById(1);
    const row = db.state.sequence_enrollments[0];
    assert.notEqual(row.status, 'exited');
  } finally { db.restore(); }
});

// Unknown rule type on a real sequence -> ignored, no crash, enrollment proceeds
test('a sequence with only an unknown exit rule type proceeds normally (rule ignored)', async () => {
  const db = installDb({
    sequences: [seedSequence([{ type: 'contact_status_changed', value: 'blocked' }])],
    sequence_steps: [seedDelayStep()],
    sequence_enrollments: [seedEnrollment()],
  });
  try {
    await executeDueEnrollmentById(1);
    const row = db.state.sequence_enrollments[0];
    assert.notEqual(row.status, 'exited');
  } finally { db.restore(); }
});

// Workspace isolation, at the scheduler level: a tag on a contact in
// another workspace never causes this enrollment to exit.
test('workspace isolation: a same-numbered contact tagged in a different workspace does not trigger exit', async () => {
  const db = installDb({
    sequences: [seedSequence([{ type: 'has_tag', tag: 'unsubscribed' }])],
    sequence_steps: [seedDelayStep()],
    sequence_enrollments: [seedEnrollment({ workspace_id: WS })],
    contacts: [{ workspace_id: 999, contact_number: CONTACT, tags: ['unsubscribed'] }],
  });
  try {
    await executeDueEnrollmentById(1);
    assert.notEqual(db.state.sequence_enrollments[0].status, 'exited');
  } finally { db.restore(); }
});

// Workspace isolation for the reply lookup: a reply recorded under a
// different WhatsApp number (i.e. a different workspace's account) never
// triggers this enrollment's exit.
test('workspace isolation: an incoming message under a different wa_number does not trigger exit', async () => {
  const db = installDb({
    sequences: [seedSequence([{ type: 'replied_since_enrollment' }])],
    sequence_steps: [seedDelayStep()],
    sequence_enrollments: [seedEnrollment()],
    chat_history: [{ wa_number: '900000000000', contact_number: CONTACT, direction: 'incoming', timestamp: new Date('2026-08-02T00:00:00Z') }],
  });
  try {
    await executeDueEnrollmentById(1);
    assert.notEqual(db.state.sequence_enrollments[0].status, 'exited');
  } finally { db.restore(); }
});
