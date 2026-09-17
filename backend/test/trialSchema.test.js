'use strict';

// Phase 8B-1 — focused schema test only (trial DB foundation).
// Mocks pool.query (same no-live-Postgres approach as
// test/planChangeRequests.test.js) and asserts:
//   1. trial_started_at / trial_ends_at are added idempotently
//   2. the status check constraint is re-created including 'trialing'
//      while preserving every pre-existing status value
//   3. no destructive statements (DROP TABLE / DROP COLUMN / DELETE /
//      TRUNCATE) are issued anywhere in ensurePlansTables()

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/db');

test('Phase 8B-1: trial columns + status constraint are additive and idempotent', async () => {
  const queries = [];
  const originalQuery = pool.query;
  pool.query = async (sql, params) => {
    queries.push(sql);
    // Neutral responses for the seed/grandfather steps so ensurePlansTables
    // runs to completion without a real DB.
    return { rows: [] };
  };

  try {
    const { ensurePlansTables } = require('../src/db/plansSchema');
    await ensurePlansTables();
  } finally {
    pool.query = originalQuery;
  }

  const joined = queries.join('\n');
  // 1. New columns added idempotently
  assert.match(joined, /ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ/);
  assert.match(joined, /ADD COLUMN IF NOT EXISTS trial_ends_at\s+TIMESTAMPTZ/);

  // 2. Constraint recreated with 'trialing' added, all originals preserved
  const constraintStmt = queries.find(q => /ADD CONSTRAINT workspace_billing_status_check/.test(q));
  assert.ok(constraintStmt, 'expected a status check constraint statement');
  for (const status of ['active', 'past_due', 'suspended', 'cancelled', 'trialing']) {
    assert.ok(constraintStmt.includes(`'${status}'`), `expected status '${status}' preserved in constraint`);
  }
  const dropStmt = queries.find(q => /DROP CONSTRAINT IF EXISTS workspace_billing_status_check/.test(q));
  assert.ok(dropStmt, 'expected idempotent DROP CONSTRAINT IF EXISTS before re-add');
  // 3. No destructive statements anywhere in the migration
  assert.doesNotMatch(joined, /DROP TABLE/i);
  assert.doesNotMatch(joined, /DROP COLUMN/i);
  assert.doesNotMatch(joined, /\bDELETE FROM\b/i);
  assert.doesNotMatch(joined, /TRUNCATE/i);
});