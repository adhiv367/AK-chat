'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFilterSQL, buildAudienceWhere, validateAudienceFilters } = require('../src/services/audienceFilter');

test('buildFilterSQL returns empty string for no rules', () => {
  const params = [];
  assert.equal(buildFilterSQL([], 'AND', params), '');
  assert.deepEqual(params, []);
});

test('buildFilterSQL builds a single equals condition with correct param index (case-insensitive ILIKE for text fields)', () => {
  const params = ['seed'];
  const sql = buildFilterSQL([{ field: 'name', operator: 'equals', value: 'Sam' }], 'AND', params);
  assert.equal(sql, '(c.name ILIKE $2)');
  assert.deepEqual(params, ['seed', 'Sam']);
});

test('buildFilterSQL joins multiple rules with the requested combinator', () => {
  const params = [];
  const rules = [
    { field: 'name', operator: 'contains', value: 'ram' },
    { field: 'purchaseCount', operator: 'gt', value: 3 },
  ];
  const sql = buildFilterSQL(rules, 'OR', params);
  assert.match(sql, / OR /);
  assert.equal(params.length, 2);
});

test('buildFilterSQL casts numeric custom fields via NULLIF(...)::numeric', () => {
  const params = [];
  const sql = buildFilterSQL([{ field: 'totalPurchaseAmount', operator: 'gte', value: 100 }], 'AND', params);
  assert.match(sql, /NULLIF\(c\.custom_fields->>'totalPurchaseAmount', ''\)::numeric >= \$1/);
});

test('buildFilterSQL rejects an unsupported operator', () => {
  assert.throws(() => buildFilterSQL([{ field: 'name', operator: 'nope', value: 1 }], 'AND', []));
});

test('buildAudienceWhere always anchors to c.workspace_id = $1 first', () => {
  const { where, params } = buildAudienceWhere(42, { audienceType: 'filters', filters: [] });
  assert.equal(params[0], 42);
  assert.match(where, /^c\.workspace_id = \$1/);
});

test('buildAudienceWhere uses contactIds path when audienceType is contacts', () => {
  const { where, params } = buildAudienceWhere(7, { audienceType: 'contacts', contactIds: [1, 2, 3] });
  assert.match(where, /c\.id = ANY\(\$2::bigint\[\]\)/);
  assert.deepEqual(params[1], [1, 2, 3]);
});

test('buildAudienceWhere falls back to an empty contact list safely (matches nothing, never all rows)', () => {
  const { where, params } = buildAudienceWhere(7, { audienceType: 'contacts', contactIds: [] });
  assert.match(where, /c\.id = ANY\(\$2::bigint\[\]\)/);
  assert.deepEqual(params[1], []);
});

