'use strict';

// Phase 7.5 — Meta Commerce Catalog Integration: route isolation tests.
//
// Same "no live Postgres, no supertest" approach as test/zohoRoutes.test.js:
// route handlers are pulled straight off router.stack and invoked with a
// mocked req/res. pool.query is monkey-patched with a tiny in-memory
// whatsapp_accounts table. NEVER calls a real Meta endpoint — the service
// layer is mocked out for the routes that would otherwise reach Graph.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

process.env.AKCHAT_ENCRYPTION_KEY = process.env.AKCHAT_ENCRYPTION_KEY || nodeCrypto.randomBytes(24).toString('hex');

const WORKSPACE_A = 1;
const WORKSPACE_B = 2;
const WA_ACCOUNT_A = 10; // belongs to workspace A
const WA_ACCOUNT_B = 20; // belongs to workspace B

function baseAccounts() {
  return [
    { id: WA_ACCOUNT_A, workspace_id: WORKSPACE_A },
    { id: WA_ACCOUNT_B, workspace_id: WORKSPACE_B },
  ];
}

function installDb(accounts) {
  const pool = require('../src/db');
  const original = pool.query;
  pool.query = async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT id FROM coexistence\.whatsapp_accounts WHERE id = \$1 AND workspace_id = \$2/i.test(s)) {
      const [waId, wsId] = params;
      const owned = accounts.some((a) => a.id === Number(waId) && a.workspace_id === Number(wsId));
      return { rows: owned ? [{ id: Number(waId) }] : [] };
    }
    return { rows: [] };
  };
  return () => { pool.query = original; };
}

// NOTE: only the routes module itself is cache-busted here. The service
// modules it requires are deliberately left alone — when a test wants a
// mocked service, it installs the mock via replaceModule() BEFORE calling
// freshRouter(), and busting the service cache here would discard that
// mock and let the routes module pick up the real (unmocked) service.
function freshRouter() {
  delete require.cache[require.resolve('../src/routes/integrations/metaCatalog')];
  return require('../src/routes/integrations/metaCatalog').router;
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
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

function mockReq({ workspace, params = {}, body = {} } = {}) {
  return { workspace, params, body };
}

function replaceModule(path, mock) {
  const resolved = require.resolve(path);
  const original = require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: mock };
  return () => { if (original) require.cache[resolved] = original; else delete require.cache[resolved]; };
}

// ── Cross-workspace isolation ───────────────────────────────────────────

test('GET /meta-catalog/:whatsappAccountId/connection returns 404 when the account belongs to a different workspace', async () => {
  const restoreDb = installDb(baseAccounts());
  try {
    const router = freshRouter();
    const handler = getHandler(router, 'get', '/meta-catalog/:whatsappAccountId/connection');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, params: { whatsappAccountId: String(WA_ACCOUNT_B) } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 404);
  } finally {
    restoreDb();
  }
});

test('GET /meta-catalog/:whatsappAccountId/catalogs returns 404 for an account outside the caller workspace (never leaks catalog data cross-tenant)', async () => {
  const restoreDb = installDb(baseAccounts());
  const restoreSvc = replaceModule('../src/services/metaCatalogConnectionService', {
    listAvailableCatalogs: async () => { throw new Error('must never be called for a cross-tenant account'); },
  });
  try {
    const router = freshRouter();
    const handler = getHandler(router, 'get', '/meta-catalog/:whatsappAccountId/catalogs');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, params: { whatsappAccountId: String(WA_ACCOUNT_B) } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 404);
  } finally {
    restoreDb();
    restoreSvc();
  }
});

test('POST /meta-catalog/:whatsappAccountId/connect succeeds for an account that belongs to the caller workspace', async () => {
  const restoreDb = installDb(baseAccounts());
  let calledWith = null;
  const restoreSvc = replaceModule('../src/services/metaCatalogConnectionService', {
    connectCatalog: async (workspaceId, whatsappAccountId, opts) => {
      calledWith = { workspaceId, whatsappAccountId, opts };
      return { id: 1, workspace_id: workspaceId, whatsapp_account_id: whatsappAccountId, catalog_id: opts.catalogId, status: 'connected' };
    },
  });
  try {
    const router = freshRouter();
    const handler = getHandler(router, 'post', '/meta-catalog/:whatsappAccountId/connect');
    const req = mockReq({
      workspace: { id: WORKSPACE_A },
      params: { whatsappAccountId: String(WA_ACCOUNT_A) },
      body: { catalogId: 'generic-catalog-id' },
    });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.catalog_id, 'generic-catalog-id');
    assert.equal(calledWith.workspaceId, WORKSPACE_A);
    assert.equal(calledWith.whatsappAccountId, String(WA_ACCOUNT_A));
  } finally {
    restoreDb();
    restoreSvc();
  }
});

