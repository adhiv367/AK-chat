'use strict';

// AK Chat Zoho — "DB is connected but UI says Needs reauthentication"
// regression suite.
//
// Root-cause trace performed for this phase (see chat write-up for the full
// end-to-end trace using the exact live DB row reported):
//   - GET /integrations/zoho/status reads ONLY coexistence.zoho_connections
//     and derives needs_reauth ONLY from status === 'reauth_required'. It
//     never reads zoho_sync_state.failure_type and never treats a populated
//     last_error as a status signal — confirmed by tests A/B below.
//   - Given the exact live row (status=connected, last_error='Zoho rejected
//     access token twice (401)'), the handler returns
//     { status: 'connected', needs_reauth: false } — proven by a direct
//     runtime invocation of the route handler with that literal row (not
//     just a hand-written assertion).
//   - The one gap this phase closes: neither the GET /status nor GET
//     /sync-status response carried a Cache-Control header, so Express's
//     default strong ETag on res.json() left the door open for a browser/
//     proxy to serve back a PREVIOUSLY cached body (e.g. captured mid-
//     reconnect, while status was still reauth_required) on a later
//     identical GET — "leave the page and reopen it" is exactly the
//     navigation pattern that triggers cache reuse. Both routes now send
//     `Cache-Control: no-store`, and the frontend's fetch wrapper
//     (src/api.js) now passes `cache: 'no-store'` on every request, so
//     no cached response for this URL can ever be reused by either side.
//
// zoho_connections.status (OAuth connection health) and
// zoho_sync_state.failure_type (per-conversation sync outcome) are read by
// completely separate code paths (zohoConnectionService vs
// zohoReconciliationService) and are never merged — test B is the explicit
// proof of that separation.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

process.env.AKCHAT_ENCRYPTION_KEY = process.env.AKCHAT_ENCRYPTION_KEY || nodeCrypto.randomBytes(24).toString('hex');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-status-truth';
process.env.ZOHO_CLIENT_ID = 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = 'test-client-secret';
process.env.ZOHO_REDIRECT_URI = 'https://app.example.test/api/integrations/zoho/callback';

function makeDb({ whatsappAccounts = [], connections = [], syncStateRows = [] } = {}) {
  const findByOwnership = (workspaceId, whatsappAccountId) =>
    connections.find((c) => c.workspace_id === Number(workspaceId) && c.whatsapp_account_id === Number(whatsappAccountId));

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

    // zoho_lead_links lookup (getLinkedLead, used by /sync-status) — not
    // relevant to connection status, but /sync-status queries it; return
    // "no link" so the route completes normally in these tests.
    if (/coexistence\.zoho_lead_links/i.test(s)) {
      return { rows: [] };
    }

    // zoho_sync_state lookup — a completely different table this test
    // proves is never consulted by the connection-status routes.
    if (/coexistence\.zoho_sync_state/i.test(s)) {
      const [, , contactNumber] = params;
      const row = syncStateRows.find((r) => r.contact_number === contactNumber);
      return { rows: row ? [row] : [] };
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
  for (const name of ['../src/services/zohoConnectionService', '../src/services/zohoTokenService', '../src/services/zohoOAuthService', '../src/services/zohoLeadService', '../src/routes/integrations/zoho']) {
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
    statusCode: 200, body: null, headers: {},
    set(key, value) { this.headers[key] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}
function mockReq({ workspace, query = {}, body = {} } = {}) {
  return { workspace, query, body };
}

const WORKSPACE_A = 1001;
const WA_ACCOUNT_A = 5001;

function baseAccounts() {
  return [{ id: WA_ACCOUNT_A, workspace_id: WORKSPACE_A }];
}

// Exact shape of the live row reported in the bug ticket.
function liveEvidenceRow(overrides = {}) {
  return {
    id: 1,
    workspace_id: WORKSPACE_A,
    whatsapp_account_id: WA_ACCOUNT_A,
    zoho_org_id: null,
    zoho_api_domain: 'https://www.zohoapis.in',
    zoho_data_center: 'in',
    status: 'connected',
    access_token_encrypted: null,
    refresh_token_encrypted: null,
    token_expires_at: new Date('2026-09-05T10:28:43Z'),
    scopes: null,
    connected_at: new Date(),
    connected_by: null,
    last_success_at: null,
    last_error: 'Zoho rejected access token twice (401)',
    last_error_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// ── A. DB status connected + old last_error -> Connected ─────────────────
test('A. status=connected with a stale last_error still reports connected / needs_reauth=false', async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts(), connections: [liveEvidenceRow()] });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'get', '/integrations/zoho/status');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, query: { whatsappAccountId: String(WA_ACCOUNT_A) } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.body.status, 'connected');
    assert.equal(res.body.connected, true);
    assert.equal(res.body.needs_reauth, false, 'a stale last_error message must never flip needs_reauth to true');
  } finally {
    restore();
  }
});

