'use strict';

// Phase 8B Part 2 — Zoho integration route tests.
//
// Same "no live Postgres, no supertest" approach as
// test/webhookBroadcastStatus.test.js: route handlers are pulled straight
// off router.stack and invoked with a mocked req/res. pool.query is
// monkey-patched on the shared '../src/db' singleton with a tiny in-memory
// coexistence.zoho_connections table, and global.fetch is stubbed for the
// Zoho token-exchange / CRM API calls zohoOAuthService.js and this route
// file make directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

process.env.AKCHAT_ENCRYPTION_KEY = process.env.AKCHAT_ENCRYPTION_KEY || nodeCrypto.randomBytes(24).toString('hex');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ZOHO_CLIENT_ID = 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = 'test-client-secret';
process.env.ZOHO_REDIRECT_URI = 'https://app.example.test/api/integrations/zoho/callback';

// ── In-memory coexistence.zoho_connections + whatsapp_accounts fake ────────

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

    // Ownership check
    if (/^SELECT id FROM coexistence\.whatsapp_accounts WHERE id = \$1 AND workspace_id = \$2/i.test(s)) {
      const [waId, wsId] = params;
      const owned = whatsappAccounts.some((a) => a.id === Number(waId) && a.workspace_id === Number(wsId));
      return { rows: owned ? [{ id: Number(waId) }] : [] };
    }

    // findConnection / getConnectionRowByOwnership
    if (/^SELECT \* FROM coexistence\.zoho_connections\s+WHERE workspace_id = \$1 AND whatsapp_account_id = \$2/i.test(s)) {
      const [wsId, waId] = params;
      const row = findByOwnership(wsId, waId);
      return { rows: row ? [row] : [] };
    }

    // getConnectionRowById (id + workspace + account)
    if (/^SELECT \* FROM coexistence\.zoho_connections\s+WHERE id = \$1 AND workspace_id = \$2 AND whatsapp_account_id = \$3/i.test(s)) {
      const [id, wsId, waId] = params;
      const row = findById(id);
      const match = row && row.workspace_id === Number(wsId) && row.whatsapp_account_id === Number(waId);
      return { rows: match ? [row] : [] };
    }

    // getConnectionRow (by id alone — zohoTokenService)
    if (/^SELECT \* FROM coexistence\.zoho_connections WHERE id = \$1$/i.test(s)) {
      const row = findById(params[0]);
      return { rows: row ? [row] : [] };
    }

    // ensureConnection INSERT
    if (/^INSERT INTO coexistence\.zoho_connections/i.test(s)) {
      const [wsId, waId, connectedBy] = params;
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

    // recordZohoOrgIdentity
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

    // updateConnectionStatus
    if (/^UPDATE coexistence\.zoho_connections\s+SET status = \$3/i.test(s)) {
      const [id, wsId, status] = params;
      const row = findById(id);
      if (!row || row.workspace_id !== Number(wsId)) return { rows: [] };
      row.status = status;
      return { rows: [row] };
    }

    // recordSuccess
    if (/^UPDATE coexistence\.zoho_connections\s+SET last_success_at = NOW\(\)/i.test(s)) {
      const [id, wsId] = params;
      const row = findById(id);
      if (!row || row.workspace_id !== Number(wsId)) return { rows: [] };
      row.last_success_at = new Date();
      return { rows: [row] };
    }

    // recordError (connectionService)
    if (/^UPDATE coexistence\.zoho_connections\s+SET status = 'error'/i.test(s)) {
      const [id, wsId, errorMessage] = params;
      const row = findById(id);
      if (!row || row.workspace_id !== Number(wsId)) return { rows: [] };
      row.status = 'error';
      row.last_error = errorMessage;
      return { rows: [row] };
    }

    // disconnect
    if (/^UPDATE coexistence\.zoho_connections\s+SET status = 'disconnected'/i.test(s)) {
      const [id, wsId] = params;
      const row = findById(id);
      if (!row || row.workspace_id !== Number(wsId)) return { rows: [] };
      Object.assign(row, {
        status: 'disconnected',
        access_token_encrypted: null,
        refresh_token_encrypted: null,
        token_expires_at: null,
        zoho_org_id: null,
        zoho_api_domain: null,
        zoho_data_center: null,
        scopes: null,
      });
      return { rows: [row] };
    }

    // tokenService.markReauthRequired (literal status value, no $ placeholder for it)
    if (/^UPDATE coexistence\.zoho_connections\s+SET status = 'reauth_required'/i.test(s)) {
      const [id, errorMessage] = params;
      const row = findById(id);
      if (!row) return { rows: [] };
      row.status = 'reauth_required';
      row.last_error = errorMessage;
      return { rows: [row] };
    }

    // atomicTokenUpdate (dynamic SET list)
    if (/^UPDATE coexistence\.zoho_connections SET /i.test(s)) {
      const setPortion = s.slice(s.indexOf('SET ') + 4, s.indexOf(' WHERE'));
      const assignments = setPortion.split(/,(?![^(]*\))/).map((x) => x.trim());
      const idParam = params[params.length - 1];
      const row = findById(idParam);
      if (!row) return { rows: [] };
      for (const assign of assignments) {
        const m = assign.match(/^(\w+)\s*=\s*\$(\d+)/);
        if (!m) continue; // NOW() literals etc.
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
    statusCode: 200,
    body: null,
    redirectedTo: null,
    headers: {},
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
    try {
      await run();
    } finally {
      global.fetch = original;
    }
  };
}

const WORKSPACE_A = 1;
const WORKSPACE_B = 2;
const WA_ACCOUNT_A = 10; // belongs to workspace A
const WA_ACCOUNT_A2 = 11; // also belongs to workspace A
const WA_ACCOUNT_B = 20; // belongs to workspace B

function baseAccounts() {
  return [
    { id: WA_ACCOUNT_A, workspace_id: WORKSPACE_A },
    { id: WA_ACCOUNT_A2, workspace_id: WORKSPACE_A },
    { id: WA_ACCOUNT_B, workspace_id: WORKSPACE_B },
  ];
}

// ── CONNECT ──────────────────────────────────────────────────────────────

test('CONNECT: authenticated + valid workspace + valid whatsapp account redirects to Zoho with signed state', async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts() });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'get', '/integrations/zoho/connect');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, user: { id: 99 }, query: { whatsappAccountId: String(WA_ACCOUNT_A) } });
    const res = mockRes();
    await handler(req, res);

    assert.ok(res.redirectedTo, 'expected a redirect to the Zoho auth URL');
    assert.match(res.redirectedTo, /^https:\/\/accounts\.zoho\.com\/oauth\/v2\/auth\?/);
    const url = new URL(res.redirectedTo);
    assert.ok(url.searchParams.get('state'), 'state param must be present');
    assert.equal(db.connections.length, 1, 'ensureConnection must create the row');
    assert.equal(db.connections[0].status, 'disconnected');
  } finally {
    restore();
  }
});

