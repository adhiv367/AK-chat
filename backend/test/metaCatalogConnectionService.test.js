'use strict';

// Phase 7.5 — Meta Commerce Catalog Integration: connection service tests.
// Mocks pool.query AND integrations/metaCatalog.js (the Graph API client) —
// this test suite NEVER makes a real network call and NEVER touches the
// real Invi Creation Meta account. Same mocked-pool convention as
// test/zohoConnectionService.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

process.env.AKCHAT_ENCRYPTION_KEY = process.env.AKCHAT_ENCRYPTION_KEY || nodeCrypto.randomBytes(24).toString('hex');

function withMocks({ queryHandler, metaCatalogMock } = {}) {
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

    const metaCatalogPath = require.resolve('../src/integrations/metaCatalog');
    const originalMetaCatalogModule = require.cache[metaCatalogPath];
    if (metaCatalogMock) {
      require.cache[metaCatalogPath] = { id: metaCatalogPath, filename: metaCatalogPath, loaded: true, exports: metaCatalogMock };
    }

    try {
      delete require.cache[require.resolve('../src/services/metaCatalogConnectionService')];
      const svc = require('../src/services/metaCatalogConnectionService');
      await run(svc, queries);
    } finally {
      pool.query = originalQuery;
      if (metaCatalogMock) {
        if (originalMetaCatalogModule) require.cache[metaCatalogPath] = originalMetaCatalogModule;
        else delete require.cache[metaCatalogPath];
      }
      delete require.cache[require.resolve('../src/services/metaCatalogConnectionService')];
    }
  };
}

const ACCOUNT_ROW = {
  id: 5, workspace_id: 1, waba_id: 'test-waba-id', business_id: 'test-business-id',
  access_token_encrypted: null,
};

function encryptedToken() {
  const { encrypt } = require('../src/util/crypto');
  return encrypt('test-graph-token');
}

// ── Required ids ─────────────────────────────────────────────────────────

test('getConnection requires both workspaceId and whatsappAccountId', async () => {
  await withMocks()(async (svc) => {
    await assert.rejects(svc.getConnection(null, 5), /workspaceId/);
    await assert.rejects(svc.getConnection(1, null), /whatsappAccountId/);
  });
});

// ── Isolation ────────────────────────────────────────────────────────────

test('getConnection scopes the query by BOTH workspace_id AND whatsapp_account_id', async () => {
  await withMocks({
    queryHandler(sql, params) {
      if (/^SELECT \* FROM coexistence\.meta_catalog_connections/i.test(sql)) {
        assert.deepEqual(params, [1, 5]);
        return { rows: [{ id: 10, workspace_id: 1, whatsapp_account_id: 5, catalog_id: 'cat-1', status: 'connected' }] };
      }
    },
  })(async (svc) => {
    const row = await svc.getConnection(1, 5);
    assert.equal(row.id, 10);
  });
});

test('listAvailableCatalogs throws 404 when the WhatsApp account does not belong to the workspace', async () => {
  await withMocks({
    queryHandler(sql) {
      if (/^SELECT id, workspace_id, waba_id/i.test(sql)) return { rows: [] };
    },
  })(async (svc) => {
    await assert.rejects(svc.listAvailableCatalogs(1, 999), (err) => err.status === 404);
  });
});

test('listAvailableCatalogs never hardcodes a business id — it comes from the whatsapp_accounts row', async () => {
  let capturedBusinessId = null;
  await withMocks({
    queryHandler(sql) {
      if (/^SELECT id, workspace_id, waba_id/i.test(sql)) {
        return { rows: [{ ...ACCOUNT_ROW, access_token_encrypted: encryptedToken() }] };
      }
    },
    metaCatalogMock: {
      listOwnedCatalogs: async ({ businessId }) => { capturedBusinessId = businessId; return [{ id: 'cat-1', name: 'Generic Catalog' }]; },
    },
  })(async (svc) => {
    const catalogs = await svc.listAvailableCatalogs(1, 5);
    assert.equal(capturedBusinessId, 'test-business-id');
    assert.deepEqual(catalogs, [{ id: 'cat-1', name: 'Generic Catalog' }]);
  });
});

