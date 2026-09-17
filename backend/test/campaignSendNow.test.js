'use strict';

// Phase 6 Part 3A — Send Now + final recipient resolution.
//
// pool.query / pool.connect are monkey-patched on the shared '../src/db'
// singleton (same approach as test/campaignSelectionPersistence.test.js —
// no live Postgres reachable from this sandbox). require.cache is
// pre-seeded for routes/broadcasts.js and routes/whatsappAccounts.js so
// routes/campaigns.js picks up controllable fakes for sendBroadcastById /
// getAccountByPhoneNumber instead of the real implementations, which is
// the only way to unit-test the Send Now route without a live DB/Meta API.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const pool = require('../src/db');

// ─── Fake out routes/broadcasts.js's sendBroadcastById + routes/
// whatsappAccounts.js's getAccountByPhoneNumber BEFORE campaigns.js is
// required, so campaigns.js's top-level destructured requires bind to
// these controllable fakes. ───────────────────────────────────────────────
const broadcastsPath = require.resolve('../src/routes/broadcasts.js');
const whatsappAccountsPath = require.resolve('../src/routes/whatsappAccounts.js');

let sendBroadcastByIdImpl = async () => ({ statusCode: 200, body: { enqueued: 1 } });
let getAccountByPhoneNumberImpl = async () => ({ id: 99, displayPhoneNumber: '15550001111' });

require.cache[broadcastsPath] = new Module(broadcastsPath, null);
require.cache[broadcastsPath].exports = {
  router: { stack: [] }, // unused by campaigns.js
  sendBroadcastById: (...args) => sendBroadcastByIdImpl(...args),
};

require.cache[whatsappAccountsPath] = new Module(whatsappAccountsPath, null);
require.cache[whatsappAccountsPath].exports = {
  getAccountByPhoneNumber: (...args) => getAccountByPhoneNumberImpl(...args),
};

const { router, resolveFinalRecipients } = require('../src/routes/campaigns');

// ─── resolveFinalRecipients ────────────────────────────────────────────────

function installDb({ rows }) {
  const calls = [];
  const originalQuery = pool.query;
  pool.query = async (sql, params) => {
    calls.push({ sql, params });
    return { rows: rows || [] };
  };
  return { calls, restore() { pool.query = originalQuery; } };
}

test('resolveFinalRecipients: CASE 1 — dynamic + select all matching uses the current filter match, no id restriction', async () => {
  const db = installDb({
    rows: [
      { id: '1', contact_number: '911111111111', name: 'A' },
      { id: '2', contact_number: '922222222222', name: 'B' },
    ],
  });
  try {
    const campaign = {
      audience_type: 'filters',
      audience_filters: [{ field: 'source', operator: 'equals', value: 'shopify_sheet_sync' }],
      audience_combinator: 'AND',
      audience_contact_ids: [],
      selected_contact_ids: [913, 1008, 2550], // must be IGNORED when select_all_matching is true
      select_all_matching: true,
    };
    const result = await resolveFinalRecipients(7, campaign);
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((r) => r.id), [1, 2]);
    // Never restricted to c.id = ANY(...) when select_all_matching is true.
    assert.ok(!/c\.id = ANY/.test(db.calls[0].sql));
  } finally { db.restore(); }
});

test('resolveFinalRecipients: CASE 2 — dynamic + individual selection intersects saved ids with the CURRENT matching audience', async () => {
  // Saved selection: [913, 1008, 2550]. Current matching audience (per the
  // spec's own example): [913, 1008]. Final recipients must be exactly
  // [913, 1008] — 2550 must never appear.
  const db = installDb({
    rows: [
      { id: '913', contact_number: '910000000913', name: 'Cust913' },
      { id: '1008', contact_number: '910000001008', name: 'Cust1008' },
    ],
  });
  try {
    const campaign = {
      audience_type: 'filters',
      audience_filters: [{ field: 'source', operator: 'equals', value: 'shopify_sheet_sync' }],
      audience_combinator: 'AND',
      audience_contact_ids: [],
      selected_contact_ids: [913, 1008, 2550],
      select_all_matching: false,
    };
    const result = await resolveFinalRecipients(7, campaign);
    assert.deepEqual(result.map((r) => r.id).sort((a, b) => a - b), [913, 1008]);
    assert.ok(result.every((r) => r.id !== 2550));
    // The selected-ids array (with the stale 2550 still IN it) is what gets
    // passed as a SQL param — the DB-side intersection (WHERE + id = ANY)
    // is what actually drops it, exactly like the "187 matched, 2 selected
    // -> 2 final recipients" example.
    const lastCall = db.calls[db.calls.length - 1];
    assert.ok(/c\.id = ANY/.test(lastCall.sql));
    assert.deepEqual(lastCall.params[lastCall.params.length - 1], [913, 1008, 2550]);
  } finally { db.restore(); }
});

