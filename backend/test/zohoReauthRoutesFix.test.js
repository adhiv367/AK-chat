'use strict';

// Route-level regression tests for the Zoho "recurring reauthentication"
// fix. Same in-memory-DB / stubbed-fetch approach as test/zohoRoutes.test.js
// (kept self-contained here rather than importing that file's internals, so
// this file can be run/read independently).

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

process.env.AKCHAT_ENCRYPTION_KEY = process.env.AKCHAT_ENCRYPTION_KEY || nodeCrypto.randomBytes(24).toString('hex');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-reauth-routes';
process.env.ZOHO_CLIENT_ID = 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = 'test-client-secret';
process.env.ZOHO_REDIRECT_URI = 'https://app.example.test/api/integrations/zoho/callback';

function makeDb({ whatsappAccounts = [], connections = [] } = {}) {
  let nextId = (connections.reduce((m, c) => Math.max(m, c.id), 0) || 0) + 1;

  function findByOwnership(workspaceId, whatsappAccountId) {
    return connections.find((c) => c.workspace_id === Number(workspaceId) && c.whatsapp_account_id === Number(whatsappAccountId));
  }
  function findById(id) {
    return connections.find((c) => c.id === Number(id));
  }

  async function query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (/^SELECT id FROM coexistence\.whatsapp_accounts WHERE id = \$1 AND workspace_id = \$2/i.test(s)) {
      const [waId, wsId] = params;
      const owned = whatsappAccounts.some((a) => a.id === Number(waId) && a.workspace_id === Number(wsId));
      return { rows: owned ? [{ id: Number(waId) }] : [] };
    }

    if (/^SELECT \* FROM coexistence\.zoho_connections\s+WHERE workspace_id = \$1 AND whatsapp_account_id = \$2/i.test(s)) {
      const [wsId, waId] = params;
      const row = findByOwnership(wsId, waId);
      return { rows: row ? [row] : [] };
    }

    if (/^SELECT \* FROM coexistence\.zoho_connections\s+WHERE id = \$1 AND workspace_id = \$2 AND whatsapp_account_id = \$3/i.test(s)) {
      const [id, wsId, waId] = params;
      const row = findById(id);
      const match = row && row.workspace_id === Number(wsId) && row.whatsapp_account_id === Number(waId);
      return { rows: match ? [row] : [] };
    }

    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE id = \$1$/i.test(s)) {
      const row = findById(params[0]);
      return { rows: row ? [row] : [] };
    }

    if (/^INSERT INTO coexistence\.zoho_connections/i.test(s)) {
      const [wsId, waId, connectedBy] = params;
      const existing = findByOwnership(wsId, waId);
      if (existing) return { rows: [existing] };
      const row = {
        id: nextId++,
        workspace_id: Number(wsId),
        whatsapp_account_id: Number(waId),
        zoho_org_id: null,
        zoho_api_domain: null,
        zoho_data_center: null,
        status: 'disconnected',
        access_token_encrypted: null,
        refresh_token_encrypted: null,
        token_expires_at: null,
        scopes: null,
        connected_at: null,
        connected_by: connectedBy || null,
        last_success_at: null,
        last_error: null,
        last_error_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      connections.push(row);
      return { rows: [row] };
    }

    // recordZohoOrgIdentity — called TWICE per callback after the fix (once
    // for domain/DC, once for org id) — both must apply cumulatively.
    if (/^UPDATE coexistence\.zoho_connections\s+SET zoho_org_id = COALESCE/i.test(s)) {
      const [id, wsId, zohoOrgId, zohoApiDomain, zohoDataCenter] = params;
      const row = findById(id);
      if (!row || row.workspace_id !== Number(wsId)) return { rows: [] };
      row.zoho_org_id = zohoOrgId ?? row.zoho_org_id;
      row.zoho_api_domain = zohoApiDomain ?? row.zoho_api_domain;
      row.zoho_data_center = zohoDataCenter ?? row.zoho_data_center;
      row.connected_at = new Date();
      return { rows: [row] };
    }

    if (/^UPDATE coexistence\.zoho_connections\s+SET status = \$3/i.test(s)) {
      const [id, wsId, status] = params;
      const row = findById(id);
      if (!row || row.workspace_id !== Number(wsId)) return { rows: [] };
      row.status = status;
      return { rows: [row] };
    }

    if (/^UPDATE coexistence\.zoho_connections\s+SET last_success_at = NOW\(\)/i.test(s)) {
      const [id, wsId] = params;
      const row = findById(id);
      if (!row || row.workspace_id !== Number(wsId)) return { rows: [] };
      row.last_success_at = new Date();
      return { rows: [row] };
    }

    if (/^UPDATE coexistence\.zoho_connections\s+SET status = 'error'/i.test(s)) {
      const [id, wsId, errorMessage] = params;
      const row = findById(id);
      if (!row || row.workspace_id !== Number(wsId)) return { rows: [] };
      row.status = 'error';
      row.last_error = errorMessage;
      return { rows: [row] };
    }

    if (/^UPDATE coexistence\.zoho_connections\s+SET status = 'disconnected'/i.test(s)) {
      const [id, wsId] = params;
      const row = findById(id);
      if (!row || row.workspace_id !== Number(wsId)) return { rows: [] };
      Object.assign(row, {
        status: 'disconnected', access_token_encrypted: null, refresh_token_encrypted: null,
        token_expires_at: null, zoho_org_id: null, zoho_api_domain: null, zoho_data_center: null, scopes: null,
      });
      return { rows: [row] };
    }

    if (/^UPDATE coexistence\.zoho_connections\s+SET status = 'reauth_required'/i.test(s)) {
      const [id, errorMessage] = params;
      const row = findById(id);
      if (!row) return { rows: [] };
      row.status = 'reauth_required';
      row.last_error = errorMessage;
      return { rows: [row] };
    }

    if (/^UPDATE coexistence\.zoho_connections SET /i.test(s)) {
      const setPortion = s.slice(s.indexOf('SET ') + 4, s.indexOf(' WHERE'));
      const assignments = setPortion.split(/,(?![^(]*\))/).map((x) => x.trim());
      const idParam = params[params.length - 1];
      const row = findById(idParam);
      if (!row) return { rows: [] };
      for (const assign of assignments) {
        const m = assign.match(/^(\w+)\s*=\s*\$(\d+)/);
        if (!m) continue;
        const [, col, idx] = m;
        const value = params[Number(idx) - 1];
        if (col === 'access_token_encrypted') row.access_token_encrypted = value;
        else if (col === 'refresh_token_encrypted') row.refresh_token_encrypted = value;
        else if (col === 'token_expires_at') row.token_expires_at = value;
        else if (col === 'scopes') row.scopes = value;
        else if (col === 'zoho_api_domain') row.zoho_api_domain = value;
        else if (col === 'status') row.status = value;
        else if (col === 'last_error') row.last_error = value;
      }
      if (/last_success_at = NOW\(\)/.test(s)) row.last_success_at = new Date();
      if (/last_error_at = NOW\(\)/.test(s)) row.last_error_at = new Date();
      return { rows: [row] };
    }

    return { rows: [] };
  }

  return { query, connections, whatsappAccounts };
}