// ── B. DB status connected + old sync_state failure_type=reauth_required
//      -> Connected (the two concepts must never be mixed) ───────────────
test('B. an old zoho_sync_state row with failure_type=reauth_required never affects /status for a connected connection', async () => {
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [liveEvidenceRow()],
    syncStateRows: [{
      contact_number: '+919999999999',
      sync_status: 'failed',
      failure_type: 'reauth_required',
      last_error: 'old blocked sync from a prior reauth episode',
    }],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();

    // The connection-status endpoint is unaffected...
    const statusHandler = getHandler(router, 'get', '/integrations/zoho/status');
    const statusRes = mockRes();
    await statusHandler(mockReq({ workspace: { id: WORKSPACE_A }, query: { whatsappAccountId: String(WA_ACCOUNT_A) } }), statusRes);
    assert.equal(statusRes.body.status, 'connected');
    assert.equal(statusRes.body.needs_reauth, false);

    // ...and /sync-status, which DOES read connection health, also reports
    // healthy for the connection itself — the old sync_state row belongs to
    // a specific conversation and is a completely separate concept.
    const syncStatusHandler = getHandler(router, 'get', '/integrations/zoho/sync-status');
    const syncRes = mockRes();
    await syncStatusHandler(mockReq({
      workspace: { id: WORKSPACE_A },
      query: { whatsappAccountId: String(WA_ACCOUNT_A), contactNumber: '+919999999999' },
    }), syncRes);
    assert.equal(syncRes.body.connection.status, 'connected');
    assert.equal(syncRes.body.connection.needsReauth, false, 'a per-conversation sync failure_type must never be read as connection status');
  } finally {
    restore();
  }
});

// ── C. DB status reauth_required -> Needs reauthentication ────────────────
test('C. status=reauth_required correctly reports needs_reauth=true', async () => {
  const db = makeDb({
    whatsappAccounts: baseAccounts(),
    connections: [liveEvidenceRow({ status: 'reauth_required' })],
  });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'get', '/integrations/zoho/status');
    const res = mockRes();
    await handler(mockReq({ workspace: { id: WORKSPACE_A }, query: { whatsappAccountId: String(WA_ACCOUNT_A) } }), res);
    assert.equal(res.body.status, 'reauth_required');
    assert.equal(res.body.needs_reauth, true);
  } finally {
    restore();
  }
});

// ── D. page reload/navigation -> connected when DB says connected ────────
test('D. repeated /status calls (simulating reload/navigation) never drift away from the true DB status', async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts(), connections: [liveEvidenceRow()] });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'get', '/integrations/zoho/status');
    for (let i = 0; i < 5; i++) {
      const res = mockRes();
      await handler(mockReq({ workspace: { id: WORKSPACE_A }, query: { whatsappAccountId: String(WA_ACCOUNT_A) } }), res);
      assert.equal(res.body.status, 'connected', `reopen #${i + 1}`);
      assert.equal(res.body.needs_reauth, false, `reopen #${i + 1}`);
    }
  } finally {
    restore();
  }
});