test('CONNECT: whatsapp account belonging to a different workspace is rejected', async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts() });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'get', '/integrations/zoho/connect');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, user: { id: 99 }, query: { whatsappAccountId: String(WA_ACCOUNT_B) } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 404);
    assert.equal(res.body.success, false);
    assert.equal(db.connections.length, 0, 'no connection row should be created for a rejected account');
  } finally {
    restore();
  }
});

test('CONNECT: missing whatsappAccountId is rejected before touching the DB', async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts() });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'get', '/integrations/zoho/connect');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, user: { id: 99 }, query: {} });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 400);
  } finally {
    restore();
  }
});

// ── CALLBACK ─────────────────────────────────────────────────────────────

function fetchDispatcher({ tokenOk = true, orgOk = true, tokenBody, orgBody } = {}) {
  return async (url) => {
    if (String(url).includes('/oauth/v2/token')) {
      return {
        ok: tokenOk,
        json: async () => tokenBody ?? (tokenOk
          ? { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, api_domain: 'https://www.zohoapis.com' }
          : { error: 'invalid_code' }),
      };
    }
    if (String(url).includes('/crm/v2/org')) {
      return {
        ok: orgOk,
        status: orgOk ? 200 : 500,
        json: async () => orgBody ?? (orgOk ? { org: [{ id: 'zoho-org-1' }] } : { message: 'boom' }),
      };
    }
    throw new Error(`unexpected fetch url: ${url}`);
  };
}

test('CALLBACK: valid state + successful token exchange + org lookup creates/updates the connection', withFetch(fetchDispatcher(), async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts() });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const oauth = require('../src/services/zohoOAuthService');
    const state = oauth.generateState({ workspaceId: WORKSPACE_A, whatsappAccountId: WA_ACCOUNT_A });

    const handler = getHandler(router, 'get', '/integrations/zoho/callback');
    const req = mockReq({ query: { code: 'auth-code-1', state } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.connection.status, 'connected');
    assert.equal(res.body.connection.zohoOrgId, 'zoho-org-1');
    assert.equal(res.body.connection.hasRefreshToken, true);
    assert.equal(res.body.connection.accessToken, undefined, 'access token must never be in the response');
    assert.equal(res.body.connection.refreshToken, undefined, 'refresh token must never be in the response');
  } finally {
    restore();
  }
}));

