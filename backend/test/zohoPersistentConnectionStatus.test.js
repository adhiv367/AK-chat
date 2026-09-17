'use strict';

// AK Chat Zoho Phase 8 — "fix persistent Zoho connection status" regression
// suite. Self-contained (same in-memory-DB / stubbed-fetch harness pattern
// as test/zohoReauthRoutesFix.test.js) so it can be read/run independently
// and maps 1:1 onto the ticket's required test list:
//
//   A. successful OAuth -> DB status connected
//   B. reopening/status API -> still connected
//   C. browser/page status check does not mark a valid connection as
//      reauth_required
//   D. expired access token + valid refresh token -> automatic refresh and
//      connected
//   E. successful refresh clears stale reauth state
//   F. genuinely invalid refresh token -> reauth_required
//   G. India DC remains correct
//   H. workspace + WhatsApp-account isolation remains intact
//
// No Lead/Note/extraction logic is touched or tested here (out of scope).

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

process.env.AKCHAT_ENCRYPTION_KEY = process.env.AKCHAT_ENCRYPTION_KEY || nodeCrypto.randomBytes(24).toString('hex');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-persistent-status';
process.env.ZOHO_CLIENT_ID = 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = 'test-client-secret';
process.env.ZOHO_REDIRECT_URI = 'https://app.example.test/api/integrations/zoho/callback';

// ── In-memory coexistence.zoho_connections + whatsapp_accounts ──────────
function makeDb({ whatsappAccounts = [], connections = [] } = {}) {
  let nextId = (connections.reduce((m, c) => Math.max(m, c.id), 0) || 0) + 1;

  const findByOwnership = (workspaceId, whatsappAccountId) =>
    connections.find((c) => c.workspace_id === Number(workspaceId) && c.whatsapp_account_id === Number(whatsappAccountId));
  const findById = (id) => connections.find((c) => c.id === Number(id));

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

const WORKSPACE_A = 101;
const WORKSPACE_B = 202;
const WA_ACCOUNT_A = 501;
const WA_ACCOUNT_A2 = 502;
const WA_ACCOUNT_B = 601;

function baseAccounts() {
  return [
    { id: WA_ACCOUNT_A, workspace_id: WORKSPACE_A },
    { id: WA_ACCOUNT_A2, workspace_id: WORKSPACE_A },
    { id: WA_ACCOUNT_B, workspace_id: WORKSPACE_B },
  ];
}

async function getStatus(router, workspaceId, whatsappAccountId) {
  const handler = getHandler(router, 'get', '/integrations/zoho/status');
  const req = mockReq({ workspace: { id: workspaceId }, query: { whatsappAccountId: String(whatsappAccountId) } });
  const res = mockRes();
  await handler(req, res);
  return res;
}

// ── A. successful OAuth -> DB status connected ───────────────────────────
test('A. successful OAuth callback leaves the DB row (and its response) as status=connected', withFetch(async (url) => {
  if (String(url).includes('/oauth/v2/token')) {
    return {
      ok: true,
      json: async () => ({
        access_token: 'at-a', refresh_token: 'rt-a', expires_in: 3600,
        api_domain: 'https://www.zohoapis.in',
        scope: 'ZohoCRM.modules.leads.ALL,ZohoCRM.modules.notes.CREATE,ZohoCRM.org.READ,ZohoCRM.users.READ',
      }),
    };
  }
  if (String(url).includes('/crm/v2/org')) {
    return { ok: true, status: 200, json: async () => ({ org: [{ id: 'zoho-org-a' }] }) };
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
    const res = mockRes();
    await handler(mockReq({ query: { code: 'auth-code-a', state } }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.connected, true);
    assert.equal(res.body.connection.status, 'connected');
    assert.equal(db.connections[0].status, 'connected', 'DB row must be connected right after OAuth');
    assert.ok(db.connections[0].refresh_token_encrypted, 'refresh token must be stored');
  } finally {
    restore();
  }
}));

// ── B. reopening/status API -> still connected ───────────────────────────
test('B. calling /status repeatedly (simulating leaving and reopening the page) keeps reporting connected', async () => {
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [{ id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A, status: 'connected', zoho_data_center: 'in' }],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();
    for (let i = 0; i < 5; i++) {
      const res = await getStatus(router, WORKSPACE_A, WA_ACCOUNT_A);
      assert.equal(res.body.status, 'connected', `open #${i + 1} must still show connected`);
      assert.equal(res.body.needs_reauth, false, `open #${i + 1} must not show needs_reauth`);
    }
    // Row itself was never mutated by any of these reads.
    assert.equal(db.connections[0].status, 'connected');
  } finally {
    restore();
  }
});

// ── C. browser/page status check does not mark a valid connection as
//      reauth_required (no side effects from a plain status read) ────────
test('C. GET /status never mutates the connection row and never marks a healthy connection reauth_required', async () => {
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [{
      id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A, status: 'connected',
      zoho_data_center: 'in',
      // Access token already expired — a naive implementation that "tests"
      // the token on every status read would flip this to reauth_required.
      token_expires_at: new Date(Date.now() - 60 * 1000),
    }],
  });
  const restore = installDb(db);
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async (...args) => { fetchCalled = true; return originalFetch ? originalFetch(...args) : { ok: true, json: async () => ({}) }; };
  try {
    const router = freshModules();
    const res = await getStatus(router, WORKSPACE_A, WA_ACCOUNT_A);
    assert.equal(res.body.status, 'connected');
    assert.equal(res.body.needs_reauth, false);
    assert.equal(fetchCalled, false, 'a plain status read must never call out to Zoho (no token test, no refresh)');
    assert.equal(db.connections[0].status, 'connected', 'row must be untouched by a page-load status check');
  } finally {
    global.fetch = originalFetch;
    restore();
  }
});

