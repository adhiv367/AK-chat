'use strict';

// Phase 8C Part 2 — Lead + Note route tests for
// routes/integrations/zoho.js's POST /leads, PUT /leads/:leadId, and
// POST /leads/:leadId/notes. Same "no live Postgres, no supertest"
// approach as test/zohoRoutes.test.js: route handlers are pulled straight
// off router.stack and invoked with a mocked req/res (authMiddleware /
// attachWorkspace are not part of what's under test here — same as
// test/zohoRoutes.test.js). pool.query is monkey-patched on the shared
// '../src/db' singleton with a tiny in-memory model, and global.fetch is
// stubbed for the Zoho Leads/Notes API calls zohoLeadService.js /
// zohoNoteService.js make.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

process.env.AKCHAT_ENCRYPTION_KEY = process.env.AKCHAT_ENCRYPTION_KEY || nodeCrypto.randomBytes(24).toString('hex');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REDIRECT_URI = process.env.ZOHO_REDIRECT_URI || 'https://app.example.test/api/integrations/zoho/callback';

const { encrypt } = require('../src/util/crypto');

const WORKSPACE_A = 1;
const WORKSPACE_B = 2;
const WA_ACCOUNT_A = 10; // belongs to workspace A
const WA_ACCOUNT_B = 20; // belongs to workspace B
const RAW_CONTACT_NUMBER = '+91 99999 99999';
const NORMALIZED_CONTACT_NUMBER = '919999999999';

function baseAccounts() {
  return [
    { id: WA_ACCOUNT_A, workspace_id: WORKSPACE_A },
    { id: WA_ACCOUNT_B, workspace_id: WORKSPACE_B },
  ];
}

function connectedConnection(overrides = {}) {
  return {
    id: 1,
    workspace_id: WORKSPACE_A,
    whatsapp_account_id: WA_ACCOUNT_A,
    status: 'connected',
    zoho_api_domain: 'https://www.zohoapis.in',
    zoho_data_center: 'in',
    access_token_encrypted: encrypt('valid-access-token'),
    refresh_token_encrypted: encrypt('valid-refresh-token'),
    token_expires_at: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides,
  };
}

