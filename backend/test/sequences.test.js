'use strict';

// Phase 7 Part B — Sequence CRUD + Manual Enrollment tests.
//
// Same no-real-Postgres approach as test/campaignSelectionPersistence.test.js
// and test/planChangeRequests.test.js: pool.query / pool.connect are
// monkey-patched on the shared '../src/db' singleton with a small in-memory
// table store, and routes are invoked directly against the router's
// internal stack (no supertest/http) — same callRoute() harness as
// test/planChangeRequests.test.js / test/usersSeatLimit.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/db');
const { router, validateSequenceInput, validateStepInput } = require('../src/routes/sequences');

// ─── In-memory fake DB ─────────────────────────────────────────────────
// Tables are plain arrays of plain objects. Enough SQL "understanding" to
// dispatch each exact query shape this router/repository issues — not a
// general SQL engine.

function makeDb(seed = {}) {
  const state = {
    sequences: seed.sequences ? seed.sequences.slice() : [],
    sequence_steps: seed.sequence_steps ? seed.sequence_steps.slice() : [],
    sequence_enrollments: seed.sequence_enrollments ? seed.sequence_enrollments.slice() : [],
    sequence_step_executions: seed.sequence_step_executions ? seed.sequence_step_executions.slice() : [],
    contacts: seed.contacts ? seed.contacts.slice() : [],
    message_templates: seed.message_templates ? seed.message_templates.slice() : [],
    akchat_users: seed.akchat_users ? seed.akchat_users.slice() : [],
  };
  let nextSeqId = 1;
  let nextStepId = 1;
  let nextEnrollmentId = 1;
  for (const s of state.sequences) nextSeqId = Math.max(nextSeqId, s.id + 1);
  for (const s of state.sequence_steps) nextStepId = Math.max(nextStepId, s.id + 1);

  const calls = [];

  async function dispatch(sql, params = []) {
    calls.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();

    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(s)) return { rows: [] };

    // ── sequences ──────────────────────────────────────────────────────
    if (/FROM coexistence\.sequences WHERE id = \$1 AND workspace_id = \$2/.test(s) && s.startsWith('SELECT')) {
      const [id, workspaceId] = params;
      const row = state.sequences.find((r) => String(r.id) === String(id) && r.workspace_id === workspaceId);
      return { rows: row ? [row] : [] };
    }
    if (/^SELECT .* FROM coexistence\.sequences WHERE workspace_id = \$1/.test(s) && /ORDER BY updated_at DESC/.test(s)) {
      const workspaceId = params[0];
      const rows = state.sequences.filter((r) => r.workspace_id === workspaceId);
      return { rows };
    }
    if (/^SELECT COUNT\(\*\)::int AS total FROM coexistence\.sequences WHERE workspace_id = \$1/.test(s)) {
      const workspaceId = params[0];
      const total = state.sequences.filter((r) => r.workspace_id === workspaceId).length;
      return { rows: [{ total }] };
    }
    if (/^INSERT INTO coexistence\.sequences/.test(s)) {
      const [workspaceId, name, description, entryConfig, exitRules, createdBy] = params;
      const row = {
        id: nextSeqId++, workspace_id: workspaceId, name, description,
        status: 'draft', entry_config: JSON.parse(entryConfig), exit_rules: JSON.parse(exitRules),
        created_by: createdBy, created_at: new Date(), updated_at: new Date(),
      };
      state.sequences.push(row);
      return { rows: [row] };
    }
    if (/^UPDATE coexistence\.sequences SET\s+name = \$3/.test(s)) {
      const [id, workspaceId, name, description, entryConfig, exitRules] = params;
      const row = state.sequences.find((r) => String(r.id) === String(id) && r.workspace_id === workspaceId);
      if (!row) return { rows: [] };
      row.name = name; row.description = description;
      row.entry_config = JSON.parse(entryConfig); row.exit_rules = JSON.parse(exitRules);
      return { rows: [row] };
    }
    if (/^UPDATE coexistence\.sequences SET status = \$3/.test(s)) {
      const [id, workspaceId, status] = params;
      const row = state.sequences.find((r) => String(r.id) === String(id) && r.workspace_id === workspaceId);
      if (!row) return { rows: [] };
      row.status = status;
      return { rows: [row] };
    }

    // ── sequence_steps ─────────────────────────────────────────────────
    if (/^SELECT .* FROM coexistence\.sequence_steps WHERE sequence_id = \$1 ORDER BY step_order ASC( LIMIT 1)?$/.test(s)) {
      let rows = state.sequence_steps.filter((r) => String(r.sequence_id) === String(params[0]))
        .sort((a, b) => a.step_order - b.step_order);
      if (/LIMIT 1$/.test(s)) rows = rows.slice(0, 1);
      return { rows };
    }
    if (/^SELECT id FROM coexistence\.sequence_steps WHERE sequence_id = \$1 ORDER BY step_order ASC$/.test(s)) {
      const rows = state.sequence_steps.filter((r) => String(r.sequence_id) === String(params[0]))
        .sort((a, b) => a.step_order - b.step_order).map((r) => ({ id: r.id }));
      return { rows };
    }
    if (/FROM coexistence\.sequence_steps WHERE id = \$1 AND sequence_id = \$2/.test(s) && s.startsWith('SELECT')) {
      const [id, sequenceId] = params;
      const row = state.sequence_steps.find((r) => String(r.id) === String(id) && String(r.sequence_id) === String(sequenceId));
      return { rows: row ? [row] : [] };
    }
    if (/^SELECT COALESCE\(MAX\(step_order\), 0\)::int AS max_order FROM coexistence\.sequence_steps WHERE sequence_id = \$1/.test(s)) {
      const rows = state.sequence_steps.filter((r) => String(r.sequence_id) === String(params[0]));
      const max = rows.reduce((m, r) => Math.max(m, r.step_order), 0);
      return { rows: [{ max_order: max }] };
    }
    if (/^INSERT INTO coexistence\.sequence_steps/.test(s) && /RETURNING id$/.test(s)) {
      const [sequenceId, stepOrder, stepType, templateId, variableMapping, delayValue, delayUnit] = params;
      const row = {
        id: nextStepId++, sequence_id: sequenceId, step_order: stepOrder, step_type: stepType,
        template_id: templateId, variable_mapping: JSON.parse(variableMapping),
        delay_value: delayValue, delay_unit: delayUnit,
        created_at: new Date(), updated_at: new Date(),
      };
      state.sequence_steps.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (/^UPDATE coexistence\.sequence_steps SET\s+step_order = \$3, step_type = \$4/.test(s)) {
      const [stepId, sequenceId, stepOrder, stepType, templateId, variableMapping, delayValue, delayUnit] = params;
      const row = state.sequence_steps.find((r) => String(r.id) === String(stepId) && String(r.sequence_id) === String(sequenceId));
      if (!row) return { rows: [] };
      Object.assign(row, {
        step_order: stepOrder, step_type: stepType, template_id: templateId,
        variable_mapping: JSON.parse(variableMapping), delay_value: delayValue, delay_unit: delayUnit,
      });
      return { rows: [row] };
    }
    if (/^UPDATE coexistence\.sequence_steps SET step_order = \$3 WHERE id = \$1 AND sequence_id = \$2$/.test(s)) {
      const [stepId, sequenceId, stepOrder] = params;
      const row = state.sequence_steps.find((r) => String(r.id) === String(stepId) && String(r.sequence_id) === String(sequenceId));
      if (row) row.step_order = stepOrder;
      return { rows: row ? [row] : [] };
    }
    if (/^DELETE FROM coexistence\.sequence_steps WHERE id = \$1 AND sequence_id = \$2$/.test(s)) {
      const [stepId, sequenceId] = params;
      const before = state.sequence_steps.length;
      state.sequence_steps = state.sequence_steps.filter((r) => !(String(r.id) === String(stepId) && String(r.sequence_id) === String(sequenceId)));
      return { rowCount: before - state.sequence_steps.length, rows: [] };
    }

    // ── sequence_enrollments ────────────────────────────────────────────
    if (/^SELECT .* FROM coexistence\.sequence_enrollments\s+WHERE workspace_id = \$1 AND sequence_id = \$2\s+ORDER BY enrolled_at DESC/.test(s)) {
      const [workspaceId, sequenceId] = params;
      const rows = state.sequence_enrollments.filter((r) => r.workspace_id === workspaceId && String(r.sequence_id) === String(sequenceId));
      return { rows };
    }
    if (/^SELECT COUNT\(\*\)::int AS total FROM coexistence\.sequence_enrollments\s+WHERE workspace_id = \$1 AND sequence_id = \$2$/.test(s)) {
      const [workspaceId, sequenceId] = params;
      const total = state.sequence_enrollments.filter((r) => r.workspace_id === workspaceId && String(r.sequence_id) === String(sequenceId)).length;
      return { rows: [{ total }] };
    }
    if (/^SELECT .* FROM coexistence\.sequence_enrollments\s+WHERE id = \$1 AND workspace_id = \$2 AND sequence_id = \$3$/.test(s)) {
      const [id, workspaceId, sequenceId] = params;
      const row = state.sequence_enrollments.find((r) => String(r.id) === String(id) && r.workspace_id === workspaceId && String(r.sequence_id) === String(sequenceId));
      return { rows: row ? [row] : [] };
    }
    if (/^SELECT .* FROM coexistence\.sequence_enrollments\s+WHERE workspace_id = \$1 AND sequence_id = \$2 AND contact_number = \$3 AND status = 'active'$/.test(s)) {
      const [workspaceId, sequenceId, contactNumber] = params;
      const row = state.sequence_enrollments.find((r) => r.workspace_id === workspaceId && String(r.sequence_id) === String(sequenceId) && r.contact_number === contactNumber && r.status === 'active');
      return { rows: row ? [row] : [] };
    }
    if (/^SELECT status, COUNT\(\*\)::int AS count\s+FROM coexistence\.sequence_enrollments\s+WHERE workspace_id = \$1 AND sequence_id = \$2\s+GROUP BY status$/.test(s)) {
      const [workspaceId, sequenceId] = params;
      const rows = state.sequence_enrollments.filter((r) => r.workspace_id === workspaceId && String(r.sequence_id) === String(sequenceId));
      const grouped = {};
      for (const r of rows) grouped[r.status] = (grouped[r.status] || 0) + 1;
      return { rows: Object.entries(grouped).map(([status, count]) => ({ status, count })) };
    }
    if (/^INSERT INTO coexistence\.sequence_enrollments/.test(s)) {
      const [workspaceId, sequenceId, contactNumber, currentStepId, nextDueAt] = params;
      const dup = state.sequence_enrollments.find((r) => r.workspace_id === workspaceId && String(r.sequence_id) === String(sequenceId) && r.contact_number === contactNumber && r.status === 'active');
      if (dup) {
        const err = new Error('duplicate key value violates unique constraint "uq_sequence_enrollments_active_contact"');
        err.code = '23505';
        throw err;
      }
      const row = {
        id: nextEnrollmentId++, workspace_id: workspaceId, sequence_id: sequenceId, contact_number: contactNumber,
        status: 'active', current_step_id: currentStepId, next_due_at: nextDueAt,
        enrolled_at: new Date(), completed_at: null, exited_at: null, exit_reason: null,
        created_at: new Date(), updated_at: new Date(),
      };
      state.sequence_enrollments.push(row);
      return { rows: [row] };
    }
    if (/^UPDATE coexistence\.sequence_enrollments\s+SET status = 'paused'/.test(s)) {
      const [id, workspaceId, sequenceId] = params;
      const row = state.sequence_enrollments.find((r) => String(r.id) === String(id) && r.workspace_id === workspaceId && String(r.sequence_id) === String(sequenceId) && r.status === 'active');
      if (!row) return { rows: [] };
      row.status = 'paused';
      return { rows: [row] };
    }
    // ── sequence_step_executions (Phase 7F Part 2 — read-only) ───────────
    if (/^SELECT .* FROM coexistence\.sequence_step_executions\s+WHERE enrollment_id = \$1\s+ORDER BY created_at ASC$/.test(s)) {
      const [enrollmentId] = params;
      const rows = (state.sequence_step_executions || []).filter((r) => String(r.enrollment_id) === String(enrollmentId));
      return { rows };
    }
    if (/^UPDATE coexistence\.sequence_enrollments\s+SET status = 'active',/.test(s)) {
      const [id, workspaceId, sequenceId] = params;
      const row = state.sequence_enrollments.find((r) => String(r.id) === String(id) && r.workspace_id === workspaceId && String(r.sequence_id) === String(sequenceId) && r.status === 'paused');
      if (!row) return { rows: [] };
      row.status = 'active';
      if (row.next_due_at === null || row.next_due_at === undefined || row.next_due_at.getTime() <= Date.now()) {
        row.next_due_at = new Date();
      }
      return { rows: [row] };
    }

    // ── contacts / message_templates ────────────────────────────────────
    if (/^SELECT id FROM coexistence\.contacts WHERE contact_number = \$1 AND workspace_id = \$2/.test(s)) {
      const [contactNumber, workspaceId] = params;
      const row = state.contacts.find((r) => r.contact_number === contactNumber && r.workspace_id === workspaceId);
      return { rows: row ? [row] : [] };
    }
    if (/^SELECT id, status FROM coexistence\.message_templates WHERE id = \$1 AND workspace_id = \$2$/.test(s)) {
      const [id, workspaceId] = params;
      const row = state.message_templates.find((r) => String(r.id) === String(id) && r.workspace_id === workspaceId);
      return { rows: row ? [row] : [] };
    }

    // ── akchat_users (requirePermission's non-admin lookup path) ──────────
    if (/^SELECT role, permissions FROM coexistence\.akchat_users WHERE id = \$1/.test(s)) {
      const [id] = params;
      const row = state.akchat_users.find((r) => String(r.id) === String(id));
      return { rows: row ? [row] : [] };
    }

    // ── entitlements / feature gate ──────────────────────────────────────
    // Phase 8F-6 added requireFeature(SEQUENCE_STUDIO) in front of every
    // route in this file (fail-closed: no BUILTIN_PLANS entry grants this
    // feature yet, by design — see entitlementService.js). These Phase 7
    // CRUD/enrollment tests exercise the routes' own behavior, not the
    // entitlement gate itself (that gate has its own coverage in
    // test/campaignFeatureGate.test.js), so every workspace here is seeded
    // with a plan that has sequence_studio explicitly enabled.
    if (/FROM coexistence\.workspace_billing wb/.test(s) && /JOIN coexistence\.plans p/.test(s)) {
      return {
        rows: [{
          status: 'active',
          plan_id: 1,
          plan_key: 'test_plan',
          plan_name: 'Test Plan',
          limits: { features: { sequence_studio: true } },
          current_period_end: null,
          cancel_at_period_end: false,
        }],
      };
    }

    throw new Error(`sequences.test.js fake DB: unhandled query: ${s}`);
  }

  return {    state,
    calls,
    query: dispatch,
    connect: async () => ({ query: dispatch, release() {} }),
  };
}