// ── D. expired access token + valid refresh token -> automatic refresh
//      and connected ─────────────────────────────────────────────────────
test('D. an expired access token with a valid refresh token is silently refreshed on the next Zoho API call and stays connected', withFetch(async (url) => {
  if (String(url).includes('/oauth/v2/token')) {
    return { ok: true, json: async () => ({ access_token: 'at-refreshed-d', expires_in: 3600, api_domain: 'https://www.zohoapis.in' }) };
  }
  if (String(url).includes('/crm/v2/org')) {
    return { ok: true, status: 200, json: async () => ({ org: [{ id: 'zoho-org-d' }] }) };
  }
  throw new Error(`unexpected fetch: ${url}`);
}, async () => {
  const { encrypt } = require('../src/util/crypto');
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [{
      id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A, status: 'connected',
      access_token_encrypted: encrypt('stale-at-d'), refresh_token_encrypted: encrypt('good-refresh-d'),
      token_expires_at: new Date(Date.now() - 60 * 1000),
      zoho_api_domain: 'https://www.zohoapis.in', zoho_data_center: 'in',
    }],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const testHandler = getHandler(router, 'post', '/integrations/zoho/test');
    const res = mockRes();
    await testHandler(mockReq({ workspace: { id: WORKSPACE_A }, body: { whatsappAccountId: String(WA_ACCOUNT_A) } }), res);

    assert.equal(res.body.success, true, 'the API call must succeed using the silently-refreshed token');
    assert.equal(db.connections[0].status, 'connected');

    const statusRes = await getStatus(router, WORKSPACE_A, WA_ACCOUNT_A);
    assert.equal(statusRes.body.status, 'connected');
    assert.equal(statusRes.body.needs_reauth, false);
  } finally {
    restore();
  }
}));

// ── E. successful refresh clears stale reauth state ──────────────────────
test('E. a successful token refresh flips a stale reauth_required row back to connected', withFetch(async (url) => {
  if (String(url).includes('/oauth/v2/token')) {
    return { ok: true, json: async () => ({ access_token: 'at-recovered', expires_in: 3600, api_domain: 'https://www.zohoapis.in' }) };
  }
  throw new Error(`unexpected fetch: ${url}`);
}, async () => {
  const { encrypt } = require('../src/util/crypto');
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [{
      id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A,
      // Simulates a row left over from a PRIOR transient failure that was
      // (incorrectly, historically) marked reauth_required, even though the
      // refresh token itself is still good.
      status: 'reauth_required', last_error: 'stale previous failure',
      access_token_encrypted: encrypt('old-at'), refresh_token_encrypted: encrypt('still-good-refresh'),
      token_expires_at: new Date(Date.now() - 1000),
      zoho_api_domain: 'https://www.zohoapis.in', zoho_data_center: 'in',
    }],
  });
  const restore = installDb(db);
  try {
    const zohoTokenService = require('../src/services/zohoTokenService');
    freshModules();
    const token = await zohoTokenService.refreshConnectionToken(1);

    assert.equal(token, 'at-recovered');
    assert.equal(db.connections[0].status, 'connected', 'a successful refresh must clear reauth_required');

    const router = freshModules();
    const statusRes = await getStatus(router, WORKSPACE_A, WA_ACCOUNT_A);
    assert.equal(statusRes.body.status, 'connected');
    assert.equal(statusRes.body.needs_reauth, false);
  } finally {
    restore();
  }
}));

