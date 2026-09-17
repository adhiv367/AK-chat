'use strict';

// Phase 7.12B — Cross-Tenant Media/Template Isolation Fix.
//
// Covers the two genuine findings from the Phase 7.12A audit:
//
//   7.12A-01: POST /messages/send-library-media resolved a client-supplied
//   mediaLibraryId with no workspace_id filter, and did not pass a
//   workspaceId through to syncMediaToAccount().
//
//   7.12A-02: POST /broadcasts and PUT /broadcasts/:id wrote a
//   client-supplied template_id / media_library_id straight onto the
//   broadcast row with no ownership check, and the three send-time
//   media_library lookups (sendBroadcastById, the Send Now inline path,
//   and the scheduler path) resolved media by id alone.
//
// Same harness as test/ordersRoutes.test.js / test/cartAccountOwnership.test.js:
// pool.query is monkey-patched with a small in-memory model of exactly the
// SQL these routes issue, and route handler chains are invoked directly
// against router.stack — no live Postgres, no supertest. Heavy
// dependencies (Meta send, filesystem media mirroring, BullMQ) are stubbed
// via require.cache the same way test/webhookContactWorkspaceId.test.js
// stubs webhook.js's dependencies.

process.env.MEDIA_DIR = require('node:os').tmpdir();

const test = require('node:test');
const assert = require('node:assert/strict');

function stubModule(relPath, exports) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// ── Stubs shared by both route files ────────────────────────────────────
// None of these are the subject of this test batch — they're stubbed so
// the routes under test can run their real logic (including the fixed
// workspace-scoped queries) without touching Postgres, Meta, or the
// filesystem beyond a throwaway tmp dir.
stubModule('../src/services/messageSender', {
  resolveAccount: async ({ workspaceId }) => ({
    account: {
      id: 900, workspaceId, phoneNumberId: 'PNID-900',
      displayPhoneNumber: '15550000000', accessToken: 'test-token',
    },
    error: null,
  }),
  insertPendingRow: async () => 'local-msg-1',
  secondsSinceLastIncoming: async () => 10,
});
stubModule('../src/queue/sendQueue', { enqueueSend: async () => {} });
stubModule('../src/integrations/metaSend', {
  sendText: async () => ({}), sendTemplate: async () => ({}), sendMedia: async () => ({}),
  sendInteractive: async () => ({}), sendFlowMessage: async () => ({}), sendLocation: async () => ({}),
  sendContacts: async () => ({}), sendReaction: async () => ({}), uploadMedia: async () => ({}),
});
stubModule('../src/services/whatsappProductMessage', {
  buildProductInteractive: () => ({}), buildCatalogInteractive: () => ({}),
});
stubModule('../src/services/accountHealth', {
  markAccountHealth: async () => {}, classifyMetaError: () => null,
});
stubModule('../src/util/pgStorage', {
  getObjectBuffer: async () => Buffer.from('fake-bytes'),
  putObjectBuffer: async () => ({}),
});
// mediaLibrary.js is require()'d *inside* the send-library-media handler
// and inside broadcasts.js's send paths (`require('./mediaLibrary')`) —
// stub its syncMediaToAccount export so no real Meta upload is attempted.
// The workspaceId argument is recorded so the test can assert it was
// actually passed through (part of Finding 7.12A-01's required fix).
const syncCalls = [];
stubModule('../src/routes/mediaLibrary', {
  syncMediaToAccount: async (mediaId, accountId, workspaceId) => {
    syncCalls.push({ mediaId, accountId, workspaceId });
    return { metaMediaId: 'META-MEDIA-1', expiresAt: new Date(Date.now() + 999999), status: 'synced' };
  },
});
// whatsappAccounts.js's getAccountByPhoneNumber is used directly by
// messages.js's assertWaWorkspace() to confirm a wa_number belongs to the
// caller's workspace — stub it so messages.js's own workspace-membership
// check always passes for our fake fromNumber, independent of the fix
// under test (the media_library scoping).
stubModule('../src/routes/whatsappAccounts', {
  getAccountByPhoneNumber: async (phoneOrId, workspaceId) =>
    (workspaceId === 10 ? { id: 900, workspaceId: 10, displayPhoneNumber: '15550000000' } : null),
  getAccountWithToken: async () => ({ id: 900, workspaceId: 10 }),
});

const pool = require('../src/db');
const { router: messagesRouter } = require('../src/routes/messages');
const { router: broadcastsRouter } = require('../src/routes/broadcasts');