test('CALLBACK: expired state is rejected', async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts() });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const jwt = require('jsonwebtoken');
    const expiredState = jwt.sign(
      { purpose: 'zoho_oauth_state', wsId: WORKSPACE_A, waId: WA_ACCOUNT_A, nonce: 'x' },
      process.env.JWT_SECRET,
      { expiresIn: -10 }
    );

    const handler = getHandler(router, 'get', '/integrations/zoho/callback');
    const req = mockReq({ query: { code: 'auth-code-1', state: expiredState } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /expired|invalid/i);
  } finally {
    restore();
  }
});

test('CALLBACK: tampered state (bad signature) is rejected', async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts() });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const jwt = require('jsonwebtoken');
    const tamperedState = jwt.sign(
      { purpose: 'zoho_oauth_state', wsId: WORKSPACE_A, waId: WA_ACCOUNT_A, nonce: 'x' },
      'wrong-secret',
      { expiresIn: '10m' }
    );

    const handler = getHandler(router, 'get', '/integrations/zoho/callback');
    const req = mockReq({ query: { code: 'auth-code-1', state: tamperedState } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 400);
  } finally {
    restore();
  }
});

test('CALLBACK: wrong-purpose state is rejected', async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts() });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const jwt = require('jsonwebtoken');
    const wrongPurposeState = jwt.sign(
      { purpose: 'ig_oauth_state', wsId: WORKSPACE_A, waId: WA_ACCOUNT_A, nonce: 'x' },
      process.env.JWT_SECRET,
      { expiresIn: '10m' }
    );

    const handler = getHandler(router, 'get', '/integrations/zoho/callback');
    const req = mockReq({ query: { code: 'auth-code-1', state: wrongPurposeState } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /purpose/i);
  } finally {
    restore();
  }
});

test('CALLBACK: authorization denied by the user (Zoho error param) is rejected safely', async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts() });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'get', '/integrations/zoho/callback');
    const req = mockReq({ query: { error: 'access_denied', state: 'irrelevant' } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /denied/i);
  } finally {
    restore();
  }
});

test('CALLBACK: token exchange failure records the error and responds safely (no secrets leaked)', withFetch(fetchDispatcher({ tokenOk: false }), async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts() });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const oauth = require('../src/services/zohoOAuthService');
    const state = oauth.generateState({ workspaceId: WORKSPACE_A, whatsappAccountId: WA_ACCOUNT_A });

    const handler = getHandler(router, 'get', '/integrations/zoho/callback');
    const req = mockReq({ query: { code: 'bad-code', state } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.doesNotMatch(JSON.stringify(res.body), /test-client-secret/);
    assert.equal(db.connections[0].status, 'error');
  } finally {
    restore();
  }
}));

test('CALLBACK: org lookup failure still leaves the connection connected (tokens already stored)', withFetch(fetchDispatcher({ orgOk: false }), async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts() });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const oauth = require('../src/services/zohoOAuthService');
    const state = oauth.generateState({ workspaceId: WORKSPACE_A, whatsappAccountId: WA_ACCOUNT_A });

    const handler = getHandler(router, 'get', '/integrations/zoho/callback');
    const req = mockReq({ query: { code: 'auth-code-1', state } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.connected, true);
    assert.equal(db.connections[0].access_token_encrypted !== null, true, 'tokens must still be stored');
  } finally {
    restore();
  }
}));

// ── STATUS ───────────────────────────────────────────────────────────────

test('STATUS: connected account reports safe fields only, no tokens', async () => {
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [{
      id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A,
      status: 'connected', zoho_org_id: 'org-1', zoho_data_center: 'com',
      access_token_encrypted: 'ciphertext', refresh_token_encrypted: 'ciphertext2',
      connected_at: new Date(), last_success_at: new Date(),
    }],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'get', '/integrations/zoho/status');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, query: { whatsappAccountId: String(WA_ACCOUNT_A) } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.body.connected, true);
    assert.equal(res.body.zoho_org_id, 'org-1');
    assert.equal(res.body.needs_reauth, false);
    assert.ok(!('access_token_encrypted' in res.body));
    assert.ok(!JSON.stringify(res.body).includes('ciphertext'));
  } finally {
    restore();
  }
});