test('resolveFinalRecipients: CASE 2b — the exact spec example (187 matched, 2 selected -> 2 final recipients)', async () => {
  // installDb always returns whatever rows are configured for the deduped
  // query regardless of the (mocked) underlying match count of 187 — the
  // real DB enforces the intersection; here we assert the ROUTE only ever
  // asks for and receives the 2 actually-selected+matching rows, never 187.
  const db = installDb({
    rows: [
      { id: '1008', contact_number: '916382121634', name: 'Cust1008' },
      { id: '913', contact_number: '917000000913', name: 'Cust913' },
    ],
  });
  try {
    const campaign = {
      audience_type: 'filters',
      audience_filters: [{ field: 'source', operator: 'equals', value: 'shopify_sheet_sync' }],
      audience_combinator: 'AND',
      audience_contact_ids: [],
      selected_contact_ids: [1008, 913],
      select_all_matching: false,
    };
    const result = await resolveFinalRecipients(7, campaign);
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((r) => r.contact_number).sort(), ['916382121634', '917000000913']);
  } finally { db.restore(); }
});

test('resolveFinalRecipients: CASE 3 — dynamic audience with no selection at all resolves to an empty list (never "send to everyone")', async () => {
  const db = installDb({ rows: [] });
  try {
    const campaign = {
      audience_type: 'filters',
      audience_filters: [],
      audience_combinator: 'AND',
      audience_contact_ids: [],
      selected_contact_ids: [],
      select_all_matching: false,
    };
    const result = await resolveFinalRecipients(7, campaign);
    assert.deepEqual(result, []);
    const lastCall = db.calls[db.calls.length - 1];
    assert.deepEqual(lastCall.params[lastCall.params.length - 1], []);
  } finally { db.restore(); }
});

test('resolveFinalRecipients: CASE 4 — static contact list uses audience_contact_ids, never selected_contact_ids as the definition', async () => {
  const db = installDb({
    rows: [
      { id: '142', contact_number: '916382121634', name: 'Static1' },
    ],
  });
  try {
    const campaign = {
      audience_type: 'contacts',
      audience_filters: [],
      audience_combinator: 'AND',
      audience_contact_ids: [142, 1008], // authoritative static list
      selected_contact_ids: [142], // user checked only one of the two
      select_all_matching: false,
    };
    const result = await resolveFinalRecipients(7, campaign);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 142);
  } finally { db.restore(); }
});

test('resolveFinalRecipients: dedup — two contacts sharing one phone number produce exactly one recipient', async () => {
  // buildDedupedContactsSQL's DISTINCT ON (c.contact_number) already
  // guarantees this at the SQL layer; this test just confirms
  // resolveFinalRecipients passes the deduped rows straight through without
  // re-duplicating or re-merging anything.
  const db = installDb({
    rows: [{ id: '142', contact_number: '916382121634', name: 'Winner' }],
  });
  try {
    const campaign = {
      audience_type: 'filters', audience_filters: [], audience_combinator: 'AND', audience_contact_ids: [],
      selected_contact_ids: [], select_all_matching: true,
    };
    const result = await resolveFinalRecipients(7, campaign);
    assert.equal(result.length, 1);
    assert.equal(result[0].contact_number, '916382121634');
  } finally { db.restore(); }
});

// ─── POST /campaigns/:id/send — route-level ───────────────────────────────