// ── In-memory model covering everything the routes touch underneath:
// whatsapp_accounts (ownership), zoho_connections (zohoConnectionService/
// zohoTokenService), zoho_lead_links (zohoLeadService), zoho_lead_notes
// (zohoNoteService).
function makeDb({ whatsappAccounts = [], connections = [], leadLinks = [], leadNotes = [] } = {}) {
  let nextLinkId = (leadLinks.reduce((m, r) => Math.max(m, r.id), 0) || 0) + 1;
  let nextNoteId = (leadNotes.reduce((m, r) => Math.max(m, r.id), 0) || 0) + 1;

  function findConnection(workspaceId, whatsappAccountId) {
    return connections.find((c) => c.workspace_id === Number(workspaceId) && c.whatsapp_account_id === Number(whatsappAccountId));
  }
  function findConnectionById(id) {
    return connections.find((c) => c.id === Number(id));
  }
  function findLink(workspaceId, whatsappAccountId, contactNumber) {
    return leadLinks.find((r) => r.workspace_id === Number(workspaceId) && r.whatsapp_account_id === Number(whatsappAccountId) && r.contact_number === contactNumber);
  }
  function findNote(workspaceId, whatsappAccountId, zohoLeadId, idempotencyKey) {
    return leadNotes.find((r) => r.workspace_id === Number(workspaceId) && r.whatsapp_account_id === Number(whatsappAccountId) && r.zoho_lead_id === zohoLeadId && r.idempotency_key === idempotencyKey);
  }

  async function query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (/^SELECT id FROM coexistence\.whatsapp_accounts WHERE id = \$1 AND workspace_id = \$2/i.test(s)) {
      const [waId, wsId] = params;
      const owned = whatsappAccounts.some((a) => a.id === Number(waId) && a.workspace_id === Number(wsId));
      return { rows: owned ? [{ id: Number(waId) }] : [] };
    }

    if (/^SELECT \* FROM coexistence\.zoho_connections\s+WHERE workspace_id = \$1 AND whatsapp_account_id = \$2/i.test(s)) {
      const row = findConnection(params[0], params[1]);
      return { rows: row ? [row] : [] };
    }

    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE id = \$1$/i.test(s)) {
      const row = findConnectionById(params[0]);
      return { rows: row ? [row] : [] };
    }

    if (/^UPDATE coexistence\.zoho_connections\s+SET last_success_at = NOW\(\)/i.test(s)) {
      const row = findConnectionById(params[0]);
      if (row) row.last_success_at = new Date();
      return { rows: row ? [row] : [] };
    }

    if (/^UPDATE coexistence\.zoho_connections\s+SET status = 'reauth_required'/i.test(s)) {
      const row = findConnectionById(params[0]);
      if (row) { row.status = 'reauth_required'; row.last_error = params[1]; }
      return { rows: row ? [row] : [] };
    }

    if (/^UPDATE coexistence\.zoho_connections SET /i.test(s)) {
      // atomicTokenUpdate (dynamic SET list) — id is always the last param.
      const row = findConnectionById(params[params.length - 1]);
      return { rows: row ? [row] : [] };
    }

    // ── zoho_lead_links ────────────────────────────────────────────────
    if (/^INSERT INTO coexistence\.zoho_lead_links/i.test(s)) {
      const [wsId, waId, connectionId, contactNumber] = params;
      if (findLink(wsId, waId, contactNumber)) return { rows: [] }; // conflict
      const row = { id: nextLinkId++, workspace_id: Number(wsId), whatsapp_account_id: Number(waId), zoho_connection_id: Number(connectionId), contact_number: contactNumber, zoho_lead_id: null, status: 'pending', last_synced_at: null, last_error: null };
      leadLinks.push(row);
      return { rows: [row] };
    }
    if (/^SELECT \* FROM coexistence\.zoho_lead_links\s+WHERE workspace_id = \$1 AND whatsapp_account_id = \$2 AND contact_number = \$3/i.test(s)) {
      const row = findLink(params[0], params[1], params[2]);
      return { rows: row ? [row] : [] };
    }
    if (/^UPDATE coexistence\.zoho_lead_links\s+SET zoho_lead_id = \$2/i.test(s)) {
      const [id, zohoLeadId] = params;
      const row = leadLinks.find((r) => r.id === Number(id));
      if (row) { row.zoho_lead_id = zohoLeadId; row.status = 'synced'; row.last_error = null; }
      return { rows: row ? [row] : [] };
    }
    if (/^UPDATE coexistence\.zoho_lead_links\s+SET status = 'synced'/i.test(s)) {
      const [id] = params;
      const row = leadLinks.find((r) => r.id === Number(id));
      if (row) { row.status = 'synced'; row.last_error = null; }
      return { rows: row ? [row] : [] };
    }
    if (/^UPDATE coexistence\.zoho_lead_links\s+SET status = 'failed'/i.test(s)) {
      const [id, err] = params;
      const row = leadLinks.find((r) => r.id === Number(id));
      if (row) { row.status = 'failed'; row.last_error = err; }
      return { rows: row ? [row] : [] };
    }

    // ── zoho_lead_notes ───────────────────────────────────────────────
    if (/^INSERT INTO coexistence\.zoho_lead_notes/i.test(s)) {
      const [wsId, waId, connectionId, zohoLeadId, contactNumber, idempotencyKey] = params;
      if (findNote(wsId, waId, zohoLeadId, idempotencyKey)) return { rows: [] }; // conflict
      const row = { id: nextNoteId++, workspace_id: Number(wsId), whatsapp_account_id: Number(waId), zoho_connection_id: Number(connectionId), zoho_lead_id: zohoLeadId, contact_number: contactNumber, idempotency_key: idempotencyKey, zoho_note_id: null, status: 'pending', last_error: null };
      leadNotes.push(row);
      return { rows: [row] };
    }
    if (/^SELECT \* FROM coexistence\.zoho_lead_notes\s+WHERE workspace_id = \$1 AND whatsapp_account_id = \$2 AND zoho_lead_id = \$3 AND idempotency_key = \$4/i.test(s)) {
      const row = findNote(params[0], params[1], params[2], params[3]);
      return { rows: row ? [row] : [] };
    }
    if (/^UPDATE coexistence\.zoho_lead_notes\s+SET zoho_note_id = \$2/i.test(s)) {
      const [id, zohoNoteId] = params;
      const row = leadNotes.find((r) => r.id === Number(id));
      if (row) { row.zoho_note_id = zohoNoteId; row.status = 'synced'; row.last_error = null; }
      return { rows: row ? [row] : [] };
    }
    if (/^UPDATE coexistence\.zoho_lead_notes\s+SET status = 'failed'/i.test(s)) {
      const [id, err] = params;
      const row = leadNotes.find((r) => r.id === Number(id));
      if (row) { row.status = 'failed'; row.last_error = err; }
      return { rows: row ? [row] : [] };
    }

    return { rows: [] };
  }

  return { query, whatsappAccounts, connections, leadLinks, leadNotes };
}

