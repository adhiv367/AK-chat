'use strict';

// Phase 6 Part 2.5 — "one WhatsApp phone number = one campaign recipient"
// safety fix. No live Postgres is reachable from this sandbox (network
// disabled / akchat-db host unresolvable), so these tests are split in two:
//
//   1. SQL-shape tests against the real exported buildDedupedContactsSQL /
//      DEDUP_ORDER_BY from services/audienceFilter.js — same style as the
//      existing buildFilterSQL tests in audienceFilter.test.js, which also
//      assert on generated SQL strings rather than executing them.
//   2. A local, side-effect-free re-implementation of the DISTINCT ON rule
//      (simulateDedup below) exercised against the exact 1008/142 duplicate
//      described in the project brief, to document and pin down the
//      *behavior* the SQL is supposed to produce. This does not prove the
//      live Postgres DISTINCT ON query behaves identically — that should be
//      verified against a real/staging database before this ships.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAudienceWhere,
  buildDedupedContactsSQL,
  DEDUP_ORDER_BY,
} = require('../src/services/audienceFilter');

// ─── 1. SQL shape ───────────────────────────────────────────────────────

test('buildDedupedContactsSQL wraps the where fragment in a DISTINCT ON (c.contact_number) subquery', () => {
  const { where } = buildAudienceWhere(1, { audienceType: 'filters', filters: [] });
  const sql = buildDedupedContactsSQL(where);
  assert.match(sql, /SELECT DISTINCT ON \(c\.contact_number\) c\.\*/);
  assert.match(sql, /FROM coexistence\.contacts c/);
  assert.match(sql, /WHERE c\.workspace_id = \$1/);
});

test('buildDedupedContactsSQL orders by contact_number first (required for DISTINCT ON correctness)', () => {
  const { where } = buildAudienceWhere(1, { audienceType: 'filters', filters: [] });
  const sql = buildDedupedContactsSQL(where);
  const orderClause = sql.slice(sql.indexOf('ORDER BY'));
  assert.match(orderClause, /ORDER BY c\.contact_number/);
});

test('DEDUP_ORDER_BY prioritizes non-blank name, then most recent update, then highest id', () => {
  assert.match(DEDUP_ORDER_BY, /contact_number/);
  assert.match(DEDUP_ORDER_BY, /NULLIF\(TRIM\(c\.name\), ''\)/);
  assert.match(DEDUP_ORDER_BY, /updated_at DESC/);
  assert.match(DEDUP_ORDER_BY, /id DESC/);
});

test('buildDedupedContactsSQL still carries the workspace-anchored where fragment for a filters audience (e.g. City = Chennai)', () => {
  const { where, params } = buildAudienceWhere(1, {
    audienceType: 'filters',
    filters: [{ field: 'city', operator: 'equals', value: 'Chennai' }],
    combinator: 'AND',
  });
  const sql = buildDedupedContactsSQL(where);
  assert.match(sql, /c\.custom_fields->>'city' ILIKE \$2/);
  assert.deepEqual(params, [1, 'Chennai']);
});

test('buildDedupedContactsSQL also covers the static contactIds audience path', () => {
  const { where } = buildAudienceWhere(1, { audienceType: 'contacts', contactIds: [1008, 142] });
  const sql = buildDedupedContactsSQL(where);
  assert.match(sql, /c\.id = ANY\(\$2::bigint\[\]\)/);
});

