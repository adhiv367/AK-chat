// Phase 8C-1 — Invoice Database Foundation ONLY.
//
// Adds coexistence.workspace_invoices: a generic multi-tenant invoice
// record table. Mirrors the idempotent `CREATE TABLE IF NOT EXISTS` /
// `ADD COLUMN IF NOT EXISTS` pattern used by plansSchema.ensurePlansTables()
// and planChangeRequestsSchema.ensurePlanChangeRequestsTable() — this file
// *is* the migration, called once on server startup.
//
// Scope, per Phase 8C-1:
//   - Schema only. No invoice generation, no payment integration, no
//     pricing/tax-rate/currency-default decisions.
//   - Does not touch coexistence.plans, coexistence.workspace_billing,
//     coexistence.plan_change_requests, or any trial columns.
//   - No frontend, no other feature area touched.

const pool = require('../db');

async function ensureInvoicesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.workspace_invoices (
      id                   BIGSERIAL PRIMARY KEY,
      workspace_id         BIGINT NOT NULL REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,
      invoice_number       TEXT NOT NULL,
      status               TEXT NOT NULL DEFAULT 'draft',
      currency             TEXT NOT NULL,
      subtotal             NUMERIC(12,2) NOT NULL DEFAULT 0,
      tax                  NUMERIC(12,2) NOT NULL DEFAULT 0,
      total                NUMERIC(12,2) NOT NULL DEFAULT 0,
      billing_period_start TIMESTAMPTZ,
      billing_period_end   TIMESTAMPTZ,
      issue_date           TIMESTAMPTZ,
      due_date             TIMESTAMPTZ,
      paid_date            TIMESTAMPTZ,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT workspace_invoices_status_check
        CHECK (status IN ('draft', 'issued', 'paid', 'overdue', 'void', 'refunded'))
    )
  `);

  // Invoice numbering must be unique across the whole table (not just per
  // workspace) — invoice numbers are expected to be globally distinct.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_invoices_invoice_number
      ON coexistence.workspace_invoices (invoice_number)
  `);

  // Tenant-scoped listing (e.g. "this workspace's invoices, newest first")
  // is the primary access pattern.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_workspace_invoices_workspace
      ON coexistence.workspace_invoices (workspace_id, created_at DESC)
  `);

  // Status-filtered lookups (e.g. "all overdue invoices") scoped per tenant.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_workspace_invoices_workspace_status
      ON coexistence.workspace_invoices (workspace_id, status)
  `);

  // Due-date lookups (e.g. dunning/reminder scans) benefit from an index
  // independent of workspace_id.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_workspace_invoices_due_date
      ON coexistence.workspace_invoices (due_date)
  `);
}

module.exports = {
  ensureInvoicesTable,
};