function installDb(dbState) {
  const pool = require('../src/db');
  const original = pool.query;
  pool.query = dbState.query;
  return () => { pool.query = original; };
}

function freshModules() {
  for (const name of [
    '../src/services/zohoConnectionService',
    '../src/services/zohoTokenService',
    '../src/services/zohoOAuthService',
    '../src/services/zohoLeadService',
    '../src/services/zohoNoteService',
    '../src/services/contactSyncService',
    '../src/routes/integrations/zoho',
  ]) {
    delete require.cache[require.resolve(name)];
  }
  return require('../src/routes/integrations/zoho').router;
}

function getHandler(router, method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    set(key, value) { this.headers[key] = value; return this; },
  };
}

function mockReq({ workspace, user, params = {}, body = {} } = {}) {
  return { workspace, user, query: {}, params, body };
}

function withFetch(dispatcher, run) {
  return async () => {
    const original = global.fetch;
    global.fetch = dispatcher;
    try {
      await run();
    } finally {
      global.fetch = original;
    }
  };
}

function zohoLeadFetchDispatcher({ leadId = 'zoho-lead-1', noteId = 'zoho-note-1', leadFails, noteFails } = {}) {
  return async (url, opts) => {
    const s = String(url);
    if (s.includes('/crm/v2/Leads') && s.includes('/Notes')) {
      if (noteFails) return { ok: false, status: noteFails, json: async () => ({ data: [{ code: 'ERROR', status: 'error' }] }) };
      return { ok: true, status: 200, json: async () => ({ data: [{ code: 'SUCCESS', status: 'success', details: { id: noteId } }] }) };
    }
    if (s.match(/\/crm\/v2\/Leads\/[^/]+$/) && opts.method === 'PUT') {
      if (leadFails) return { ok: false, status: leadFails, json: async () => ({ data: [{ code: 'ERROR', status: 'error' }] }) };
      return { ok: true, status: 200, json: async () => ({ data: [{ code: 'SUCCESS', status: 'success', details: { id: leadId } }] }) };
    }
    if (s.endsWith('/crm/v2/Leads') && opts.method === 'POST') {
      if (leadFails) return { ok: false, status: leadFails, json: async () => ({ data: [{ code: 'ERROR', status: 'error' }] }) };
      return { ok: true, status: 200, json: async () => ({ data: [{ code: 'SUCCESS', status: 'success', details: { id: leadId } }] }) };
    }
    throw new Error(`unexpected fetch url: ${url}`);
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CREATE LEAD — POST /integrations/zoho/leads
// ═══════════════════════════════════════════════════════════════════════

test('CREATE LEAD: authenticated + owned account creates a Lead and returns a safe result', withFetch(zohoLeadFetchDispatcher(), async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts(), connections: [connectedConnection()] });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'post', '/integrations/zoho/leads');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, user: { id: 1 }, body: { whatsappAccountId: WA_ACCOUNT_A, contactNumber: RAW_CONTACT_NUMBER, name: 'Ravi Kumar' } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.lead.zohoLeadId, 'zoho-lead-1');
    assert.equal(JSON.stringify(res.body).includes('token'), false, 'response must never include token fields');
  } finally {
    restore();
  }
}));

