// Phase 8A — Message Usage Metering.
//
// Adds coexistence.workspace_message_usage: one row per workspace per UTC
// calendar month, holding a running count of successfully-sent outbound
// WhatsApp messages. Mirrors the existing idempotent `CREATE TABLE IF NOT
// EXISTS` pattern used by plansSchema.ensurePlansTables() /
// planChangeRequestsSchema.ensurePlanChangeRequestsTable() — this file *is*
// the migration, called once on server startup (see src/index.js).
//
// This is a pure usage COUNTER, not an audit log — it does not enforce
// monthly_message_quota (see entitlementService.js's checkLimit, which is
// NOT wired to this counter as of Phase 8A) and does not touch
// coexistence.chat_history, workspace_billing, or plans. The counter is
// incremented exactly once per successfully-sent message by
// messageUsageService.incrementMessageUsage(), called only from
// queue/sendQueue.js's single markSent() call site, only when markSent()
// reports it actually updated a row (see messageSender.js).
//
// Calendar-month bucketing (UTC), NOT workspace_billing.current_period_end:
// current_period_end is only ever populated by a real payment-provider
// webhook (applyBillingEvent in billingService.js) and is NULL for every
// workspace today (manual billing, no provider configured) — tying usage
// periods to it would mean the counter never resets for any current
// customer. A simple UTC calendar-month bucket needs no coordination with
// billing-cycle dates and can be revisited later if/when a real provider
// is added.
const pool = require('../db');
async function ensureMessageUsageTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.workspace_message_usage (
      id             BIGSERIAL PRIMARY KEY,
      workspace_id   BIGINT NOT NULL REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,
      period_start   DATE NOT NULL,
      message_count  BIGINT NOT NULL DEFAULT 0,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (workspace_id, period_start)
    )
  `);
  // Fast lookup for "this workspace's usage this month" (countMessagesThisMonth)
  // and for the atomic per-send increment (incrementMessageUsage), both of
  // which filter on workspace_id + period_start — the same pair the UNIQUE
  // constraint above already indexes, but an explicit index name documents
  // the intent and survives if the UNIQUE constraint implementation ever
  // changes.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_workspace_message_usage_workspace_period
      ON coexistence.workspace_message_usage (workspace_id, period_start)
  `);
}
module.exports = {
  ensureMessageUsageTable,
};