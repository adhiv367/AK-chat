'use strict';

// Phase 8H Part 1 — additive route tests only. Covers:
//   1. GET /integrations/zoho/reconciliation-state
//   2. OAuth callback -> zohoReconciliationService.resetForReauthRecovery hook
//
// Same "no live Postgres, no supertest" approach as test/zohoRoutes.test.js:
// route handlers are pulled straight off router.stack and invoked with a
// mocked req/res. pool.query is monkey-patched on the shared '../src/db'
// singleton. This file does not re-test anything already covered by
// zohoRoutes.test.js (connect/status/disconnect/test/leads/sync routes) —
// only the two 8H-specific surfaces above.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

process.env.AKCHAT_ENCRYPTION_KEY = process.env.AKCHAT_ENCRYPTION_KEY || nodeCrypto.randomBytes(24).toString('hex');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ZOHO_CLIENT_ID = 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = 'test-client-secret';
process.env.ZOHO_REDIRECT_URI = 'https://app.example.test/api/integrations/zoho/callback';

const WORKSPACE_A = 1;
const WORKSPACE_B = 2;
const WA_ACCOUNT_A = 10;
const WA_ACCOUNT_B = 20;

function baseAccounts() {
  return [
    { id: WA_ACCOUNT_A, workspace_id: WORKSPACE_A },
    { id: WA_ACCOUNT_B, workspace_id: WORKSPACE_B },
  ];
}

// ── In-memory coexistence.zoho_connections + zoho_sync_state + whatsapp_accounts fake ──
function makeDb({ whatsappAccounts = [], connections = [], syncStateRows = [] } = {}) {
  let nextConnId = (connections.reduce((m, c) => Math.max(m, c.id), 0) || 0) + 1;

  function findConnByOwnership(workspaceId, whatsappAccountId) {
    return connections.find((c) => c.workspace_id === Number(workspaceId) && c.whatsapp_account_id === Number(whatsappAccountId));
  }
  function findConnById(id) {
    return connections.find((c) => c.id === Number(id));
  }
  function findSyncState(workspaceId, whatsappAccountId, contactNumber) {
    return syncStateRows.find((r) => r.workspace_id === Number(workspaceId)
      && r.whatsapp_account_id === Number(whatsappAccountId)
      && r.contact_number === contactNumber);
  }

  async function query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();

    // Ownership check
    if (/^SELECT id FROM coexistence\.whatsapp_accounts WHERE id = \$1 AND workspace_id = \$2/i.test(s)) {
      const [waId, wsId] = params;
      const owned = whatsappAccounts.some((a) => a.id === Number(waId) && a.workspace_id === Number(wsId));
      return { rows: owned ? [{ id: Number(waId) }] : [] };
    }

    // zohoConnectionService.findConnection / getConnection
    if (/^SELECT \* FROM coexistence\.zoho_connections\s+WHERE workspace_id = \$1 AND whatsapp_account_id = \$2/i.test(s)) {
      const [wsId, waId] = params;
      const row = findConnByOwnership(wsId, waId);
      return { rows: row ? [row] : [] };
    }

    // ensureConnection INSERT (only exercised by /connect, unused here but kept for safety)
    if (/^INSERT INTO coexistence\.zoho_connections/i.test(s)) {
      const [wsId, waId, connectedBy] = params;
      const row = {
        id: nextConnId++,
        workspace_id: Number(wsId),
        whatsapp_account_id: Number(waId),
        status: 'disconnected',
        connected_by: connectedBy || null,
      };
      connections.push(row);
      return { rows: [row] };
    }

    // ── Phase 8H reconciliation-state read ──────────────────────────────
    if (/^SELECT \* FROM coexistence\.zoho_sync_state\s+WHERE workspace_id = \$1 AND whatsapp_account_id = \$2 AND contact_number = \$3/i.test(s)) {
      const [wsId, waId, contactNumber] = params;
      const row = findSyncState(wsId, waId, contactNumber);
      return { rows: row ? [row] : [] };
    }

    // ── Phase 8H reauth-recovery reset (resetForReauthRecovery) ─────────
    if (/^UPDATE coexistence\.zoho_sync_state\s+SET sync_status = 'pending'/i.test(s)) {
      const [wsId, waId] = params;
      let count = 0;
      for (const row of syncStateRows) {
        if (row.workspace_id === Number(wsId) && row.whatsapp_account_id === Number(waId) && row.failure_type === 'reauth_required') {
          row.sync_status = 'pending';
          row.failure_type = null;
          row.last_error = null;
          count += 1;
        }
      }
      return { rowCount: count, rows: [] };
    }

    return { rows: [] };
  }

  return { query, connections, whatsappAccounts, syncStateRows };
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
    '../src/services/zohoReconciliationService',
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

