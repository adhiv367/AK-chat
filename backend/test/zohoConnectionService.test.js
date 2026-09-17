'use strict';

// Phase 8B Part 1 — Zoho connection service tests. Mocks pool.query on the
// shared '../src/db' singleton (same approach as test/zohoSchema.test.js).
// No live Postgres required.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

process.env.AKCHAT_ENCRYPTION_KEY = process.env.AKCHAT_ENCRYPTION_KEY || nodeCrypto.randomBytes(24).toString('hex');

function withMockedPool(handler, run) {
  return async () => {
    const pool = require('../src/db');
    const queries = [];
    const original = pool.query;
    pool.query = async (sql, params) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      queries.push({ sql: normalized, params });
      const result = handler(normalized, params, queries);
      return result !== undefined ? result : { rows: [] };
    };
    try {
      delete require.cache[require.resolve('../src/services/zohoConnectionService')];
      const svc = require('../src/services/zohoConnectionService');
      await run(svc, queries);
    } finally {
      pool.query = original;
    }
  };
}

const OWNED_WA_ACCOUNT = { rows: [{ id: 5 }] };
const NOT_OWNED = { rows: [] };

// ── Ownership guard ───────────────────────────────────────────────────────

test('assertWhatsappAccountInWorkspace throws (404) when the account does not belong to the workspace', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return NOT_OWNED;
}, async (svc) => {
  await assert.rejects(
    svc.assertWhatsappAccountInWorkspace(1, 5),
    (err) => err.status === 404
  );
}));

test('assertWhatsappAccountInWorkspace requires both ids', withMockedPool(() => undefined, async (svc) => {
  await assert.rejects(svc.assertWhatsappAccountInWorkspace(null, 5), /workspaceId/);
  await assert.rejects(svc.assertWhatsappAccountInWorkspace(1, null), /whatsappAccountId/);
}));

test('findConnection scopes the whatsapp_accounts ownership check by workspace_id (prevents Workspace A -> Workspace B whatsapp account use)', withMockedPool((sql, params) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) {
    assert.deepEqual(params, [5, 1]);
    return OWNED_WA_ACCOUNT;
  }
}, async (svc) => {
  await svc.findConnection(1, 5);
}));

// ── Lookup / isolation ────────────────────────────────────────────────────

test('findConnection queries by BOTH workspace_id AND whatsapp_account_id', withMockedPool((sql, params) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED_WA_ACCOUNT;
  if (/^SELECT \* FROM coexistence\.zoho_connections WHERE workspace_id/i.test(sql)) {
    assert.deepEqual(params, [1, 5]);
    return { rows: [{ id: 10, workspace_id: 1, whatsapp_account_id: 5, status: 'connected' }] };
  }
}, async (svc) => {
  const row = await svc.findConnection(1, 5);
  assert.equal(row.id, 10);
}));

test('getConnection returns null (not an error) when no connection row exists yet', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED_WA_ACCOUNT;
  if (/^SELECT \* FROM coexistence\.zoho_connections WHERE workspace_id/i.test(sql)) return { rows: [] };
}, async (svc) => {
  const result = await svc.getConnection(1, 5);
  assert.equal(result, null);
}));

// ── Safe serialization ────────────────────────────────────────────────────

test('serializeConnection never includes token fields, only a hasRefreshToken boolean', withMockedPool(() => undefined, async (svc) => {
  const serialized = svc.serializeConnection({
    id: 1,
    workspace_id: 1,
    whatsapp_account_id: 5,
    status: 'connected',
    access_token_encrypted: 'ciphertext-access',
    refresh_token_encrypted: 'ciphertext-refresh',
    zoho_org_id: 'org-1',
  });
  assert.equal(serialized.accessTokenEncrypted, undefined);
  assert.equal(serialized.refreshTokenEncrypted, undefined);
  assert.equal(serialized.accessToken, undefined);
  assert.equal(serialized.refreshToken, undefined);
  assert.equal(JSON.stringify(serialized).includes('ciphertext'), false);
  assert.equal(serialized.hasRefreshToken, true);
}));

test('serializeConnection returns null for a null row', withMockedPool(() => undefined, async (svc) => {
  assert.equal(svc.serializeConnection(null), null);
}));

// ── ensureConnection ──────────────────────────────────────────────────────

test('ensureConnection is idempotent: returns the existing row without inserting when one already exists', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED_WA_ACCOUNT;
  if (/^SELECT \* FROM coexistence\.zoho_connections WHERE workspace_id/i.test(sql)) {
    return { rows: [{ id: 10, workspace_id: 1, whatsapp_account_id: 5, status: 'disconnected' }] };
  }
  if (/^INSERT INTO coexistence\.zoho_connections/i.test(sql)) {
    throw new Error('must not INSERT when a connection already exists');
  }
}, async (svc) => {
  const result = await svc.ensureConnection(1, 5);
  assert.equal(result.id, 10);
}));