test('CREATE LEAD: missing contactNumber is rejected before touching Zoho', withFetch(() => { throw new Error('must not call Zoho'); }, async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts(), connections: [connectedConnection()] });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'post', '/integrations/zoho/leads');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, user: { id: 1 }, body: { whatsappAccountId: WA_ACCOUNT_A } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 400);
  } finally {
    restore();
  }
}));

test('CREATE LEAD: WhatsApp account belonging to a different workspace is rejected', withFetch(() => { throw new Error('must not call Zoho'); }, async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts(), connections: [connectedConnection()] });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'post', '/integrations/zoho/leads');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, user: { id: 1 }, body: { whatsappAccountId: WA_ACCOUNT_B, contactNumber: RAW_CONTACT_NUMBER } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 404);
  } finally {
    restore();
  }
}));

test('CREATE LEAD: missing Zoho connection returns a safe error', withFetch(() => { throw new Error('must not call Zoho'); }, async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts(), connections: [] });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'post', '/integrations/zoho/leads');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, user: { id: 1 }, body: { whatsappAccountId: WA_ACCOUNT_A, contactNumber: RAW_CONTACT_NUMBER } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.success, false);
  } finally {
    restore();
  }
}));

test('CREATE LEAD + NOTE: Lead succeeds and Note succeeds — both returned', withFetch(zohoLeadFetchDispatcher(), async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts(), connections: [connectedConnection()] });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'post', '/integrations/zoho/leads');
    const req = mockReq({
      workspace: { id: WORKSPACE_A },
      user: { id: 1 },
      body: { whatsappAccountId: WA_ACCOUNT_A, contactNumber: RAW_CONTACT_NUMBER, name: 'Ravi Kumar', note: { title: 'Interested', content: 'Wants a quote' } },
    });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.lead.zohoLeadId, 'zoho-lead-1');
    assert.equal(res.body.note.zohoNoteId, 'zoho-note-1');
  } finally {
    restore();
  }
}));

test('CREATE LEAD + NOTE: Lead succeeds, Note fails — safe partial-success (Lead never deleted, contactNumber preserved for retry)', withFetch(zohoLeadFetchDispatcher({ noteFails: 400 }), async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts(), connections: [connectedConnection()] });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'post', '/integrations/zoho/leads');
    const req = mockReq({
      workspace: { id: WORKSPACE_A },
      user: { id: 1 },
      body: { whatsappAccountId: WA_ACCOUNT_A, contactNumber: RAW_CONTACT_NUMBER, name: 'Ravi Kumar', note: { title: 'Interested', content: 'Wants a quote' } },
    });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 207);
    assert.equal(res.body.success, true);
    assert.equal(res.body.partial, true);
    assert.equal(res.body.lead.zohoLeadId, 'zoho-lead-1', 'Lead must still be reported as created');
    assert.equal(res.body.note, null);
    assert.ok(res.body.noteError);
    assert.equal(db.leadLinks.length, 1, 'exactly one Lead link — never a second Lead created');
    assert.equal(db.leadLinks[0].status, 'synced', 'the Lead link itself remains synced even though the Note failed');
  } finally {
    restore();
  }
}));

