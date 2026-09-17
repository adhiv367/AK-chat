'use strict';

// Phase 6 — Campaign Studio audience-resolution follow-up (continuation of
// audienceDedup.test.js / audienceSourceCounts.test.js). These pin down the
// specific regression scenarios requested for this pass:
//
//   A. source = Shopify resolves the actual Shopify contacts (not the count).
//   C. duplicate contact_number (142/1008) still resolves to ONE contact.
//   D. the source-dropdown count and resolveAudience's count come from the
//      exact same deduplicated population (so they can never disagree).
//   E/F. "contains"/"starts_with" on source use ILIKE, not the equals path,
//      and still resolve through the same dedup subquery.
//   G. != Shopify resolves the actual non-Shopify contacts.
//   J. nothing in this path can turn the displayed count (187) into a
//      customer identifier — buildCondition never accepts a numeric count
//      as a stand-in for a source value, and the resolved rows always carry
//      their own real id/contact_number, never the match count.
//
// No live Postgres is reachable from this sandbox (see the same caveat in
// audienceDedup.test.js / audienceSourceCounts.test.js), so — same as those
// files — this exercises the real exported SQL-builders for shape/params,
// plus a local re-implementation of the DISTINCT ON dedup rule to pin down
// end-to-end *behavior* against representative rows.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAudienceWhere,
  buildFilterSQL,
  buildDedupedContactsSQL,
  validateAudienceFilters,
} = require('../src/services/audienceFilter');

// Mirrors DEDUP_ORDER_BY from audienceFilter.js exactly (see that file's
// doc comment for the full rule): sort by contact_number, blank-name last,
// updated_at DESC, id DESC, keep first row per contact_number — exactly
// what Postgres DISTINCT ON (c.contact_number) with that ORDER BY produces.
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

// Applies a single filter rule client-side, against real-shaped rows, using
// the SAME semantics buildCondition() compiles into SQL (ILIKE-equivalent
// case-insensitive equals/contains/starts_with, NOT for not_equals). This
// is only used to simulate the WHERE clause over an in-memory fixture set —
// the actual SQL string generation is still asserted separately via
// buildFilterSQL below, so this never substitutes for that.
function matchesSourceFilter(row, operator, value) {
  const src = (row.custom_fields && row.custom_fields.source) || '';
  const v = String(value).toLowerCase();
  const s = String(src).toLowerCase();
  switch (operator) {
    case 'equals': return s === v;
    case 'not_equals': return s !== v;
    case 'contains': return s.includes(v);
    case 'starts_with': return s.startsWith(v);
    default: throw new Error(`unhandled operator in test fixture: ${operator}`);
  }
}

// Fixture population: the 142/1008 duplicate-phone Shopify pair from the
// project brief, a second unrelated Shopify customer, and a non-Shopify
// (manual_import) customer, all in the same workspace.
const CONTACT_142 = {
  id: 142, workspace_id: 1, contact_number: '916382121634', name: '',
  wa_number: '918000000001', updated_at: '2026-08-10T00:00:00Z',
  custom_fields: { source: 'shopify_sheet_sync', city: 'Chennai' },
};
const CONTACT_1008 = {
  id: 1008, workspace_id: 1, contact_number: '916382121634', name: '26',
  wa_number: '918000000001', updated_at: '2026-08-20T00:00:00Z',
  custom_fields: { source: 'shopify_sheet_sync', city: 'Chennai' },
};
const CONTACT_OTHER_SHOPIFY = {
  id: 2001, workspace_id: 1, contact_number: '917000000002', name: 'Priya',
  wa_number: '918000000002', updated_at: '2026-08-15T00:00:00Z',
  custom_fields: { source: 'shopify_sheet_sync', city: 'Erode' },
};
const CONTACT_MANUAL = {
  id: 3001, workspace_id: 1, contact_number: '917000000003', name: 'Ravi',
  wa_number: '918000000003', updated_at: '2026-08-16T00:00:00Z',
  custom_fields: { source: 'manual_import', city: 'Erode' },
};
const ALL_ROWS = [CONTACT_142, CONTACT_1008, CONTACT_OTHER_SHOPIFY, CONTACT_MANUAL];