function installDb(seed) {
  const mock = makeDb(seed);
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  pool.query = mock.query;
  pool.connect = mock.connect;
  return { state: mock.state, calls: mock.calls, restore() { pool.query = originalQuery; pool.connect = originalConnect; } };
}

// ─── minimal Express route-chain runner (same as test/planChangeRequests.test.js) ──
function callRoute(routerToUse, method, path, req) {
  const layer = routerToUse.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      body: undefined,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; resolve(this); return this; },
    };
    let idx = 0;
    function next(err) {
      if (err) return reject(err);
      idx += 1;
      if (idx >= stack.length) return;
      Promise.resolve(stack[idx].handle(req, res, next)).catch(reject);
    }
    Promise.resolve(stack[0].handle(req, res, next)).catch(reject);
  });
}

function makeReq({ params = {}, body = {}, query = {}, workspaceId = 7, userRole = 'OWNER', userId = 1 } = {}) {
  return {
    user: { id: userId, username: 'kavin', role: userRole },
    workspace: { id: workspaceId, role: userRole },
    params, body, query,
  };
}

const WS = 7;

// ─── validateSequenceInput / validateStepInput (pure) ─────────────────────

test('validateSequenceInput: rejects missing name', () => {
  assert.match(validateSequenceInput({}), /name is required/);
});
test('validateSequenceInput: rejects an overlong name', () => {
  assert.match(validateSequenceInput({ name: 'x'.repeat(300) }), /cannot exceed/);
});
test('validateSequenceInput: rejects non-object entryConfig / non-array exitRules', () => {
  assert.match(validateSequenceInput({ name: 'A', entryConfig: 'nope' }), /entryConfig must be a JSON object/);
  assert.match(validateSequenceInput({ name: 'A', exitRules: 'nope' }), /exitRules must be a JSON array/);
});
test('validateSequenceInput: accepts a normal payload', () => {
  assert.equal(validateSequenceInput({ name: 'Welcome flow', entryConfig: {}, exitRules: [] }), null);
});

