'use strict';

// ZOHO PHASE 8 — FINAL FIX: CONSOLIDATE NOTES.
//
// Focused tests for zohoNoteService.upsertConversationNote — the new
// entry point zohoSyncService now calls instead of createNote so that
// EXACTLY ONE AKChat conversation Note exists per Zoho Lead, updated in
// place on every successful sync rather than a new Note being created
// every time a customer sends another message.
//
// Same no-real-Postgres / no-real-Zoho approach as test/zohoNoteService.test.js:
// pool.query mocked on the shared '../src/db' singleton, global.fetch
// stubbed for all Zoho CRM HTTP calls.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

process.env.AKCHAT_ENCRYPTION_KEY = process.env.AKCHAT_ENCRYPTION_KEY || nodeCrypto.randomBytes(24).toString('hex');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-zoho-note-consolidation-tests';
process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REDIRECT_URI = process.env.ZOHO_REDIRECT_URI || 'https://app.example.com/api/zoho/oauth/callback';

const { encrypt } = require('../src/util/crypto');

const WORKSPACE_ID = 1;
const WA_ACCOUNT_ID = 5;
const RAW_CONTACT_NUMBER = '+91 99999 99999';
const NORMALIZED_CONTACT_NUMBER = '919999999999';
const ZOHO_LEAD_ID = 'zoho-lead-123';
const CONSOLIDATED_KEY = 'akchat-conversation-sync';

const OWNED_WA_ACCOUNT = { rows: [{ id: WA_ACCOUNT_ID }] };

function connectedConnectionRow(overrides = {}) {
  return {
    id: 10,
    workspace_id: WORKSPACE_ID,
    whatsapp_account_id: WA_ACCOUNT_ID,
    status: 'connected',
    zoho_api_domain: 'https://www.zohoapis.in',
    zoho_data_center: 'in',
    access_token_encrypted: encrypt('valid-access-token'),
    refresh_token_encrypted: encrypt('valid-refresh-token'),
    token_expires_at: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides,
  };
}

function linkedLeadRow(overrides = {}) {
  return {
    id: 77,
    workspace_id: WORKSPACE_ID,
    whatsapp_account_id: WA_ACCOUNT_ID,
    contact_number: NORMALIZED_CONTACT_NUMBER,
    zoho_lead_id: ZOHO_LEAD_ID,
    status: 'synced',
    ...overrides,
  };
}

function baseRouter({ connectionRow = connectedConnectionRow(), linkRow = linkedLeadRow() } = {}) {
  return (sql, params) => {
    if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED_WA_ACCOUNT;
    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE workspace_id/i.test(sql)) {
      return { rows: [connectionRow] };
    }
    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE id/i.test(sql)) {
      return { rows: [connectionRow] };
    }
    if (/^UPDATE coexistence\.zoho_connections SET last_success_at/i.test(sql)) {
      return { rows: [connectionRow] };
    }
    if (/^SELECT \* FROM coexistence\.zoho_lead_links/i.test(sql)) {
      return { rows: linkRow ? [linkRow] : [] };
    }
    return undefined;
  };
}

function withMockedEnv({ queryHandler, fetchHandler }, run) {
  return async () => {
    const pool = require('../src/db');
    const originalQuery = pool.query;
    const originalFetch = global.fetch;
    const queries = [];

    pool.query = async (sql, params) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      queries.push({ sql: normalized, params });
      const result = queryHandler(normalized, params, queries);
      return result !== undefined ? result : { rows: [] };
    };

    let fetchCalls = [];
    global.fetch = async (url, opts) => {
      fetchCalls.push({ url, opts });
      return fetchHandler(url, opts, fetchCalls);
    };

    try {
      for (const modName of ['zohoNoteService', 'zohoLeadService', 'zohoConnectionService', 'zohoTokenService', 'zohoOAuthService', 'contactSyncService']) {
        delete require.cache[require.resolve(`../src/services/${modName}`)];
      }
      const svc = require('../src/services/zohoNoteService');
      await run(svc, queries, fetchCalls);
    } finally {
      pool.query = originalQuery;
      global.fetch = originalFetch;
    }
  };
}