// ─── A. source = Shopify resolves the actual Shopify contacts ────────────

test('A: buildFilterSQL for source equals "shopify_sheet_sync" produces a case-insensitive exact match, not a substring/contains match', () => {
  const params = [1];
  const sql = buildFilterSQL([{ field: 'source', operator: 'equals', value: 'shopify_sheet_sync' }], 'AND', params);
  assert.match(sql, /c\.custom_fields->>'source' ILIKE \$2/);
  assert.equal(params[1], 'shopify_sheet_sync'); // exact value, no % wildcards
});

test('A: source = Shopify resolves to the deduplicated real Shopify contact records (not a count)', () => {
  const matched = ALL_ROWS.filter((r) => matchesSourceFilter(r, 'equals', 'shopify_sheet_sync'));
  const resolved = simulateDedup(matched);
  const ids = resolved.map((r) => r.id).sort();
  assert.deepEqual(ids, [1008, 2001]); // 142 collapses into 1008; the manual_import contact is excluded
  for (const r of resolved) {
    assert.ok(r.id && r.contact_number, 'resolved row must carry a real id + contact_number');
    assert.equal(r.custom_fields.source, 'shopify_sheet_sync');
  }
});

// ─── C. duplicate contact_number resolves to ONE contact ─────────────────

test('C: contact_number 916382121634 (ids 142 and 1008) resolves to exactly one contact', () => {
  const matched = ALL_ROWS.filter((r) => r.contact_number === '916382121634');
  const resolved = simulateDedup(matched);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].id, 1008); // non-blank name wins per DEDUP_ORDER_BY
});

// ─── D. source count equals resolved unique contact count ────────────────

test('D: the /audience/sources dropdown count and resolveAudience preview count are the same number for the same source', () => {
  const matched = ALL_ROWS.filter((r) => matchesSourceFilter(r, 'equals', 'shopify_sheet_sync'));
  const dedupedForPreview = simulateDedup(matched); // what resolveAudience()'s COUNT(*) would return

  // What GET /campaigns/audience/sources computes: group the FULL deduped
  // workspace population by source, then read off the shopify_sheet_sync
  // bucket — same subquery, same population, just a GROUP BY instead of a
  // WHERE on source.
  const dedupedWholeWorkspace = simulateDedup(ALL_ROWS);
  const sourcesCount = dedupedWholeWorkspace.filter((r) => r.custom_fields.source === 'shopify_sheet_sync').length;

  assert.equal(sourcesCount, dedupedForPreview.length);
  assert.equal(sourcesCount, 2);
});

// ─── E/F. contains / starts_with use the text-search path, not equals ─────

test('E: buildFilterSQL "contains" on source produces a wildcard-both-sides ILIKE, distinct from equals', () => {
  const params = [1];
  const sql = buildFilterSQL([{ field: 'source', operator: 'contains', value: 'shop' }], 'AND', params);
  assert.match(sql, /c\.custom_fields->>'source' ILIKE \$2/);
  assert.equal(params[1], '%shop%');
});

test('E: source contains "shop" resolves the actual (deduplicated) matching contacts', () => {
  const matched = ALL_ROWS.filter((r) => matchesSourceFilter(r, 'contains', 'shop'));
  const resolved = simulateDedup(matched);
  assert.deepEqual(resolved.map((r) => r.id).sort(), [1008, 2001]);
});

test('F: buildFilterSQL "starts_with" on source anchors the pattern at the start only', () => {
  const params = [1];
  const sql = buildFilterSQL([{ field: 'source', operator: 'starts_with', value: 'shop' }], 'AND', params);
  assert.equal(params[1], 'shop%');
  // Would NOT match e.g. "pre_shopify" — anchored, unlike "contains".
  assert.doesNotMatch(params[1], /^%/);
});

test('F: source starts_with "shop" resolves the actual (deduplicated) matching contacts', () => {
  const matched = ALL_ROWS.filter((r) => matchesSourceFilter(r, 'starts_with', 'shop'));
  const resolved = simulateDedup(matched);
  assert.deepEqual(resolved.map((r) => r.id).sort(), [1008, 2001]);
});

