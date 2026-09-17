'use strict';

// Phase 6 Part 2 bugfix — customer SELECTION persistence.
//
// Root cause (see PR description): the Resolved Audience list (Step 4) kept
// `selectedIds` / `selectAllMatching` as component-local React state that
// was never lifted into the campaign draft, never included in the Save
// Draft payload, and had no backing database column at all — so it was
// always lost on reload, by construction, regardless of what the UI did.
//
// These tests cover the backend half of the fix: validateSelectionInput,
// sanitizeSelectedContactIds, resolveAudience's new includeAllIds option,
// and the GET /campaigns/:id safety intersection (stale ids never survive
// a changed audience).
//
// pool.query is monkey-patched on the shared '../src/db' singleton, same
// approach as test/audienceResolvedList.test.js (no live Postgres reachable
// from this sandbox).

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/db');
const { router, resolveAudience, validateSelectionInput, sanitizeSelectedContactIds, MAX_AUDIENCE } = require('../src/routes/campaigns');

// ─── validateSelectionInput ───────────────────────────────────────────────

test('validateSelectionInput: accepts a normal array of ids', () => {
  assert.equal(validateSelectionInput({ selectedContactIds: [1008, 2550, 2429] }), null);
});

test('validateSelectionInput: rejects the audience COUNT mistakenly sent as an id list', () => {
  // The exact "WRONG: selectedIds = [187]" example from the project brief —
  // 187 is a single-element array here, which passes the array/type/length
  // checks; the count-vs-id distinction is enforced structurally elsewhere
  // (the frontend never has a code path that produces this), but this test
  // documents that a plain numeric array is accepted at this validation
  // layer and the real safety net is the intersection against
  // allMatchingContactIds in GET /campaigns/:id (covered below).
  assert.equal(validateSelectionInput({ selectedContactIds: [187] }), null);
});

test('validateSelectionInput: rejects a non-array selectedContactIds', () => {
  assert.match(validateSelectionInput({ selectedContactIds: 'not-an-array' }), /must be an array/);
});

test('validateSelectionInput: rejects non-numeric entries', () => {
  assert.match(validateSelectionInput({ selectedContactIds: [1008, 'abc'] }), /numeric/);
});

test('validateSelectionInput: rejects more than MAX_AUDIENCE entries', () => {
  const tooMany = Array.from({ length: MAX_AUDIENCE + 1 }, (_, i) => i + 1);
  assert.match(validateSelectionInput({ selectedContactIds: tooMany }), /cannot exceed/);
});

test('validateSelectionInput: rejects a non-boolean selectAllMatching', () => {
  assert.match(validateSelectionInput({ selectAllMatching: 'yes' }), /must be a boolean/);
});

test('validateSelectionInput: undefined/null selection fields are fine (no-op update)', () => {
  assert.equal(validateSelectionInput({}), null);
  assert.equal(validateSelectionInput({ selectedContactIds: null, selectAllMatching: null }), null);
});

// ─── sanitizeSelectedContactIds ───────────────────────────────────────────

test('sanitizeSelectedContactIds: dedupes and coerces to numbers', () => {
  assert.deepEqual(sanitizeSelectedContactIds([1008, '1008', 2550, 2550, '2429']), [1008, 2550, 2429]);
});

test('sanitizeSelectedContactIds: non-array input returns empty array', () => {
  assert.deepEqual(sanitizeSelectedContactIds(undefined), []);
  assert.deepEqual(sanitizeSelectedContactIds(null), []);
});

// ─── resolveAudience: includeAllIds option ────────────────────────────────

function installDb({ total, pageRows, idRows }) {
  const calls = [];
  const originalQuery = pool.query;
  pool.query = async (sql, params) => {
    calls.push({ sql, params });
    if (/COUNT\(\*\)::int AS total/.test(sql)) return { rows: [{ total }] };
    if (/deduped\.custom_fields->>'source' AS source/.test(sql)) return { rows: pageRows || [] };
    if (/SELECT deduped\.id FROM/.test(sql)) return { rows: (idRows || []).map((id) => ({ id })) };
    return { rows: [] };
  };
  return { calls, restore() { pool.query = originalQuery; } };
}