function zohoNoteSuccessResponse(id) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: [{ code: 'SUCCESS', status: 'success', details: { id } }] }),
  };
}

// In-memory fake of the zoho_lead_notes row so multi-call tests (create
// then update) behave like a real table without needing real Postgres.
function fakeNotesTable() {
  let row = null; // { id, ...columns }
  let nextId = 1;
  return {
    router(sql, params) {
      if (/^SELECT \* FROM coexistence\.zoho_lead_notes WHERE workspace_id .* AND idempotency_key/i.test(sql)) {
        return { rows: row ? [row] : [] };
      }
      if (/^INSERT INTO coexistence\.zoho_lead_notes/i.test(sql)) {
        if (row) return { rows: [] }; // conflict — a row already exists
        row = {
          id: nextId++,
          workspace_id: params[0],
          whatsapp_account_id: params[1],
          zoho_connection_id: params[2],
          zoho_lead_id: params[3],
          contact_number: params[4],
          idempotency_key: params[5],
          status: 'pending',
          zoho_note_id: null,
          note_fields: JSON.parse(params[6]),
        };
        return { rows: [row] };
      }
      if (/^UPDATE coexistence\.zoho_lead_notes SET zoho_note_id/i.test(sql)) {
        row = { ...row, zoho_note_id: params[1], status: 'synced', last_error: null, note_fields: JSON.parse(params[2]) };
        return { rows: [row] };
      }
      if (/^UPDATE coexistence\.zoho_lead_notes SET status = 'synced'/i.test(sql)) {
        row = { ...row, status: 'synced', last_error: null, note_fields: JSON.parse(params[1]) };
        return { rows: [row] };
      }
      if (/^UPDATE coexistence\.zoho_lead_notes SET status = 'failed'/i.test(sql)) {
        row = { ...row, status: 'failed', last_error: params[1] };
        return { rows: [] };
      }
      if (/^UPDATE coexistence\.zoho_lead_notes\s+SET status = 'pending'/i.test(sql)) {
        row = { ...row, status: 'pending', note_fields: JSON.parse(params[1]) };
        return { rows: [row] };
      }
      return undefined;
    },
    get current() { return row; },
  };
}

// ── a) first sync creates one Note ─────────────────────────────────────

test('upsertConversationNote: first sync creates exactly one Note (POST), row starts pending then synced', withMockedEnv({
  queryHandler: (() => {
    const table = fakeNotesTable();
    return (sql, params) => {
      const handled = table.router(sql, params);
      if (handled !== undefined) return handled;
      return baseRouter()(sql, params);
    };
  })(),
  fetchHandler: (url, opts) => {
    assert.match(url, new RegExp(`/crm/v2/Leads/${ZOHO_LEAD_ID}/Notes$`));
    assert.equal(opts.method, 'POST');
    const body = JSON.parse(opts.body);
    assert.match(body.data[0].Note_Content, /Name: Ravi/);
    return zohoNoteSuccessResponse('note-1');
  },
}, async (svc, _queries, fetchCalls) => {
  const result = await svc.upsertConversationNote({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    name: 'Ravi',
  });
  assert.equal(result.created, true);
  assert.equal(result.zohoNoteId, 'note-1');
  assert.equal(fetchCalls.length, 1);
}));

// ── b) second sync updates the same Note ────────────────────────────────