test('validateStepInput: rejects unknown stepType', () => {
  assert.match(validateStepInput({ stepType: 'send_email' }), /stepType must be one of/);
});
test('validateStepInput: message step requires templateId', () => {
  assert.match(validateStepInput({ stepType: 'message' }), /templateId is required/);
});
test('validateStepInput: delay step rejects zero/negative/non-integer', () => {
  assert.match(validateStepInput({ stepType: 'delay', delayValue: 0, delayUnit: 'hours' }), /positive whole number/);
  assert.match(validateStepInput({ stepType: 'delay', delayValue: -5, delayUnit: 'hours' }), /positive whole number/);
  assert.match(validateStepInput({ stepType: 'delay', delayValue: 1.5, delayUnit: 'hours' }), /positive whole number/);
});
test('validateStepInput: delay step rejects invalid unit', () => {
  assert.match(validateStepInput({ stepType: 'delay', delayValue: 5, delayUnit: 'fortnights' }), /delayUnit must be one of/);
});
test('validateStepInput: accepts valid message/delay steps', () => {
  assert.equal(validateStepInput({ stepType: 'message', templateId: 1 }), null);
  assert.equal(validateStepInput({ stepType: 'delay', delayValue: 3, delayUnit: 'days' }), null);
});

// ─── 1. create sequence ─────────────────────────────────────────────────