function installDb(dbState) {
  const pool = require('../src/db');
  const original = pool.query;
  pool.query = dbState.query;
  return () => { pool.query = original; };
}

function freshModules() {
  for (const name of ['../src/services/zohoConnectionService', '../src/services/zohoTokenService', '../src/services/zohoOAuthService', '../src/routes/integrations/zoho']) {
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
    statusCode: 200, body: null, redirectedTo: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    redirect(url) { this.redirectedTo = url; return this; },
    set(key, value) { this.headers[key] = value; return this; },
  };
}
function mockReq({ workspace, user, query = {}, body = {} } = {}) {
  return { workspace, user, query, body };
}
function withFetch(dispatcher, run) {
  return async () => {
    const original = global.fetch;
    global.fetch = dispatcher;
    try { await run(); } finally { global.fetch = original; }
  };
}

const WORKSPACE_A = 1;
const WORKSPACE_B = 2;
const WA_ACCOUNT_A = 10;
const WA_ACCOUNT_A2 = 11;
const WA_ACCOUNT_B = 20;

function baseAccounts() {
  return [
    { id: WA_ACCOUNT_A, workspace_id: WORKSPACE_A },
    { id: WA_ACCOUNT_A2, workspace_id: WORKSPACE_A },
    { id: WA_ACCOUNT_B, workspace_id: WORKSPACE_B },
  ];
}

