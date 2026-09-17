'use strict';

// Phase 8 — final migration fix: zoho_sync_state.sync_status CHECK
// constraint must permanently include every current status
// (pending/processing/lead_synced/note_pending/completed/incomplete/
// retryable_failure/permanent_failure/reauth_required — note:
// retryable_failure/permanent_failure/reauth_required actually live on
// FAILURE_TYPE, not sync_status, but the constraint under test only ever
// governs sync_status; ZOHO_SYNC_STATUSES is the single source of truth
// asserted against here) on BOTH fresh and pre-existing databases, without
// a manual ALTER ever being required again.
//
// Same no-real-Postgres approach as test/zohoSchema.test.js and
// test/broadcastsSourceCheckConstraint.test.js: pool.query is
// monkey-patched on the shared '../src/db' singleton and every issued SQL
// statement is captured, then asserted against.

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
      delete require.cache[require.resolve('../src/db/zohoSyncStateSchema')];
      const schema = require('../src/db/zohoSyncStateSchema');
      await run(schema, queries);
    } finally {
      pool.query = originalQuery;
    }
  };
}

// ── ZOHO_SYNC_STATUSES itself — the single source of truth ────────────────

test('ZOHO_SYNC_STATUSES contains exactly the required statuses (all existing ones preserved, nothing extra)', () => {
  const { ZOHO_SYNC_STATUSES } = require('../src/db/zohoSyncStateSchema');

  assert.deepEqual(
    [...ZOHO_SYNC_STATUSES].sort(),
    [
      'pending',
      'processing',
      'lead_synced',
      'note_pending',
      'completed',
      'incomplete',
      'retryable_failure',
      'permanent_failure',
      'reauth_required',
    ].sort(),
    'ZOHO_SYNC_STATUSES must include every original status plus incomplete, retryable_failure, permanent_failure, and reauth_required, with none removed'
  );
});

// ── ensureZohoSyncStatusCheckConstraint — the migration itself ────────────

test('ensureZohoSyncStatusCheckConstraint drops the old constraint idempotently (IF EXISTS) then re-adds it with every current status', withMockedPool(async (schema, queries) => {
  await schema.ensureZohoSyncStatusCheckConstraint();

  const dropStmt = queries.find((q) => /DROP CONSTRAINT/i.test(q.sql));
  assert.ok(dropStmt, 'expected a DROP CONSTRAINT statement');
  assert.match(dropStmt.sql, /DROP CONSTRAINT IF EXISTS zoho_sync_state_status_check/i);

  const addStmt = queries.find((q) => /ADD CONSTRAINT zoho_sync_state_status_check/i.test(q.sql));
  assert.ok(addStmt, 'expected an ADD CONSTRAINT zoho_sync_state_status_check statement');

  const { ZOHO_SYNC_STATUSES } = require('../src/db/zohoSyncStateSchema');
  for (const status of ZOHO_SYNC_STATUSES) {
    assert.match(addStmt.sql, new RegExp(`'${status}'`), `ADD CONSTRAINT must allow '${status}'`);
  }

  // Must never be left permanently dropped — re-added in the same call.
  const dropIdx = queries.findIndex((q) => /DROP CONSTRAINT/i.test(q.sql));
  const addIdx = queries.findIndex((q) => /ADD CONSTRAINT zoho_sync_state_status_check/i.test(q.sql));
  assert.ok(dropIdx !== -1 && addIdx !== -1 && addIdx > dropIdx, 'constraint must be re-added after being dropped, in the same call');
}));

test('ensureZohoSyncStatusCheckConstraint targets only coexistence.zoho_sync_state — never touches any other table', withMockedPool(async (schema, queries) => {
  await schema.ensureZohoSyncStatusCheckConstraint();

  for (const q of queries) {
    assert.match(q.sql, /ALTER TABLE coexistence\.zoho_sync_state/i, `unexpected statement touching a different table: ${q.sql}`);
  }
}));