// ─── 2. Behavioral simulation of the DISTINCT ON rule ──────────────────
// Mirrors DEDUP_ORDER_BY exactly: sort ascending by contact_number, then
// (blank-name last), then updated_at DESC, then id DESC — then keep only
// the first row per contact_number, exactly like Postgres DISTINCT ON.
function simulateDedup(rows) {
  const sorted = [...rows].sort((a, b) => {
    if (a.contact_number !== b.contact_number) return a.contact_number < b.contact_number ? -1 : 1;
    const aBlank = !a.name || !String(a.name).trim() ? 1 : 0;
    const bBlank = !b.name || !String(b.name).trim() ? 1 : 0;
    if (aBlank !== bBlank) return aBlank - bBlank;
    if (a.updated_at !== b.updated_at) return a.updated_at > b.updated_at ? -1 : 1;
    return b.id - a.id;
  });
  const seen = new Set();
  const out = [];
  for (const row of sorted) {
    if (seen.has(row.contact_number)) continue;
    seen.add(row.contact_number);
    out.push(row);
  }
  return out;
}

const CONTACT_1008 = {
  id: 1008, workspace_id: 1, contact_number: '916382121634', name: '26',
  updated_at: '2026-08-20T00:00:00Z', custom_fields: { city: 'Chennai' },
};
const CONTACT_142 = {
  id: 142, workspace_id: 1, contact_number: '916382121634', name: '',
  updated_at: '2026-08-10T00:00:00Z', custom_fields: { city: 'Chennai' },
};

test('same workspace + same phone + both match -> count = 1', () => {
  const result = simulateDedup([CONTACT_1008, CONTACT_142]);
  assert.equal(result.length, 1);
});

test('same workspace + same phone + both match -> recipient list contains the phone once', () => {
  const result = simulateDedup([CONTACT_1008, CONTACT_142]);
  const phones = result.map((r) => r.contact_number);
  assert.deepEqual(phones, ['916382121634']);
});

test('contact 1008 (non-blank name) wins over 142 (blank name), matching the documented rule', () => {
  const [winner] = simulateDedup([CONTACT_142, CONTACT_1008]); // order-independent
  assert.equal(winner.id, 1008);
});

test('same phone but only one duplicate matches the audience -> caller pre-filters, dedup still returns it once', () => {
  // Simulates the WHERE clause having already excluded 142 (e.g. it lacks
  // custom_fields.city = Chennai) — only one candidate row reaches dedup.
  const result = simulateDedup([CONTACT_1008]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 1008);
});

test('different phone numbers remain separate recipients', () => {
  const other = { id: 2001, workspace_id: 1, contact_number: '919999999999', name: 'Priya', updated_at: '2026-08-01T00:00:00Z' };
  const result = simulateDedup([CONTACT_1008, CONTACT_142, other]);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((r) => r.contact_number).sort(), ['916382121634', '919999999999']);
});

test('tie-break: equal name-blankness and equal updated_at falls back to highest id', () => {
  const a = { id: 5, contact_number: '9111', name: 'Same', updated_at: 't1' };
  const b = { id: 9, contact_number: '9111', name: 'Same', updated_at: 't1' };
  const [winner] = simulateDedup([a, b]);
  assert.equal(winner.id, 9);
});

test('when names are equally blank, the most recently updated row wins', () => {
  const older = { id: 1, contact_number: '9111', name: '', updated_at: '2026-01-01T00:00:00Z' };
  const newer = { id: 2, contact_number: '9111', name: '', updated_at: '2026-06-01T00:00:00Z' };
  const [winner] = simulateDedup([older, newer]);
  assert.equal(winner.id, 2);
});

// ─── Workspace isolation is unaffected by dedup ─────────────────────────
// buildAudienceWhere always anchors to c.workspace_id = $1 BEFORE the
// dedup subquery runs, so the same phone number in two different
// workspaces is never collapsed together — each workspace's query only
// ever sees its own rows to begin with.
test('buildDedupedContactsSQL never removes the workspace anchor (workspace isolation intact)', () => {
  const { where: whereA } = buildAudienceWhere(1, { audienceType: 'filters', filters: [] });
  const { where: whereB } = buildAudienceWhere(2, { audienceType: 'filters', filters: [] });
  assert.match(buildDedupedContactsSQL(whereA), /c\.workspace_id = \$1/);
  assert.match(buildDedupedContactsSQL(whereB), /c\.workspace_id = \$1/);
});