// ── 1. GET /integrations/zoho/reconciliation-state ─────────────────────────

test('RECONCILIATION-STATE: returns null state when no sync-state row exists yet', async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts() });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'get', '/integrations/zoho/reconciliation-state');
    const req = mockReq({
      workspace: { id: WORKSPACE_A },
      query: { whatsappAccountId: String(WA_ACCOUNT_A), contactNumber: '+911234567890' },
    });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.state, null);
  } finally {
    restore();
  }
});

test('RECONCILIATION-STATE: maps an existing sync-state row into the documented shape', async () => {
  const syncStateRows = [{
    workspace_id: WORKSPACE_A,
    whatsapp_account_id: WA_ACCOUNT_A,
    contact_number: '+911234567890',
    sync_status: 'note_pending',
    failure_type: 'retryable_failure',
    attempt_count: 2,
    max_attempts: 8,
    next_attempt_at: new Date('2026-01-01T00:00:00Z'),
    last_attempt_at: new Date('2025-12-31T23:00:00Z'),
    last_success_at: null,
    completed_at: null,
    last_error: 'Zoho CRM rate limit exceeded',
  }];
  const db = makeDb({ whatsappAccounts: baseAccounts(), syncStateRows });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'get', '/integrations/zoho/reconciliation-state');
    const req = mockReq({
      workspace: { id: WORKSPACE_A },
      query: { whatsappAccountId: String(WA_ACCOUNT_A), contactNumber: '+911234567890' },
    });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.state.syncStatus, 'note_pending');
    assert.equal(res.body.state.failureType, 'retryable_failure');
    assert.equal(res.body.state.attemptCount, 2);
    assert.equal(res.body.state.maxAttempts, 8);
    assert.equal(res.body.state.lastError, 'Zoho CRM rate limit exceeded');
  } finally {
    restore();
  }
});

test('RECONCILIATION-STATE: missing contactNumber is rejected with 400', async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts() });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'get', '/integrations/zoho/reconciliation-state');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, query: { whatsappAccountId: String(WA_ACCOUNT_A) } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
  } finally {
    restore();
  }
});

test('RECONCILIATION-STATE: whatsapp account belonging to a different workspace is rejected (isolation)', async () => {
  const syncStateRows = [{
    workspace_id: WORKSPACE_B,
    whatsapp_account_id: WA_ACCOUNT_B,
    contact_number: '+911234567890',
    sync_status: 'pending',
    failure_type: null,
    attempt_count: 0,
    max_attempts: 8,
  }];
  const db = makeDb({ whatsappAccounts: baseAccounts(), syncStateRows });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'get', '/integrations/zoho/reconciliation-state');
    // Workspace A caller trying to peek at Workspace B's account.
    const req = mockReq({
      workspace: { id: WORKSPACE_A },
      query: { whatsappAccountId: String(WA_ACCOUNT_B), contactNumber: '+911234567890' },
    });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 404, 'account not owned by caller workspace must be rejected before reading sync state');
  } finally {
    restore();
  }
});

test('RECONCILIATION-STATE: missing req.workspace is rejected, not defaulted', async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts() });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'get', '/integrations/zoho/reconciliation-state');
    const req = mockReq({ workspace: undefined, query: { whatsappAccountId: String(WA_ACCOUNT_A), contactNumber: '+911234567890' } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 409);
  } finally {
    restore();
  }
});

// ── 2. OAuth callback -> reauth recovery hook ───────────────────────────────