test('STATUS: missing connection returns the safe not-connected shape', async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts() });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'get', '/integrations/zoho/status');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, query: { whatsappAccountId: String(WA_ACCOUNT_A) } });
    const res = mockRes();
    await handler(req, res);

    assert.deepEqual(res.body, { connected: false, status: 'disconnected' });
  } finally {
    restore();
  }
});

test('STATUS: workspace isolation — Workspace B cannot read Workspace A\'s connection', async () => {
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [{ id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A, status: 'connected' }],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'get', '/integrations/zoho/status');
    // Workspace B trying to read Workspace A's WhatsApp account's status.
    const req = mockReq({ workspace: { id: WORKSPACE_B }, query: { whatsappAccountId: String(WA_ACCOUNT_A) } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 404, 'cross-workspace access must be rejected, not silently scoped');
  } finally {
    restore();
  }
});

test('STATUS: account isolation — one account\'s connection is never returned for a sibling account', async () => {
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [{ id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A, status: 'connected' }],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'get', '/integrations/zoho/status');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, query: { whatsappAccountId: String(WA_ACCOUNT_A2) } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.body.connected, false);
  } finally {
    restore();
  }
});

// ── DISCONNECT ───────────────────────────────────────────────────────────

test('DISCONNECT: clears tokens and org identity for the correct account only, leaves sibling account untouched', async () => {
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [
      { id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A, status: 'connected', access_token_encrypted: 'ct1', refresh_token_encrypted: 'rt1', zoho_org_id: 'org-1' },
      { id: 2, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A2, status: 'connected', access_token_encrypted: 'ct2', refresh_token_encrypted: 'rt2', zoho_org_id: 'org-2' },
    ],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'post', '/integrations/zoho/disconnect');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, body: { whatsappAccountId: String(WA_ACCOUNT_A) } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.body.success, true);
    const [rowA, rowA2] = db.connections;
    assert.equal(rowA.status, 'disconnected');
    assert.equal(rowA.access_token_encrypted, null);
    assert.equal(rowA.zoho_org_id, null);
    // Sibling account (same workspace, different WhatsApp account) untouched.
    assert.equal(rowA2.status, 'connected');
    assert.equal(rowA2.access_token_encrypted, 'ct2');
  } finally {
    restore();
  }
});

test('DISCONNECT: another workspace\'s connection is never affected', async () => {
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [
      { id: 1, workspace_id: WORKSPACE_B, whatsapp_account_id: WA_ACCOUNT_B, status: 'connected', access_token_encrypted: 'ctB' },
    ],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'post', '/integrations/zoho/disconnect');
    // Workspace A attempting to disconnect an account that is actually Workspace B's.
    const req = mockReq({ workspace: { id: WORKSPACE_A }, body: { whatsappAccountId: String(WA_ACCOUNT_B) } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 404);
    assert.equal(db.connections[0].status, 'connected', 'Workspace B row must be untouched');
  } finally {
    restore();
  }
});

// ── TEST CONNECTION ────────────────────────────────────────────────────

test('TEST CONNECTION: successful Zoho API request records success', withFetch(fetchDispatcher({ orgOk: true }), async () => {
  const { encrypt } = require('../src/util/crypto');
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [{
      id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A, status: 'connected',
      access_token_encrypted: encrypt('valid-token'), token_expires_at: new Date(Date.now() + 60 * 60 * 1000),
      zoho_api_domain: 'https://www.zohoapis.com',
    }],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'post', '/integrations/zoho/test');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, body: { whatsappAccountId: String(WA_ACCOUNT_A) } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.body.success, true);
    assert.ok(db.connections[0].last_success_at);
  } finally {
    restore();
  }
}));

test('TEST CONNECTION: no connection exists yet returns a safe 404', async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts() });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'post', '/integrations/zoho/test');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, body: { whatsappAccountId: String(WA_ACCOUNT_A) } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 404);
  } finally {
    restore();
  }
});

test('TEST CONNECTION: refresh failure (revoked refresh token) responds 409 needs-reauth and marks reauth_required', withFetch(async (url) => {
  if (String(url).includes('/oauth/v2/token')) {
    return { ok: false, json: async () => ({ error: 'invalid_grant' }) };
  }
  throw new Error(`unexpected fetch: ${url}`);
}, async () => {
  const { encrypt } = require('../src/util/crypto');
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [{
      id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A, status: 'connected',
      access_token_encrypted: encrypt('expired-token'), refresh_token_encrypted: encrypt('revoked-refresh'),
      token_expires_at: new Date(Date.now() - 60 * 1000), // already expired -> ensureValidAccessToken must refresh
      zoho_api_domain: 'https://www.zohoapis.com',
    }],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'post', '/integrations/zoho/test');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, body: { whatsappAccountId: String(WA_ACCOUNT_A) } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /re-authentication/i);
    assert.equal(db.connections[0].status, 'reauth_required');
  } finally {
    restore();
  }
}));

