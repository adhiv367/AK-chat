'use strict';

// Phase 6 Part 2 — "Resolved Audience" list (Step 4). resolveAudience() now
// also returns a paginated list of the actual deduplicated contact records
// (id, contact_number, name, wa_number, source, city, state) plus a
// lightweight id-only list of every matching contact, in addition to the
// existing count — all built from the SAME buildDedupedContactsSQL subquery,
// so count/contacts/allMatchingContactIds can never disagree or come from a
// second, separate dedup implementation.
//
// pool.query is monkey-patched on the shared '../src/db' singleton, same
// approach as test/broadcastStatus.test.js / test/planChangeRequests.test.js
// (no live Postgres reachable from this sandbox).

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/db');
const { resolveAudience } = require('../src/routes/campaigns');

// The exact 142/1008 duplicate-phone-number pair from the project brief,
// as buildDedupedContactsSQL (DISTINCT ON contact_number, non-blank-name-
// first, then updated_at DESC, then id DESC) would return them — i.e. only
// 1008 survives, already deduplicated, because that's what the real SQL
// produces (this test simulates the subquery's OUTPUT, not the dedup logic
// itself — that's covered by audienceDedup.test.js).
const DEDUPED_ROW_1008 = {
  id: 1008, contact_number: '916382121634', name: '26', wa_number: '919344330905',
  source: 'shopify_sheet_sync', city: 'Chennai', state: 'Tamil Nadu',
};
const DEDUPED_ROW_OTHER = {
  id: 2001, contact_number: '917000000002', name: 'Priya', wa_number: '918000000002',
  source: 'shopify_sheet_sync', city: 'Erode', state: 'Tamil Nadu',
};

function installDb({ total, pageRows, idRows }) {
  const calls = [];
  const originalQuery = pool.query;
  pool.query = async (sql, params) => {
    calls.push({ sql, params });
    if (/COUNT\(\*\)::int AS total/.test(sql)) return { rows: [{ total }] };
    if (/deduped\.custom_fields->>'source' AS source/.test(sql)) return { rows: pageRows || [] };
    if (/SELECT deduped\.id FROM/.test(sql)) return { rows: (idRows || []).map((id) => ({ id })) };
    return { rows: [] };
  };
  return { calls, restore() { pool.query = originalQuery; } };
}

test('A/B/C/D: resolveAudience() with pageSize returns actual contact records with name, phone, source, city, state', async () => {
  const db = installDb({ total: 2, pageRows: [DEDUPED_ROW_1008, DEDUPED_ROW_OTHER], idRows: [1008, 2001] });
  try {
    const result = await resolveAudience(1, { audienceType: 'filters', filters: [], combinator: 'AND' }, { page: 1, pageSize: 50 });
    assert.equal(result.count, 2);
    assert.equal(result.contacts.length, 2);
    const [row] = result.contacts;
    assert.equal(row.id, 1008);
    assert.equal(row.name, '26');
    assert.equal(row.contact_number, '916382121634'); // phone, never the count/id
    assert.equal(row.source, 'shopify_sheet_sync');
    assert.equal(row.city, 'Chennai');
    assert.equal(row.state, 'Tamil Nadu');
  } finally { db.restore(); }
});

test('G/H/I: the 142/1008 duplicate resolves to exactly one contact (id 1008) in the Resolved Audience list', async () => {
  // The dedup subquery itself only ever emits ONE row per contact_number —
  // simulating its output here (id 1008, never 142) is the contract this
  // route relies on; the dedup rule itself is proven by audienceDedup.test.js.
  const db = installDb({ total: 1, pageRows: [DEDUPED_ROW_1008], idRows: [1008] });
  try {
    const result = await resolveAudience(1, { audienceType: 'filters', filters: [{ field: 'source', operator: 'equals', value: 'shopify_sheet_sync' }], combinator: 'AND' }, { page: 1, pageSize: 50 });
    assert.equal(result.count, 1);
    assert.equal(result.contacts.length, 1);
    assert.equal(result.contacts[0].id, 1008);
    assert.notEqual(result.contacts.some((c) => c.id === 142), true);
  } finally { db.restore(); }
});

test('E/F: the audience count (187-style number) is never present as a contact field value', async () => {
  const db = installDb({ total: 2, pageRows: [DEDUPED_ROW_1008, DEDUPED_ROW_OTHER], idRows: [1008, 2001] });
  try {
    const result = await resolveAudience(1, { audienceType: 'filters', filters: [], combinator: 'AND' }, { page: 1, pageSize: 50 });
    for (const c of result.contacts) {
      assert.notEqual(c.id, result.count);
      assert.notEqual(c.contact_number, String(result.count));
    }
  } finally { db.restore(); }
});

test('J: count always equals the length of the id-only allMatchingContactIds list for the same audience', async () => {
  const db = installDb({ total: 2, pageRows: [DEDUPED_ROW_1008, DEDUPED_ROW_OTHER], idRows: [1008, 2001] });
  try {
    const result = await resolveAudience(1, { audienceType: 'filters', filters: [], combinator: 'AND' }, { page: 1, pageSize: 50 });
    assert.equal(result.count, result.allMatchingContactIds.length);
    assert.deepEqual(result.allMatchingContactIds, [1008, 2001]);
  } finally { db.restore(); }
});

test('pageSize = 0 (Step 2 count-only preview) never issues the contacts/id-list queries — no behavior change from before this feature', async () => {
  const db = installDb({ total: 187, pageRows: [], idRows: [] });
  try {
    const result = await resolveAudience(1, { audienceType: 'filters', filters: [], combinator: 'AND' });
    assert.equal(result.count, 187);
    assert.deepEqual(result.contacts, []);
    assert.deepEqual(result.allMatchingContactIds, []);
    assert.equal(result.totalPages, 0);
    // Only the COUNT query should have run.
    assert.equal(db.calls.length, 1);
  } finally { db.restore(); }
});

test('N: an empty-matching audience returns count 0 and an empty contacts list (no fabricated rows)', async () => {
  const db = installDb({ total: 0, pageRows: [], idRows: [] });
  try {
    const result = await resolveAudience(1, { audienceType: 'filters', filters: [{ field: 'city', operator: 'equals', value: 'Nowhereville' }], combinator: 'AND' }, { page: 1, pageSize: 50 });
    assert.equal(result.count, 0);
    assert.deepEqual(result.contacts, []);
    assert.deepEqual(result.allMatchingContactIds, []);
  } finally { db.restore(); }
});

test('pagination: page/pageSize are echoed back and totalPages is computed from count', async () => {
  const db = installDb({ total: 187, pageRows: [DEDUPED_ROW_1008], idRows: [1008] });
  try {
    const result = await resolveAudience(1, { audienceType: 'filters', filters: [], combinator: 'AND' }, { page: 2, pageSize: 50 });
    assert.equal(result.page, 2);
    assert.equal(result.pageSize, 50);
    assert.equal(result.totalPages, Math.ceil(187 / 50));
  } finally { db.restore(); }
});

test('pageSize is capped at 100 even if a larger value is requested', async () => {
  const db = installDb({ total: 187, pageRows: [], idRows: [] });
  try {
    const result = await resolveAudience(1, { audienceType: 'filters', filters: [], combinator: 'AND' }, { page: 1, pageSize: 500 });
    assert.equal(result.pageSize, 100);
  } finally { db.restore(); }
});