test('CREATE LEAD + NOTE: retrying the same contact after a Note failure does not create a second Lead', withFetch(zohoLeadFetchDispatcher(), async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts(), connections: [connectedConnection()] });
  const restore = installDb(db);
  try {
    const router = freshModules();

    // First attempt (fails on the Note).
    const failingRouter = installDb(db); // no-op, db already installed
    global.fetch = zohoLeadFetchDispatcher({ noteFails: 400 });
    const handler1 = getHandler(router, 'post', '/integrations/zoho/leads');
    const req1 = mockReq({ workspace: { id: WORKSPACE_A }, user: { id: 1 }, body: { whatsappAccountId: WA_ACCOUNT_A, contactNumber: RAW_CONTACT_NUMBER, name: 'Ravi Kumar', note: { content: 'first try' } } });
    await handler1(req1, mockRes());
    failingRouter();

    // Retry: same contact, Lead already linked — must reuse it, not create another.
    global.fetch = zohoLeadFetchDispatcher();
    const handler2 = getHandler(router, 'post', '/integrations/zoho/leads');
    const req2 = mockReq({ workspace: { id: WORKSPACE_A }, user: { id: 1 }, body: { whatsappAccountId: WA_ACCOUNT_A, contactNumber: RAW_CONTACT_NUMBER, name: 'Ravi Kumar', note: { content: 'retry' } } });
    const res2 = mockRes();
    await handler2(req2, res2);

    assert.equal(res2.body.lead.created, false, 'second call must reuse the existing linked Lead');
    assert.equal(db.leadLinks.length, 1);
  } finally {
    restore();
  }
}));

// ═══════════════════════════════════════════════════════════════════════
// UPDATE LEAD — PUT /integrations/zoho/leads/:leadId
// ═══════════════════════════════════════════════════════════════════════

test('UPDATE LEAD: authenticated request with a matching linked Lead updates only supplied fields', withFetch(zohoLeadFetchDispatcher(), async () => {
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [connectedConnection()],
    leadLinks: [{ id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A, contact_number: NORMALIZED_CONTACT_NUMBER, zoho_lead_id: 'zoho-lead-1', status: 'synced' }],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'put', '/integrations/zoho/leads/:leadId');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, user: { id: 1 }, params: { leadId: 'zoho-lead-1' }, body: { whatsappAccountId: WA_ACCOUNT_A, contactNumber: RAW_CONTACT_NUMBER, place: 'Erode' } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.lead.zohoLeadId, 'zoho-lead-1');
  } finally {
    restore();
  }
}));

test('UPDATE LEAD: no linked Zoho Lead found for this contact returns a safe 404', withFetch(() => { throw new Error('must not call Zoho'); }, async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts(), connections: [connectedConnection()], leadLinks: [] });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'put', '/integrations/zoho/leads/:leadId');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, user: { id: 1 }, params: { leadId: 'zoho-lead-1' }, body: { whatsappAccountId: WA_ACCOUNT_A, contactNumber: RAW_CONTACT_NUMBER, place: 'Erode' } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 404);
  } finally {
    restore();
  }
}));

test('UPDATE LEAD: cross-workspace rejection — a Lead linked in workspace B is never updateable from workspace A', withFetch(() => { throw new Error('must not call Zoho'); }, async () => {
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [connectedConnection(), connectedConnection({ id: 2, workspace_id: WORKSPACE_B, whatsapp_account_id: WA_ACCOUNT_B })],
    leadLinks: [{ id: 1, workspace_id: WORKSPACE_B, whatsapp_account_id: WA_ACCOUNT_B, contact_number: NORMALIZED_CONTACT_NUMBER, zoho_lead_id: 'zoho-lead-in-b', status: 'synced' }],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'put', '/integrations/zoho/leads/:leadId');
    // Attacker in workspace A tries to update workspace B's Lead by guessing its id.
    const req = mockReq({ workspace: { id: WORKSPACE_A }, user: { id: 1 }, params: { leadId: 'zoho-lead-in-b' }, body: { whatsappAccountId: WA_ACCOUNT_A, contactNumber: RAW_CONTACT_NUMBER, place: 'Erode' } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 404, 'workspace A has no link for this contact, so it 404s before ever comparing Lead ids');
  } finally {
    restore();
  }
}));