test('upsertConversationNote: second sync with new info UPDATEs the same Zoho Note (PUT), never a second POST', withMockedEnv({
  queryHandler: (() => {
    const table = fakeNotesTable();
    return (sql, params) => {
      const handled = table.router(sql, params);
      if (handled !== undefined) return handled;
      return baseRouter()(sql, params);
    };
  })(),
  fetchHandler: (url, opts) => {
    if (opts.method === 'POST') return zohoNoteSuccessResponse('note-1');
    assert.equal(opts.method, 'PUT');
    assert.match(url, new RegExp(`/crm/v2/Leads/${ZOHO_LEAD_ID}/Notes/note-1$`));
    const body = JSON.parse(opts.body);
    assert.equal(body.data[0].id, 'note-1');
    assert.match(body.data[0].Note_Content, /Name: Ravi/);
    assert.match(body.data[0].Note_Content, /Location: Chennai/);
    return zohoNoteSuccessResponse('note-1');
  },
}, async (svc, _queries, fetchCalls) => {
  const first = await svc.upsertConversationNote({
    workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, name: 'Ravi',
  });
  assert.equal(first.created, true);

  const second = await svc.upsertConversationNote({
    workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, location: 'Chennai',
  });
  assert.equal(second.created, false);
  assert.equal(second.updated, true);
  assert.equal(second.zohoNoteId, 'note-1');

  const postCalls = fetchCalls.filter((c) => c.opts.method === 'POST');
  const putCalls = fetchCalls.filter((c) => c.opts.method === 'PUT');
  assert.equal(postCalls.length, 1, 'must never create a second Zoho Note');
  assert.equal(putCalls.length, 1);
}));

// ── b2) REGRESSION — two near-simultaneous inbound messages for the SAME
// Lead (webhook.js fires syncConversationToZoho in the background,
// unawaited, for every incoming message) must not lose either update.
// Without the per-contact lock, both calls read the same pre-update row,
// merge their own new field into that stale snapshot, and whichever
// UPDATE commits last overwrites the other's field. This is the real
// runtime bug behind "message 2 updated the Note, but a later concurrent
// message's info never showed up" — it never reproduces in the other
// (sequential) tests in this file.
test('upsertConversationNote: two concurrent syncs for the same Lead (message overlap) both land — no lost update', withMockedEnv({
  queryHandler: (() => {
    const table = fakeNotesTable();
    return (sql, params) => {
      const handled = table.router(sql, params);
      if (handled !== undefined) return handled;
      return baseRouter()(sql, params);
    };
  })(),
  fetchHandler: async (url, opts) => {
    if (opts.method === 'POST') return zohoNoteSuccessResponse('note-1');
    // Simulate a real Zoho HTTP round-trip taking actual wall-clock time —
    // this is the window in which two concurrent callers used to race
    // each other's read-merge-write cycle before the per-contact lock.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return zohoNoteSuccessResponse('note-1');
  },
}, async (svc, _queries, fetchCalls) => {
  const first = await svc.upsertConversationNote({
    workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, name: 'Subash',
  });
  assert.equal(first.created, true);

  // Fire both "next messages" concurrently, exactly like two inbound
  // WhatsApp messages arriving close together and both invoking
  // syncConversationToZoho() in the background without awaiting each other.
  const [locationResult, emailResult] = await Promise.all([
    svc.upsertConversationNote({
      workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, location: 'Erode',
    }),
    svc.upsertConversationNote({
      workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, email: 'subash@test.com',
    }),
  ]);

  assert.equal(locationResult.updated, true);
  assert.equal(emailResult.updated, true);

  const putCalls = fetchCalls.filter((c) => c.opts.method === 'PUT');
  assert.equal(putCalls.length, 2, 'each new confirmed field gets its own update, never silently dropped');

  // The final Zoho content (from the LAST PUT to actually complete) must
  // carry BOTH fields merged in — neither call's contribution lost.
  const finalBody = JSON.parse(putCalls[putCalls.length - 1].opts.body);
  assert.match(finalBody.data[0].Note_Content, /Name: Subash/);
  assert.match(finalBody.data[0].Note_Content, /Location: Erode/);
  assert.match(finalBody.data[0].Note_Content, /Email: subash@test\.com/);
}));

// ── c) name + location + email from separate messages -> one consolidated Note ──