test('resolveAudience: pageSize 0 with includeAllIds true fetches ids WITHOUT the full contacts-detail query', async () => {
  const db = installDb({ total: 3, pageRows: [], idRows: [1008, 2550, 2429] });
  try {
    const result = await resolveAudience(1, { audienceType: 'filters', filters: [], combinator: 'AND' }, { includeAllIds: true });
    assert.deepEqual(result.allMatchingContactIds, [1008, 2550, 2429]);
    assert.deepEqual(result.contacts, []); // no page requested -> no detail rows
    // Only the COUNT query + the id-only query should have run — never the
    // full per-contact detail query (no `pageSize` was requested).
    const detailCalls = db.calls.filter((c) => /deduped\.custom_fields->>'source' AS source/.test(c.sql));
    assert.equal(detailCalls.length, 0);
  } finally { db.restore(); }
});

test('resolveAudience: default behavior unchanged — pageSize 0 without includeAllIds still issues only the COUNT query', async () => {
  const db = installDb({ total: 187, pageRows: [], idRows: [] });
  try {
    const result = await resolveAudience(1, { audienceType: 'filters', filters: [], combinator: 'AND' });
    assert.deepEqual(result.allMatchingContactIds, []);
    assert.equal(db.calls.length, 1);
  } finally { db.restore(); }
});

// ─── Regression: node-postgres returns BIGINT (int8) columns as STRINGS ──
// `deduped.id` is BIGINT. The real pg driver returns int8 values as JS
// strings, not numbers (https://github.com/brianc/node-postgres/issues/45).
// Every mock above hands resolveAudience() already-numeric ids, which is
// exactly why the old backend test suite passed 18/18 while the live
// browser still lost every individual selection on reopen — the mocks
// never exercised the real driver's string return type. These two tests
// use STRING ids, as pg actually returns, to catch that class of bug.
test('resolveAudience: normalizes STRING BIGINT ids (as the real pg driver returns) to numbers in allMatchingContactIds', async () => {
  const db = installDb({ total: 3, pageRows: [], idRows: ['1008', '2550', '913'] });
  try {
    const result = await resolveAudience(1, { audienceType: 'filters', filters: [], combinator: 'AND' }, { includeAllIds: true });
    assert.deepEqual(result.allMatchingContactIds, [1008, 2550, 913]);
    result.allMatchingContactIds.forEach((id) => assert.equal(typeof id, 'number'));
  } finally { db.restore(); }
});

test('resolveAudience: normalizes STRING BIGINT ids in the contacts detail page', async () => {
  const db = installDb({
    total: 1,
    pageRows: [{ id: '1008', contact_number: '916382121634', name: '26', wa_number: '919344330905', source: 'shopify_sheet_sync', city: 'Chennai', state: 'Tamil Nadu' }],
    idRows: ['1008'],
  });
  try {
    const result = await resolveAudience(1, { audienceType: 'filters', filters: [], combinator: 'AND' }, { page: 1, pageSize: 25 });
    assert.equal(result.contacts[0].id, 1008);
    assert.equal(typeof result.contacts[0].id, 'number');
  } finally { db.restore(); }
});

// ─── GET /campaigns/:id — stale-selection safety intersection ────────────
// Exercises the actual Express handler (via its route stack), not just the
// helper functions, so the intersection logic itself is under test.

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

function makeReq({ body = {}, params = { id: '42' } } = {}) {
  // role: 'admin' short-circuits requirePermission's isAdmin() check, so
  // this test doesn't need to also mock the akchat_users permission lookup.
  return { user: { id: 1, role: 'admin' }, workspace: { id: 7 }, params, body };
}