test('POST /sequences: creates a draft sequence', async () => {
  const db = installDb({});
  try {
    const res = await callRoute(router, 'post', '/sequences', makeReq({ body: { name: 'Onboarding' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'draft');
    assert.equal(res.body.name, 'Onboarding');
  } finally { db.restore(); }
});

test('POST /sequences: rejects missing name', async () => {
  const db = installDb({});
  try {
    const res = await callRoute(router, 'post', '/sequences', makeReq({ body: {} }));
    assert.equal(res.statusCode, 400);
  } finally { db.restore(); }
});

// ─── 2. workspace isolation ─────────────────────────────────────────────

test('GET /sequences/:id: a sequence in another workspace is a 404', async () => {
  const db = installDb({ sequences: [{ id: 1, workspace_id: 99, name: 'Other WS', description: null, status: 'draft', entry_config: {}, exit_rules: [], created_by: 1, created_at: new Date(), updated_at: new Date() }] });
  try {
    const res = await callRoute(router, 'get', '/sequences/:id', makeReq({ params: { id: '1' }, workspaceId: WS }));
    assert.equal(res.statusCode, 404);
  } finally { db.restore(); }
});

// ─── 3. list sequences ──────────────────────────────────────────────────

test('GET /sequences: lists only this workspace\'s sequences', async () => {
  const db = installDb({
    sequences: [
      { id: 1, workspace_id: WS, name: 'A', description: null, status: 'draft', entry_config: {}, exit_rules: [], created_by: 1, created_at: new Date(), updated_at: new Date() },
      { id: 2, workspace_id: 99, name: 'B', description: null, status: 'draft', entry_config: {}, exit_rules: [], created_by: 1, created_at: new Date(), updated_at: new Date() },
    ],
  });
  try {
    const res = await callRoute(router, 'get', '/sequences', makeReq({ workspaceId: WS }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.rows.length, 1);
    assert.equal(res.body.rows[0].id, 1);
  } finally { db.restore(); }
});

// ─── 4. get sequence with ordered steps ─────────────────────────────────

test('GET /sequences/:id: returns steps ordered by step_order ASC', async () => {
  const db = installDb({
    sequences: [{ id: 1, workspace_id: WS, name: 'A', description: null, status: 'draft', entry_config: {}, exit_rules: [], created_by: 1, created_at: new Date(), updated_at: new Date() }],
    sequence_steps: [
      { id: 10, sequence_id: 1, step_order: 2, step_type: 'delay', template_id: null, variable_mapping: {}, delay_value: 1, delay_unit: 'days', created_at: new Date(), updated_at: new Date() },
      { id: 11, sequence_id: 1, step_order: 1, step_type: 'delay', template_id: null, variable_mapping: {}, delay_value: 2, delay_unit: 'hours', created_at: new Date(), updated_at: new Date() },
    ],
  });
  try {
    const res = await callRoute(router, 'get', '/sequences/:id', makeReq({ params: { id: '1' }, workspaceId: WS }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.steps.map((s) => s.id), [11, 10]);
    assert.deepEqual(res.body.steps.map((s) => s.step_order), [1, 2]);
  } finally { db.restore(); }
});

// ─── 5. update draft sequence / 6. invalid sequence update ─────────────

test('PUT /sequences/:id: updates a draft sequence', async () => {
  const db = installDb({
    sequences: [{ id: 1, workspace_id: WS, name: 'A', description: null, status: 'draft', entry_config: {}, exit_rules: [], created_by: 1, created_at: new Date(), updated_at: new Date() }],
  });
  try {
    const res = await callRoute(router, 'put', '/sequences/:id', makeReq({ params: { id: '1' }, workspaceId: WS, body: { name: 'Renamed' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.name, 'Renamed');
  } finally { db.restore(); }
});

test('PUT /sequences/:id: rejects editing an active sequence', async () => {
  const db = installDb({
    sequences: [{ id: 1, workspace_id: WS, name: 'A', description: null, status: 'active', entry_config: {}, exit_rules: [], created_by: 1, created_at: new Date(), updated_at: new Date() }],
  });
  try {
    const res = await callRoute(router, 'put', '/sequences/:id', makeReq({ params: { id: '1' }, workspaceId: WS, body: { name: 'Renamed' } }));
    assert.equal(res.statusCode, 409);
  } finally { db.restore(); }
});

// ─── 7. add message step / 8. reject invalid template / 9. reject cross-workspace template ──

test('POST /sequences/:id/steps: adds a message step with a valid template', async () => {
  const db = installDb({
    sequences: [{ id: 1, workspace_id: WS, name: 'A', description: null, status: 'draft', entry_config: {}, exit_rules: [], created_by: 1, created_at: new Date(), updated_at: new Date() }],
    message_templates: [{ id: 55, workspace_id: WS, status: 'APPROVED' }],
  });
  try {
    const res = await callRoute(router, 'post', '/sequences/:id/steps', makeReq({ params: { id: '1' }, workspaceId: WS, body: { stepType: 'message', templateId: 55 } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.step_type, 'message');
    assert.equal(res.body.template_id, 55);
    assert.equal(res.body.step_order, 1);
  } finally { db.restore(); }
});

test('POST /sequences/:id/steps: rejects a non-APPROVED template', async () => {
  const db = installDb({
    sequences: [{ id: 1, workspace_id: WS, name: 'A', description: null, status: 'draft', entry_config: {}, exit_rules: [], created_by: 1, created_at: new Date(), updated_at: new Date() }],
    message_templates: [{ id: 55, workspace_id: WS, status: 'SUBMITTED' }],
  });
  try {
    const res = await callRoute(router, 'post', '/sequences/:id/steps', makeReq({ params: { id: '1' }, workspaceId: WS, body: { stepType: 'message', templateId: 55 } }));
    assert.equal(res.statusCode, 403);
  } finally { db.restore(); }
});

test('POST /sequences/:id/steps: rejects a template from another workspace', async () => {
  const db = installDb({
    sequences: [{ id: 1, workspace_id: WS, name: 'A', description: null, status: 'draft', entry_config: {}, exit_rules: [], created_by: 1, created_at: new Date(), updated_at: new Date() }],
    message_templates: [{ id: 55, workspace_id: 99, status: 'APPROVED' }],
  });
  try {
    const res = await callRoute(router, 'post', '/sequences/:id/steps', makeReq({ params: { id: '1' }, workspaceId: WS, body: { stepType: 'message', templateId: 55 } }));
    assert.equal(res.statusCode, 403);
  } finally { db.restore(); }
});

// ─── 10. add delay step / 11. reject invalid delay ─────────────────────

test('POST /sequences/:id/steps: adds a delay step', async () => {
  const db = installDb({
    sequences: [{ id: 1, workspace_id: WS, name: 'A', description: null, status: 'draft', entry_config: {}, exit_rules: [], created_by: 1, created_at: new Date(), updated_at: new Date() }],
  });
  try {
    const res = await callRoute(router, 'post', '/sequences/:id/steps', makeReq({ params: { id: '1' }, workspaceId: WS, body: { stepType: 'delay', delayValue: 2, delayUnit: 'days' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.step_type, 'delay');
    assert.equal(res.body.delay_value, 2);
    assert.equal(res.body.delay_unit, 'days');
  } finally { db.restore(); }
});

test('POST /sequences/:id/steps: rejects an invalid delay', async () => {
  const db = installDb({
    sequences: [{ id: 1, workspace_id: WS, name: 'A', description: null, status: 'draft', entry_config: {}, exit_rules: [], created_by: 1, created_at: new Date(), updated_at: new Date() }],
  });
  try {
    const res = await callRoute(router, 'post', '/sequences/:id/steps', makeReq({ params: { id: '1' }, workspaceId: WS, body: { stepType: 'delay', delayValue: -1, delayUnit: 'days' } }));
    assert.equal(res.statusCode, 400);
  } finally { db.restore(); }
});

// ─── 12. update step / 13. delete step / 14. ordering remains valid ───

test('PUT + DELETE step: ordering stays contiguous and unique after edits', async () => {
  const db = installDb({
    sequences: [{ id: 1, workspace_id: WS, name: 'A', description: null, status: 'draft', entry_config: {}, exit_rules: [], created_by: 1, created_at: new Date(), updated_at: new Date() }],
  });
  try {
    const r1 = await callRoute(router, 'post', '/sequences/:id/steps', makeReq({ params: { id: '1' }, workspaceId: WS, body: { stepType: 'delay', delayValue: 1, delayUnit: 'hours' } }));
    const r2 = await callRoute(router, 'post', '/sequences/:id/steps', makeReq({ params: { id: '1' }, workspaceId: WS, body: { stepType: 'delay', delayValue: 2, delayUnit: 'hours' } }));
    const r3 = await callRoute(router, 'post', '/sequences/:id/steps', makeReq({ params: { id: '1' }, workspaceId: WS, body: { stepType: 'delay', delayValue: 3, delayUnit: 'hours' } }));
    assert.deepEqual([r1.body.step_order, r2.body.step_order, r3.body.step_order], [1, 2, 3]);

    // update the middle step's delay value (no reposition)
    const upd = await callRoute(router, 'put', '/sequences/:id/steps/:stepId', makeReq({ params: { id: '1', stepId: String(r2.body.id) }, workspaceId: WS, body: { delayValue: 9 } }));
    assert.equal(upd.statusCode, 200);
    assert.equal(upd.body.delay_value, 9);
    assert.equal(upd.body.step_order, 2); // unchanged

    // delete the first step — remaining two must renumber to 1,2 with no gap/dup
    const del = await callRoute(router, 'delete', '/sequences/:id/steps/:stepId', makeReq({ params: { id: '1', stepId: String(r1.body.id) }, workspaceId: WS }));
    assert.equal(del.statusCode, 200);

    const detail = await callRoute(router, 'get', '/sequences/:id', makeReq({ params: { id: '1' }, workspaceId: WS }));
    const orders = detail.body.steps.map((s) => s.step_order);
    assert.deepEqual(orders, [1, 2]);
    assert.equal(new Set(orders).size, orders.length); // no duplicates
  } finally { db.restore(); }
});

// ─── 15. manual enrollment / 22. no WhatsApp message sent ─────────────
// Phase 7D note: this test previously asserted next_due_at === null (the
// 7B behavior). That was the exact gap Phase 7D closes — see
// routes/sequences.js's enroll handler doc comment — so this test now
// asserts the activated value instead. It is updated deliberately, not
// blindly: the request explicitly calls out determining and fixing this.

test('POST /sequences/:id/enroll: a delay-first sequence activates with next_due_at = now + the delay', async () => {
  const db = installDb({
    sequences: [{ id: 1, workspace_id: WS, name: 'A', description: null, status: 'draft', entry_config: {}, exit_rules: [], created_by: 1, created_at: new Date(), updated_at: new Date() }],
    sequence_steps: [{ id: 10, sequence_id: 1, step_order: 1, step_type: 'delay', template_id: null, variable_mapping: {}, delay_value: 1, delay_unit: 'days', created_at: new Date(), updated_at: new Date() }],
    contacts: [{ id: 500, workspace_id: WS, contact_number: '919876543210' }],
  });
  try {
    const before = Date.now();
    const res = await callRoute(router, 'post', '/sequences/:id/enroll', makeReq({ params: { id: '1' }, workspaceId: WS, body: { contactNumber: '919876543210' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'active');
    assert.equal(res.body.current_step_id, 10);
    assert.ok(res.body.next_due_at instanceof Date);
    const deltaMs = res.body.next_due_at.getTime() - before;
    // ~1 day out (allow generous slack for test execution time).
    const oneDayMs = 24 * 60 * 60 * 1000;
    assert.ok(deltaMs > oneDayMs - 5000 && deltaMs < oneDayMs + 60000, `expected ~1 day, got ${deltaMs}ms`);
    // No WhatsApp send call of any kind was ever issued by this route —
    // the only queries made touch sequences/contacts/enrollments tables.
    assert.ok(!db.calls.some((c) => /broadcast_logs|whatsapp|chat_history/i.test(c.sql)));
  } finally { db.restore(); }
});

// ─── Phase 7D — activation tests ───────────────────────────────────────

test('POST /sequences/:id/enroll: a message-first sequence activates with next_due_at = now (immediate)', async () => {
  const db = installDb({
    sequences: [{ id: 1, workspace_id: WS, name: 'A', description: null, status: 'draft', entry_config: {}, exit_rules: [], created_by: 1, created_at: new Date(), updated_at: new Date() }],
    sequence_steps: [{ id: 20, sequence_id: 1, step_order: 1, step_type: 'message', template_id: 55, variable_mapping: {}, delay_value: null, delay_unit: null, created_at: new Date(), updated_at: new Date() }],
    contacts: [{ id: 500, workspace_id: WS, contact_number: '919876543210' }],
  });
  try {
    const before = Date.now();
    const res = await callRoute(router, 'post', '/sequences/:id/enroll', makeReq({ params: { id: '1' }, workspaceId: WS, body: { contactNumber: '919876543210' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'active');
    assert.equal(res.body.current_step_id, 20);
    assert.ok(res.body.next_due_at instanceof Date);
    // Immediate — due "now", not in the future.
    assert.ok(res.body.next_due_at.getTime() - before < 5000);
    assert.ok(res.body.next_due_at.getTime() - before >= 0);
    // Still no send from this route — only the scheduler ever sends.
    assert.ok(!db.calls.some((c) => /broadcast_logs|whatsapp|chat_history/i.test(c.sql)));
  } finally { db.restore(); }
});

test('POST /sequences/:id/enroll: a sequence with no steps still activates with next_due_at = now and current_step_id = null', async () => {
  const db = installDb({
    sequences: [{ id: 1, workspace_id: WS, name: 'Empty', description: null, status: 'draft', entry_config: {}, exit_rules: [], created_by: 1, created_at: new Date(), updated_at: new Date() }],
    contacts: [{ id: 500, workspace_id: WS, contact_number: '919876543210' }],
  });
  try {
    const before = Date.now();
    const res = await callRoute(router, 'post', '/sequences/:id/enroll', makeReq({ params: { id: '1' }, workspaceId: WS, body: { contactNumber: '919876543210' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'active');
    assert.equal(res.body.current_step_id, null);
    assert.ok(res.body.next_due_at instanceof Date);
    assert.ok(res.body.next_due_at.getTime() - before < 5000);
  } finally { db.restore(); }
});

test('POST /sequences/:id/enroll: an active enrollment (with next_due_at set) is visible to the 7C scheduler claim query', async () => {
  // Exercises the exact same "who is due" predicate
  // sequenceScheduler.claimDueEnrollmentIds() issues
  // (status='active' AND next_due_at IS NOT NULL AND next_due_at <= NOW()),
  // against the in-memory enrollment this route just created, proving the
  // 7D activation fix actually makes the enrollment reachable by 7C without
  // needing sequenceScheduler.js loaded (and its Redis/BullMQ requires)
  // inside this test file.
  const db = installDb({
    sequences: [{ id: 1, workspace_id: WS, name: 'A', description: null, status: 'draft', entry_config: {}, exit_rules: [], created_by: 1, created_at: new Date(), updated_at: new Date() }],
    sequence_steps: [{ id: 20, sequence_id: 1, step_order: 1, step_type: 'message', template_id: 55, variable_mapping: {}, delay_value: null, delay_unit: null, created_at: new Date(), updated_at: new Date() }],
    contacts: [{ id: 500, workspace_id: WS, contact_number: '919876543210' }],
  });
  try {
    const res = await callRoute(router, 'post', '/sequences/:id/enroll', makeReq({ params: { id: '1' }, workspaceId: WS, body: { contactNumber: '919876543210' } }));
    assert.equal(res.statusCode, 200);

    const due = db.state.sequence_enrollments.filter(
      (e) => e.status === 'active' && e.next_due_at !== null && e.next_due_at.getTime() <= Date.now()
    );
    assert.equal(due.length, 1);
    assert.equal(due[0].id, res.body.id);
  } finally { db.restore(); }
});

test('POST /sequences/:id/enroll: a future-due enrollment (delay-first) is not yet visible to the scheduler claim query', async () => {
  const db = installDb({
    sequences: [{ id: 1, workspace_id: WS, name: 'A', description: null, status: 'draft', entry_config: {}, exit_rules: [], created_by: 1, created_at: new Date(), updated_at: new Date() }],
    sequence_steps: [{ id: 10, sequence_id: 1, step_order: 1, step_type: 'delay', template_id: null, variable_mapping: {}, delay_value: 1, delay_unit: 'days', created_at: new Date(), updated_at: new Date() }],
    contacts: [{ id: 500, workspace_id: WS, contact_number: '919876543210' }],
  });
  try {
    const res = await callRoute(router, 'post', '/sequences/:id/enroll', makeReq({ params: { id: '1' }, workspaceId: WS, body: { contactNumber: '919876543210' } }));
    assert.equal(res.statusCode, 200);

    const due = db.state.sequence_enrollments.filter(
      (e) => e.status === 'active' && e.next_due_at !== null && e.next_due_at.getTime() <= Date.now()
    );
    assert.equal(due.length, 0);
  } finally { db.restore(); }
});

// ─── 16. reject nonexistent contact / 17. reject cross-workspace contact ──

test('POST /sequences/:id/enroll: rejects a nonexistent contact', async () => {
  const db = installDb({
    sequences: [{ id: 1, workspace_id: WS, name: 'A', description: null, status: 'draft', entry_config: {}, exit_rules: [], created_by: 1, created_at: new Date(), updated_at: new Date() }],
  });
  try {
    const res = await callRoute(router, 'post', '/sequences/:id/enroll', makeReq({ params: { id: '1' }, workspaceId: WS, body: { contactNumber: '900000000000' } }));
    assert.equal(res.statusCode, 404);
  } finally { db.restore(); }
});

test('POST /sequences/:id/enroll: rejects a contact from another workspace', async () => {
  const db = installDb({
    sequences: [{ id: 1, workspace_id: WS, name: 'A', description: null, status: 'draft', entry_config: {}, exit_rules: [], created_by: 1, created_at: new Date(), updated_at: new Date() }],
    contacts: [{ id: 500, workspace_id: 99, contact_number: '919876543210' }],
  });
  try {
    const res = await callRoute(router, 'post', '/sequences/:id/enroll', makeReq({ params: { id: '1' }, workspaceId: WS, body: { contactNumber: '919876543210' } }));
    assert.equal(res.statusCode, 404);
  } finally { db.restore(); }
});

// ─── 18. duplicate active enrollment ────────────────────────────────────

test('POST /sequences/:id/enroll: rejects a duplicate active enrollment', async () => {
  const db = installDb({
    sequences: [{ id: 1, workspace_id: WS, name: 'A', description: null, status: 'draft', entry_config: {}, exit_rules: [], created_by: 1, created_at: new Date(), updated_at: new Date() }],
    contacts: [{ id: 500, workspace_id: WS, contact_number: '919876543210' }],
  });
  try {
    const first = await callRoute(router, 'post', '/sequences/:id/enroll', makeReq({ params: { id: '1' }, workspaceId: WS, body: { contactNumber: '919876543210' } }));
    assert.equal(first.statusCode, 200);
    const second = await callRoute(router, 'post', '/sequences/:id/enroll', makeReq({ params: { id: '1' }, workspaceId: WS, body: { contactNumber: '919876543210' } }));
    assert.equal(second.statusCode, 409);
  } finally { db.restore(); }
});

// ─── 19. enrollment listing / 20. enrollment workspace isolation ──────

test('GET /sequences/:id/enrollments: lists enrollments scoped to the workspace', async () => {
  const db = installDb({
    sequences: [{ id: 1, workspace_id: WS, name: 'A', description: null, status: 'draft', entry_config: {}, exit_rules: [], created_by: 1, created_at: new Date(), updated_at: new Date() }],
    sequence_enrollments: [
      { id: 1, workspace_id: WS, sequence_id: 1, contact_number: '111', status: 'active', current_step_id: null, next_due_at: null, enrolled_at: new Date(), completed_at: null, exited_at: null, exit_reason: null, created_at: new Date(), updated_at: new Date() },
    ],
  });
  try {
    const res = await callRoute(router, 'get', '/sequences/:id/enrollments', makeReq({ params: { id: '1' }, workspaceId: WS }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.total, 1);
  } finally { db.restore(); }
});

test('GET /sequences/:id/enrollments: a sequence in another workspace is a 404 (no leak)', async () => {
  const db = installDb({
    sequences: [{ id: 1, workspace_id: 99, name: 'A', description: null, status: 'draft', entry_config: {}, exit_rules: [], created_by: 1, created_at: new Date(), updated_at: new Date() }],
    sequence_enrollments: [
      { id: 1, workspace_id: 99, sequence_id: 1, contact_number: '111', status: 'active', current_step_id: null, next_due_at: null, enrolled_at: new Date(), completed_at: null, exited_at: null, exit_reason: null, created_at: new Date(), updated_at: new Date() },
    ],
  });
  try {
    const res = await callRoute(router, 'get', '/sequences/:id/enrollments', makeReq({ params: { id: '1' }, workspaceId: WS }));
    assert.equal(res.statusCode, 404);
  } finally { db.restore(); }
});

// ─── 21. sequence lifecycle validation ──────────────────────────────────

test('POST /sequences/:id/enroll: rejects enrollment into an archived sequence', async () => {
  const db = installDb({
    sequences: [{ id: 1, workspace_id: WS, name: 'A', description: null, status: 'archived', entry_config: {}, exit_rules: [], created_by: 1, created_at: new Date(), updated_at: new Date() }],
    contacts: [{ id: 500, workspace_id: WS, contact_number: '919876543210' }],
  });
  try {
    const res = await callRoute(router, 'post', '/sequences/:id/enroll', makeReq({ params: { id: '1' }, workspaceId: WS, body: { contactNumber: '919876543210' } }));
    assert.equal(res.statusCode, 409);
  } finally { db.restore(); }
});

test('DELETE /sequences/:id: archives instead of hard-deleting', async () => {
  const db = installDb({
    sequences: [{ id: 1, workspace_id: WS, name: 'A', description: null, status: 'draft', entry_config: {}, exit_rules: [], created_by: 1, created_at: new Date(), updated_at: new Date() }],
  });
  try {
    const res = await callRoute(router, 'delete', '/sequences/:id', makeReq({ params: { id: '1' }, workspaceId: WS }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'archived');
    // Still present in the table — never row-deleted.
    assert.equal(db.state.sequences.length, 1);
  } finally { db.restore(); }
});

test('DELETE /sequences/:id: cannot double-archive', async () => {
  const db = installDb({
    sequences: [{ id: 1, workspace_id: WS, name: 'A', description: null, status: 'archived', entry_config: {}, exit_rules: [], created_by: 1, created_at: new Date(), updated_at: new Date() }],
  });
  try {
    const res = await callRoute(router, 'delete', '/sequences/:id', makeReq({ params: { id: '1' }, workspaceId: WS }));
    assert.equal(res.statusCode, 409);
  } finally { db.restore(); }
});

// ─── Phase 7E — Pause / Resume ─────────────────────────────────────────

function activeEnrollmentSeed(overrides = {}) {
  return {
    id: 1, workspace_id: WS, sequence_id: 1, contact_number: '919876543210',
    status: 'active', current_step_id: 20, next_due_at: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    enrolled_at: new Date(), completed_at: null, exited_at: null, exit_reason: null,
    created_at: new Date(), updated_at: new Date(),
    ...overrides,
  };
}

const seqSeed = [{ id: 1, workspace_id: WS, name: 'A', description: null, status: 'active', entry_config: {}, exit_rules: [], created_by: 1, created_at: new Date(), updated_at: new Date() }];

// 1. active -> paused
test('POST .../pause: pauses an active enrollment, preserving current_step_id/contact/history', async () => {
  const db = installDb({ sequences: seqSeed, sequence_enrollments: [activeEnrollmentSeed()] });
  try {
    const res = await callRoute(router, 'post', '/sequences/:id/enrollments/:enrollmentId/pause', makeReq({ params: { id: '1', enrollmentId: '1' }, workspaceId: WS }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'paused');
    assert.equal(res.body.current_step_id, 20);
    assert.equal(res.body.contact_number, '919876543210');
    assert.ok(!db.calls.some((c) => /DELETE FROM coexistence\.sequence_step_executions/.test(c.sql)));
  } finally { db.restore(); }
});

// 2. paused -> resumed / 11. resume does not restart from step 1
test('POST .../resume: resumes a paused enrollment from its existing current_step_id, not step 1', async () => {
  const db = installDb({ sequences: seqSeed, sequence_enrollments: [activeEnrollmentSeed({ status: 'paused', current_step_id: 20 })] });
  try {
    const res = await callRoute(router, 'post', '/sequences/:id/enrollments/:enrollmentId/resume', makeReq({ params: { id: '1', enrollmentId: '1' }, workspaceId: WS }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'active');
    assert.equal(res.body.current_step_id, 20); // unchanged — not reset to step 1
  } finally { db.restore(); }
});

// Resume preserves a still-future delay timestamp (does not blindly reset to NOW()).
test('POST .../resume: a delay step whose wait had not elapsed keeps its existing future next_due_at', async () => {
  const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const db = installDb({ sequences: seqSeed, sequence_enrollments: [activeEnrollmentSeed({ status: 'paused', next_due_at: future })] });
  try {
    const res = await callRoute(router, 'post', '/sequences/:id/enrollments/:enrollmentId/resume', makeReq({ params: { id: '1', enrollmentId: '1' }, workspaceId: WS }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.next_due_at.getTime(), future.getTime());
  } finally { db.restore(); }
});

// Resume makes an already-elapsed (or message-step) due time immediate.
test('POST .../resume: an already-past next_due_at becomes due immediately (now), not blindly reset in general', async () => {
  const past = new Date(Date.now() - 60000);
  const db = installDb({ sequences: seqSeed, sequence_enrollments: [activeEnrollmentSeed({ status: 'paused', next_due_at: past })] });
  try {
    const before = Date.now();
    const res = await callRoute(router, 'post', '/sequences/:id/enrollments/:enrollmentId/resume', makeReq({ params: { id: '1', enrollmentId: '1' }, workspaceId: WS }));
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.next_due_at.getTime() >= before);
  } finally { db.restore(); }
});

// 3. pause twice
test('POST .../pause: pausing an already-paused enrollment is rejected (409), not silently re-applied', async () => {
  const db = installDb({ sequences: seqSeed, sequence_enrollments: [activeEnrollmentSeed({ status: 'paused' })] });
  try {
    const res = await callRoute(router, 'post', '/sequences/:id/enrollments/:enrollmentId/pause', makeReq({ params: { id: '1', enrollmentId: '1' }, workspaceId: WS }));
    assert.equal(res.statusCode, 409);
  } finally { db.restore(); }
});

// 4. resume twice
test('POST .../resume: resuming an already-active enrollment is rejected (409)', async () => {
  const db = installDb({ sequences: seqSeed, sequence_enrollments: [activeEnrollmentSeed({ status: 'active' })] });
  try {
    const res = await callRoute(router, 'post', '/sequences/:id/enrollments/:enrollmentId/resume', makeReq({ params: { id: '1', enrollmentId: '1' }, workspaceId: WS }));
    assert.equal(res.statusCode, 409);
  } finally { db.restore(); }
});

// 5 / 7. pause a terminal (completed/exited) enrollment
test('POST .../pause: rejects pausing a completed enrollment', async () => {
  const db = installDb({ sequences: seqSeed, sequence_enrollments: [activeEnrollmentSeed({ status: 'completed', current_step_id: null, next_due_at: null })] });
  try {
    const res = await callRoute(router, 'post', '/sequences/:id/enrollments/:enrollmentId/pause', makeReq({ params: { id: '1', enrollmentId: '1' }, workspaceId: WS }));
    assert.equal(res.statusCode, 409);
  } finally { db.restore(); }
});

test('POST .../pause: rejects pausing an exited enrollment', async () => {
  const db = installDb({ sequences: seqSeed, sequence_enrollments: [activeEnrollmentSeed({ status: 'exited', next_due_at: null })] });
  try {
    const res = await callRoute(router, 'post', '/sequences/:id/enrollments/:enrollmentId/pause', makeReq({ params: { id: '1', enrollmentId: '1' }, workspaceId: WS }));
    assert.equal(res.statusCode, 409);
  } finally { db.restore(); }
});

// 6 / 8. resume a terminal (completed/exited) enrollment
test('POST .../resume: rejects resuming a completed enrollment', async () => {
  const db = installDb({ sequences: seqSeed, sequence_enrollments: [activeEnrollmentSeed({ status: 'completed', current_step_id: null, next_due_at: null })] });
  try {
    const res = await callRoute(router, 'post', '/sequences/:id/enrollments/:enrollmentId/resume', makeReq({ params: { id: '1', enrollmentId: '1' }, workspaceId: WS }));
    assert.equal(res.statusCode, 409);
  } finally { db.restore(); }
});

test('POST .../resume: rejects resuming an exited enrollment', async () => {
  const db = installDb({ sequences: seqSeed, sequence_enrollments: [activeEnrollmentSeed({ status: 'exited', next_due_at: null })] });
  try {
    const res = await callRoute(router, 'post', '/sequences/:id/enrollments/:enrollmentId/resume', makeReq({ params: { id: '1', enrollmentId: '1' }, workspaceId: WS }));
    assert.equal(res.statusCode, 409);
  } finally { db.restore(); }
});

// 9. paused enrollment invisible to the scheduler's claim predicate.
test('paused enrollment is never matched by the scheduler claim predicate, even with a due next_due_at', async () => {
  const past = new Date(Date.now() - 60000);
  const db = installDb({ sequences: seqSeed, sequence_enrollments: [activeEnrollmentSeed({ status: 'paused', next_due_at: past })] });
  try {
    // Exact predicate sequenceScheduler.claimDueEnrollmentIds() uses:
    // status = 'active' AND next_due_at IS NOT NULL AND next_due_at <= NOW().
    const due = db.state.sequence_enrollments.filter((e) => e.status === 'active' && e.next_due_at !== null && e.next_due_at.getTime() <= Date.now());
    assert.equal(due.length, 0);
  } finally { db.restore(); }
});

// 10. resumed enrollment becomes eligible correctly
test('POST .../resume: a resumed, now-due enrollment is matched by the scheduler claim predicate', async () => {
  const past = new Date(Date.now() - 60000);
  const db = installDb({ sequences: seqSeed, sequence_enrollments: [activeEnrollmentSeed({ status: 'paused', next_due_at: past })] });
  try {
    const res = await callRoute(router, 'post', '/sequences/:id/enrollments/:enrollmentId/resume', makeReq({ params: { id: '1', enrollmentId: '1' }, workspaceId: WS }));
    assert.equal(res.statusCode, 200);
    const due = db.state.sequence_enrollments.filter((e) => e.status === 'active' && e.next_due_at !== null && e.next_due_at.getTime() <= Date.now());
    assert.equal(due.length, 1);
    assert.equal(due[0].id, res.body.id);
  } finally { db.restore(); }
});

// 14 / 15. pause/resume racing a scheduler claim: the claim UPDATE (SET
// next_due_at = lease) never touches `status`, so pauseEnrollment's
// conditional WHERE status='active' still matches after a claim — the row
// simply moves to 'paused' and the ALREADY-claimed executeDueEnrollmentById
// call (see sequenceScheduler.js) re-checks `enrollment.status !== 'active'`
// itself and no-ops. Modelled here at the predicate level since this test
// file intentionally never imports sequenceScheduler.js (it would pull in
// live Redis/BullMQ connections — see util/sequenceDelay.js's header for
// the same reasoning applied to routes/sequences.js).
test('pause racing a scheduler claim: a lease-only next_due_at bump does not block pause, and the paused row is excluded afterward', async () => {
  const db = installDb({ sequences: seqSeed, sequence_enrollments: [activeEnrollmentSeed({ status: 'active', next_due_at: new Date(Date.now() - 1000) })] });
  try {
    // Simulate the scheduler's claim: push next_due_at into a short lease,
    // status stays 'active' (exactly what claimDueEnrollmentIds does).
    db.state.sequence_enrollments[0].next_due_at = new Date(Date.now() + 30000);

    const res = await callRoute(router, 'post', '/sequences/:id/enrollments/:enrollmentId/pause', makeReq({ params: { id: '1', enrollmentId: '1' }, workspaceId: WS }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'paused');

    const due = db.state.sequence_enrollments.filter((e) => e.status === 'active' && e.next_due_at !== null && e.next_due_at.getTime() <= Date.now());
    assert.equal(due.length, 0);
  } finally { db.restore(); }
});

// 19. workspace isolation
test('POST .../pause: an enrollment in another workspace is a 404 (no leak)', async () => {
  const db = installDb({
    sequences: [{ id: 1, workspace_id: 99, name: 'A', description: null, status: 'active', entry_config: {}, exit_rules: [], created_by: 1, created_at: new Date(), updated_at: new Date() }],
    sequence_enrollments: [activeEnrollmentSeed({ workspace_id: 99 })],
  });
  try {
    const res = await callRoute(router, 'post', '/sequences/:id/enrollments/:enrollmentId/pause', makeReq({ params: { id: '1', enrollmentId: '1' }, workspaceId: WS }));
    assert.equal(res.statusCode, 404);
  } finally { db.restore(); }
});

test('POST .../resume: an enrollment in another workspace is a 404 (no leak)', async () => {
  const db = installDb({
    sequences: [{ id: 1, workspace_id: 99, name: 'A', description: null, status: 'active', entry_config: {}, exit_rules: [], created_by: 1, created_at: new Date(), updated_at: new Date() }],
    sequence_enrollments: [activeEnrollmentSeed({ workspace_id: 99, status: 'paused' })],
  });
  try {
    const res = await callRoute(router, 'post', '/sequences/:id/enrollments/:enrollmentId/resume', makeReq({ params: { id: '1', enrollmentId: '1' }, workspaceId: WS }));
    assert.equal(res.statusCode, 404);
  } finally { db.restore(); }
});

// 20. permission enforcement — the existing sequence-studio permission,
// reused as instructed (no new permission system). VIEWER does not have
// sequence-studio in permissions.js's ROLE_PAGE_DEFAULTS, so this is a
// real 403 through requirePermission's non-admin (DB-lookup) path, not
// just the isAdmin() short-circuit every other test in this file relies
// on via the default 'OWNER' role.
test('POST .../pause: a workspace VIEWER (no sequence-studio permission) is rejected with 403', async () => {
  const db = installDb({
    sequences: seqSeed,
    sequence_enrollments: [activeEnrollmentSeed()],
    akchat_users: [{ id: 2, role: 'VIEWER', permissions: null }],
  });
  try {
    const res = await callRoute(router, 'post', '/sequences/:id/enrollments/:enrollmentId/pause', makeReq({ params: { id: '1', enrollmentId: '1' }, workspaceId: WS, userRole: 'VIEWER', userId: 2 }));
    assert.equal(res.statusCode, 403);
  } finally { db.restore(); }
});
// ─── Phase 7F Part 2 — Execution history (read-only) ────────────────────

test('GET /sequences/:id/enrollments/:enrollmentId: includes execution history rows', async () => {
  const db = installDb({
    sequences: seqSeed,
    sequence_enrollments: [activeEnrollmentSeed()],
    sequence_step_executions: [
      { id: 1, enrollment_id: 1, step_id: 20, status: 'sent', wa_message_id: 'wamid.1', error_message: null, executed_at: new Date(), created_at: new Date(), updated_at: new Date() },
      { id: 2, enrollment_id: 1, step_id: 21, status: 'pending', wa_message_id: null, error_message: null, executed_at: null, created_at: new Date(), updated_at: new Date() },
    ],
  });
  try {
    const res = await callRoute(router, 'get', '/sequences/:id/enrollments/:enrollmentId', makeReq({ params: { id: '1', enrollmentId: '1' }, workspaceId: WS }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.executions.length, 2);
    assert.equal(res.body.executions[0].status, 'sent');
    assert.equal(res.body.executions[1].status, 'pending');
  } finally { db.restore(); }
});

test('GET /sequences/:id/enrollments/:enrollmentId: executions is empty array when none exist', async () => {
  const db = installDb({
    sequences: seqSeed,
    sequence_enrollments: [activeEnrollmentSeed()],
  });
  try {
    const res = await callRoute(router, 'get', '/sequences/:id/enrollments/:enrollmentId', makeReq({ params: { id: '1', enrollmentId: '1' }, workspaceId: WS }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.executions, []);
  } finally { db.restore(); }
});





























