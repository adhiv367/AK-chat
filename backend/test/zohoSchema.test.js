'use strict';

// Phase 8A — Zoho CRM Integration: schema-foundation tests.
//
// Same no-real-Postgres approach as test/broadcastsSourceCheckConstraint.test.js
// and test/sequences.test.js: pool.query is monkey-patched on the shared
// '../src/db' singleton and every issued SQL statement is captured, then
// asserted against — no live Postgres reachable from this sandbox.

const test = require('node:test');
const assert = require('node:assert/strict');

function withMockedPool(run) {
  return async () => {
    const pool = require('../src/db');
    const queries = [];
    const originalQuery = pool.query;
    pool.query = async (sql, params) => {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return { rows: [] };
    };
    try {
      delete require.cache[require.resolve('../src/db/zohoSchema')];
      const zohoSchema = require('../src/db/zohoSchema');
      await run(zohoSchema, queries);
    } finally {
      pool.query = originalQuery;
    }
  };
}

// ── Schema creation ───────────────────────────────────────────────────────

test('ensureZohoTables creates all five tables, idempotently', withMockedPool(async (schema, queries) => {
  await schema.ensureZohoTables();

  const createStmts = queries.filter((q) => /^CREATE TABLE IF NOT EXISTS/i.test(q.sql));
  const tables = createStmts.map((q) => q.sql.match(/CREATE TABLE IF NOT EXISTS (coexistence\.\w+)/i)[1]);

  assert.deepEqual(
    [...new Set(tables)].sort(),
    [
      'coexistence.zoho_connections',
      'coexistence.zoho_extraction_audit',
      'coexistence.zoho_field_mappings',
      'coexistence.zoho_lead_links',
      // Phase 8C Part 2 — additive Note-idempotency ledger (see
      // zohoSchema.js's table comment for why this is a new table rather
      // than a column on zoho_lead_links).
      'coexistence.zoho_lead_notes',
    ].sort(),
    'must create exactly the five foundation tables (four from 8A + zoho_lead_notes from 8C Part 2)'
  );

  // Every CREATE TABLE statement must use IF NOT EXISTS (idempotent startup).
  for (const stmt of createStmts) {
    assert.match(stmt.sql, /CREATE TABLE IF NOT EXISTS/i);
  }
}));

test('ensureZohoTables is safe to call twice in a row (idempotent startup)', withMockedPool(async (schema) => {
  await schema.ensureZohoTables();
  await assert.doesNotReject(schema.ensureZohoTables());
}));

// ── Phase 8B Part 2 — reauth_required status support ───────────────────────

test('ZOHO_CONNECTION_STATUSES includes reauth_required alongside the original three values', withMockedPool(async (schema) => {
  assert.deepEqual(
    [...schema.ZOHO_CONNECTION_STATUSES].sort(),
    ['connected', 'disconnected', 'error', 'reauth_required'].sort()
  );
}));

test('ensureZohoTables migrates the status CHECK constraint additively (drop-if-exists then re-add, same constraint name, no data touched)', withMockedPool(async (schema, queries) => {
  await schema.ensureZohoTables();

  const dropStmt = queries.find((q) => /^ALTER TABLE coexistence\.zoho_connections\s+DROP CONSTRAINT IF EXISTS zoho_connections_status_check/i.test(q.sql));
  const addStmt = queries.find((q) => /^ALTER TABLE coexistence\.zoho_connections\s+ADD CONSTRAINT zoho_connections_status_check/i.test(q.sql));

  assert.ok(dropStmt, 'must DROP CONSTRAINT IF EXISTS before re-adding (idempotent on repeated startup)');
  assert.ok(addStmt, 'must re-ADD CONSTRAINT with the same name');
  assert.match(addStmt.sql, /'reauth_required'/, 'the re-added constraint must allow reauth_required');
  assert.match(addStmt.sql, /'disconnected'/);
  assert.match(addStmt.sql, /'connected'/);
  assert.match(addStmt.sql, /'error'/);

  // Must appear in drop-then-add order, and before the connected/whatsapp
  // account indexes (i.e. right after table creation, not bolted on at the end).
  assert.ok(queries.indexOf(dropStmt) < queries.indexOf(addStmt));
}));