const BASE_CAMPAIGN_ROW = {
  id: 42, workspace_id: 7, name: 'Diwali Sale', description: null,
  channel: 'whatsapp', campaign_type: 'broadcast', status: 'draft',
  audience_type: 'filters',
  audience_filters: [{ field: 'source', operator: 'equals', value: 'shopify_sheet_sync' }],
  audience_combinator: 'AND', audience_contact_ids: [],
  selected_contact_ids: [1008, 2550, 2429], select_all_matching: false,
  audience_size_cached: null, audience_resolved_at: null,
  from_number: null, template_id: null, message_type: 'template', body: null,
  variable_mapping: {}, media_library_id: null, caption: null, broadcast_id: null,
  created_by: 1, created_at: new Date(), updated_at: new Date(),
  scheduled_at: null, started_at: null, completed_at: null,
};

function installCampaignDetailDb({ total, idRows, campaignRow = BASE_CAMPAIGN_ROW }) {
  const originalQuery = pool.query;
  pool.query = async (sql) => {
    if (/FROM coexistence\.campaigns WHERE id = \$1 AND workspace_id = \$2/.test(sql)) {
      return { rows: [campaignRow] };
    }
    if (/COUNT\(\*\)::int AS total/.test(sql)) return { rows: [{ total }] };
    if (/SELECT deduped\.id FROM/.test(sql)) return { rows: (idRows || []).map((id) => ({ id })) };
    if (/UPDATE coexistence\.campaigns\s+SET audience_size_cached/.test(sql)) return { rows: [] };
    return { rows: [] };
  };
  return { restore() { pool.query = originalQuery; } };
}

// ─── LIVE-REPRODUCTION regression: exact Campaign 2 evidence ─────────────
// Saved selection [913, 1008] (numbers, from JSONB) vs. the resolved
// audience's ids coming back as STRINGS (the real pg driver's behavior for
// BIGINT columns — see resolveAudience()'s comment). Before the fix,
// `matchingSet.has(Number(id))` looked up a NUMBER in a Set built from
// STRINGS and always missed, so GET /campaigns/2 returned
// selected_contact_ids: [] even though both 913 and 1008 were genuinely
// still in the resolved audience — exactly the bug reported from the live
// browser Network tab.
test('GET /campaigns/:id: LIVE BUG REPRO — numeric saved selection survives a resolved audience whose ids come back as strings', async () => {
  const campaignRow = { ...BASE_CAMPAIGN_ROW, selected_contact_ids: [913, 1008], select_all_matching: false };
  // idRows as STRINGS, exactly as node-postgres returns BIGINT columns —
  // NOT as numbers like the other tests above (which is why those passed
  // while the live bug still existed).
  const db = installCampaignDetailDb({ total: 187, idRows: ['1008', '2550', '2429', '913', '2536'], campaignRow });
  try {
    const res = await callRoute(router, 'get', '/campaigns/:id', makeReq({ params: { id: '2' } }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.selected_contact_ids.slice().sort((a, b) => a - b), [913, 1008]);
    assert.equal(res.body.select_all_matching, false);
  } finally { db.restore(); }
});

test('GET /campaigns/:id: a saved id that is still in the current resolved audience is restored', async () => {
  const db = installCampaignDetailDb({ total: 3, idRows: [1008, 2550, 2429] });
  try {
    const res = await callRoute(router, 'get', '/campaigns/:id', makeReq());
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.selected_contact_ids.sort(), [1008, 2429, 2550]);
  } finally { db.restore(); }
});

test('GET /campaigns/:id: a saved id NO LONGER in the resolved audience (e.g. filters changed) is dropped, not restored', async () => {
  // 2550 no longer matches — only 1008 and 2429 are in the current audience.
  const db = installCampaignDetailDb({ total: 2, idRows: [1008, 2429] });
  try {
    const res = await callRoute(router, 'get', '/campaigns/:id', makeReq());
    assert.deepEqual(res.body.selected_contact_ids.sort(), [1008, 2429]);
    assert.equal(res.body.selected_contact_ids.includes(2550), false);
  } finally { db.restore(); }
});

test('GET /campaigns/:id: "Select all matching" — the explicit id list is not returned as a partial selection', async () => {
  const campaignRow = { ...BASE_CAMPAIGN_ROW, selected_contact_ids: [1008, 2550, 2429], select_all_matching: true };
  const db = installCampaignDetailDb({ total: 3, idRows: [1008, 2550, 2429], campaignRow });
  try {
    const res = await callRoute(router, 'get', '/campaigns/:id', makeReq());
    assert.equal(res.body.select_all_matching, true);
    assert.deepEqual(res.body.selected_contact_ids, []);
  } finally { db.restore(); }
});

