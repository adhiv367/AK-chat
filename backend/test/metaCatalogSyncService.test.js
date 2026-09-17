'use strict';

// Phase 7.5 — Meta Commerce Catalog Integration: outbound sync tests.
// Mocks pool.query, integrations/metaCatalog.js, and
// metaCatalogConnectionService.resolveAccessToken — NEVER makes a real
// network call, NEVER touches the real Invi Creation Meta account.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

process.env.AKCHAT_ENCRYPTION_KEY = process.env.AKCHAT_ENCRYPTION_KEY || nodeCrypto.randomBytes(24).toString('hex');

function replaceModule(path, mock) {
  const resolved = require.resolve(path);
  const original = require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: mock };
  return () => {
    if (original) require.cache[resolved] = original;
    else delete require.cache[resolved];
  };
}

function withMocks({ queryHandler, metaCatalogMock, connectionServiceMock } = {}) {
  return async (run) => {
    const pool = require('../src/db');
    const queries = [];
    const originalQuery = pool.query;
    pool.query = async (sql, params) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      queries.push({ sql: normalized, params });
      const result = queryHandler ? queryHandler(normalized, params, queries) : undefined;
      return result !== undefined ? result : { rows: [] };
    };

    const restoreMetaCatalog = metaCatalogMock
      ? replaceModule('../src/integrations/metaCatalog', metaCatalogMock)
      : () => {};
    const restoreConnSvc = connectionServiceMock
      ? replaceModule('../src/services/metaCatalogConnectionService', connectionServiceMock)
      : () => {};

    try {
      delete require.cache[require.resolve('../src/services/metaCatalogSyncService')];
      const svc = require('../src/services/metaCatalogSyncService');
      await run(svc, queries);
    } finally {
      pool.query = originalQuery;
      restoreMetaCatalog();
      restoreConnSvc();
      delete require.cache[require.resolve('../src/services/metaCatalogSyncService')];
    }
  };
}

const CONNECTION = { id: 30, workspace_id: 1, whatsapp_account_id: 5, catalog_id: 'cat-1', status: 'connected' };

const PRODUCTS = [
  { id: 101, workspace_id: 1, whatsapp_account_id: 5, name: 'Generic Widget', sku: 'WID-1', retailer_id: 'WID-1', price: '100.00', currency: 'INR', status: 'active', meta_sync_status: 'not_synced' },
  { id: 102, workspace_id: 1, whatsapp_account_id: 5, name: 'Generic Gadget', sku: 'GAD-1', retailer_id: 'GAD-1', price: '200.00', currency: 'INR', status: 'archived', meta_sync_status: 'synced' },
];

test('runSync rejects when there is no active connection', async () => {
  await withMocks()(async (svc) => {
    await assert.rejects(svc.runSync(1, 5, null), /No active Meta catalog connection/);
    await assert.rejects(svc.runSync(1, 5, { status: 'disconnected' }), /No active Meta catalog connection/);
  });
});

test('runSync scopes the product fetch to workspace_id + whatsapp_account_id and only active/archived statuses', async () => {
  let productQuery = null;
  await withMocks({
    queryHandler(sql, params) {
      if (/^INSERT INTO coexistence\.meta_catalog_sync_log/i.test(sql)) return { rows: [{ id: 1 }] };
      if (/^SELECT \* FROM coexistence\.products WHERE/i.test(sql)) {
        productQuery = { sql, params };
        return { rows: PRODUCTS };
      }
    },
    metaCatalogMock: {
      toCatalogItem: (p) => ({ retailer_id: p.retailer_id, availability: p.status === 'archived' ? 'out of stock' : 'in stock' }),
      upsertCatalogItems: async () => ({ handles: [] }),
    },
    connectionServiceMock: { resolveAccessToken: async () => 'fake-token' },
  })(async (svc) => {
    await svc.runSync(1, 5, CONNECTION, { triggeredBy: 'manual' });
    assert.match(productQuery.sql, /workspace_id = \$1/);
    assert.match(productQuery.sql, /status IN \('active', 'archived'\)/);
    assert.deepEqual(productQuery.params.slice(0, 2), [1, 5]);
  });
});

test('runSync maps archived products to out-of-stock availability, never a hard delete', async () => {
  const pushedItems = [];
  await withMocks({
    queryHandler(sql) {
      if (/^INSERT INTO coexistence\.meta_catalog_sync_log/i.test(sql)) return { rows: [{ id: 1 }] };
      if (/^SELECT \* FROM coexistence\.products WHERE/i.test(sql)) return { rows: PRODUCTS };
    },
    metaCatalogMock: {
      toCatalogItem: (p) => ({
        retailer_id: p.retailer_id,
        availability: p.status === 'archived' ? 'out of stock' : 'in stock',
      }),
      upsertCatalogItems: async ({ items }) => { pushedItems.push(...items); return {}; },
      deleteCatalogItem: async () => { throw new Error('deleteCatalogItem must never be called by runSync'); },
    },
    connectionServiceMock: { resolveAccessToken: async () => 'fake-token' },
  })(async (svc) => {
    await svc.runSync(1, 5, CONNECTION, { triggeredBy: 'manual' });
    const archivedItem = pushedItems.find((i) => i.retailer_id === 'GAD-1');
    assert.equal(archivedItem.availability, 'out of stock');
    const activeItem = pushedItems.find((i) => i.retailer_id === 'WID-1');
    assert.equal(activeItem.availability, 'in stock');
  });
});

