'use strict';

// Phase 6 Part 3A — live Send Now failure regression test.
//
// ROOT CAUSE: routes/campaigns.js's POST /campaigns/:id/send inserts a
// literal 'campaign' value into a `source` column on coexistence.broadcasts
// (INSERT INTO coexistence.broadcasts (..., source) VALUES (..., 'campaign')),
// but no migration in src/db/*.js ever created that column — the ONLY
// migration touching coexistence.broadcasts was ensureBroadcastsWorkspaceColumns
// (adds workspace_id). Every live Send Now click therefore hit a genuine
// Postgres error — column "source" of relation "broadcasts" does not exist —
// thrown from that INSERT, uncaught inside the route's inner try block,
// caught by the outer execErr catch, which marks the campaign 'failed' and
// returns the generic "Failed to send campaign" 500. This exactly matches
// the reported live behavior: confirmation showed the correct 2 recipients,
// but the campaign still ended up FAILED.
//
// This test can't reach a live Postgres (see test/campaignSendNow.test.js's
// header comment — same sandbox constraint), so it reproduces the bug
// deterministically and statically instead: every column name the Send Now
// INSERT writes to must be backed by either (a) the ALREADY-WORKING
// POST /broadcasts route's own INSERT (proof those columns really exist —
// that route has always worked), or (b) an explicit
// `ADD COLUMN IF NOT EXISTS <col>` migration against coexistence.broadcasts
// somewhere in src/db/*.js. Before the fix, `source` was in neither set —
// this test fails on the pre-fix code and passes once
// ensureBroadcastsSourceColumn() (src/db/broadcastsWorkspaceSchema.js) is
// wired into the boot sequence (src/index.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

// Extracts the column list of an `INSERT INTO coexistence.broadcasts (...)`
// statement given a snippet of source containing it. Tolerant of CRLF vs LF
// line endings.
function extractInsertColumns(source, matchHint) {
  const idx = source.indexOf(matchHint);
  assert.ok(idx !== -1, `expected to find "${matchHint}" in source`);
  const openParen = source.indexOf('(', idx);
  const closeParen = source.indexOf(')', openParen);
  const colList = source.slice(openParen + 1, closeParen);
  return colList.split(',').map((c) => c.trim().replace(/\s+/g, ''));
}