test('POST /meta-catalog/:whatsappAccountId/connect returns 404 and never calls the service for a cross-workspace account', async () => {
  const restoreDb = installDb(baseAccounts());
  let serviceCalled = false;
  const restoreSvc = replaceModule('../src/services/metaCatalogConnectionService', {
    connectCatalog: async () => { serviceCalled = true; return {}; },
  });
  try {
    const router = freshRouter();
    const handler = getHandler(router, 'post', '/meta-catalog/:whatsappAccountId/connect');
    const req = mockReq({
      workspace: { id: WORKSPACE_A },
      params: { whatsappAccountId: String(WA_ACCOUNT_B) },
      body: { catalogId: 'generic-catalog-id' },
    });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 404);
    assert.equal(serviceCalled, false);
  } finally {
    restoreDb();
    restoreSvc();
  }
});

test('POST /meta-catalog/:whatsappAccountId/sync-now returns 404 when no connection exists yet', async () => {
  const restoreDb = installDb(baseAccounts());
  const restoreSvc = replaceModule('../src/services/metaCatalogConnectionService', {
    getConnection: async () => null,
  });
  try {
    const router = freshRouter();
    const handler = getHandler(router, 'post', '/meta-catalog/:whatsappAccountId/sync-now');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, params: { whatsappAccountId: String(WA_ACCOUNT_A) } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 404);
  } finally {
    restoreDb();
    restoreSvc();
  }
});

test('POST /meta-catalog/:whatsappAccountId/sync-now returns the sync result on success', async () => {
  const restoreDb = installDb(baseAccounts());
  const restoreConnSvc = replaceModule('../src/services/metaCatalogConnectionService', {
    getConnection: async () => ({ id: 1, status: 'connected', catalog_id: 'generic-catalog-id' }),
  });
  const restoreSyncSvc = replaceModule('../src/services/metaCatalogSyncService', {
    runSync: async () => ({ rowsRead: 2, rowsCreated: 1, rowsUpdated: 1, rowsFailed: 0 }),
  });
  try {
    const router = freshRouter();
    const handler = getHandler(router, 'post', '/meta-catalog/:whatsappAccountId/sync-now');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, params: { whatsappAccountId: String(WA_ACCOUNT_A) } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { rowsRead: 2, rowsCreated: 1, rowsUpdated: 1, rowsFailed: 0 });
  } finally {
    restoreDb();
    restoreConnSvc();
    restoreSyncSvc();
  }
});

test('GET /meta-catalog/:whatsappAccountId/sync-log is scoped per-account and returns 404 cross-tenant', async () => {
  const restoreDb = installDb(baseAccounts());
  let serviceCalled = false;
  const restoreSvc = replaceModule('../src/services/metaCatalogSyncService', {
    listSyncLog: async () => { serviceCalled = true; return []; },
  });
  try {
    const router = freshRouter();
    const handler = getHandler(router, 'get', '/meta-catalog/:whatsappAccountId/sync-log');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, params: { whatsappAccountId: String(WA_ACCOUNT_B) } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 404);
    assert.equal(serviceCalled, false);
  } finally {
    restoreDb();
    restoreSvc();
  }
});

test('POST /meta-catalog/:whatsappAccountId/products/:productId/retry is scoped per-account and returns 404 cross-tenant', async () => {
  const restoreDb = installDb(baseAccounts());
  let serviceCalled = false;
  const restoreSvc = replaceModule('../src/services/metaCatalogSyncService', {
    retryProduct: async () => { serviceCalled = true; return {}; },
  });
  try {
    const router = freshRouter();
    const handler = getHandler(router, 'post', '/meta-catalog/:whatsappAccountId/products/:productId/retry');
    const req = mockReq({ workspace: { id: WORKSPACE_A }, params: { whatsappAccountId: String(WA_ACCOUNT_B), productId: '999' } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 404);
    assert.equal(serviceCalled, false);
  } finally {
    restoreDb();
    restoreSvc();
  }
});