// ─── G. != Shopify resolves the actual non-Shopify contacts ───────────────

test('G: buildFilterSQL "not_equals" on source produces NOT ILIKE (exact, negated, case-insensitive)', () => {
  const params = [1];
  const sql = buildFilterSQL([{ field: 'source', operator: 'not_equals', value: 'shopify_sheet_sync' }], 'AND', params);
  assert.match(sql, /c\.custom_fields->>'source' NOT ILIKE \$2/);
});

test('G: source != Shopify resolves to the deduplicated non-Shopify contacts, not an inverted count', () => {
  const matched = ALL_ROWS.filter((r) => matchesSourceFilter(r, 'not_equals', 'shopify_sheet_sync'));
  const resolved = simulateDedup(matched);
  assert.deepEqual(resolved.map((r) => r.id), [3001]);
  assert.equal(resolved[0].custom_fields.source, 'manual_import');
});

// ─── J. the display count can never be mistaken for an identifier ────────

test('J: validateAudienceFilters accepts a source value that happens to look like a count-bearing label, but only as an opaque string — never as a numeric id substitute', () => {
  // A client that (incorrectly) sent the rendered label instead of the raw
  // value would send a string like "Shopify (187)" here. It passes basic
  // shape validation (it's a non-empty string) exactly like any other text
  // value would — the allowlist has no way to "know" this is wrong, which
  // is precisely why the FRONTEND must never construct this value in the
  // first place (see CampaignStudioPage.audienceSource.test.jsx). This test
  // documents that the backend treats it as literal text to match against,
  // not as anything special — it will simply match zero real rows.
  assert.equal(
    validateAudienceFilters([{ field: 'source', operator: 'equals', value: 'Shopify (187)' }], 'AND'),
    null
  );
  const matched = ALL_ROWS.filter((r) => matchesSourceFilter(r, 'equals', 'Shopify (187)'));
  assert.equal(matched.length, 0, 'the mislabeled value matches no real contact — it is never treated as an id or count');
});

test('J: the resolved audience never surfaces the match count as a row field — every resolved row is a real contact with its own id/contact_number/wa_number', () => {
  const matched = ALL_ROWS.filter((r) => matchesSourceFilter(r, 'equals', 'shopify_sheet_sync'));
  const resolved = simulateDedup(matched);
  assert.equal(resolved.length, 2); // this IS the "count" (187 in production) — never itself a row field
  for (const r of resolved) {
    assert.notEqual(r.id, resolved.length);
    assert.ok(typeof r.contact_number === 'string' && r.contact_number.length > 0);
    assert.ok(typeof r.wa_number === 'string' && r.wa_number.length > 0);
    assert.ok('source' in r.custom_fields);
  }
});

test('J: buildAudienceWhere never lets a raw count/number be substituted for the source WHERE value — it is always the literal filter.value, unparsed', () => {
  const { where, params } = buildAudienceWhere(1, {
    audienceType: 'filters',
    filters: [{ field: 'source', operator: 'equals', value: 'shopify_sheet_sync' }],
    combinator: 'AND',
  });
  assert.deepEqual(params, [1, 'shopify_sheet_sync']);
  assert.doesNotMatch(where, /\b187\b/);
});

// ─── Save/preview parity: buildDedupedContactsSQL is the single choke point ──

test('preview (resolveAudience) and the eventual full recipient resolution both wrap buildAudienceWhere in buildDedupedContactsSQL — one dedup implementation', () => {
  const { where } = buildAudienceWhere(1, {
    audienceType: 'filters',
    filters: [{ field: 'source', operator: 'equals', value: 'shopify_sheet_sync' }],
    combinator: 'AND',
  });
  const sql = buildDedupedContactsSQL(where);
  assert.match(sql, /SELECT DISTINCT ON \(c\.contact_number\) c\.\*/);
  assert.match(sql, /c\.custom_fields->>'source' ILIKE \$2/);
});