test('UPDATE LEAD: cross-account rejection — supplying a foreign leadId for an owned contact is rejected, never trusted', withFetch(() => { throw new Error('must not call Zoho'); }, async () => {
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [connectedConnection()],
    leadLinks: [{ id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A, contact_number: NORMALIZED_CONTACT_NUMBER, zoho_lead_id: 'zoho-lead-1', status: 'synced' }],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'put', '/integrations/zoho/leads/:leadId');
    // Same workspace/account/contact, but the caller supplies a DIFFERENT
    // (unrelated) Zoho Lead id in the path — must never be trusted.
    const req = mockReq({ workspace: { id: WORKSPACE_A }, user: { id: 1 }, params: { leadId: 'someone-elses-lead-id' }, body: { whatsappAccountId: WA_ACCOUNT_A, contactNumber: RAW_CONTACT_NUMBER, place: 'Erode' } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 404);
    assert.match(res.body.error, /not linked/i);
  } finally {
    restore();
  }
}));

test('UPDATE LEAD: missing Zoho connection returns a safe error', withFetch(() => { throw new Error('must not call Zoho'); }, async () => {
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [],
    leadLinks: [{ id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A, contact_number: NORMALIZED_CONTACT_NUMBER, zoho_lead_id: 'zoho-lead-1', status: 'synced' }],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'put', '/integrations/zoho/leads/:leadId');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, user: { id: 1 }, params: { leadId: 'zoho-lead-1' }, body: { whatsappAccountId: WA_ACCOUNT_A, contactNumber: RAW_CONTACT_NUMBER, place: 'Erode' } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 404);
  } finally {
    restore();
  }
}));

// ═══════════════════════════════════════════════════════════════════════
// ADD NOTE — POST /integrations/zoho/leads/:leadId/notes
// ═══════════════════════════════════════════════════════════════════════

test('ADD NOTE: authenticated request with a matching linked Lead creates the Note', withFetch(zohoLeadFetchDispatcher(), async () => {
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [connectedConnection()],
    leadLinks: [{ id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A, contact_number: NORMALIZED_CONTACT_NUMBER, zoho_lead_id: 'zoho-lead-1', status: 'synced' }],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'post', '/integrations/zoho/leads/:leadId/notes');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, user: { id: 1 }, params: { leadId: 'zoho-lead-1' }, body: { whatsappAccountId: WA_ACCOUNT_A, contactNumber: RAW_CONTACT_NUMBER, title: 'Interested', content: 'Wants a quote' } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.note.zohoNoteId, 'zoho-note-1');
  } finally {
    restore();
  }
}));

test('ADD NOTE: missing content is rejected before touching Zoho', withFetch(() => { throw new Error('must not call Zoho'); }, async () => {
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [connectedConnection()],
    leadLinks: [{ id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A, contact_number: NORMALIZED_CONTACT_NUMBER, zoho_lead_id: 'zoho-lead-1', status: 'synced' }],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'post', '/integrations/zoho/leads/:leadId/notes');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, user: { id: 1 }, params: { leadId: 'zoho-lead-1' }, body: { whatsappAccountId: WA_ACCOUNT_A, contactNumber: RAW_CONTACT_NUMBER } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 400);
  } finally {
    restore();
  }
}));

test('ADD NOTE: cross-account rejection — an arbitrary Zoho Lead id is verified against the local link before calling Zoho', withFetch(() => { throw new Error('must not call Zoho'); }, async () => {
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [connectedConnection()],
    leadLinks: [{ id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A, contact_number: NORMALIZED_CONTACT_NUMBER, zoho_lead_id: 'zoho-lead-1', status: 'synced' }],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'post', '/integrations/zoho/leads/:leadId/notes');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, user: { id: 1 }, params: { leadId: 'unrelated-lead-id' }, body: { whatsappAccountId: WA_ACCOUNT_A, contactNumber: RAW_CONTACT_NUMBER, content: 'hello' } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 404);
  } finally {
    restore();
  }
}));

test('ADD NOTE: cross-workspace rejection', withFetch(() => { throw new Error('must not call Zoho'); }, async () => {
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [connectedConnection(), connectedConnection({ id: 2, workspace_id: WORKSPACE_B, whatsapp_account_id: WA_ACCOUNT_B })],
    leadLinks: [{ id: 1, workspace_id: WORKSPACE_B, whatsapp_account_id: WA_ACCOUNT_B, contact_number: NORMALIZED_CONTACT_NUMBER, zoho_lead_id: 'zoho-lead-in-b', status: 'synced' }],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'post', '/integrations/zoho/leads/:leadId/notes');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, user: { id: 1 }, params: { leadId: 'zoho-lead-in-b' }, body: { whatsappAccountId: WA_ACCOUNT_A, contactNumber: RAW_CONTACT_NUMBER, content: 'hello' } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 404);
  } finally {
    restore();
  }
}));

