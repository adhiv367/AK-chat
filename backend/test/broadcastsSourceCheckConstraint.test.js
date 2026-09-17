'use strict';

// Phase 6 Part 3A — THIRD live Send Now failure regression test.
//
// CONFIRMED ROOT CAUSE (from live evidence — docker exec akchat-db psql -U
// postgres -d postgres -c "SELECT conname, pg_get_constraintdef(oid) ...
// WHERE conname = 'broadcasts_source_check'"):
//
//   broadcasts_source_check CHECK ((source = ANY (ARRAY['manual','target'])))
//
// This constraint exists on the live coexistence.broadcasts table but is
// NOT created anywhere in this codebase's src/db/*.js (grepped — no other
// file references broadcasts_source_check or any CHECK on broadcasts.source).
// ensureBroadcastsSourceColumn() only ever ran `ADD COLUMN IF NOT EXISTS
// source TEXT` — it never touched this constraint. So once the column
// existed (fixing live failure #1) and updated_at was supplied (fixing live
// failure #2), Campaign Studio's Send Now INSERT hit a THIRD, different
// error: the pre-existing constraint rejects the literal 'campaign' value
// this route has always written, producing:
//   new row for relation "broadcasts" violates check constraint
//   "broadcasts_source_check"
// which again propagates to campaigns.js's execErr catch and produces the
// same generic "Failed to send campaign" 500.
//
// Fix: ensureBroadcastsSourceCheckAllowsCampaign() (src/db/
// broadcastsWorkspaceSchema.js), called from ensureBroadcastsSourceColumn(),
// drops and re-adds broadcasts_source_check to also allow 'campaign',
// idempotently, on every boot — preserving 'manual' and 'target' exactly.
//
// This test exercises the ACTUAL migration function against a fake pool
// (no live Postgres reachable from this sandbox — same constraint as the
// other Send Now tests), asserting the exact SQL it issues, plus a static
// check that the source literal Send Now writes is one of the values the
// migration allows.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

test('ensureBroadcastsSourceCheckAllowsCampaign drops and re-adds broadcasts_source_check to allow manual, target, AND campaign', async () => {
  const pool = require('../src/db');
  const queries = [];
  const originalQuery = pool.query;
  pool.query = async (sql, params) => {
    queries.push(sql.replace(/\s+/g, ' ').trim());
    return { rows: [] };
  };
  try {
    delete require.cache[require.resolve('../src/db/broadcastsWorkspaceSchema')];
    const { ensureBroadcastsSourceCheckAllowsCampaign } = require('../src/db/broadcastsWorkspaceSchema');
    await ensureBroadcastsSourceCheckAllowsCampaign();

    // Must drop the constraint idempotently (IF EXISTS — never errors if
    // it's already gone, e.g. a fresh database that never had it).
    const dropStmt = queries.find((q) => /DROP CONSTRAINT/i.test(q));
    assert.ok(dropStmt, 'expected a DROP CONSTRAINT statement');
    assert.match(dropStmt, /DROP CONSTRAINT IF EXISTS broadcasts_source_check/i);

    // Must re-add it in the same run — the constraint is never left
    // permanently dropped — widened to include 'campaign' alongside the
    // two existing live values.
    const addStmt = queries.find((q) => /ADD CONSTRAINT broadcasts_source_check/i.test(q));
    assert.ok(addStmt, 'expected an ADD CONSTRAINT broadcasts_source_check statement');
    assert.match(addStmt, /'manual'/);
    assert.match(addStmt, /'target'/);
    assert.match(addStmt, /'campaign'/);

    // Must never permanently drop without re-adding.
    const dropIdx = queries.findIndex((q) => /DROP CONSTRAINT/i.test(q));
    const addIdx = queries.findIndex((q) => /ADD CONSTRAINT broadcasts_source_check/i.test(q));
    assert.ok(dropIdx !== -1 && addIdx !== -1 && addIdx > dropIdx, 'constraint must be re-added after being dropped, in the same call');
  } finally {
    pool.query = originalQuery;
  }
});

test('ensureBroadcastsSourceColumn calls the constraint-widening migration (wired together, not just the ADD COLUMN)', async () => {
  const pool = require('../src/db');
  const queries = [];
  const originalQuery = pool.query;
  pool.query = async (sql) => {
    queries.push(sql.replace(/\s+/g, ' ').trim());
    return { rows: [] };
  };
  try {
    delete require.cache[require.resolve('../src/db/broadcastsWorkspaceSchema')];
    const { ensureBroadcastsSourceColumn } = require('../src/db/broadcastsWorkspaceSchema');
    await ensureBroadcastsSourceColumn();

    assert.ok(queries.some((q) => /ADD COLUMN IF NOT EXISTS\s+source/i.test(q)), 'must still add the column (idempotent)');
    assert.ok(queries.some((q) => /DROP CONSTRAINT IF EXISTS broadcasts_source_check/i.test(q)), 'must also widen the CHECK constraint');
    assert.ok(queries.some((q) => /ADD CONSTRAINT broadcasts_source_check/i.test(q) && /'campaign'/.test(q)), 'must re-add the constraint allowing campaign');
  } finally {
    pool.query = originalQuery;
  }
});

test('routes/campaigns.js Send Now writes source=\'campaign\', which the widened constraint allows', () => {
  const campaignsSrc = read('src/routes/campaigns.js');
  assert.match(
    campaignsSrc,
    /INSERT INTO coexistence\.broadcasts[\s\S]*?'campaign'/,
    'Send Now INSERT should write the literal \'campaign\' source value'
  );
});

test('routes/targetMessage.js and routes/broadcasts.js are untouched: still write \'target\' and no explicit source respectively', () => {
  const targetSrc = read('src/routes/targetMessage.js');
  const broadcastsSrc = read('src/routes/broadcasts.js');

  assert.match(
    targetSrc,
    /INSERT INTO coexistence\.broadcasts[\s\S]*?'target'/,
    'Target Message must keep writing source=\'target\' — untouched by this fix'
  );

  // Broadcast Studio's create route never lists `source` as a column it
  // writes — confirming this fix does not need to (and must not) touch it.
  const insertIdx = broadcastsSrc.indexOf('INSERT INTO coexistence.broadcasts');
  const openParen = broadcastsSrc.indexOf('(', insertIdx);
  const closeParen = broadcastsSrc.indexOf(')', openParen);
  const colList = broadcastsSrc.slice(openParen + 1, closeParen);
  assert.ok(
    !/\bsource\b/.test(colList),
    'POST /broadcasts (Broadcast Studio) must not be modified to write source — out of scope for this fix'
  );
});
test('the constraint migration never alters existing data (no UPDATE/DELETE) and never modifies unrelated tables', () => {
  const schemaSrc = read('src/db/broadcastsWorkspaceSchema.js');
  const fnMatch = schemaSrc.match(/async function ensureBroadcastsSourceCheckAllowsCampaign\(\)\s*{([\s\S]*?)\n}/);
  assert.ok(fnMatch, 'ensureBroadcastsSourceCheckAllowsCampaign function not found');
  const body = fnMatch[1];
  assert.doesNotMatch(body, /UPDATE\s+coexistence/i, 'must never modify existing row data');
  assert.doesNotMatch(body, /DELETE\s+FROM/i, 'must never delete rows');
  const alteredTables = [...body.matchAll(/ALTER TABLE\s+(coexistence\.\w+)/gi)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(alteredTables)],
    ['coexistence.broadcasts'],
    'must only touch coexistence.broadcasts'
  );
});