test('routes/campaigns.js Send Now INSERT only writes columns that actually exist on coexistence.broadcasts', () => {
  const campaignsSrc = read('src/routes/campaigns.js');
  const broadcastsSrc = read('src/routes/broadcasts.js');

  // (a) Columns proven to exist — the long-working POST /broadcasts create
  // route's own INSERT column list.
  const provenColumns = new Set(
    extractInsertColumns(broadcastsSrc, 'INSERT INTO coexistence.broadcasts')
  );

  // (b) Columns explicitly migrated onto coexistence.broadcasts anywhere in
  // src/db/*.js via `ADD COLUMN IF NOT EXISTS <col>` — gathered by scanning
  // every schema file for ALTER TABLE coexistence.broadcasts blocks.
  const dbDir = path.join(__dirname, '..', 'src', 'db');
  const migratedColumns = new Set();
  for (const file of fs.readdirSync(dbDir)) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(dbDir, file), 'utf8');
    // Match each `ALTER TABLE coexistence.broadcasts ... ADD COLUMN IF NOT EXISTS <col>`
    // (possibly multiple ADD COLUMN clauses per ALTER, and multiple ALTERs per file).
    const alterBlocks = src.match(/ALTER TABLE coexistence\.broadcasts[\s\S]*?(?=`|\)|;)/g) || [];
    for (const block of alterBlocks) {
      const colMatches = block.matchAll(/ADD COLUMN IF NOT EXISTS\s+(\w+)/g);
      for (const m of colMatches) migratedColumns.add(m[1]);
    }
  }

  const knownGoodColumns = new Set([...provenColumns, ...migratedColumns]);

  // The actual Send Now INSERT under test.
  const sendNowColumns = extractInsertColumns(campaignsSrc, 'INSERT INTO coexistence.broadcasts');

  const unbackedColumns = sendNowColumns.filter((c) => !knownGoodColumns.has(c));
  assert.deepEqual(
    unbackedColumns,
    [],
    `Send Now INSERT references column(s) with no proven source and no migration: ${unbackedColumns.join(', ')}. ` +
    `This is exactly the live failure: Postgres rejects the INSERT, the campaign is marked 'failed'.`
  );
});

test('ensureBroadcastsSourceColumn is wired into the server boot sequence in src/index.js', () => {
  const indexSrc = read('src/index.js');
  assert.match(
    indexSrc,
    /ensureBroadcastsSourceColumn\s*}\s*=\s*require\(['"].\/db\/broadcastsWorkspaceSchema['"]\)/,
    'src/index.js must import ensureBroadcastsSourceColumn from db/broadcastsWorkspaceSchema'
  );
  assert.match(
    indexSrc,
    /await ensureBroadcastsSourceColumn\(\);/,
    'src/index.js must actually call ensureBroadcastsSourceColumn() during boot, or the column is never created on a fresh/existing database'
  );
});

test('ensureBroadcastsSourceColumn migration is idempotent (ADD COLUMN IF NOT EXISTS) and additive-only', () => {
  const schemaSrc = read('src/db/broadcastsWorkspaceSchema.js');
  const fnMatch = schemaSrc.match(/async function ensureBroadcastsSourceColumn\(\)\s*{([\s\S]*?)\n}/);
  assert.ok(fnMatch, 'ensureBroadcastsSourceColumn function not found');
  const body = fnMatch[1];
  assert.match(body, /ADD COLUMN IF NOT EXISTS\s+source/, 'must use ADD COLUMN IF NOT EXISTS (idempotent, safe to run on every boot)');
  assert.doesNotMatch(body, /DROP\s+COLUMN/i, 'must never drop a column');
  assert.doesNotMatch(body, /DELETE\s+FROM/i, 'must never delete rows');
});

// ─── Second live 500: the Send Now INSERT also omitted `updated_at` ────────
//
// Every OTHER write to coexistence.broadcasts in this codebase — the
// working POST /broadcasts create route, the PUT update route,
// sendBroadcastById's two status UPDATEs, the test_number UPDATE, and the
// DRAFT-reset UPDATE — explicitly sets `updated_at = NOW()`. That
// consistent, repeated convention across every single other write is
// strong evidence `updated_at` is NOT NULL with no default at the DB level
// (why else would every write bother setting it explicitly?). The Send Now
// INSERT was the lone exception: it omitted `updated_at` entirely, so once
// the `source` column existed, this INSERT hit a SECOND, different
// Postgres error — a NOT NULL constraint violation on `updated_at` — which
// again propagated uncaught to the execErr catch and produced the exact
// same generic "Failed to send campaign" 500, even after the source-column
// fix was deployed.
test('routes/campaigns.js Send Now INSERT sets updated_at, matching every other write to coexistence.broadcasts', () => {
  const campaignsSrc = read('src/routes/campaigns.js');
  const broadcastsSrc = read('src/routes/broadcasts.js');

  // Every other write to coexistence.broadcasts in broadcasts.js explicitly
  // sets updated_at = NOW() — confirms the established, required convention.
  const otherWriteSites = (broadcastsSrc.match(/(?:INSERT INTO|UPDATE)\s+coexistence\.broadcasts\b[\s\S]{0,400}?(?=`)/g) || []);
  assert.ok(otherWriteSites.length > 0, 'expected to find writes to coexistence.broadcasts in broadcasts.js to establish the convention');
  for (const site of otherWriteSites) {
    assert.match(
      site,
      /updated_at/,
      `every write to coexistence.broadcasts in broadcasts.js is expected to set updated_at — found one that does not:\n${site}`
    );
  }

  // The Send Now INSERT must follow the same convention.
  const sendNowColumns = extractInsertColumns(campaignsSrc, 'INSERT INTO coexistence.broadcasts');
  assert.ok(
    sendNowColumns.includes('updated_at'),
    'Send Now INSERT into coexistence.broadcasts must include updated_at (NOW()), matching every other write to this table — ' +
    'omitting it is exactly the second live 500 (NOT NULL constraint violation on updated_at)'
  );

  // And the VALUES clause must actually supply NOW() for it, not just list
  // the column name with nothing behind it.
  const insertIdx = campaignsSrc.indexOf('INSERT INTO coexistence.broadcasts');
  const valuesIdx = campaignsSrc.indexOf('VALUES', insertIdx);
  const valuesEnd = campaignsSrc.indexOf('RETURNING', valuesIdx);
  const valuesClause = campaignsSrc.slice(valuesIdx, valuesEnd);
  assert.match(valuesClause, /NOW\(\)/, 'VALUES clause must supply NOW() for updated_at');
});