// ── Minimal Express route-chain runner (same shape as test/ordersRoutes.test.js) ──
function callRoute(routerToUse, method, path, req) {
  const layer = routerToUse.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      body: undefined,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; resolve(this); return this; },
    };
    let idx = 0;
    function next(err) {
      if (err) return reject(err);
      idx += 1;
      if (idx >= stack.length) return;
      Promise.resolve(stack[idx].handle(req, res, next)).catch(reject);
    }
    Promise.resolve(stack[0].handle(req, res, next)).catch(reject);
  });
}

function ownerReq(workspaceId, extra = {}) {
  return {
    user: { id: 1, role: 'OWNER' },
    workspace: { id: workspaceId, role: 'OWNER' },
    params: {}, query: {}, body: {},
    ...extra,
  };
}

// ── Fake DB ──────────────────────────────────────────────────────────────
// Two workspaces (10 and 20), each with its own template and media_library
// row, plus one broadcast pre-seeded in workspace 10.
function makeFakeDb() {
  let nextId = 1000;
  const templates = [
    { id: 1, workspace_id: 10, name: 'ws10-template' },
    { id: 2, workspace_id: 20, name: 'ws20-template' },
  ];
  const media = [
    { id: 100, workspace_id: 10, deleted_at: null, storage_key: 'k-100', mime_type: 'image/jpeg', original_name: 'a.jpg' },
    { id: 200, workspace_id: 20, deleted_at: null, storage_key: 'k-200', mime_type: 'image/jpeg', original_name: 'b.jpg' },
  ];
  const broadcasts = [];

  async function query(sqlRaw, params = []) {
    const sql = sqlRaw.replace(/\s+/g, ' ').trim();

    // ── message_templates ownership check (broadcasts.js validateBroadcastReferences) ──
    if (/^SELECT id FROM coexistence\.message_templates WHERE id = \$1 AND workspace_id = \$2$/i.test(sql)) {
      const [id, wsId] = params;
      const row = templates.find(t => t.id === Number(id) && t.workspace_id === wsId);
      return { rows: row ? [{ id: row.id }] : [] };
    }

    // ── media_library ownership check (broadcasts.js validateBroadcastReferences) ──
    if (/^SELECT id FROM coexistence\.media_library WHERE id = \$1 AND workspace_id = \$2 AND deleted_at IS NULL$/i.test(sql)) {
      const [id, wsId] = params;
      const row = media.find(m => m.id === Number(id) && m.workspace_id === wsId && !m.deleted_at);
      return { rows: row ? [{ id: row.id }] : [] };
    }

    // ── messages.js send-library-media: full media_library row, workspace-scoped ──
    if (/^SELECT \* FROM coexistence\.media_library WHERE id = \$1 AND deleted_at IS NULL AND workspace_id = \$2$/i.test(sql)) {
      const [id, wsId] = params;
      const row = media.find(m => m.id === Number(id) && m.workspace_id === wsId && !m.deleted_at);
      return { rows: row ? [row] : [] };
    }

    // ── broadcasts.js send-time media_library lookup (3 call sites, now workspace-scoped) ──
    if (/^SELECT \* FROM coexistence\.media_library WHERE id = \$1 AND workspace_id = \$2 AND deleted_at IS NULL$/i.test(sql)) {
      const [id, wsId] = params;
      const row = media.find(m => m.id === Number(id) && m.workspace_id === wsId && !m.deleted_at);
      return { rows: row ? [row] : [] };
    }

    // ── media_meta_sync lookup (both routes) — no cached sync, forces the
    //    syncMediaToAccount() call path so the workspaceId argument fix
    //    (Finding 7.12A-01) is actually exercised. ──
    if (/^SELECT \* FROM coexistence\.media_meta_sync WHERE media_id = \$1 AND account_id = \$2$/i.test(sql)) {
      return { rows: [] };
    }

    // ── chat_history media update (messages.js) ──
    if (/^UPDATE coexistence\.chat_history SET/i.test(sql)) {
      return { rows: [] };
    }

    // ── broadcasts: INSERT ──
    if (/^INSERT INTO coexistence\.broadcasts/i.test(sql)) {
      const [workspaceId, from_number, recipient_numbers, template_id, status, test_number, name,
        variable_mapping, message_type, body, url, media_library_id, caption, scheduled_at] = params;
      const row = {
        id: nextId++, workspace_id: workspaceId, from_number, recipient_numbers, template_id, status,
        test_number, name, variable_mapping, message_type, body, url, media_library_id, caption, scheduled_at,
      };
      broadcasts.push(row);
      return { rows: [row] };
    }

    // ── sendBroadcastById: broadcast + LEFT JOIN template ──
    if (/^SELECT b\.\*, t\.id AS t_id.*FROM coexistence\.broadcasts b\s+LEFT JOIN coexistence\.message_templates t ON t\.id = b\.template_id\s+WHERE b\.id = \$1 AND b\.workspace_id = \$2$/i.test(sql)) {
      const [id, wsId] = params;
      const row = broadcasts.find(b => b.id === Number(id) && b.workspace_id === wsId);
      if (!row) return { rows: [] };
      const tpl = templates.find(t => t.id === row.template_id);
      return { rows: [{
        ...row,
        t_id: tpl ? tpl.id : null, t_name: tpl ? tpl.name : null, t_language: 'en_US',
        t_body: 'body', t_header_type: null, t_header_text: null, t_footer: null, t_buttons: null,
      }] };
    }

    // ── broadcasts: existing-status lookup (PUT pre-check) ──
    if (/^SELECT status FROM coexistence\.broadcasts WHERE id = \$1 AND workspace_id = \$2$/i.test(sql)) {
      const row = broadcasts.find(b => b.id === Number(params[0]) && b.workspace_id === params[1]);
      return { rows: row ? [{ status: row.status }] : [] };
    }

    // ── broadcasts: UPDATE ──
    if (/^UPDATE coexistence\.broadcasts SET/i.test(sql)) {
      const id = Number(params[14]);
      const wsId = params[15];
      const row = broadcasts.find(b => b.id === id && b.workspace_id === wsId);
      if (!row) return { rows: [] };
      if (params[2] !== null) row.template_id = params[2];
      if (params[9] !== null) row.media_library_id = params[9];
      return { rows: [row] };
    }

    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) return { rows: [] };

    throw new Error(`Unhandled fake SQL: ${sql}`);
  }

  return { query, templates, media, broadcasts };
}