// ── C. OAuth callback with the new Notes scope -> connected ───────────────
test('C. CALLBACK: fresh reconnect (post Notes-scope-addition) grants notes.CREATE and ends up connected', withFetch(async (url) => {
  if (String(url).includes('/oauth/v2/token')) {
    return {
      ok: true,
      json: async () => ({
        access_token: 'at-notes', refresh_token: 'rt-notes', expires_in: 3600,
        api_domain: 'https://www.zohoapis.in',
        // Real Zoho echoes back the granted scope string on the token
        // response, reflecting whatever the user consented to on Zoho's own
        // consent screen (driven by getAuthUrl's DEFAULT_SCOPES, which now
        // includes notes.CREATE) — never something this test file requests
        // directly, since scope is not a parameter of the token exchange.
        scope: 'ZohoCRM.modules.leads.ALL,ZohoCRM.modules.notes.CREATE,ZohoCRM.org.READ,ZohoCRM.users.READ',
      }),
    };
  }
  if (String(url).includes('/crm/v2/org')) {
    return { ok: true, status: 200, json: async () => ({ org: [{ id: 'zoho-org-notes' }] }) };
  }
  throw new Error(`unexpected fetch: ${url}`);
}, async () => {
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    // Simulates an existing connection whose OLD token predates the Notes
    // scope addition — status was already 'connected' from before.
    connections: [{ id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A, status: 'reauth_required', scopes: 'ZohoCRM.modules.leads.ALL' }],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const oauth = require('../src/services/zohoOAuthService');
    const state = oauth.generateState({ workspaceId: WORKSPACE_A, whatsappAccountId: WA_ACCOUNT_A });

    const handler = getHandler(router, 'get', '/integrations/zoho/callback');
    const req = mockReq({ query: { code: 'auth-code-notes', state } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.connection.status, 'connected', 'the one-time reconnect after adding a scope must end up connected');
    assert.match(db.connections[0].scopes, /notes\.CREATE/);

    // And the /status endpoint immediately reflects "no reauth needed".
    const statusHandler = getHandler(router, 'get', '/integrations/zoho/status');
    const statusReq = mockReq({ workspace: { id: WORKSPACE_A }, query: { whatsappAccountId: String(WA_ACCOUNT_A) } });
    const statusRes = mockRes();
    await statusHandler(statusReq, statusRes);
    assert.equal(statusRes.body.needs_reauth, false);
    assert.equal(statusRes.body.status, 'connected');
  } finally {
    restore();
  }
}));

// ── F. correct India DC remains persisted (even if org lookup fails) ─────
test('F. CALLBACK: India datacenter is persisted from the token response even when the accounts-server header is absent and the org lookup fails', withFetch(async (url) => {
  if (String(url).includes('/oauth/v2/token')) {
    return { ok: true, json: async () => ({ access_token: 'at-in', refresh_token: 'rt-in', expires_in: 3600, api_domain: 'https://www.zohoapis.in' }) };
  }
  if (String(url).includes('/crm/v2/org')) {
    // Best-effort org lookup fails (transient) — must not affect DC/status.
    return { ok: false, status: 500, json: async () => ({ message: 'boom' }) };
  }
  throw new Error(`unexpected fetch: ${url}`);
}, async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts() });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const oauth = require('../src/services/zohoOAuthService');
    const state = oauth.generateState({ workspaceId: WORKSPACE_A, whatsappAccountId: WA_ACCOUNT_A });

    const handler = getHandler(router, 'get', '/integrations/zoho/callback');
    // NOTE: no `accounts-server` query param — simulates the case where
    // Zoho's redirect doesn't carry a recognizable value.
    const req = mockReq({ query: { code: 'auth-code-in', state } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.connection.status, 'connected', 'a failed best-effort org lookup must never flip status away from connected');
    assert.equal(res.body.connection.needsReauth, undefined); // serializeConnection doesn't expose this field directly, checked via /status below
    assert.equal(db.connections[0].zoho_data_center, 'in', 'DC must be derived from the token exchange api_domain, not silently defaulted to com');
    assert.equal(db.connections[0].zoho_api_domain, 'https://www.zohoapis.in');

    const statusHandler = getHandler(router, 'get', '/integrations/zoho/status');
    const statusReq = mockReq({ workspace: { id: WORKSPACE_A }, query: { whatsappAccountId: String(WA_ACCOUNT_A) } });
    const statusRes = mockRes();
    await statusHandler(statusReq, statusRes);
    assert.equal(statusRes.body.data_center, 'in');
    assert.equal(statusRes.body.needs_reauth, false, 'a transient org-lookup failure must never surface as needing reauthentication');
    assert.equal(statusRes.body.status, 'connected');
  } finally {
    restore();
  }
}));