test('upsertConversationNote: name, location, and email arriving in separate messages merge into one consolidated Note', withMockedEnv({
  queryHandler: (() => {
    const table = fakeNotesTable();
    return (sql, params) => {
      const handled = table.router(sql, params);
      if (handled !== undefined) return handled;
      return baseRouter()(sql, params);
    };
  })(),
  fetchHandler: (url, opts) => zohoNoteSuccessResponse('note-1'),
}, async (svc, _queries, fetchCalls) => {
  await svc.upsertConversationNote({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, name: 'Suresh' });
  await svc.upsertConversationNote({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, location: 'Madurai' });
  const third = await svc.upsertConversationNote({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, email: 'suresh@test.com' });

  assert.equal(third.zohoNoteId, 'note-1');

  const lastPut = fetchCalls.filter((c) => c.opts.method === 'PUT').pop();
  const content = JSON.parse(lastPut.opts.body).data[0].Note_Content;
  assert.match(content, /Name: Suresh/);
  assert.match(content, /Location: Madurai/);
  assert.match(content, /Email: suresh@test\.com/);

  // Exactly one POST (creation), never a second Note created for this Lead.
  assert.equal(fetchCalls.filter((c) => c.opts.method === 'POST').length, 1);
}));

// ── d) duplicate information is not repeated ─────────────────────────────

test('upsertConversationNote: resubmitting the same already-confirmed info produces no duplicate line and no extra Zoho call', withMockedEnv({
  queryHandler: (() => {
    const table = fakeNotesTable();
    return (sql, params) => {
      const handled = table.router(sql, params);
      if (handled !== undefined) return handled;
      return baseRouter()(sql, params);
    };
  })(),
  fetchHandler: () => zohoNoteSuccessResponse('note-1'),
}, async (svc, _queries, fetchCalls) => {
  await svc.upsertConversationNote({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, name: 'Suresh', location: 'Madurai' });
  const callsAfterFirst = fetchCalls.length;

  // Same name AND location resubmitted (e.g. re-run extraction on retry) —
  // merged content is byte-identical, so no PUT should ever be issued.
  const repeat = await svc.upsertConversationNote({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, name: 'Suresh', location: 'Madurai' });

  assert.equal(repeat.unchanged, true);
  assert.equal(repeat.created, false);
  assert.equal(repeat.updated, false);
  assert.equal(fetchCalls.length, callsAfterFirst, 'must not call Zoho again for unchanged content');
}));

// ── e) retry does not create duplicate Notes ─────────────────────────────

test('upsertConversationNote: a previously-failed (never synced) attempt is retried in place, never inserting a second row/Note', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^SELECT \* FROM coexistence\.zoho_lead_notes WHERE workspace_id .* AND idempotency_key/i.test(sql)) {
      return { rows: [{ id: 55, workspace_id: WORKSPACE_ID, whatsapp_account_id: WA_ACCOUNT_ID, zoho_lead_id: ZOHO_LEAD_ID, contact_number: NORMALIZED_CONTACT_NUMBER, idempotency_key: CONSOLIDATED_KEY, status: 'failed', zoho_note_id: null, note_fields: {} }] };
    }
    if (/^UPDATE coexistence\.zoho_lead_notes\s+SET status = 'pending'/i.test(sql)) {
      return { rows: [{ id: 55, status: 'pending' }] };
    }
    if (/^UPDATE coexistence\.zoho_lead_notes SET zoho_note_id/i.test(sql)) {
      return { rows: [{ id: 55, status: 'synced', zoho_note_id: 'note-retry' }] };
    }
    if (/^INSERT INTO coexistence\.zoho_lead_notes/i.test(sql)) {
      throw new Error('must never INSERT a second row for this Lead — must UPDATE the existing failed row instead');
    }
    return baseRouter()(sql, params);
  },
  fetchHandler: () => zohoNoteSuccessResponse('note-retry'),
}, async (svc, _queries, fetchCalls) => {
  const result = await svc.upsertConversationNote({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, name: 'Ravi' });
  assert.equal(result.zohoNoteId, 'note-retry');
  assert.equal(fetchCalls.length, 1);
}));