function installDb() {
  const fake = makeFakeDb();
  const original = pool.query;
  const originalConnect = pool.connect;
  pool.query = fake.query;
  // POST /broadcasts uses pool.connect() for a transaction — route the
  // fake client's query() through the same in-memory model.
  pool.connect = async () => ({
    query: fake.query,
    release() {},
  });
  return {
    fake,
    restore() { pool.query = original; pool.connect = originalConnect; },
  };
}

async function seedBroadcast(db, { workspaceId = 10, templateId = 1, mediaLibraryId = null, messageType = 'template' } = {}) {
  const { rows } = await db.query(
    `INSERT INTO coexistence.broadcasts
       (workspace_id, from_number, recipient_numbers, template_id, status, test_number, name,
        variable_mapping, message_type, body, url, media_library_id, caption,
        scheduled_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
     RETURNING *`,
    [workspaceId, '15550000000', JSON.stringify(['15551111111']), templateId, 'DRAFT', null, 'seed',
      JSON.stringify({}), messageType, null, null, mediaLibraryId, null, null]
  );
  return rows[0];
}

// ── Finding 7.12A-02: POST /broadcasts ──────────────────────────────────

test('POST /broadcasts rejects a template_id belonging to another workspace', async () => {
  const db = installDb();
  try {
    const req = ownerReq(10, {
      body: {
        from_number: '15550000000', recipient_numbers: ['15551111111'],
        template_id: 2, message_type: 'template',
      },
    });
    const res = await callRoute(broadcastsRouter, 'post', '/broadcasts', req);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /template_id/);
    assert.equal(db.fake.broadcasts.length, 0, 'no broadcast row should have been created');
  } finally { db.restore(); }
});

test('POST /broadcasts rejects a media_library_id belonging to another workspace', async () => {
  const db = installDb();
  try {
    const req = ownerReq(10, {
      body: {
        from_number: '15550000000', recipient_numbers: ['15551111111'],
        message_type: 'image', media_library_id: 200,
      },
    });
    const res = await callRoute(broadcastsRouter, 'post', '/broadcasts', req);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /media_library_id/);
    assert.equal(db.fake.broadcasts.length, 0);
  } finally { db.restore(); }
});

test('POST /broadcasts succeeds with a same-workspace template_id and media_library_id', async () => {
  const db = installDb();
  try {
    const req = ownerReq(10, {
      body: {
        from_number: '15550000000', recipient_numbers: ['15551111111'],
        template_id: 1, message_type: 'template', media_library_id: 100,
      },
    });
    const res = await callRoute(broadcastsRouter, 'post', '/broadcasts', req);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.template_id, 1);
    assert.equal(res.body.media_library_id, 100);
  } finally { db.restore(); }
});

// ── Finding 7.12A-02: PUT /broadcasts/:id ───────────────────────────────