test('TEST CONNECTION: Zoho 401 on an otherwise-valid token triggers one refresh+retry before failing', withFetch(async (url) => {
  if (String(url).includes('/oauth/v2/token')) {
    return { ok: false, json: async () => ({ error: 'invalid_grant' }) };
  }
  if (String(url).includes('/crm/v2/org')) {
    return { ok: false, status: 401, json: async () => ({ message: 'INVALID_TOKEN' }) };
  }
  throw new Error(`unexpected fetch: ${url}`);
}, async () => {
  const { encrypt } = require('../src/util/crypto');
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [{
      id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A, status: 'connected',
      access_token_encrypted: encrypt('looks-valid-token'), refresh_token_encrypted: encrypt('also-revoked'),
      token_expires_at: new Date(Date.now() + 60 * 60 * 1000), // not expired per our own bookkeeping
      zoho_api_domain: 'https://www.zohoapis.com',
    }],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'post', '/integrations/zoho/test');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, body: { whatsappAccountId: String(WA_ACCOUNT_A) } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 409);
    assert.equal(db.connections[0].status, 'reauth_required');
  } finally {
    restore();
  }
}));

test('TEST CONNECTION: Zoho rate limit (429) responds safely without marking reauth_required', withFetch(async (url) => {
  if (String(url).includes('/crm/v2/org')) {
    return { ok: false, status: 429, json: async () => ({ message: 'too many requests' }) };
  }
  throw new Error(`unexpected fetch: ${url}`);
}, async () => {
  const { encrypt } = require('../src/util/crypto');
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [{
      id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A, status: 'connected',
      access_token_encrypted: encrypt('valid-token'), token_expires_at: new Date(Date.now() + 60 * 60 * 1000),
      zoho_api_domain: 'https://www.zohoapis.com',
    }],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'post', '/integrations/zoho/test');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, body: { whatsappAccountId: String(WA_ACCOUNT_A) } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 429);
    assert.equal(db.connections[0].status, 'connected', 'rate limit must not flip status to reauth_required');
  } finally {
    restore();
  }
}));

test('TEST CONNECTION: Zoho network error responds safely (502) without leaking internals', withFetch(async (url) => {
  if (String(url).includes('/crm/v2/org')) {
    throw new Error('ECONNRESET: socket hang up');
  }
  throw new Error(`unexpected fetch: ${url}`);
}, async () => {
  const { encrypt } = require('../src/util/crypto');
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [{
      id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A, status: 'connected',
      access_token_encrypted: encrypt('valid-token'), token_expires_at: new Date(Date.now() + 60 * 60 * 1000),
      zoho_api_domain: 'https://www.zohoapis.com',
    }],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'post', '/integrations/zoho/test');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, body: { whatsappAccountId: String(WA_ACCOUNT_A) } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 502);
    assert.doesNotMatch(JSON.stringify(res.body), /ECONNRESET/);
  } finally {
    restore();
  }
}));

// ── SECURITY ─────────────────────────────────────────────────────────────

test('SECURITY: no route in this file ever returns access_token/refresh_token fields', async () => {
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [{
      id: 1, workspace_id: WORKSPACE_A, whatsapp_account_id: WA_ACCOUNT_A, status: 'connected',
      access_token_encrypted: 'super-secret-ciphertext', refresh_token_encrypted: 'super-secret-ciphertext-2',
    }],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'get', '/integrations/zoho/status');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, query: { whatsappAccountId: String(WA_ACCOUNT_A) } });
    const res = mockRes();
    await handler(req, res);

    const serialized = JSON.stringify(res.body);
    assert.doesNotMatch(serialized, /super-secret-ciphertext/);
  } finally {
    restore();
  }
});

test('SECURITY: workspace membership is required — missing req.workspace is rejected, not defaulted', async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts() });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'get', '/integrations/zoho/status');
    const req = mockReq({ workspace: undefined, query: { whatsappAccountId: String(WA_ACCOUNT_A) } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 409);
  } finally {
    restore();
  }
});