test('ensureConnection inserts a disconnected row scoped to workspace+account when none exists', withMockedPool((sql, params) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED_WA_ACCOUNT;
  if (/^SELECT \* FROM coexistence\.zoho_connections WHERE workspace_id/i.test(sql)) return { rows: [] };
  if (/^INSERT INTO coexistence\.zoho_connections/i.test(sql)) {
    assert.deepEqual(params.slice(0, 2), [1, 5]);
    return { rows: [{ id: 11, workspace_id: 1, whatsapp_account_id: 5, status: 'disconnected' }] };
  }
}, async (svc) => {
  const result = await svc.ensureConnection(1, 5);
  assert.equal(result.status, 'disconnected');
}));

// ── Status management ─────────────────────────────────────────────────────

test('updateConnectionStatus rejects an invalid status value', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED_WA_ACCOUNT;
}, async (svc) => {
  await assert.rejects(svc.updateConnectionStatus(1, 5, 'BOGUS_STATUS'), /Invalid Zoho connection status/);
}));

test('updateConnectionStatus accepts each documented safe status', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED_WA_ACCOUNT;
  if (/^SELECT \* FROM coexistence\.zoho_connections WHERE workspace_id/i.test(sql)) {
    return { rows: [{ id: 10, workspace_id: 1, whatsapp_account_id: 5 }] };
  }
  if (/^UPDATE coexistence\.zoho_connections/i.test(sql)) {
    return { rows: [{ id: 10, workspace_id: 1, whatsapp_account_id: 5, status: 'connected' }] };
  }
}, async (svc) => {
  for (const status of svc.CONNECTION_STATUSES) {
    await svc.updateConnectionStatus(1, 5, status);
  }
}));

test('recordError sets status to error and stores a truncated last_error message', withMockedPool((sql, params, queries) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED_WA_ACCOUNT;
  if (/^SELECT \* FROM coexistence\.zoho_connections WHERE workspace_id/i.test(sql)) {
    return { rows: [{ id: 10, workspace_id: 1, whatsapp_account_id: 5 }] };
  }
  if (/^UPDATE coexistence\.zoho_connections/i.test(sql)) {
    assert.match(sql, /status = 'error'/);
    return { rows: [{ id: 10, workspace_id: 1, whatsapp_account_id: 5, status: 'error', last_error: params[2] }] };
  }
}, async (svc) => {
  const result = await svc.recordError(1, 5, 'refresh token revoked');
  assert.equal(result.status, 'error');
  assert.equal(result.lastError, 'refresh token revoked');
}));

// ── Disconnect ─────────────────────────────────────────────────────────────

test('disconnect clears all token/org fields and sets status disconnected', withMockedPool((sql, params) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED_WA_ACCOUNT;
  if (/^SELECT \* FROM coexistence\.zoho_connections WHERE workspace_id/i.test(sql)) {
    return { rows: [{ id: 10, workspace_id: 1, whatsapp_account_id: 5 }] };
  }
  if (/^UPDATE coexistence\.zoho_connections/i.test(sql)) {
    assert.match(sql, /access_token_encrypted = NULL/);
    assert.match(sql, /refresh_token_encrypted = NULL/);
    assert.match(sql, /status = 'disconnected'/);
    return { rows: [{ id: 10, workspace_id: 1, whatsapp_account_id: 5, status: 'disconnected' }] };
  }
}, async (svc) => {
  const result = await svc.disconnect(1, 5);
  assert.equal(result.status, 'disconnected');
}));

test('disconnect returns null when there is no connection to disconnect (no crash)', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED_WA_ACCOUNT;
  if (/^SELECT \* FROM coexistence\.zoho_connections WHERE workspace_id/i.test(sql)) return { rows: [] };
}, async (svc) => {
  const result = await svc.disconnect(1, 5);
  assert.equal(result, null);
}));

// ── Cross-workspace / cross-account isolation ────────────────────────────

test('every lookup/update query filters explicitly by workspace_id in its WHERE clause', withMockedPool((sql) => {
  if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED_WA_ACCOUNT;
  if (/^SELECT \* FROM coexistence\.zoho_connections WHERE workspace_id/i.test(sql)) {
    return { rows: [{ id: 10, workspace_id: 1, whatsapp_account_id: 5 }] };
  }
  if (/^UPDATE coexistence\.zoho_connections/i.test(sql)) {
    assert.match(sql, /WHERE id = \$\d+ AND workspace_id = \$\d+/);
    return { rows: [{ id: 10 }] };
  }
}, async (svc) => {
  await svc.updateConnectionStatus(1, 5, 'connected');
  await svc.recordSuccess(1, 5);
}));








