// Shared audience filter-builder over coexistence.contacts (core columns +
// custom_fields jsonb). Extracted from routes/targetMessage.js (Phase 5
// Audience & Segmentation) so Phase 6 Campaign Studio resolves audiences
// through the EXACT SAME filter logic instead of a second implementation.
//
// Anything that changes how a filter rule is turned into SQL must change
// here once, and both Target Message and Campaign Studio pick it up.

const CORE_FIELDS = new Set(['name', 'contact_number']);
const NUMERIC_FIELDS = new Set(['purchaseCount', 'totalPurchaseAmount', 'age']);
const DATE_FIELDS = new Set(['lastPurchase']);

// Server-side allowlist of every field the filter UI (Target Message AND
// Campaign Studio) is permitted to expose. `field` is otherwise interpolated
// directly into a SQL string (c.custom_fields->>'<field>'), so this allowlist
// is what stands between a client-supplied field name and SQL injection —
// validateAudienceFilters() below MUST be called on every field that reaches
// buildAudienceWhere/buildFilterSQL from a request body or query string.
const ALLOWED_FIELDS = new Set([
  'name', 'contact_number',
  'city', 'state', 'country', 'lastProduct',
  'purchaseCount', 'totalPurchaseAmount', 'lastPurchase', 'email',
  // Phase 6 Part 1 correction — 'source' exists in coexistence.contacts
  // .custom_fields (e.g. 'shopify_sheet_sync' from the sheet-sync pipeline)
  // but was missing from this allowlist, so it silently 400'd instead of
  // being selectable in Campaign Studio. Text field, no special handling
  // needed beyond being present here and in fieldType() below (defaults to
  // 'text').
  'source',
]);

function fieldType(field) {
  if (NUMERIC_FIELDS.has(field)) return 'number';
  if (DATE_FIELDS.has(field)) return 'date';
  return 'text';
}

const ALLOWED_OPERATORS_BY_TYPE = {
  text: new Set(['equals', 'not_equals', 'contains', 'starts_with', 'is_empty', 'not_empty']),
  number: new Set(['equals', 'gt', 'lt', 'gte', 'lte', 'between', 'is_empty', 'not_empty']),
  date: new Set(['within_days', 'equals', 'is_empty', 'not_empty']),
};

// Validates a filter-rule array + combinator BEFORE it ever reaches
// buildFilterSQL/buildAudienceWhere. Returns null when valid, or a short
// human-readable error string identifying the first problem found — callers
// (routes/targetMessage.js, routes/campaigns.js) should respond 400 with it.
// Never allows an unrecognized field or an operator not valid for that
// field's type through, so no client-supplied string can be interpolated
// into the generated SQL.
function validateAudienceFilters(filters, combinator) {
  if (combinator !== undefined && combinator !== null && !['AND', 'OR'].includes(combinator)) {
    return 'combinator must be "AND" or "OR"';
  }
  if (filters === undefined || filters === null) return null;
  if (!Array.isArray(filters)) return 'filters must be an array';

  for (const rule of filters) {
    if (!rule || typeof rule !== 'object') return 'each filter must be an object';
    const { field, operator, value } = rule;

    if (typeof field !== 'string' || !ALLOWED_FIELDS.has(field)) {
      return `Unsupported filter field: ${JSON.stringify(field)}`;
    }
    const type = fieldType(field);
    if (typeof operator !== 'string' || !ALLOWED_OPERATORS_BY_TYPE[type].has(operator)) {
      return `Unsupported operator "${operator}" for field "${field}"`;
    }
    if (!['is_empty', 'not_empty'].includes(operator)) {
      if (operator === 'between') {
        if (!Array.isArray(value) || value.length !== 2) {
          return `Operator "between" on field "${field}" requires a [min, max] value`;
        }
      } else if (value === undefined || value === null || value === '') {
        return `A value is required for operator "${operator}" on field "${field}"`;
      }
    }
  }
  return null;
}

function fieldExpr(field) {
  return CORE_FIELDS.has(field) ? `c.${field}` : `c.custom_fields->>'${field}'`;
}

function buildCondition(rule, params) {
  const { field, operator, value } = rule;
  const expr = fieldExpr(field);
  const isNumeric = NUMERIC_FIELDS.has(field);
  const isDate = DATE_FIELDS.has(field);
  const opMap = { gt: '>', lt: '<', gte: '>=', lte: '<=' };

  switch (operator) {
    case 'contains':
      params.push(`%${value}%`);
      return `${expr} ILIKE $${params.length}`;
    case 'starts_with':
      params.push(`${value}%`);
      return `${expr} ILIKE $${params.length}`;
    case 'equals':
    case 'not_equals': {
      // Requirement: normal text matching (City, Customer source, etc.)
      // must be case-insensitive — "Chennai"/"chennai"/"CHENNAI" and
      // "Shopify"/"shopify"/"SHOPIFY" should match the same records. Text
      // fields use a plain (no-wildcard) ILIKE, which is an exact,
      // case-insensitive match. Numeric/date fields keep exact numeric/date
      // comparison — case-insensitivity doesn't apply to them.
      params.push(value);
      if (!isNumeric && !isDate) {
        return `${expr} ${operator === 'not_equals' ? 'NOT ' : ''}ILIKE $${params.length}`;
      }
      const cast = isNumeric ? `NULLIF(${expr}, '')::numeric` : `NULLIF(${expr}, '')::date`;
      return `${cast} ${operator === 'not_equals' ? '!=' : '='} $${params.length}`;
    }
    case 'gt':
    case 'lt':
    case 'gte':
    case 'lte': {
      params.push(value);
      const cast = isNumeric ? `NULLIF(${expr}, '')::numeric` : expr;
      return `${cast} ${opMap[operator]} $${params.length}`;
    }
    case 'between': {
      const [min, max] = Array.isArray(value) ? value : [null, null];
      params.push(min, max);
      return `NULLIF(${expr}, '')::numeric BETWEEN $${params.length - 1} AND $${params.length}`;
    }
    case 'within_days':
      params.push(Number(value) || 0);
      return `NULLIF(${expr}, '')::date >= (NOW() - ($${params.length} || ' days')::interval)`;
    case 'is_empty':
      return `(${expr} IS NULL OR ${expr} = '')`;
    case 'not_empty':
      return `(${expr} IS NOT NULL AND ${expr} != '')`;
    default:
      throw new Error(`Unsupported operator: ${operator}`);
  }
}