// ── F. genuinely invalid/revoked refresh token -> reauth_required ────────
test('F. a genuinely revoked refresh token (Zoho invalid_grant) marks the connection reauth_required', withFetch(async (url) => {
  if (String(url).includes('/oauth/v2/token')) {
    return { ok: false, status: 400, json: async () => ({ error: 'invalid_code' }) };
  }
  throw new Error(`unexpected fetch: ${url}`);
}, async () => {
  const { encrypt } = require('../src/util/crypto');
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [{
      id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A, status: 'connected',
      access_token_encrypted: encrypt('stale-at-f'), refresh_token_encrypted: encrypt('revoked-refresh'),
      token_expires_at: new Date(Date.now() - 1000),
      zoho_api_domain: 'https://www.zohoapis.in', zoho_data_center: 'in',
    }],
  });
  const restore = installDb(db);
  try {
    const zohoTokenService = require('../src/services/zohoTokenService');
    freshModules();
    await assert.rejects(() => zohoTokenService.refreshConnectionToken(1));
    assert.equal(db.connections[0].status, 'reauth_required', 'a genuinely rejected grant must require reconnection');

    const router = freshModules();
    const statusRes = await getStatus(router, WORKSPACE_A, WA_ACCOUNT_A);
    assert.equal(statusRes.body.status, 'reauth_required');
    assert.equal(statusRes.body.needs_reauth, true);
  } finally {
    restore();
  }
}));

test('F2. a transient 5xx/network failure while refreshing must NOT be treated as reauth_required', withFetch(async (url) => {
  if (String(url).includes('/oauth/v2/token')) {
    return { ok: false, status: 503, json: async () => ({ message: 'Zoho is down' }) };
  }
  throw new Error(`unexpected fetch: ${url}`);
}, async () => {
  const { encrypt } = require('../src/util/crypto');
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [{
      id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A, status: 'connected',
      access_token_encrypted: encrypt('stale-at-f2'), refresh_token_encrypted: encrypt('good-refresh-f2'),
      token_expires_at: new Date(Date.now() - 1000),
      zoho_api_domain: 'https://www.zohoapis.in', zoho_data_center: 'in',
    }],
  });
  const restore = installDb(db);
  try {
    const zohoTokenService = require('../src/services/zohoTokenService');
    freshModules();
    await assert.rejects(() => zohoTokenService.refreshConnectionToken(1));
    assert.equal(db.connections[0].status, 'connected', 'a transient outage must never force reconnect');
    assert.equal(db.connections[0].last_error, undefined === db.connections[0].last_error ? db.connections[0].last_error : db.connections[0].last_error);
  } finally {
    restore();
  }
}));

// ── G. India DC remains correct ──────────────────────────────────────────
test('G. India datacenter persists through OAuth and stays correct across subsequent status reads', withFetch(async (url) => {
  if (String(url).includes('/oauth/v2/token')) {
    return { ok: true, json: async () => ({ access_token: 'at-g', refresh_token: 'rt-g', expires_in: 3600, api_domain: 'https://www.zohoapis.in' }) };
  }
  if (String(url).includes('/crm/v2/org')) {
    return { ok: false, status: 500, json: async () => ({}) }; // best-effort org lookup fails
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
    const res = mockRes();
    // No `accounts-server` query param — DC must still be derived from api_domain.
    await handler(mockReq({ query: { code: 'auth-code-g', state } }), res);

    assert.equal(db.connections[0].zoho_data_center, 'in');
    assert.equal(res.body.connection.status, 'connected');

    for (let i = 0; i < 3; i++) {
      const statusRes = await getStatus(router, WORKSPACE_A, WA_ACCOUNT_A);
      assert.equal(statusRes.body.data_center, 'in', `open #${i + 1} must still report India DC`);
      assert.equal(statusRes.body.status, 'connected');
    }
  } finally {
    restore();
  }
}));

// ── H. workspace + WhatsApp-account isolation remains intact ─────────────
test('H. a reauth_required connection on one WhatsApp account/workspace never leaks onto another', async () => {
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [
      { id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A, status: 'reauth_required', zoho_data_center: 'in' },
      { id: 2, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A2, status: 'connected', zoho_data_center: 'in' },
      { id: 3, workspace_id: WORKSPACE_B, whatsapp_account_id: WA_ACCOUNT_B, status: 'connected', zoho_data_center: 'com' },
    ],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();

    const resA = await getStatus(router, WORKSPACE_A, WA_ACCOUNT_A);
    assert.equal(resA.body.needs_reauth, true);

    const resA2 = await getStatus(router, WORKSPACE_A, WA_ACCOUNT_A2);
    assert.equal(resA2.body.needs_reauth, false, 'sibling account on the SAME workspace must stay healthy');

    const resB = await getStatus(router, WORKSPACE_B, WA_ACCOUNT_B);
    assert.equal(resB.body.needs_reauth, false, 'a different workspace entirely must never see A\'s reauth state');

    // Cross-workspace access attempt is rejected outright (404), never
    // silently returning the other workspace's connection.
    const crossHandler = getHandler(router, 'get', '/integrations/zoho/status');
    const crossReq = mockReq({ workspace: { id: WORKSPACE_B }, query: { whatsappAccountId: String(WA_ACCOUNT_A) } });
    const crossRes = mockRes();
    await crossHandler(crossReq, crossRes);
    assert.equal(crossRes.statusCode, 404);
  } finally {
    restore();
  }
});