function callRoute(routerToUse, method, routePath, req) {
  const layer = routerToUse.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${routePath}`);
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

function makeReq(id = '42') {
  return { user: { id: 1, role: 'admin' }, workspace: { id: 7 }, params: { id }, body: {} };
}

const DRAFT_CAMPAIGN = {
  id: 42, workspace_id: 7, name: 'Diwali Sale', status: 'draft',
  audience_type: 'filters',
  audience_filters: [{ field: 'source', operator: 'equals', value: 'shopify_sheet_sync' }],
  audience_combinator: 'AND', audience_contact_ids: [],
  selected_contact_ids: [1008, 913], select_all_matching: false,
  from_number: '15550001111', template_id: 55, message_type: 'template', body: null,
  variable_mapping: {}, media_library_id: null, caption: null, broadcast_id: null,
};

// Builds a full fake pool.query + pool.connect implementation for the
// send route's happy/edge paths. `campaignRow` is what getCampaignById
// (SELECT ... FROM coexistence.campaigns WHERE id = $1 AND workspace_id = $2,
// no FOR UPDATE) returns; `lockStatus` is what the row-locked SELECT ...
// FOR UPDATE sees (lets tests simulate a concurrent transition).
function installRouteDb({ campaignRow, lockStatus, templateExists = true, broadcastInsertId = 900 }) {
  const calls = [];
  const originalQuery = pool.query;
  const originalConnect = pool.connect;

  pool.query = async (sql, params) => {
    calls.push({ sql, params });
    if (/FROM coexistence\.campaigns WHERE id = \$1 AND workspace_id = \$2$/.test(sql.trim())) {
      return { rows: campaignRow ? [campaignRow] : [] };
    }
    if (/FROM coexistence\.message_templates/.test(sql)) {
      return { rows: templateExists ? [{ id: params[0] }] : [] };
    }
    if (/SELECT deduped\.id, deduped\.contact_number, deduped\.name/.test(sql)) {
      return { rows: [{ id: '1008', contact_number: '916382121634', name: 'Cust1008' }] };
    }
    if (/INSERT INTO coexistence\.broadcasts/.test(sql)) {
      return { rows: [{ id: broadcastInsertId }] };
    }
    if (/UPDATE coexistence\.campaigns SET/.test(sql) && /RETURNING/.test(sql)) {
      return { rows: [{ ...campaignRow, status: params[2] || 'running' }] };
    }
    return { rows: [] };
  };

  pool.connect = async () => ({
    query: async (sql, params) => {
      calls.push({ sql, params, client: true });
      if (/^BEGIN$/.test(sql) || /^COMMIT$/.test(sql) || /^ROLLBACK$/.test(sql)) return { rows: [] };
      if (/SELECT status FROM coexistence\.campaigns.*FOR UPDATE/s.test(sql)) {
        return { rows: campaignRow ? [{ status: lockStatus ?? campaignRow.status }] : [] };
      }
      if (/UPDATE coexistence\.campaigns/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  });

  return {
    calls,
    restore() { pool.query = originalQuery; pool.connect = originalConnect; },
  };
}

test('POST /campaigns/:id/send: 404 when campaign does not exist', async () => {
  const db = installRouteDb({ campaignRow: null, lockStatus: null });
  try {
    const res = await callRoute(router, 'post', '/campaigns/:id/send', makeReq());
    assert.equal(res.statusCode, 404);
  } finally { db.restore(); }
});

test('POST /campaigns/:id/send: 409 when campaign is not in a sendable status', async () => {
  const db = installRouteDb({ campaignRow: { ...DRAFT_CAMPAIGN, status: 'completed' }, lockStatus: 'completed' });
  try {
    const res = await callRoute(router, 'post', '/campaigns/:id/send', makeReq());
    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /completed/);
  } finally { db.restore(); }
});

test('POST /campaigns/:id/send: 400 when campaign has no from_number', async () => {
  const db = installRouteDb({ campaignRow: { ...DRAFT_CAMPAIGN, from_number: null } });
  try {
    const res = await callRoute(router, 'post', '/campaigns/:id/send', makeReq());
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /from_number/);
  } finally { db.restore(); }
});

test('POST /campaigns/:id/send: 400 when from_number does not resolve to a WhatsApp account in this workspace', async () => {
  const db = installRouteDb({ campaignRow: DRAFT_CAMPAIGN });
  const originalImpl = getAccountByPhoneNumberImpl;
  getAccountByPhoneNumberImpl = async () => null;
  try {
    const res = await callRoute(router, 'post', '/campaigns/:id/send', makeReq());
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /WhatsApp account/);
  } finally { db.restore(); getAccountByPhoneNumberImpl = originalImpl; }
});

test('POST /campaigns/:id/send: 403 when template does not belong to this workspace', async () => {
  const db = installRouteDb({ campaignRow: DRAFT_CAMPAIGN, templateExists: false });
  try {
    const res = await callRoute(router, 'post', '/campaigns/:id/send', makeReq());
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /template/);
  } finally { db.restore(); }
});

test('POST /campaigns/:id/send: 400 empty final audience is rejected safely (no broadcast created)', async () => {
  const db = installRouteDb({ campaignRow: { ...DRAFT_CAMPAIGN, selected_contact_ids: [] } });
  // Override the deduped-contacts query to return zero rows for this test.
  const originalQuery = pool.query;
  pool.query = async (sql, params) => {
    if (/SELECT deduped\.id, deduped\.contact_number, deduped\.name/.test(sql)) return { rows: [] };
    return originalQuery(sql, params);
  };
  try {
    const res = await callRoute(router, 'post', '/campaigns/:id/send', makeReq());
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /No customers match/);
    assert.ok(!db.calls.some((c) => /INSERT INTO coexistence\.broadcasts/.test(c.sql)));
  } finally { db.restore(); }
});

test('POST /campaigns/:id/send: double-send protection — a concurrent claim (status already flipped under FOR UPDATE) is rejected with 409, no second broadcast', async () => {
  // Simulates "Request B" arriving after "Request A" already committed its
  // status flip: the initial (non-locking) load still shows 'draft' (it ran
  // before A committed), but the row-locked re-check inside the transaction
  // now sees 'queued' — this is exactly the concurrency window the FOR
  // UPDATE re-check exists to close.
  const db = installRouteDb({ campaignRow: DRAFT_CAMPAIGN, lockStatus: 'queued' });
  try {
    const res = await callRoute(router, 'post', '/campaigns/:id/send', makeReq());
    assert.equal(res.statusCode, 409);
    assert.ok(!db.calls.some((c) => /INSERT INTO coexistence\.broadcasts/.test(c.sql)));
  } finally { db.restore(); }
});

test('POST /campaigns/:id/send: happy path creates exactly ONE broadcast, links campaigns.broadcast_id, and returns running status', async () => {
  const db = installRouteDb({ campaignRow: DRAFT_CAMPAIGN, lockStatus: 'draft', broadcastInsertId: 777 });
  const originalImpl = sendBroadcastByIdImpl;
  let sendCalls = 0;
  sendBroadcastByIdImpl = async (workspaceId, broadcastId) => {
    sendCalls += 1;
    assert.equal(workspaceId, 7);
    assert.equal(broadcastId, 777);
    return { statusCode: 200, body: { enqueued: 1 } };
  };
  try {
    const res = await callRoute(router, 'post', '/campaigns/:id/send', makeReq());
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.broadcastId, 777);
    assert.equal(res.body.recipientCount, 1);
    assert.equal(sendCalls, 1);
    const insertCalls = db.calls.filter((c) => /INSERT INTO coexistence\.broadcasts/.test(c.sql));
    assert.equal(insertCalls.length, 1); // exactly ONE broadcast
  } finally { db.restore(); sendBroadcastByIdImpl = originalImpl; }
});

test('POST /campaigns/:id/send: sendBroadcastById failure marks the campaign failed, not successful', async () => {
  const db = installRouteDb({ campaignRow: DRAFT_CAMPAIGN, lockStatus: 'draft' });
  const originalImpl = sendBroadcastByIdImpl;
  sendBroadcastByIdImpl = async () => ({ statusCode: 400, body: { error: 'No recipients selected' } });
  try {
    const res = await callRoute(router, 'post', '/campaigns/:id/send', makeReq());
    assert.equal(res.statusCode, 400);
    const failCalls = db.calls.filter(
      (c) => /UPDATE coexistence\.campaigns SET/.test(c.sql) && Array.isArray(c.params) && c.params.includes('failed')
    );
    assert.ok(failCalls.length >= 1);
  } finally { db.restore(); sendBroadcastByIdImpl = originalImpl; }
});