test('listAvailableCatalogs throws when the account has no business_id (no silent fallback/hardcode)', async () => {
  await withMocks({
    queryHandler(sql) {
      if (/^SELECT id, workspace_id, waba_id/i.test(sql)) return { rows: [{ ...ACCOUNT_ROW, business_id: null }] };
    },
  })(async (svc) => {
    await assert.rejects(svc.listAvailableCatalogs(1, 5), /business Manager id/i);
  });
});

// ── Connect / reuse-token behavior ───────────────────────────────────────

test('connectCatalog reuses the WhatsApp account token and never writes access_token_encrypted when no explicit token is given', async () => {
  let insertParams = null;
  await withMocks({
    queryHandler(sql, params) {
      if (/^SELECT id, workspace_id, waba_id/i.test(sql)) return { rows: [{ ...ACCOUNT_ROW, access_token_encrypted: encryptedToken() }] };
      if (/^INSERT INTO coexistence\.meta_catalog_connections/i.test(sql)) {
        insertParams = params;
        return { rows: [{ id: 20, workspace_id: 1, whatsapp_account_id: 5, catalog_id: 'cat-1', status: 'connected', access_token_encrypted: null }] };
      }
      if (/^SELECT \* FROM coexistence\.meta_catalog_connections/i.test(sql)) {
        return { rows: [{ id: 20, workspace_id: 1, whatsapp_account_id: 5, catalog_id: 'cat-1', status: 'connected', access_token_encrypted: null }] };
      }
    },
    metaCatalogMock: {
      associateCatalogWithWaba: async () => ({ success: true }),
    },
  })(async (svc) => {
    const connection = await svc.connectCatalog(1, 5, { catalogId: 'cat-1' });
    // 5th bind param is access_token_encrypted — must be null: no distinct token supplied
    assert.equal(insertParams[4], null);
    assert.equal(connection.hasOwnToken, false);
  });
});

test('connectCatalog encrypts and stores a distinct token only when one is explicitly supplied', async () => {
  let insertParams = null;
  await withMocks({
    queryHandler(sql, params) {
      if (/^SELECT id, workspace_id, waba_id/i.test(sql)) return { rows: [ACCOUNT_ROW] };
      if (/^INSERT INTO coexistence\.meta_catalog_connections/i.test(sql)) {
        insertParams = params;
        return { rows: [{ id: 21, workspace_id: 1, whatsapp_account_id: 5, catalog_id: 'cat-2', status: 'connected', access_token_encrypted: params[4] }] };
      }
      if (/^SELECT \* FROM coexistence\.meta_catalog_connections/i.test(sql)) {
        return { rows: [{ id: 21, workspace_id: 1, whatsapp_account_id: 5, catalog_id: 'cat-2', status: 'connected', access_token_encrypted: insertParams[4] }] };
      }
    },
    metaCatalogMock: {
      associateCatalogWithWaba: async () => ({ success: true }),
    },
  })(async (svc) => {
    const connection = await svc.connectCatalog(1, 5, { catalogId: 'cat-2', token: 'a-distinct-system-user-token' });
    assert.notEqual(insertParams[4], null);
    assert.notEqual(insertParams[4], 'a-distinct-system-user-token', 'token must be encrypted, never stored in plaintext');
    assert.equal(connection.hasOwnToken, true);
  });
});

test('connectCatalog requires catalogId', async () => {
  await withMocks()(async (svc) => {
    await assert.rejects(svc.connectCatalog(1, 5, {}), /catalogId/);
  });
});

// ── Never expose tokens ──────────────────────────────────────────────────

test('serializeConnection never includes access_token_encrypted, only a hasOwnToken boolean', async () => {
  await withMocks()(async (svc) => {
    const serialized = svc.serializeConnection({
      id: 1, workspace_id: 1, whatsapp_account_id: 5, catalog_id: 'cat-1',
      status: 'connected', access_token_encrypted: 'ciphertext-secret',
    });
    assert.equal(serialized.access_token_encrypted, undefined);
    assert.equal(JSON.stringify(serialized).includes('ciphertext-secret'), false);
    assert.equal(serialized.hasOwnToken, true);
  });
});

test('disconnectCatalog throws 404 when no connection exists for this workspace/account', async () => {
  await withMocks({
    queryHandler(sql) {
      if (/^SELECT \* FROM coexistence\.meta_catalog_connections/i.test(sql)) return { rows: [] };
    },
  })(async (svc) => {
    await assert.rejects(svc.disconnectCatalog(1, 5), (err) => err.status === 404);
  });
});