// ── E. status API response must accurately reflect current status,
//      including a transition mid-session (simulates a background refresh
//      completing between two page opens) ────────────────────────────────
test('E. /status reflects a status change that happens between two reads (no caching inside the handler itself)', async () => {
  const row = liveEvidenceRow({ status: 'reauth_required' });
  const db = makeDb({ whatsappAccounts: baseAccounts(), connections: [row] });
  const restore = installDb(db);
  try {
    const router = freshModules();
    const handler = getHandler(router, 'get', '/integrations/zoho/status');

    const res1 = mockRes();
    await handler(mockReq({ workspace: { id: WORKSPACE_A }, query: { whatsappAccountId: String(WA_ACCOUNT_A) } }), res1);
    assert.equal(res1.body.needs_reauth, true);

    // Connection recovers (e.g. a successful reconnect/refresh happens).
    row.status = 'connected';

    const res2 = mockRes();
    await handler(mockReq({ workspace: { id: WORKSPACE_A }, query: { whatsappAccountId: String(WA_ACCOUNT_A) } }), res2);
    assert.equal(res2.body.status, 'connected');
    assert.equal(res2.body.needs_reauth, false, 'the very next read must reflect the new status immediately');
  } finally {
    restore();
  }
});

// ── F. no stale frontend state can override a fresh API response ─────────
// Enforced at the transport level: both connection-status GET routes must
// tell every cache (browser, proxy, CDN) never to reuse a previous
// response for this URL.
test('F. GET /status and GET /sync-status both send Cache-Control: no-store', async () => {
  const db = makeDb({ whatsappAccounts: baseAccounts(), connections: [liveEvidenceRow()] });
  const restore = installDb(db);
  try {
    const router = freshModules();

    const statusHandler = getHandler(router, 'get', '/integrations/zoho/status');
    const statusRes = mockRes();
    await statusHandler(mockReq({ workspace: { id: WORKSPACE_A }, query: { whatsappAccountId: String(WA_ACCOUNT_A) } }), statusRes);
    assert.equal(statusRes.headers['Cache-Control'], 'no-store', '/status must forbid caching so a reopened page never sees a stale snapshot');

    const syncStatusHandler = getHandler(router, 'get', '/integrations/zoho/sync-status');
    const syncRes = mockRes();
    await syncStatusHandler(mockReq({
      workspace: { id: WORKSPACE_A },
      query: { whatsappAccountId: String(WA_ACCOUNT_A), contactNumber: '+919999999999' },
    }), syncRes);
    assert.equal(syncRes.headers['Cache-Control'], 'no-store', '/sync-status must forbid caching for the same reason');
  } finally {
    restore();
  }
});

// ── F2. frontend fetch wrapper never lets the browser reuse a cached GET ──
test('F2. the frontend api.js request helper issues every call with cache: "no-store"', () => {
  const fs = require('fs');
  const path = require('path');
  // Resolve the sibling frontend package's src/api.js. This repo's two
  // packages are checked out as sibling directories next to each other,
  // but the exact directory name for the frontend package isn't fixed
  // (e.g. "frontend" vs an environment-specific checkout name) — so
  // rather than hard-coding "frontend", look for any sibling directory
  // whose name contains "frontend" and has a src/api.js in it.
  const backendRoot = path.join(__dirname, '..');
  const workspaceRoot = path.join(backendRoot, '..');
  const candidates = [path.join(workspaceRoot, 'frontend', 'src', 'api.js')];
  try {
    for (const entry of fs.readdirSync(workspaceRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && /frontend/i.test(entry.name)) {
        candidates.push(path.join(workspaceRoot, entry.name, 'src', 'api.js'));
      }
    }
  } catch (err) {
    // workspaceRoot unreadable — fall through with just the default candidate
  }
  const apiJsPath = candidates.find((p) => fs.existsSync(p)) || candidates[0];
  const src = fs.readFileSync(apiJsPath, 'utf8');
  const reqFnMatch = src.match(/async function req\(path, opts = \{\}\) \{[\s\S]*?\n\}/);
  assert.ok(reqFnMatch, 'expected to find the req() helper in frontend/src/api.js');
  assert.match(reqFnMatch[0], /cache:\s*['"]no-store['"]/, 'req() must pass cache: "no-store" so no stale cached response can ever be reused after leaving/reopening a page');
});
