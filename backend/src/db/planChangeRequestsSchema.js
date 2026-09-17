// Phase 5C — Manual Billing / Zero Payment Gateway.
//
// Adds coexistence.plan_change_requests: an append-history table of
// OWNER-submitted plan-change requests and their eventual admin resolution.
// Mirrors the idempotent `CREATE TABLE IF NOT EXISTS` pattern used by
// plansSchema.ensurePlansTables() — this file *is* the migration, called
// once on server startup (see src/index.js, next to ensurePlansTables()).
//
// This table never itself changes coexistence.workspace_billing.plan_id —
// it only records the request. The actual plan change happens through
// billingService.adminSetPlan(), which additionally resolves the relevant
// pending row here. No payment gateway involved anywhere in this file.

const pool = require('../db');

async function ensurePlanChangeRequestsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.plan_change_requests (
      id                BIGSERIAL PRIMARY KEY,
      workspace_id      BIGINT NOT NULL REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,
      requested_plan_id BIGINT NOT NULL REFERENCES coexistence.plans(id),
      requested_by      BIGINT REFERENCES coexistence.akchat_users(id) ON DELETE SET NULL,
      status            TEXT NOT NULL DEFAULT 'pending',
      note              TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at       TIMESTAMPTZ,
      resolved_by       BIGINT REFERENCES coexistence.akchat_users(id) ON DELETE SET NULL,
      CONSTRAINT plan_change_requests_status_check
        CHECK (status IN ('pending', 'approved', 'rejected'))
    )
  `);
  // Fast lookups for "does this workspace already have a pending request"
  // and for the history listing (newest first) used by GET .../plan-requests.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_plan_change_requests_workspace
      ON coexistence.plan_change_requests (workspace_id, created_at DESC)
  `);
  // Enforce at most one pending request per workspace at the DB level, not
  // just in application code — a partial index so approved/rejected history
  // rows are unaffected.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_change_requests_one_pending
      ON coexistence.plan_change_requests (workspace_id)
      WHERE status = 'pending'
  `);
}
module.exports = {
  ensurePlanChangeRequestsTable,
};