function fetchDispatcher({ tokenOk = true, orgOk = true } = {}) {
  return async (url) => {
    if (String(url).includes('/oauth/v2/token')) {
      return {
        ok: tokenOk,
        json: async () => (tokenOk
          ? { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, api_domain: 'https://www.zohoapis.com' }
          : { error: 'invalid_code' }),
      };
    }
    if (String(url).includes('/crm/v2/org')) {
      return {
        ok: orgOk,
        status: orgOk ? 200 : 500,
        json: async () => (orgOk ? { org: [{ id: 'zoho-org-1' }] } : { message: 'boom' }),
      };
    }
    throw new Error(`unexpected fetch url: ${url}`);
  };
}

test('CALLBACK: successful reconnection triggers resetForReauthRecovery for this exact workspace/account', withFetch(fetchDispatcher(), async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts() });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const oauth = require('../src/services/zohoOAuthService');
    const zohoReconciliationService = require('../src/services/zohoReconciliationService');

    const calls = [];
    const original = zohoReconciliationService.resetForReauthRecovery;
    zohoReconciliationService.resetForReauthRecovery = async (workspaceId, whatsappAccountId) => {
      calls.push({ workspaceId, whatsappAccountId });
      return { reset: 0 };
    };

    try {
      const state = oauth.generateState({ workspaceId: WORKSPACE_A, whatsappAccountId: WA_ACCOUNT_A });
      const handler = getHandler(router, 'get', '/integrations/zoho/callback');
      const req = mockReq({ query: { code: 'auth-code-1', state } });
      const res = mockRes();
      await handler(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      // Hook is fire-and-forget (best-effort, .catch()'d in the route) —
      // give its microtask a tick to run before asserting it fired.
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls.length, 1, 'resetForReauthRecovery must be called exactly once on successful callback');
      assert.equal(calls[0].workspaceId, WORKSPACE_A);
      assert.equal(calls[0].whatsappAccountId, WA_ACCOUNT_A);
    } finally {
      zohoReconciliationService.resetForReauthRecovery = original;
    }
  } finally {
    restore();
  }
}));

test('CALLBACK: a rejected resetForReauthRecovery never fails the callback response (best-effort)', withFetch(fetchDispatcher(), async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts() });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const oauth = require('../src/services/zohoOAuthService');
    const zohoReconciliationService = require('../src/services/zohoReconciliationService');

    const original = zohoReconciliationService.resetForReauthRecovery;
    zohoReconciliationService.resetForReauthRecovery = async () => {
      throw new Error('boom — sync_state table unavailable');
    };

    try {
      const state = oauth.generateState({ workspaceId: WORKSPACE_A, whatsappAccountId: WA_ACCOUNT_A });
      const handler = getHandler(router, 'get', '/integrations/zoho/callback');
      const req = mockReq({ query: { code: 'auth-code-1', state } });
      const res = mockRes();
      await handler(req, res);

      assert.equal(res.statusCode, 200, 'callback must still report success even if the reauth-recovery hook rejects');
      assert.equal(res.body.success, true);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      zohoReconciliationService.resetForReauthRecovery = original;
    }
  } finally {
    restore();
  }
}));

test('CALLBACK: a failed token exchange never triggers resetForReauthRecovery', withFetch(fetchDispatcher({ tokenOk: false }), async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts() });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const oauth = require('../src/services/zohoOAuthService');
    const zohoReconciliationService = require('../src/services/zohoReconciliationService');

    const calls = [];
    const original = zohoReconciliationService.resetForReauthRecovery;
    zohoReconciliationService.resetForReauthRecovery = async (...args) => {
      calls.push(args);
      return { reset: 0 };
    };

    try {
      const state = oauth.generateState({ workspaceId: WORKSPACE_A, whatsappAccountId: WA_ACCOUNT_A });
      const handler = getHandler(router, 'get', '/integrations/zoho/callback');
      const req = mockReq({ query: { code: 'auth-code-1', state } });
      const res = mockRes();
      await handler(req, res);

      assert.equal(res.statusCode, 400);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls.length, 0, 'reauth-recovery must never run when the callback itself failed');
    } finally {
      zohoReconciliationService.resetForReauthRecovery = original;
    }
  } finally {
    restore();
  }
}));