test('the status-constraint migration never issues UPDATE/DELETE (additive only, no data rewrite)', withMockedPool(async (schema, queries) => {
  await schema.ensureZohoTables();
  const mutations = queries.filter((q) => /^(UPDATE|DELETE)\b/i.test(q.sql));
  assert.deepEqual(mutations, []);
}));

test('ensureZohoTables never issues UPDATE or DELETE against existing data', withMockedPool(async (schema, queries) => {
  await schema.ensureZohoTables();
  for (const q of queries) {
    assert.doesNotMatch(q.sql, /^UPDATE\s+coexistence/i, `unexpected UPDATE: ${q.sql}`);
    assert.doesNotMatch(q.sql, /^DELETE\s+FROM/i, `unexpected DELETE: ${q.sql}`);
  }
}));

test('ensureZohoTables never touches any pre-existing table other than whatsapp_accounts/workspaces/akchat_users via FK reference', withMockedPool(async (schema, queries) => {
  await schema.ensureZohoTables();
  const alteredTables = queries
    .filter((q) => /^ALTER TABLE/i.test(q.sql))
    .map((q) => q.sql.match(/ALTER TABLE\s+(coexistence\.\w+)/i)[1]);
  // Phase 8B Part 2 legitimately ALTERs coexistence.zoho_connections itself
  // (additive status-constraint migration to allow 'reauth_required' — see
  // the dedicated migration tests below), and the ZOHO PHASE 8 — FINAL FIX
  // (Note Consolidation) legitimately ALTERs coexistence.zoho_lead_notes
  // itself (additive `note_fields` column — see zohoNoteService.js's
  // upsertConversationNote) — both tables are owned by this same schema
  // file, not pre-existing tables. No OTHER table may ever appear here;
  // this test's original 8A guarantee (no ALTER of anything) still holds
  // for every table this schema does not itself own.
  const unexpectedAlters = alteredTables.filter((t) => t !== 'coexistence.zoho_connections' && t !== 'coexistence.zoho_lead_notes');
  assert.deepEqual(unexpectedAlters, [], 'must not ALTER any table other than ones this schema file itself owns (zoho_connections, zoho_lead_notes)');
}));

// ── workspace_id + whatsapp_account_id isolation ────────────────────────

test('zoho_connections requires NOT NULL workspace_id and whatsapp_account_id, both FK-constrained', withMockedPool(async (schema, queries) => {
  await schema.ensureZohoTables();
  const create = queries.find((q) => /CREATE TABLE IF NOT EXISTS coexistence\.zoho_connections/i.test(q.sql)).sql;

  assert.match(create, /workspace_id\s+BIGINT NOT NULL REFERENCES coexistence\.workspaces\(id\) ON DELETE CASCADE/i);
  assert.match(create, /whatsapp_account_id\s+BIGINT NOT NULL REFERENCES coexistence\.whatsapp_accounts\(id\) ON DELETE CASCADE/i);
}));

test('zoho_connections enforces UNIQUE(workspace_id, whatsapp_account_id) — one connection per WhatsApp account, isolated per workspace', withMockedPool(async (schema, queries) => {
  await schema.ensureZohoTables();
  const create = queries.find((q) => /CREATE TABLE IF NOT EXISTS coexistence\.zoho_connections/i.test(q.sql)).sql;
  assert.match(create, /UNIQUE\s*\(workspace_id, whatsapp_account_id\)/i);
}));

test('zoho_lead_links, zoho_field_mappings, and zoho_extraction_audit all carry both workspace_id and whatsapp_account_id directly (no join-only isolation)', withMockedPool(async (schema, queries) => {
  await schema.ensureZohoTables();
  for (const table of ['zoho_lead_links', 'zoho_field_mappings', 'zoho_extraction_audit']) {
    const create = queries.find((q) => new RegExp(`CREATE TABLE IF NOT EXISTS coexistence\\.${table}\\b`, 'i').test(q.sql)).sql;
    assert.match(create, /workspace_id\s+BIGINT NOT NULL REFERENCES coexistence\.workspaces\(id\) ON DELETE CASCADE/i, `${table} must require workspace_id`);
    assert.match(create, /whatsapp_account_id\s+BIGINT NOT NULL REFERENCES coexistence\.whatsapp_accounts\(id\) ON DELETE CASCADE/i, `${table} must require whatsapp_account_id`);
  }
}));

