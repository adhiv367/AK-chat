// Retarget module — repository layer.
// Owns every SQL statement against coexistence.retarget_customers.
// Nothing above this layer (service/controller) should touch `pool` directly.
//
// Phase 3C-4: every function now takes/uses workspaceId to scope reads and
// writes to coexistence.retarget_customers.workspace_id — see
// db/retargetWorkspaceSchema.js for the column + backfill. workspaceId must
// come from req.workspace.id (never trust one supplied by the client).

const pool = require('../db');

const LIST_COLUMNS = `
  id, workspace_id, name, phone, email, exit_url, retarget_type, timestamp,
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

// findAll(workspaceId, { search, status, category, sent, active, page, limit }) → { rows, total }
async function findAll(workspaceId, { search = '', status = '', category = '', sent = '', active = '', page = 1, limit = 20 } = {}) {
  const where = [];
  const params = [];

  // Workspace scoping is always the first, mandatory predicate — a missing
  // workspaceId must never fall through to an unscoped (all-workspaces) scan.
  params.push(workspaceId);
  where.push(`workspace_id = $${params.length}`);

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

  const whereSql = `WHERE ${where.join(' AND ')}`;
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

// findById scoped to workspaceId — a retarget customer id from another
// workspace must resolve as "not found", not leak its data.
async function findById(id, workspaceId) {
  const { rows } = await pool.query(
    `SELECT ${LIST_COLUMNS} FROM coexistence.retarget_customers WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId]
  );
  return rows[0] || null;
}

async function create(data, workspaceId) {
  const {
    name = null, phone = null, email = null, exitUrl = null,
    retargetType = null, timestamp = null, source = null, status = 'pending',
  } = data;

  const { rows } = await pool.query(
    `INSERT INTO coexistence.retarget_customers
       (workspace_id, name, phone, email, exit_url, retarget_type, timestamp, source, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, NOW()), $8, $9, NOW())
     RETURNING ${LIST_COLUMNS}`,
    [workspaceId, name, phone, email, exitUrl, retargetType, timestamp, source, status]
  );
  return rows[0];
}

// update scoped to workspaceId in the WHERE clause — a caller can never
// mutate another workspace's row even if it guesses a valid id.
async function update(id, data, workspaceId) {
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

  params.push(id, workspaceId);
  const { rows } = await pool.query(
    `UPDATE coexistence.retarget_customers SET ${sets.join(', ')}
      WHERE id = $${i} AND workspace_id = $${i + 1}
      RETURNING ${LIST_COLUMNS}`,
    params
  );
  return rows[0] || null;
}

async function remove(id, workspaceId) {
  const { rowCount } = await pool.query(
    `DELETE FROM coexistence.retarget_customers WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId]
  );
  return rowCount > 0;
}

// Exact-match phone lookup scoped to a workspace — used by the import/sync
// pipeline (retargetImportService.js) for dedupe. Distinct from findAll's
// ILIKE substring search: phone dedupe must be exact AND workspace-scoped,
// otherwise two workspaces sharing a customer's phone number would collide.
async function findByPhone(phone, workspaceId) {
  const { rows } = await pool.query(
    `SELECT ${LIST_COLUMNS} FROM coexistence.retarget_customers WHERE phone = $1 AND workspace_id = $2 LIMIT 1`,
    [phone, workspaceId]
  );
  return rows[0] || null;
}

module.exports = { findAll, findById, create, update, remove, findByPhone };
