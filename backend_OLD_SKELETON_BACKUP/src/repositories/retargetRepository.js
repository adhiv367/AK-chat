// Retarget module — repository layer.
// Owns every SQL statement against coexistence.retarget_customers.
// Nothing above this layer (service/controller) should touch `pool` directly.

const pool = require('../db');

const LIST_COLUMNS = `
  id, name, phone, email, exit_url, retarget_type, timestamp,
  source, status, created_at, updated_at
`;

// Exit-URL → category SQL fragments — mirror
// services/retargetClassifier.js#detectExitCategory exactly (regex-for-regex)
// so the "Filters" dropdown on the Retarget page classifies rows the same
// way the import/sync pipeline does. Kept here instead of a stored column
// per the "no schema changes" constraint on this feature.
const CATEGORY_SQL = {
  cart: `(exit_url ~* '/cart\\M|\\mcart\\M') AND NOT (exit_url ~* '/checkout|\\mcheckout\\M')`,
  checkout: `(exit_url ~* '/checkout|\\mcheckout\\M')`,
  product: `(exit_url ~* '/products?/') AND NOT (exit_url ~* '/checkout|\\mcheckout\\M') AND NOT (exit_url ~* '/cart\\M|\\mcart\\M')`,
  collection: `(exit_url ~* '/collections?/') AND NOT (exit_url ~* '/checkout|\\mcheckout\\M') AND NOT (exit_url ~* '/cart\\M|\\mcart\\M') AND NOT (exit_url ~* '/products?/')`,
  other: `(exit_url IS NULL OR exit_url = '' OR (
      NOT (exit_url ~* '/checkout|\\mcheckout\\M')
      AND NOT (exit_url ~* '/cart\\M|\\mcart\\M')
      AND NOT (exit_url ~* '/products?/')
      AND NOT (exit_url ~* '/collections?/')
    ))`,
};

// "Sent" facet — derived from status (no dedicated sent/active columns are
// added; contacted/converted both imply a retarget message went out).
const SENT_STATUSES = ['contacted', 'converted'];
const NOT_SENT_STATUSES = ['pending', 'ignored'];

// "Active" facet — pending/contacted are still actionable; converted/ignored
// are terminal states for the retarget funnel.
const ACTIVE_STATUSES = ['pending', 'contacted'];
const INACTIVE_STATUSES = ['converted', 'ignored'];

// findAll({ search, status, category, sent, active, page, limit }) → { rows, total }
async function findAll({ search = '', status = '', category = '', sent = '', active = '', page = 1, limit = 20 } = {}) {
  const where = [];
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    where.push(`(name ILIKE $${params.length} OR phone ILIKE $${params.length} OR email ILIKE $${params.length})`);
  }
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (category && CATEGORY_SQL[category]) {
    where.push(CATEGORY_SQL[category]);
  }
  if (sent === 'sent') {
    params.push(SENT_STATUSES);
    where.push(`status = ANY($${params.length}::text[])`);
  } else if (sent === 'not_sent') {
    params.push(NOT_SENT_STATUSES);
    where.push(`status = ANY($${params.length}::text[])`);
  }
  if (active === 'active') {
    params.push(ACTIVE_STATUSES);
    where.push(`status = ANY($${params.length}::text[])`);
  } else if (active === 'inactive') {
    params.push(INACTIVE_STATUSES);
    where.push(`status = ANY($${params.length}::text[])`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const offset = (safePage - 1) * safeLimit;

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM coexistence.retarget_customers ${whereSql}`,
    params
  );
  const total = countRows[0]?.total || 0;

  params.push(safeLimit, offset);
  const { rows } = await pool.query(
    `SELECT ${LIST_COLUMNS}
       FROM coexistence.retarget_customers
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return { rows, total, page: safePage, limit: safeLimit };
}

async function findById(id) {
  const { rows } = await pool.query(
    `SELECT ${LIST_COLUMNS} FROM coexistence.retarget_customers WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function create(data) {
  const {
    name = null, phone = null, email = null, exitUrl = null,
    retargetType = null, timestamp = null, source = null, status = 'pending',
  } = data;

  const { rows } = await pool.query(
    `INSERT INTO coexistence.retarget_customers
       (name, phone, email, exit_url, retarget_type, timestamp, source, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, NOW()), $7, $8, NOW())
     RETURNING ${LIST_COLUMNS}`,
    [name, phone, email, exitUrl, retargetType, timestamp, source, status]
  );
  return rows[0];
}

async function update(id, data) {
  const sets = ['updated_at = NOW()'];
  const params = [];
  let i = 1;
  const push = (col, val) => { sets.push(`${col} = $${i++}`); params.push(val); };

  if (data.name !== undefined) push('name', data.name);
  if (data.phone !== undefined) push('phone', data.phone);
  if (data.email !== undefined) push('email', data.email);
  if (data.exitUrl !== undefined) push('exit_url', data.exitUrl);
  if (data.retargetType !== undefined) push('retarget_type', data.retargetType);
  if (data.timestamp !== undefined) push('timestamp', data.timestamp);
  if (data.source !== undefined) push('source', data.source);
  if (data.status !== undefined) push('status', data.status);

  params.push(id);
  const { rows } = await pool.query(
    `UPDATE coexistence.retarget_customers SET ${sets.join(', ')} WHERE id = $${i} RETURNING ${LIST_COLUMNS}`,
    params
  );
  return rows[0] || null;
}

async function remove(id) {
  const { rowCount } = await pool.query(
    `DELETE FROM coexistence.retarget_customers WHERE id = $1`,
    [id]
  );
  return rowCount > 0;
}
module.exports = { findAll, findById, create, update, remove };