test('ensureZohoSyncStatusCheckConstraint never alters row data (no UPDATE/DELETE/INSERT)', withMockedPool(async (schema, queries) => {
  await schema.ensureZohoSyncStatusCheckConstraint();

  for (const q of queries) {
    assert.doesNotMatch(q.sql, /^\s*(UPDATE|DELETE|INSERT)\b/i, `migration must never write row data: ${q.sql}`);
  }
}));

test('ensureZohoSyncStatusCheckConstraint is safe to run twice in a row (idempotent — same statements each time)', withMockedPool(async (schema, queries) => {
  await schema.ensureZohoSyncStatusCheckConstraint();
  const firstRunCount = queries.length;
  await schema.ensureZohoSyncStatusCheckConstraint();

  assert.equal(queries.length, firstRunCount * 2, 'second run should issue the identical pair of statements again, nothing more');
  assert.deepEqual(
    queries.slice(0, firstRunCount).map((q) => q.sql),
    queries.slice(firstRunCount).map((q) => q.sql),
    'both runs must issue byte-identical SQL — true idempotency, not just "does not error twice"'
  );
}));

// ── ensureZohoSyncStateTable — wired together, not just the CREATE TABLE ──

test('ensureZohoSyncStateTable calls the status-check migration (wired together, not just CREATE TABLE)', withMockedPool(async (schema, queries) => {
  await schema.ensureZohoSyncStateTable();

  assert.ok(
    queries.some((q) => /CREATE TABLE IF NOT EXISTS coexistence\.zoho_sync_state/i.test(q.sql)),
    'must still create the table idempotently on a fresh database'
  );
  assert.ok(
    queries.some((q) => /DROP CONSTRAINT IF EXISTS zoho_sync_state_status_check/i.test(q.sql)),
    'must also run the status-check migration — this is what makes a pre-existing database self-heal without a manual ALTER'
  );
  assert.ok(
    queries.some((q) => /ADD CONSTRAINT zoho_sync_state_status_check/i.test(q.sql) && /'incomplete'/.test(q.sql)),
    'must re-add the constraint allowing incomplete (and every other current status)'
  );

  // The migration must run AFTER the CREATE TABLE (constraint drop/add
  // targets a table that must already exist).
  const createIdx = queries.findIndex((q) => /CREATE TABLE IF NOT EXISTS coexistence\.zoho_sync_state/i.test(q.sql));
  const dropIdx = queries.findIndex((q) => /DROP CONSTRAINT IF EXISTS zoho_sync_state_status_check/i.test(q.sql));
  assert.ok(createIdx !== -1 && dropIdx !== -1 && dropIdx > createIdx, 'status-check migration must run after table creation');
}));

test('ensureZohoSyncStateTable still preserves the failure_type CHECK constraint untouched by this fix', withMockedPool(async (schema, queries) => {
  await schema.ensureZohoSyncStateTable();

  const createStmt = queries.find((q) => /CREATE TABLE IF NOT EXISTS coexistence\.zoho_sync_state/i.test(q.sql));
  assert.ok(createStmt, 'expected the CREATE TABLE statement');
  assert.match(createStmt.sql, /zoho_sync_state_failure_type_check/i);
  assert.match(createStmt.sql, /'retryable_failure'/);
  assert.match(createStmt.sql, /'permanent_failure'/);
  assert.match(createStmt.sql, /'reauth_required'/);

  // This fix's DROP/ADD pair must never mention failure_type — scope is
  // sync_status only.
  const migrationStmts = queries.filter(
    (q) => /DROP CONSTRAINT IF EXISTS zoho_sync_state_status_check/i.test(q.sql) ||
      (/ADD CONSTRAINT zoho_sync_state_status_check/i.test(q.sql))
  );
  for (const q of migrationStmts) {
    assert.doesNotMatch(q.sql, /failure_type/i, 'this migration must not touch the failure_type constraint');
  }
}));

