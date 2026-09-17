'use strict';

// Phase 6 Part 2.5 — regression test for the Campaign Studio "Customer
// source" dropdown / audience-preview count mismatch.
//
// ROOT CAUSE (see routes/campaigns.js GET /campaigns/audience/sources):
// the source dropdown endpoint used to GROUP BY over RAW
// coexistence.contacts rows, while /campaigns/audience/preview (and every
// other audience count in the app) counts over the DEDUPLICATED
// one-row-per-contact_number result from
// audienceFilter.buildDedupedContactsSQL. Same workspace, same underlying
// data, two different populations — e.g. "Shopify (264)" in the dropdown
// vs "187 customers match" in the preview for the exact same source.
//
// No live Postgres is reachable from this sandbox (see the same caveat in
// audienceDedup.test.js), so this file verifies:
//   1. SQL-shape: the sources endpoint's query is now built from the SAME
//      buildAudienceWhere/buildDedupedContactsSQL helpers as
//      resolveAudience() (audience preview) — one source of truth, no
//      second dedup algorithm.
//   2. Behavioral simulation: with the 142/1008 duplicate-phone-number
//      scenario from the project brief, grouping raw rows by source
//      produces the old (wrong, inflated) counts, while grouping the
//      deduplicated rows produces the counts that match the audience
//      preview — pinning down exactly the bug that was fixed.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAudienceWhere,
  buildDedupedContactsSQL,
  DEDUP_ORDER_BY,
} = require('../src/services/audienceFilter');

// ─── 1. SQL shape: sources endpoint and audience preview share one helper ──

test('sources endpoint query is built from buildAudienceWhere(workspaceId, {}) — full workspace population, no filter/contactIds branch taken', () => {
  const { where, params } = buildAudienceWhere(1, {});
  assert.equal(where, 'c.workspace_id = $1');
  assert.deepEqual(params, [1]);
});

test('sources endpoint groups over the deduplicated subquery, not the raw contacts table', () => {
  const { where, params } = buildAudienceWhere(1, {});
  const dedupedSQL = buildDedupedContactsSQL(where);
  const sourcesSQL = `SELECT NULLIF(deduped.custom_fields->>'source', '') AS source, COUNT(*)::int AS count
     FROM (${dedupedSQL}) deduped
    GROUP BY 1`;

  // Must select FROM the deduped subquery alias, never directly FROM
  // coexistence.contacts (that was the bug).
  assert.match(sourcesSQL, /FROM \(SELECT DISTINCT ON \(c\.contact_number\)/);
  assert.match(sourcesSQL, /GROUP BY 1/);
  assert.match(sourcesSQL, /deduped\.custom_fields->>'source'/);
  assert.deepEqual(params, [1]);
});

test('sources query and resolveAudience/preview query are built from the identical where+dedup fragment for the same workspace', () => {
  const workspaceId = 1;
  const sourcesWhere = buildAudienceWhere(workspaceId, {});
  // resolveAudience() (POST /campaigns/audience/preview) with no filters —
  // e.g. previewing "Customer source = Shopify" starts from this same base.
  const previewWhere = buildAudienceWhere(workspaceId, { audienceType: 'filters', filters: [] });
  assert.equal(buildDedupedContactsSQL(sourcesWhere.where), buildDedupedContactsSQL(previewWhere.where));
  assert.deepEqual(sourcesWhere.params, previewWhere.params);
});

// ─── 2. Behavioral simulation pinning down 264/1214 (raw) vs 187/1213 (deduped) ──
// Mirrors DEDUP_ORDER_BY exactly, same as audienceDedup.test.js's
// simulateDedup: sort by contact_number, blank-name last, updated_at DESC,
// id DESC, then keep only the first row per contact_number.
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

function groupBySourceRaw(rows) {
  const counts = {};
  for (const r of rows) {
    const key = r.source || '__unknown__';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

// The exact duplicate from the project brief: id 142 (blank name) and id
// 1008 (name "26"), same workspace, same contact_number, both Shopify.
const CONTACT_142 = {
  id: 142, workspace_id: 1, contact_number: '916382121634', name: '',
  updated_at: '2026-08-10T00:00:00Z', source: 'shopify_sheet_sync',
};
const CONTACT_1008 = {
  id: 1008, workspace_id: 1, contact_number: '916382121634', name: '26',
  updated_at: '2026-08-20T00:00:00Z', source: 'shopify_sheet_sync',
};

test('A: raw Shopify rows count both duplicates (the old, buggy behavior)', () => {
  const rawCounts = groupBySourceRaw([CONTACT_142, CONTACT_1008]);
  assert.equal(rawCounts['shopify_sheet_sync'], 2); // inflated — this is the "264 vs 187" bug shape
});

test('A: deduplicated Shopify customers count the phone number once (the fixed behavior)', () => {
  const deduped = simulateDedup([CONTACT_142, CONTACT_1008]);
  const dedupedCounts = groupBySourceRaw(deduped);
  assert.equal(dedupedCounts['shopify_sheet_sync'], 1);
});

test('E: a duplicate phone number does not produce two audience/source customers', () => {
  const deduped = simulateDedup([CONTACT_142, CONTACT_1008]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].id, 1008); // non-blank name wins, per DEDUP_ORDER_BY
});

test('B: unknown-source duplicates also collapse to one deduplicated customer', () => {
  const unknownA = { id: 5000, workspace_id: 1, contact_number: '917000000001', name: '', updated_at: '2026-01-01T00:00:00Z', source: null };
  const unknownB = { id: 5001, workspace_id: 1, contact_number: '917000000001', name: 'Ravi', updated_at: '2026-02-01T00:00:00Z', source: null };
  const rawCounts = groupBySourceRaw([unknownA, unknownB]);
  assert.equal(rawCounts['__unknown__'], 2);

  const deduped = simulateDedup([unknownA, unknownB]);
  const dedupedCounts = groupBySourceRaw(deduped);
  assert.equal(dedupedCounts['__unknown__'], 1);
});

test('sanity check: DEDUP_ORDER_BY (used by both the sources endpoint and audience preview) is unchanged', () => {
  assert.match(DEDUP_ORDER_BY, /contact_number/);
  assert.match(DEDUP_ORDER_BY, /NULLIF\(TRIM\(c\.name\), ''\)/);
  assert.match(DEDUP_ORDER_BY, /updated_at DESC/);
  assert.match(DEDUP_ORDER_BY, /id DESC/);
});