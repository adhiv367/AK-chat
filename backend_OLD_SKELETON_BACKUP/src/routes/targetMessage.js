// Target Message: filter + select synchronized contacts (see
// services/sheetSyncScheduler.js for how they get here), then hand off to the
// EXISTING broadcast pipeline. This file creates zero new send logic — it only
// prepares a DRAFT row in coexistence.broadcasts, then the already-existing
// /broadcasts/:id/send and /broadcasts/:id/test routes do the actual sending.

const { Router } = require('express');
const pool = require('../db');
const { requirePermission } = require('../middleware/access');

const router = Router();

// ─── Filter builder over coexistence.contacts (core columns + custom_fields jsonb) ───

const CORE_FIELDS = new Set(['name', 'contact_number']);
const NUMERIC_FIELDS = new Set(['purchaseCount', 'totalPurchaseAmount', 'age']);

function fieldExpr(field) {
  return CORE_FIELDS.has(field) ? `c.${field}` : `c.custom_fields->>'${field}'`;
}

function buildCondition(rule, params) {
  const { field, operator, value } = rule;
  const expr = fieldExpr(field);
  const isNumeric = NUMERIC_FIELDS.has(field);
  const opMap = { equals: '=', not_equals: '!=', gt: '>', lt: '<', gte: '>=', lte: '<=' };

  switch (operator) {
    case 'contains':
      params.push(`%${value}%`);
      return `${expr} ILIKE $${params.length}`;
    case 'equals':
    case 'not_equals':
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

// ─── Routes ──────────────────────────────────────────────────────────────

// GET /api/target/customers — list synced contacts, filtered/searched.
// No batchId anymore: Target Message reads the single, always-current
// contacts table (kept in sync by services/sheetSyncScheduler.js).
router.get('/target/customers', requirePermission('target-message'), async (req, res) => {
  try {
    const { search = '', combinator = 'AND', limit = 500 } = req.query;
    let filters = [];
    if (req.query.filters) {
      try { filters = JSON.parse(req.query.filters); }
      catch { return res.status(400).json({ error: 'Invalid filters JSON' }); }
    }

    const params = [];
    let where = '1=1';
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (c.name ILIKE $${params.length} OR c.contact_number ILIKE $${params.length})`;
    }
    const filterSql = buildFilterSQL(filters, combinator, params);
    if (filterSql) where += ` AND ${filterSql}`;
    const capLimit = Math.min(parseInt(limit, 10) || 500, 2000);

    const { rows } = await pool.query(
      `SELECT c.id, c.contact_number, c.name, c.tags, c.custom_fields, c.created_at, c.updated_at
         FROM coexistence.contacts c WHERE ${where}
        ORDER BY c.updated_at DESC LIMIT ${capLimit}`,
      params
    );
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM coexistence.contacts c WHERE ${where}`,
      params
    );
    res.json({ rows, total: countRows[0]?.total || 0 });
  } catch (err) {
    console.error('[targetMessage] list customers error:', err.message);
    res.status(500).json({ error: 'Failed to list customers' });
  }
});

// POST /api/target/campaign — creates a DRAFT broadcast (source='target') from
// the filtered/selected contacts. Sending itself happens via the EXISTING
// /broadcasts/:id/send and /broadcasts/:id/test routes — no new sender code.
router.post('/target/campaign', requirePermission('target-message'), async (req, res) => {
  try {
    const {
      filters = [], combinator = 'AND', customerIds,
      fromNumber, name, messageType, templateId, body, url,
      mediaLibraryId, caption, variableMapping = {},
    } = req.body;

    if (!fromNumber) return res.status(400).json({ error: 'fromNumber is required' });
    const msgType = messageType || 'template';
    if (msgType === 'template' && !templateId) {
      return res.status(400).json({ error: 'templateId required for template messages' });
    }

    const params = [];
    let where = '1=1';
    if (Array.isArray(customerIds) && customerIds.length > 0) {
      params.push(customerIds);
      where += ` AND c.id = ANY($${params.length}::bigint[])`;
    } else {
      const filterSql = buildFilterSQL(filters, combinator, params);
      if (filterSql) where += ` AND ${filterSql}`;
    }

    const { rows: recipients } = await pool.query(
      `SELECT contact_number, name FROM coexistence.contacts c WHERE ${where}`,
      params
    );
    if (recipients.length === 0) {
      return res.status(400).json({ error: 'No customers match the selected audience' });
    }
    if (recipients.length > 5000) {
      return res.status(400).json({ error: 'Audience exceeds 5000 — narrow your filters' });
    }

    const recipientNumbers = recipients.map((r) => ({ contact_number: r.contact_number, name: r.name || '' }));

    const { rows: inserted } = await pool.query(
      `INSERT INTO coexistence.broadcasts
         (from_number, recipient_numbers, template_id, status, name,
          variable_mapping, message_type, body, url, media_library_id, caption, source)
       VALUES ($1,$2,$3,'DRAFT',$4,$5,$6,$7,$8,$9,$10,'target')
       RETURNING id`,
      [
        fromNumber, JSON.stringify(recipientNumbers), templateId || null,
        name || `Target Campaign ${new Date().toISOString()}`,
        JSON.stringify(variableMapping || {}), msgType,
        body || null, url || null, mediaLibraryId || null, caption || null,
      ]
    );

    res.json({ broadcastId: inserted[0].id, audienceCount: recipients.length });
  } catch (err) {
    console.error('[targetMessage] campaign create error:', err.message);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
});

module.exports = { router };