test('upsertConversationNote: a concurrent in-flight attempt (still pending) is rejected as in-progress, never re-created', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^SELECT \* FROM coexistence\.zoho_lead_notes WHERE workspace_id .* AND idempotency_key/i.test(sql)) {
      return { rows: [{ id: 56, status: 'pending', zoho_note_id: null, note_fields: {} }] };
    }
    if (/^UPDATE coexistence\.zoho_lead_notes\s+SET status = 'pending'/i.test(sql)) {
      return { rows: [] }; // guard: WHERE status <> 'pending' matched nothing
    }
    return baseRouter()(sql, params);
  },
  fetchHandler: () => { throw new Error('must not call Zoho'); },
}, async (svc) => {
  await assert.rejects(
    svc.upsertConversationNote({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, name: 'Ravi' }),
    (err) => err.status === 409
  );
}));

// ── f) existing Lead behavior remains unchanged ──────────────────────────
// (i.e. this new code path never touches zoho_lead_links / Lead creation —
// it only ever READS the lead link to find which Lead to attach the Note
// to, exactly like createNote already does.)

test('upsertConversationNote: never issues any INSERT/UPDATE against coexistence.zoho_lead_links (Lead behavior untouched)', withMockedEnv({
  queryHandler: (() => {
    const table = fakeNotesTable();
    return (sql, params) => {
      const handled = table.router(sql, params);
      if (handled !== undefined) return handled;
      return baseRouter()(sql, params);
    };
  })(),
  fetchHandler: () => zohoNoteSuccessResponse('note-1'),
}, async (svc, queries) => {
  await svc.upsertConversationNote({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, name: 'Ravi' });
  const leadLinkWrites = queries.filter((q) => /^(INSERT INTO|UPDATE)\s+coexistence\.zoho_lead_links/i.test(q.sql));
  assert.deepEqual(leadLinkWrites, []);
}));

test('upsertConversationNote: rejects when no linked Zoho Lead exists for this contact (never invents one)', withMockedEnv({
  queryHandler: baseRouter({ linkRow: null }),
  fetchHandler: () => { throw new Error('must not call Zoho'); },
}, async (svc) => {
  await assert.rejects(
    svc.upsertConversationNote({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: RAW_CONTACT_NUMBER, name: 'Ravi' }),
    (err) => err.status === 404
  );
}));
// ── Merge/render helpers (pure) ───────────────────────────────────────────
test('mergeConversationFields: incoming values overwrite, missing incoming values preserve existing', withMockedEnv({ queryHandler: () => undefined, fetchHandler: () => { throw new Error('no fetch expected'); } }, async (svc) => {
  const merged = svc.mergeConversationFields({ name: 'Suresh' }, { location: 'Madurai' });
  assert.equal(merged.name, 'Suresh');
  assert.equal(merged.location, 'Madurai');
}));

test('mergeConversationFields: dynamic business fields merge by key without duplicating', withMockedEnv({ queryHandler: () => undefined, fetchHandler: () => { throw new Error('no fetch expected'); } }, async (svc) => {
  const merged = svc.mergeConversationFields(
    { dynamic: { roof_type: { label: 'Roof Type', value: 'Metal' } } },
    { dynamicFields: [{ fieldKey: 'roof_type', fieldLabel: 'Roof Type', value: 'Metal' }, { fieldKey: 'pipe_size', fieldLabel: 'Pipe Size', value: '2 inch' }] }
  );
  assert.equal(Object.keys(merged.dynamic).length, 2);
  assert.equal(merged.dynamic.roof_type.value, 'Metal');
  assert.equal(merged.dynamic.pipe_size.value, '2 inch');
}));

test('renderConsolidatedNoteContent: omits empty fields, never fabricates a line for missing info', withMockedEnv({ queryHandler: () => undefined, fetchHandler: () => { throw new Error('no fetch expected'); } }, async (svc) => {
  const content = svc.renderConsolidatedNoteContent({ name: 'Suresh' });
  assert.equal(content, 'Name: Suresh');
  assert.doesNotMatch(content, /Location/);
  assert.doesNotMatch(content, /Email/);
}));