test('runSync counts a fresh product as created and an already-synced product as updated', async () => {
  const updates = [];
  await withMocks({
    queryHandler(sql, params) {
      if (/^INSERT INTO coexistence\.meta_catalog_sync_log/i.test(sql)) return { rows: [{ id: 1 }] };
      if (/^SELECT \* FROM coexistence\.products WHERE/i.test(sql)) return { rows: PRODUCTS };
      if (/^UPDATE coexistence\.products/i.test(sql)) updates.push({ sql, params });
    },
    metaCatalogMock: {
      toCatalogItem: (p) => ({ retailer_id: p.retailer_id }),
      upsertCatalogItems: async () => ({}),
    },
    connectionServiceMock: { resolveAccessToken: async () => 'fake-token' },
  })(async (svc) => {
    const result = await svc.runSync(1, 5, CONNECTION, { triggeredBy: 'manual' });
    assert.equal(result.rowsRead, 2);
    assert.equal(result.rowsCreated, 1); // WID-1 was 'not_synced'
    assert.equal(result.rowsUpdated, 1); // GAD-1 was already 'synced'
    assert.equal(result.rowsFailed, 0);
  });
});

test('runSync degrades to per-item retry when a batch upsert fails, so one bad product does not fail the whole run', async () => {
  let batchCallCount = 0;
  const perItemCalls = [];
  await withMocks({
    queryHandler(sql) {
      if (/^INSERT INTO coexistence\.meta_catalog_sync_log/i.test(sql)) return { rows: [{ id: 1 }] };
      if (/^SELECT \* FROM coexistence\.products WHERE/i.test(sql)) return { rows: PRODUCTS };
    },
    metaCatalogMock: {
      toCatalogItem: (p) => ({ retailer_id: p.retailer_id }),
      upsertCatalogItems: async ({ items }) => {
        if (items.length > 1) { batchCallCount++; throw new Error('simulated batch failure'); }
        perItemCalls.push(items[0].retailer_id);
        if (items[0].retailer_id === 'GAD-1') throw new Error('simulated item failure');
        return {};
      },
    },
    connectionServiceMock: { resolveAccessToken: async () => 'fake-token' },
  })(async (svc) => {
    const result = await svc.runSync(1, 5, CONNECTION, { triggeredBy: 'manual' });
    assert.equal(batchCallCount, 1);
    assert.deepEqual(perItemCalls.sort(), ['GAD-1', 'WID-1']);
    assert.equal(result.rowsFailed, 1);
    assert.equal(result.rowsUpdated, 1);
  });
});

test('runSync writes a meta_catalog_sync_log row on success and on failure', async () => {
  const logInserts = [];
  const logUpdates = [];
  await withMocks({
    queryHandler(sql, params) {
      if (/^INSERT INTO coexistence\.meta_catalog_sync_log/i.test(sql)) { logInserts.push(params); return { rows: [{ id: 42 }] }; }
      if (/^UPDATE coexistence\.meta_catalog_sync_log/i.test(sql)) { logUpdates.push({ sql, params }); return { rows: [] }; }
      if (/^SELECT \* FROM coexistence\.products WHERE/i.test(sql)) return { rows: [] };
    },
    metaCatalogMock: { toCatalogItem: (p) => p, upsertCatalogItems: async () => ({}) },
    connectionServiceMock: { resolveAccessToken: async () => { throw new Error('token resolution failed'); } },
  })(async (svc) => {
    await assert.rejects(svc.runSync(1, 5, CONNECTION, { triggeredBy: 'manual' }));
    assert.equal(logInserts.length, 1);
    assert.equal(logUpdates.length, 1);
    assert.match(logUpdates[0].sql, /status = \$2/);
    assert.ok(logUpdates[0].params.includes('error'));
  });
});

test('deleteProductFromCatalog is never invoked by runSync and requires an explicit call', async () => {
  let deleteWasCalled = false;
  await withMocks({
    queryHandler(sql) {
      if (/^SELECT \* FROM coexistence\.products WHERE/i.test(sql)) return { rows: [PRODUCTS[0]] };
      if (/^UPDATE coexistence\.products/i.test(sql)) return { rows: [] };
    },
    metaCatalogMock: {
      deleteCatalogItem: async () => { deleteWasCalled = true; return {}; },
    },
    connectionServiceMock: { resolveAccessToken: async () => 'fake-token' },
  })(async (svc) => {
    await svc.deleteProductFromCatalog(1, 5, CONNECTION, 101);
    assert.equal(deleteWasCalled, true);
  });
});

test('listSyncLog scopes by workspace_id and optional whatsapp_account_id', async () => {
  await withMocks({
    queryHandler(sql, params) {
      if (/^SELECT \* FROM coexistence\.meta_catalog_sync_log/i.test(sql)) {
        assert.deepEqual(params, [1, 5]);
        assert.match(sql, /whatsapp_account_id = \$2/);
        return { rows: [] };
      }
    },
  })(async (svc) => {
    await svc.listSyncLog(1, 5);
  });
});