function buildFilterSQL(rules, combinator, params) {
  if (!Array.isArray(rules) || rules.length === 0) return '';
  const parts = rules.map((r) => buildCondition(r, params));
  const glue = combinator === 'OR' ? ' OR ' : ' AND ';
  return `(${parts.join(glue)})`;
}

// ─── Phone-level recipient deduplication ───────────────────────────────────
//
// ROOT CAUSE: contact identity is currently (wa_number, contact_number), not
// (workspace_id, contact_number) — a workspace can have multiple connected
// WhatsApp accounts, so the same real customer phone number can legitimately
// exist as more than one row in coexistence.contacts within one workspace.
// Left alone, an audience filter (or a static contact-id list) can match
// more than one row for the same phone number, which would inflate the
// audience count AND — once campaign sending exists — could send the same
// WhatsApp message to the same phone number twice.
//
// RULE: within one workspace, one normalized phone number (contact_number)
// = one campaign recipient. When more than one contact row shares a phone
// number and both satisfy the audience, exactly one of those rows is kept.
//
// Which row wins (smallest safe deterministic rule, in priority order):
//   1. A row with a non-blank `name` beats a row with a blank name — a
//      named record is more useful for personalization/preview than a
//      blank one (e.g. contact 1008 has name "26"; contact 142 has no
//      name at all — 1008 should win).
//   2. Otherwise, the most recently updated row wins (`updated_at DESC`) —
//      Shopify sync / contact edits / imports all bump updated_at when they
//      write richer data, so the freshest row is the best proxy for "most
//      complete" without having to hand-weight every individual field.
//   3. Final tie-break: highest `id` — purely for determinism (stable
//      output across repeated calls with otherwise-identical rows).
// This never fabricates or merges fields from two contacts — the chosen
// row is always one real, existing contact record, exactly as stored.
const DEDUP_ORDER_BY = `c.contact_number,
       (CASE WHEN NULLIF(TRIM(c.name), '') IS NULL THEN 1 ELSE 0 END),
       c.updated_at DESC,
       c.id DESC`;

// Wraps a WHERE fragment (from buildAudienceWhere, always anchored to
// c.workspace_id = $1) in a DISTINCT ON (c.contact_number) subquery using
// the rule above, so the query returns at most one row per phone number.
// This is the SINGLE choke point for phone-level dedup — audience count,
// audience sample/preview, and recipient resolution (Campaign Studio +
// Target Message) all build their queries from this same fragment, so
// count and recipient-resolution can never disagree with each other.
function buildDedupedContactsSQL(where) {
  return `SELECT DISTINCT ON (c.contact_number) c.*
             FROM coexistence.contacts c
            WHERE ${where}
            ORDER BY ${DEDUP_ORDER_BY}`;
}

// Builds a full `WHERE ... ` fragment (always anchored to c.workspace_id =
// $1, never trusting a client-supplied workspace id) + params array for an
// audience definition of the shape Campaign Studio / Target Message store:
//   { audienceType: 'contacts' | 'filters', contactIds?: number[],
//     filters?: Rule[], combinator?: 'AND' | 'OR' }
// Always scoped server-side to `workspaceId` — callers must never accept an
// audience definition from the client without re-resolving it through this
// function against the *authenticated* workspace.
function buildAudienceWhere(workspaceId, audience) {
  const params = [workspaceId];
  let where = 'c.workspace_id = $1';

  const { audienceType, contactIds, filters, combinator } = audience || {};

  if (audienceType === 'contacts' || (Array.isArray(contactIds) && contactIds.length > 0)) {
    const ids = Array.isArray(contactIds) ? contactIds : [];
    params.push(ids);
    where += ` AND c.id = ANY($${params.length}::bigint[])`;
  } else {
    const filterSql = buildFilterSQL(filters || [], combinator || 'AND', params);
    if (filterSql) where += ` AND ${filterSql}`;
  }

  return { where, params };
}

module.exports = {
  CORE_FIELDS, NUMERIC_FIELDS, DATE_FIELDS, ALLOWED_FIELDS, ALLOWED_OPERATORS_BY_TYPE,
  fieldExpr, fieldType, buildCondition, buildFilterSQL, buildAudienceWhere, validateAudienceFilters,
  DEDUP_ORDER_BY, buildDedupedContactsSQL,
};