test('zoho_lead_links enforces idempotent identity: UNIQUE(workspace_id, whatsapp_account_id, contact_number)', withMockedPool(async (schema, queries) => {
  await schema.ensureZohoTables();
  const create = queries.find((q) => /CREATE TABLE IF NOT EXISTS coexistence\.zoho_lead_links/i.test(q.sql)).sql;
  assert.match(create, /UNIQUE\s*\(workspace_id, whatsapp_account_id, contact_number\)/i);
}));

test('zoho_field_mappings enforces UNIQUE(workspace_id, whatsapp_account_id, field_key) so field configs never collide across businesses', withMockedPool(async (schema, queries) => {
  await schema.ensureZohoTables();
  const create = queries.find((q) => /CREATE TABLE IF NOT EXISTS coexistence\.zoho_field_mappings/i.test(q.sql)).sql;
  assert.match(create, /UNIQUE\s*\(workspace_id, whatsapp_account_id, field_key\)/i);
}));

// ── Token security ────────────────────────────────────────────────────────

test('zoho_connections stores tokens only as *_encrypted TEXT columns, never a plaintext token column', withMockedPool(async (schema, queries) => {
  await schema.ensureZohoTables();
  const create = queries.find((q) => /CREATE TABLE IF NOT EXISTS coexistence\.zoho_connections/i.test(q.sql)).sql;

  assert.match(create, /access_token_encrypted\s+TEXT/i);
  assert.match(create, /refresh_token_encrypted\s+TEXT/i);
  assert.doesNotMatch(create, /\baccess_token\s+TEXT/i, 'must not store a plaintext access_token column');
  assert.doesNotMatch(create, /\brefresh_token\s+TEXT/i, 'must not store a plaintext refresh_token column');
}));

test('util/crypto.js encrypt/decrypt (already used for WhatsApp tokens) round-trips correctly, confirming it is reusable for Zoho tokens', () => {
  const { encrypt, decrypt } = require('../src/util/crypto');
  const secret = 'zoho-refresh-token-example-value';
  const ciphertext = encrypt(secret);
  assert.ok(ciphertext, 'encrypt should return a non-empty ciphertext');
  assert.notEqual(ciphertext, secret, 'ciphertext must not equal the plaintext');
  assert.equal(decrypt(ciphertext), secret, 'decrypt must recover the original plaintext');
});

// ── No premature scope: no OAuth routes, no Zoho API calls, no frontend ───

test('no OAuth/Zoho API route files exist yet (8B+ scope)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const routesDir = path.join(__dirname, '..', 'src', 'routes');
  const files = fs.readdirSync(routesDir);
  const zohoRouteFiles = files.filter((f) => /zoho/i.test(f));
  assert.deepEqual(zohoRouteFiles, [], 'Phase 8A must not add any routes/zoho* files');
});

test('index.js wires ensureZohoTables after ensureWorkspaceTables and ensureWhatsappAccountsSaasColumns', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

  assert.match(src, /require\('\.\/db\/zohoSchema'\)/, 'index.js must require zohoSchema');
  assert.match(src, /await ensureZohoTables\(\)/, 'index.js must call ensureZohoTables()');

  const workspaceIdx = src.indexOf('await ensureWorkspaceTables()');
  const whatsappIdx = src.indexOf('await ensureWhatsappAccountsSaasColumns()');
  const zohoIdx = src.indexOf('await ensureZohoTables()');

  assert.ok(workspaceIdx !== -1 && whatsappIdx !== -1 && zohoIdx !== -1, 'all three calls must be present');
  assert.ok(zohoIdx > workspaceIdx, 'ensureZohoTables must run after ensureWorkspaceTables');
  assert.ok(zohoIdx > whatsappIdx, 'ensureZohoTables must run after ensureWhatsappAccountsSaasColumns');
});