// ── G. two WhatsApp accounts (Number A / Number B) remain independent ────
test('G. Number A\'s reauth_required status never bleeds into Number B\'s status on the same workspace', async () => {
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [
      { id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A, status: 'reauth_required', zoho_data_center: 'in' },
      { id: 2, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A2, status: 'connected', zoho_data_center: 'in' },
    ],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'get', '/integrations/zoho/status');

    const reqA = mockReq({ workspace: { id: WORKSPACE_A }, query: { whatsappAccountId: String(WA_ACCOUNT_A) } });
    const resA = mockRes();
    await handler(reqA, resA);
    assert.equal(resA.body.needs_reauth, true);

    const reqA2 = mockReq({ workspace: { id: WORKSPACE_A }, query: { whatsappAccountId: String(WA_ACCOUNT_A2) } });
    const resA2 = mockRes();
    await handler(reqA2, resA2);
    assert.equal(resA2.body.needs_reauth, false, 'Number B must remain healthy independent of Number A needing reauth');
  } finally {
    restore();
  }
});

// ── H. status endpoint reports connected after a successful refresh ──────
test('H. STATUS reports connected (not needs_reauth) immediately after /test triggers a successful silent refresh', withFetch(fetchDispatcherForTest(), async () => {
  const { encrypt } = require('../src/util/crypto');
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [{
      id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A, status: 'connected',
      access_token_encrypted: encrypt('stale-at'), refresh_token_encrypted: encrypt('good-refresh'),
      token_expires_at: new Date(Date.now() - 60 * 1000), // expired -> ensureValidAccessToken must refresh
      zoho_api_domain: 'https://www.zohoapis.in', zoho_data_center: 'in',
    }],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const testHandler = getHandler(router, 'post', '/integrations/zoho/test');
    const testReq = mockReq({ workspace: { id: WORKSPACE_A }, body: { whatsappAccountId: String(WA_ACCOUNT_A) } });
    const testRes = mockRes();
    await testHandler(testReq, testRes);
    assert.equal(testRes.body.success, true);

    const statusHandler = getHandler(router, 'get', '/integrations/zoho/status');
    const statusReq = mockReq({ workspace: { id: WORKSPACE_A }, query: { whatsappAccountId: String(WA_ACCOUNT_A) } });
    const statusRes = mockRes();
    await statusHandler(statusReq, statusRes);
    assert.equal(statusRes.body.status, 'connected');
    assert.equal(statusRes.body.needs_reauth, false);
  } finally {
    restore();
  }
}));

function fetchDispatcherForTest() {
  return async (url) => {
    if (String(url).includes('/oauth/v2/token')) {
      return { ok: true, json: async () => ({ access_token: 'at-refreshed', expires_in: 3600, api_domain: 'https://www.zohoapis.in' }) };
    }
    if (String(url).includes('/crm/v2/org')) {
      return { ok: true, status: 200, json: async () => ({ org: [{ id: 'zoho-org-1' }] }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

// ── I. repeated API calls after token expiry never require OAuth again ────
test('I. repeated /test calls across multiple token-expiry cycles never require reconnect', withFetch(fetchDispatcherForTest(), async () => {
  const { encrypt } = require('../src/util/crypto');
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [{
      id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A, status: 'connected',
      access_token_encrypted: encrypt('cycle-0-token'), refresh_token_encrypted: encrypt('good-refresh'),
      token_expires_at: new Date(Date.now() - 1000), zoho_api_domain: 'https://www.zohoapis.in', zoho_data_center: 'in',
    }],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const testHandler = getHandler(router, 'post', '/integrations/zoho/test');

    for (let i = 0; i < 3; i++) {
      // Force expiry again before each call, simulating three separate
      // access-token expiry cycles over time.
      db.connections[0].token_expires_at = new Date(Date.now() - 1000);
      const req = mockReq({ workspace: { id: WORKSPACE_A }, body: { whatsappAccountId: String(WA_ACCOUNT_A) } });
      const res = mockRes();
      await testHandler(req, res);
      assert.equal(res.statusCode, 200, `cycle ${i}: must succeed without requiring OAuth again`);
      assert.equal(db.connections[0].status, 'connected', `cycle ${i}: status must remain connected`);
    }
  } finally {
    restore();
  }
}));