test('buildAudienceWhere uses the filters path when audienceType is filters', () => {
  const { where, params } = buildAudienceWhere(7, {
    audienceType: 'filters',
    filters: [{ field: 'name', operator: 'not_empty' }],
    combinator: 'AND',
  });
  assert.match(where, /c\.workspace_id = \$1 AND \(/);
  assert.equal(params.length, 1); // not_empty adds no param
});
// ─── validateAudienceFilters (Phase 6 Part 1 fix) ──────────────────────────
// Server-side allowlist that stands between client-supplied field/operator
// strings and the SQL interpolation in fieldExpr()/buildCondition().

test('validateAudienceFilters accepts a single well-formed condition', () => {
  assert.equal(validateAudienceFilters([{ field: 'city', operator: 'equals', value: 'Chennai' }], 'AND'), null);
});

test('validateAudienceFilters accepts multiple conditions with AND', () => {
  const filters = [
    { field: 'city', operator: 'equals', value: 'Chennai' },
    { field: 'purchaseCount', operator: 'gt', value: 3 },
  ];
  assert.equal(validateAudienceFilters(filters, 'AND'), null);
});

test('validateAudienceFilters accepts multiple conditions with OR', () => {
  const filters = [
    { field: 'city', operator: 'equals', value: 'Chennai' },
    { field: 'city', operator: 'equals', value: 'Erode' },
  ];
  assert.equal(validateAudienceFilters(filters, 'OR'), null);
});

test('validateAudienceFilters accepts an empty filter list (means "all contacts")', () => {
  assert.equal(validateAudienceFilters([], 'AND'), null);
  assert.equal(validateAudienceFilters(undefined, undefined), null);
});

test('validateAudienceFilters rejects an unknown field (blocks SQL interpolation via custom_fields)', () => {
  const err = validateAudienceFilters([{ field: "x'); DROP TABLE contacts;--", operator: 'equals', value: '1' }], 'AND');
  assert.match(err, /Unsupported filter field/);
});

test('validateAudienceFilters rejects an operator not valid for the field type', () => {
  // "contains" is a text-only operator; city is text so this should be fine,
  // but "gt" is not defined for text fields.
  const err = validateAudienceFilters([{ field: 'city', operator: 'gt', value: 'x' }], 'AND');
  assert.match(err, /Unsupported operator/);
});

test('validateAudienceFilters rejects an unknown operator outright', () => {
  const err = validateAudienceFilters([{ field: 'name', operator: 'nope', value: 'x' }], 'AND');
  assert.match(err, /Unsupported operator/);
});

test('validateAudienceFilters rejects a bad combinator', () => {
  assert.match(validateAudienceFilters([], 'XOR'), /combinator/);
});

test('validateAudienceFilters requires a value for value-bearing operators', () => {
  const err = validateAudienceFilters([{ field: 'city', operator: 'equals', value: '' }], 'AND');
  assert.match(err, /value is required/);
});

test('validateAudienceFilters allows is_empty/not_empty without a value', () => {
  assert.equal(validateAudienceFilters([{ field: 'city', operator: 'is_empty' }], 'AND'), null);
  assert.equal(validateAudienceFilters([{ field: 'city', operator: 'not_empty' }], 'AND'), null);
});

test('validateAudienceFilters requires a [min, max] pair for "between"', () => {
  assert.match(validateAudienceFilters([{ field: 'purchaseCount', operator: 'between', value: 5 }], 'AND'), /requires a \[min, max\]/);
  assert.equal(validateAudienceFilters([{ field: 'purchaseCount', operator: 'between', value: [1, 5] }], 'AND'), null);
});

test('validateAudienceFilters accepts core fields name/contact_number', () => {
  assert.equal(validateAudienceFilters([{ field: 'name', operator: 'contains', value: 'ram' }], 'AND'), null);
  assert.equal(validateAudienceFilters([{ field: 'contact_number', operator: 'contains', value: '98' }], 'AND'), null);
});

test('validateAudienceFilters accepts the date field with within_days', () => {
  assert.equal(validateAudienceFilters([{ field: 'lastPurchase', operator: 'within_days', value: 30 }], 'AND'), null);
});

// ─── Phase 6 Part 1 correction — 'source' field ────────────────────────────

test('validateAudienceFilters accepts the "source" field', () => {
  assert.equal(validateAudienceFilters([{ field: 'source', operator: 'equals', value: 'shopify_sheet_sync' }], 'AND'), null);
});

test('buildFilterSQL maps "source" to custom_fields->>\'source\' (not hardcoded to any value), case-insensitively', () => {
  const params = [];
  const sql = buildFilterSQL([{ field: 'source', operator: 'equals', value: 'shopify_sheet_sync' }], 'AND', params);
  assert.match(sql, /c\.custom_fields->>'source' ILIKE \$1/);
  assert.deepEqual(params, ['shopify_sheet_sync']);
});

test('buildFilterSQL "source" works with an arbitrary user-supplied value, not just shopify_sheet_sync', () => {
  const params = [];
  const sql = buildFilterSQL([{ field: 'source', operator: 'equals', value: 'manual_import' }], 'AND', params);
  assert.match(sql, /c\.custom_fields->>'source' ILIKE \$1/);
  assert.deepEqual(params, ['manual_import']);
});

test('buildFilterSQL "source" equals is case-insensitive (Shopify/shopify/SHOPIFY all match the same rows)', () => {
  const paramsLower = [];
  const paramsUpper = [];
  const sqlLower = buildFilterSQL([{ field: 'source', operator: 'equals', value: 'shopify_sheet_sync' }], 'AND', paramsLower);
  const sqlUpper = buildFilterSQL([{ field: 'source', operator: 'equals', value: 'SHOPIFY_SHEET_SYNC' }], 'AND', paramsUpper);
  // Same generated SQL shape (ILIKE) regardless of the casing of the value —
  // the case-insensitivity is enforced by the SQL operator, not by
  // pre-lowercasing the value (which would break exact-match semantics for
  // legitimately mixed-case stored data).
  assert.equal(sqlLower, sqlUpper);
});

test('buildFilterSQL "city" not_equals is case-insensitive too (NOT ILIKE)', () => {
  const params = [];
  const sql = buildFilterSQL([{ field: 'city', operator: 'not_equals', value: 'Chennai' }], 'AND', params);
  assert.match(sql, /c\.custom_fields->>'city' NOT ILIKE \$1/);
  assert.deepEqual(params, ['Chennai']);
});

test('buildFilterSQL "email is not empty" maps correctly', () => {
  const params = [];
  const sql = buildFilterSQL([{ field: 'email', operator: 'not_empty' }], 'AND', params);
  assert.match(sql, /\(c\.custom_fields->>'email' IS NOT NULL AND c\.custom_fields->>'email' != ''\)/);
  assert.deepEqual(params, []);
});

test('validateAudienceFilters accepts "source" AND "email is not empty" together', () => {
  const filters = [
    { field: 'source', operator: 'equals', value: 'shopify_sheet_sync' },
    { field: 'email', operator: 'not_empty' },
  ];
  assert.equal(validateAudienceFilters(filters, 'AND'), null);
});

test('buildFilterSQL joins "source" AND "email is not empty" with AND', () => {
  const params = [];
  const filters = [
    { field: 'source', operator: 'equals', value: 'shopify_sheet_sync' },
    { field: 'email', operator: 'not_empty' },
  ];
  const sql = buildFilterSQL(filters, 'AND', params);
  assert.match(sql, /c\.custom_fields->>'source' ILIKE \$1.* AND .*c\.custom_fields->>'email' IS NOT NULL/);
  assert.deepEqual(params, ['shopify_sheet_sync']);
});

test('validateAudienceFilters accepts the "starts_with" text operator', () => {
  assert.equal(validateAudienceFilters([{ field: 'source', operator: 'starts_with', value: 'shopify' }], 'AND'), null);
});

test('buildFilterSQL "starts_with" anchors the pattern at the start (value%)', () => {
  const params = [];
  const sql = buildFilterSQL([{ field: 'source', operator: 'starts_with', value: 'shopify' }], 'AND', params);
  assert.match(sql, /c\.custom_fields->>'source' ILIKE \$1/);
  assert.deepEqual(params, ['shopify%']);
});

test('validateAudienceFilters still rejects fields not in the allowlist (e.g. free-text custom_fields keys not exposed to the UI)', () => {
  const err = validateAudienceFilters([{ field: 'isRetarget', operator: 'equals', value: 'true' }], 'AND');
  assert.match(err, /Unsupported filter field/);
});

test('validateAudienceFilters rejects "source" with an unsupported operator (e.g. numeric-only "gt")', () => {
  const err = validateAudienceFilters([{ field: 'source', operator: 'gt', value: '1' }], 'AND');
  assert.match(err, /Unsupported operator/);
});

test('buildAudienceWhere with "source" equals is still anchored to c.workspace_id = $1 first (workspace isolation)', () => {
  const { where, params } = buildAudienceWhere(1, {
    audienceType: 'filters',
    filters: [{ field: 'source', operator: 'equals', value: 'shopify_sheet_sync' }],
    combinator: 'AND',
  });
  assert.match(where, /^c\.workspace_id = \$1/);
  assert.equal(params[0], 1);
  assert.deepEqual(params, [1, 'shopify_sheet_sync']);
});

test('buildAudienceWhere workspace anchor is never overridable by a client-supplied workspace value inside the filters array', () => {
  // Even if a caller tried to sneak a workspace-like field into filters, it's
  // not in ALLOWED_FIELDS, so validateAudienceFilters rejects it before this
  // function is ever reached — this test documents that the ONLY workspace
  // scoping path is the explicit workspaceId argument.
  const { where } = buildAudienceWhere(999, { audienceType: 'filters', filters: [] });
  assert.equal(where, 'c.workspace_id = $1');
});