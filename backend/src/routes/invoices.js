// Phase 8C-3 — Invoice API Routes ONLY.
//
//   POST /workspaces/:id/invoices              — create an invoice.
//                                                 OWNER/ADMIN (billing-adjacent
//                                                 write, same bar as
//                                                 request-plan-change in
//                                                 billing.js would use for a
//                                                 write — here OWNER+ per
//                                                 8C-3 "enforce existing
//                                                 workspace membership/access
//                                                 rules").
//   GET  /workspaces/:id/invoices               — list this workspace's invoices.
//   GET  /workspaces/:id/invoices/:invoiceId     — single invoice.
//   PATCH /workspaces/:id/invoices/:invoiceId/status — update status.
//
// All four routes resolve membership via loadMembership (copied pattern
// from routes/billing.js — never trusts workspace_id from the client
// without re-checking req.membership) then delegate every DB query to
// invoiceService.js (8C-2, frozen — no queries duplicated here). Read
// routes (GET) are ADMIN+; mutating routes (POST/PATCH) are OWNER-only,
// matching billing.js's split between read (ADMIN+) and manage (OWNER-only).

const { Router } = require('express');
const { getMembership } = require('../middleware/workspaceContext');
const { requireWorkspaceRole, auditLog } = require('../middleware/access');
const {
  createInvoice,
  getInvoiceById,
  listWorkspaceInvoices,
  updateInvoiceStatus,
  VALID_STATUSES,
} = require('../services/invoiceService');

const router = Router();

// Same 404-not-403 pattern as routes/billing.js's loadMembership: an
// attacker probing workspace IDs can't distinguish "doesn't exist" from
// "not your workspace".
async function loadMembership(req, res, next) {
  try {
    const workspaceId = req.params.id;
    const membership = await getMembership(req.user.id, workspaceId);
    if (!membership) return res.status(404).json({ error: 'Workspace not found' });
    req.membership = membership;
    next();
  } catch (err) {
    console.error('[invoices] membership lookup error:', err.message);
    res.status(500).json({ error: 'Failed to resolve workspace' });
  }
}

// ─── POST /workspaces/:id/invoices ───────────────────────────────────────
// OWNER ONLY, same gate as billing.js's checkout/cancel/request-plan-change.
router.post('/workspaces/:id/invoices', loadMembership, requireWorkspaceRole('OWNER'), async (req, res) => {
  const { invoiceNumber, status, currency, subtotal, tax, total,
    billingPeriodStart, billingPeriodEnd, issueDate, dueDate, paidDate } = req.body || {};

  if (!invoiceNumber || typeof invoiceNumber !== 'string') {
    return res.status(400).json({ error: 'invoiceNumber is required' });
  }
  if (!currency || typeof currency !== 'string') {
    return res.status(400).json({ error: 'currency is required' });
  }
  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Invalid invoice status: ${status}` });
  }

  try {
    const invoice = await createInvoice(req.membership.id, {
      invoiceNumber, status, currency, subtotal, tax, total,
      billingPeriodStart, billingPeriodEnd, issueDate, dueDate, paidDate,
    });
    await auditLog({ actor: req.user, action: 'invoice.created', targetType: 'workspace', targetId: req.membership.id, payload: { invoiceId: invoice.id, invoiceNumber } });
    res.status(201).json(invoice);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('[invoices] create error:', err.message);
    res.status(status).json({ error: err.message || 'Failed to create invoice' });
  }
});

// ─── GET /workspaces/:id/invoices ────────────────────────────────────────
// Readable by ADMIN+, same read/manage split as billing.js.
router.get('/workspaces/:id/invoices', loadMembership, requireWorkspaceRole('ADMIN'), async (req, res) => {
  const { status } = req.query || {};
  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Invalid invoice status: ${status}` });
  }
  try {
    const invoices = await listWorkspaceInvoices(req.membership.id, { status });
    res.json({ invoices });
  } catch (err) {
    const httpStatus = err.status || 500;
    if (httpStatus === 500) console.error('[invoices] list error:', err.message);
    res.status(httpStatus).json({ error: err.message || 'Failed to list invoices' });
  }
});

// ─── GET /workspaces/:id/invoices/:invoiceId ─────────────────────────────
router.get('/workspaces/:id/invoices/:invoiceId', loadMembership, requireWorkspaceRole('ADMIN'), async (req, res) => {
  try {
    const invoice = await getInvoiceById(req.membership.id, req.params.invoiceId);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    res.json(invoice);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('[invoices] get error:', err.message);
    res.status(status).json({ error: err.message || 'Failed to load invoice' });
  }
});

// ─── PATCH /workspaces/:id/invoices/:invoiceId/status ────────────────────
// OWNER ONLY, same gate as create above.
router.patch('/workspaces/:id/invoices/:invoiceId/status', loadMembership, requireWorkspaceRole('OWNER'), async (req, res) => {
  const { status, paidDate } = req.body || {};
  if (!status || !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Invalid invoice status: ${status}` });
  }
  try {
    const invoice = await updateInvoiceStatus(req.membership.id, req.params.invoiceId, status, { paidDate });
    await auditLog({ actor: req.user, action: 'invoice.status_updated', targetType: 'workspace', targetId: req.membership.id, payload: { invoiceId: req.params.invoiceId, status } });
    res.json(invoice);
  } catch (err) {
    const httpStatus = err.status || 500;
    if (httpStatus === 500) console.error('[invoices] update status error:', err.message);
    res.status(httpStatus).json({ error: err.message || 'Failed to update invoice status' });
  }
});

module.exports = { router };