test('GET /campaigns/:id: an audience that now matches nobody drops every previously selected id', async () => {
  const db = installCampaignDetailDb({ total: 0, idRows: [] });
  try {
    const res = await callRoute(router, 'get', '/campaigns/:id', makeReq());
    assert.deepEqual(res.body.selected_contact_ids, []);
  } finally { db.restore(); }
});

// ─── PUT /campaigns/:id — selection is accepted, validated, and persisted ─

test('PUT /campaigns/:id: rejects the count mistakenly sent as the id list only if malformed; a normal id array with a valid audience is accepted and persisted', async () => {
  let updatePayload = null;
  const originalQuery = pool.query;
  pool.query = async (sql, params) => {
    if (/FROM coexistence\.campaigns WHERE id = \$1 AND workspace_id = \$2/.test(sql)) {
      return { rows: [BASE_CAMPAIGN_ROW] };
    }
    if (/UPDATE coexistence\.campaigns SET/.test(sql)) {
      updatePayload = params;
      return { rows: [{ ...BASE_CAMPAIGN_ROW, selected_contact_ids: JSON.parse(params[10]), select_all_matching: params[11] }] };
    }
    return { rows: [] };
  };
  try {
    const res = await callRoute(router, 'put', '/campaigns/:id', makeReq({
      body: { name: 'Diwali Sale', selectedContactIds: [1008, '1008', 2550], selectAllMatching: false },
    }));
    assert.equal(res.statusCode, 200);
    // Persisted value is deduped/coerced to numbers — never the raw mixed
    // string/number input, and never the audience count.
    assert.deepEqual(JSON.parse(updatePayload[10]), [1008, 2550]);
    assert.equal(updatePayload[11], false);
  } finally { pool.query = originalQuery; }
});

test('PUT /campaigns/:id: rejects selectedContactIds that is not an array', async () => {
  const originalQuery = pool.query;
  pool.query = async (sql) => {
    if (/FROM coexistence\.campaigns WHERE id = \$1 AND workspace_id = \$2/.test(sql)) {
      return { rows: [BASE_CAMPAIGN_ROW] };
    }
    return { rows: [] };
  };
  try {
    const res = await callRoute(router, 'put', '/campaigns/:id', makeReq({
      body: { name: 'Diwali Sale', selectedContactIds: 'nope' },
    }));
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /must be an array/);
  } finally { pool.query = originalQuery; }
});


test('PUT /campaigns/:id: static contact-list audience (audienceContactIds) is untouched by the separate selection fields', async () => {
  const staticRow = { ...BASE_CAMPAIGN_ROW, audience_type: 'contacts', audience_contact_ids: [10, 20, 30] };
  let updatePayload = null;
  const originalQuery = pool.query;
  pool.query = async (sql, params) => {
    if (/FROM coexistence\.campaigns WHERE id = \$1 AND workspace_id = \$2/.test(sql)) {
      return { rows: [staticRow] };
    }
    if (/UPDATE coexistence\.campaigns SET/.test(sql)) {
      updatePayload = params;
      return { rows: [staticRow] };
    }
    return { rows: [] };
  };
  try {
    const res = await callRoute(router, 'put', '/campaigns/:id', makeReq({
      body: { name: 'Static Reminder', selectedContactIds: [10, 20], selectAllMatching: false },
    }));
    assert.equal(res.statusCode, 200);
    // audience_contact_ids (the static audience DEFINITION) still round-trips
    // unchanged — param index 9 (0-based) per campaignRepository.updateCampaign.
    assert.deepEqual(JSON.parse(updatePayload[9]), [10, 20, 30]);
    // selected_contact_ids (param index 10) is the separate SELECTION field.
    assert.deepEqual(JSON.parse(updatePayload[10]), [10, 20]);
  } finally { pool.query = originalQuery; }
});