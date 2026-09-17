// Phase 8C-2 — Invoice Service Foundation ONLY.
//
// Generic CRUD-ish service over coexistence.workspace_invoices (created in
// Phase 8C-1, frozen — not touched here). Mirrors the existing
// pool/service conventions (billingService.js, businessFieldDefinitionService.js):
// plain pg pool queries, `err.status` for HTTP-shaped errors, `err.code ===
// '23505'` translated into a safe 409 rather than leaking the raw Postgres
// constraint error.
//
// Scope, per Phase 8C-2:
//   - No pricing/tax calculation — subtotal/tax/total are passed in as-is.
//   - No PDF generation, no routes, no frontend, no payment integration.
//   - Every query is workspace-scoped; workspace_id is never accepted in
//     the update path, so it can never change after creation.
//   - Does not touch coexistence.plans / workspace_billing / trials.

const pool = require('../db');

// Mirrors the CHECK constraint in invoicesSchema.js
// (workspace_invoices_status_check). Kept in sync manually, same as how
// billingService.js/routes re-validate against known plan/status values
// rather than relying solely on the DB to reject bad input.
const VALID_STATUSES = ['draft', 'issued', 'paid', 'overdue', 'void', 'refunded'];

function assertValidStatus(status) {
  if (!VALID_STATUSES.includes(status)) {
    const err = new Error(`Invalid invoice status: ${status}`);
    err.status = 400;
    throw err;
  }
}

// ── Create ──────────────────────────────────────────────────────────────
// workspaceId always comes from server-resolved context (route layer),
// never from client-suppliable invoice fields — same convention as
// billingService.startCheckout().
async function createInvoice(workspaceId, {
  invoiceNumber,
  status = 'draft',
  currency,
  subtotal = 0,
  tax = 0,
  total = 0,
  billingPeriodStart = null,
  billingPeriodEnd = null,
  issueDate = null,
  dueDate = null,
  paidDate = null,
} = {}) {
  if (!workspaceId) {
    const err = new Error('workspaceId is required');
    err.status = 400;
    throw err;
  }
  if (!invoiceNumber) {
    const err = new Error('invoiceNumber is required');
    err.status = 400;
    throw err;
  }
  if (!currency) {
    const err = new Error('currency is required');
    err.status = 400;
    throw err;
  }
  assertValidStatus(status);
  try {
    const { rows } = await pool.query(
      `INSERT INTO coexistence.workspace_invoices
         (workspace_id, invoice_number, status, currency, subtotal, tax, total,
          billing_period_start, billing_period_end, issue_date, due_date, paid_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        workspaceId, invoiceNumber, status, currency, subtotal, tax, total,
        billingPeriodStart, billingPeriodEnd, issueDate, dueDate, paidDate,
      ]
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') {
      // uq_workspace_invoices_invoice_number — invoice numbers are unique
      // across the whole table (8C-1). Translate into a safe 409 rather
      // than leaking the raw constraint error.
      const dupErr = new Error(`An invoice with number "${invoiceNumber}" already exists`);
      dupErr.status = 409;
      throw dupErr;
    }
    throw err;
  }
}
// ── Read: single invoice, workspace-scoped ───────────────────────────────
async function getInvoiceById(workspaceId, invoiceId) {
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.workspace_invoices
      WHERE id = $1 AND workspace_id = $2`,
    [invoiceId, workspaceId]
  );
  return rows[0] || null;
}
// ── Read: list, workspace-scoped ─────────────────────────────────────────
async function listWorkspaceInvoices(workspaceId, { status = null, limit = 50, offset = 0 } = {}) {
  if (status) assertValidStatus(status);

  const params = [workspaceId];
  let where = 'WHERE workspace_id = $1';
  if (status) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  params.push(limit, offset);

  const { rows } = await pool.query(
    `SELECT * FROM coexistence.workspace_invoices
      ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}
// ── Update status, workspace-scoped ──────────────────────────────────────
// Only status (+ paidDate, when transitioning to 'paid') is mutable here.
// workspace_id is intentionally never accepted as an updatable field, so it
// can never change after creation (requirement #4) — the WHERE clause is
// also the only place workspace_id is used, purely to scope the update.
async function updateInvoiceStatus(workspaceId, invoiceId, status, { paidDate = null } = {}) {
  assertValidStatus(status);

  const { rows } = await pool.query(
    `UPDATE coexistence.workspace_invoices
        SET status = $1,
            paid_date = COALESCE($2, paid_date),
            updated_at = NOW()
      WHERE id = $3 AND workspace_id = $4
      RETURNING *`,
    [status, paidDate, invoiceId, workspaceId]
  );

  if (!rows[0]) {
    const err = new Error('Invoice not found');
    err.status = 404;
    throw err;
  }
  return rows[0];
}
module.exports = {
  VALID_STATUSES,
  createInvoice,
  getInvoiceById,
  listWorkspaceInvoices,
  updateInvoiceStatus,
};