test('ADD NOTE: duplicate/idempotent submission returns the same Note without a second Zoho call', withFetch(zohoLeadFetchDispatcher(), async () => {
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [connectedConnection()],
    leadLinks: [{ id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A, contact_number: NORMALIZED_CONTACT_NUMBER, zoho_lead_id: 'zoho-lead-1', status: 'synced' }],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'post', '/integrations/zoho/leads/:leadId/notes');

    const body = { whatsappAccountId: WA_ACCOUNT_A, contactNumber: RAW_CONTACT_NUMBER, title: 'Interested', content: 'Wants a quote' };
    const res1 = mockRes();
    await handler(mockReq({ workspace: { id: WORKSPACE_A }, user: { id: 1 }, params: { leadId: 'zoho-lead-1' }, body }), res1);
    const res2 = mockRes();
    await handler(mockReq({ workspace: { id: WORKSPACE_A }, user: { id: 1 }, params: { leadId: 'zoho-lead-1' }, body }), res2);

    assert.equal(res1.body.note.zohoNoteId, res2.body.note.zohoNoteId);
    assert.equal(db.leadNotes.length, 1, 'exactly one Note row — the duplicate submission must not create a second one');
  } finally {
    restore();
  }
}));

test('ADD NOTE: safe errors — Zoho errors never leak raw payload/tokens', withFetch(zohoLeadFetchDispatcher({ noteFails: 500 }), async () => {
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [connectedConnection()],
    leadLinks: [{ id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A, contact_number: NORMALIZED_CONTACT_NUMBER, zoho_lead_id: 'zoho-lead-1', status: 'synced' }],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'post', '/integrations/zoho/leads/:leadId/notes');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, user: { id: 1 }, params: { leadId: 'zoho-lead-1' }, body: { whatsappAccountId: WA_ACCOUNT_A, contactNumber: RAW_CONTACT_NUMBER, content: 'hello' } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 502);
    assert.equal(res.body.success, false);
    assert.equal(JSON.stringify(res.body).includes('token'), false);
  } finally {
    restore();
  }
}));

// ═══════════════════════════════════════════════════════════════════════
// SECURITY
// ═══════════════════════════════════════════════════════════════════════

test('SECURITY: no Lead/Note route in this file ever returns access_token/refresh_token fields', withFetch(zohoLeadFetchDispatcher(), async () => {
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [connectedConnection()],
    leadLinks: [{ id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A, contact_number: NORMALIZED_CONTACT_NUMBER, zoho_lead_id: 'zoho-lead-1', status: 'synced' }],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();

    const createHandler = getHandler(router, 'post', '/integrations/zoho/leads');
    const createRes = mockRes();
    await createHandler(mockReq({ workspace: { id: WORKSPACE_A }, user: { id: 1 }, body: { whatsappAccountId: WA_ACCOUNT_A, contactNumber: '+91 88888 88888', name: 'Test' } }), createRes);

    const noteHandler = getHandler(router, 'post', '/integrations/zoho/leads/:leadId/notes');
    const noteRes = mockRes();
    await noteHandler(mockReq({ workspace: { id: WORKSPACE_A }, user: { id: 1 }, params: { leadId: 'zoho-lead-1' }, body: { whatsappAccountId: WA_ACCOUNT_A, contactNumber: RAW_CONTACT_NUMBER, content: 'hello' } }), noteRes);

    for (const res of [createRes, noteRes]) {
      const raw = JSON.stringify(res.body);
      assert.equal(raw.includes('access_token'), false);
      assert.equal(raw.includes('refresh_token'), false);
    }
  } finally {
    restore();
  }
}));