test('PUT /broadcasts/:id rejects a template_id belonging to another workspace', async () => {
  const db = installDb();
  try {
    const seeded = await seedBroadcast(db.fake, { workspaceId: 10, templateId: 1 });
    const req = ownerReq(10, { params: { id: seeded.id }, body: { template_id: 2 } });
    const res = await callRoute(broadcastsRouter, 'put', '/broadcasts/:id', req);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /template_id/);
    const stillThere = db.fake.broadcasts.find(b => b.id === seeded.id);
    assert.equal(stillThere.template_id, 1, 'template_id must not have been overwritten');
  } finally { db.restore(); }
});

test('PUT /broadcasts/:id rejects a media_library_id belonging to another workspace', async () => {
  const db = installDb();
  try {
    const seeded = await seedBroadcast(db.fake, { workspaceId: 10, templateId: 1, mediaLibraryId: 100, messageType: 'image' });
    const req = ownerReq(10, { params: { id: seeded.id }, body: { media_library_id: 200 } });
    const res = await callRoute(broadcastsRouter, 'put', '/broadcasts/:id', req);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /media_library_id/);
    const stillThere = db.fake.broadcasts.find(b => b.id === seeded.id);
    assert.equal(stillThere.media_library_id, 100, 'media_library_id must not have been overwritten');
  } finally { db.restore(); }
});

test('PUT /broadcasts/:id succeeds with a same-workspace template_id and media_library_id', async () => {
  const db = installDb();
  try {
    const seeded = await seedBroadcast(db.fake, { workspaceId: 10, templateId: 1 });
    const req = ownerReq(10, { params: { id: seeded.id }, body: { template_id: 1, media_library_id: 100 } });
    const res = await callRoute(broadcastsRouter, 'put', '/broadcasts/:id', req);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.template_id, 1);
    assert.equal(res.body.media_library_id, 100);
  } finally { db.restore(); }
});

// ── Finding 7.12A-02: send-time media_library lookup (sendBroadcastById) ──

test('sendBroadcastById cannot resolve another workspace\'s media_library_id at send time', async () => {
  const db = installDb();
  try {
    // Simulates a broadcast whose media_library_id row was already
    // cross-workspace before this fix existed (e.g. created before
    // Phase 7.12B, or written directly). The send path must not resolve
    // it just because the id happens to exist in another workspace.
    const seeded = await seedBroadcast(db.fake, { workspaceId: 10, templateId: 1, mediaLibraryId: 200, messageType: 'image' });
    const { sendBroadcastById } = require('../src/routes/broadcasts');
    const result = await sendBroadcastById(10, seeded.id);
    // The broadcast itself is found (own workspace), but media resolution
    // must silently fail to find workspace 20's media — resolvedMediaId
    // stays null rather than being set from another tenant's row. We can't
    // observe resolvedMediaId directly, but we CAN confirm syncMediaToAccount
    // was never invoked with workspace 20's media id.
    assert.ok(!syncCalls.some(c => c.mediaId === 200), 'must never sync workspace 20 media from workspace 10 send');
    assert.notEqual(result.statusCode, 500, `unexpected 500: ${JSON.stringify(result.body)}`);
  } finally { db.restore(); }
});

// ── Finding 7.12A-01: POST /messages/send-library-media ─────────────────

test('POST /messages/send-library-media returns 404 for a mediaLibraryId belonging to another workspace', async () => {
  const db = installDb();
  try {
    const req = ownerReq(10, {
      body: { fromNumber: '15550000000', toNumber: '15551111111', mediaLibraryId: 200 },
    });
    const res = await callRoute(messagesRouter, 'post', '/messages/send-library-media', req);
    assert.equal(res.statusCode, 404);
    assert.match(res.body.error, /not found/i);
  } finally { db.restore(); }
});

test('POST /messages/send-library-media succeeds for a same-workspace mediaLibraryId and passes workspaceId to syncMediaToAccount', async () => {
  const db = installDb();
  syncCalls.length = 0;
  try {
    const req = ownerReq(10, {
      body: { fromNumber: '15550000000', toNumber: '15551111111', mediaLibraryId: 100 },
    });
    const res = await callRoute(messagesRouter, 'post', '/messages/send-library-media', req);
    assert.equal(res.statusCode, 202, `expected 202, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.mediaLibraryId, 100);
    assert.ok(
      syncCalls.some(c => c.mediaId === 100 && c.workspaceId === 10),
      'syncMediaToAccount must be called with the caller\'s workspaceId'
    );
  } finally { db.restore(); }
});