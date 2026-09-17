// Phase 8A — Message Usage Metering service.
//
// The ONE place that knows how to record and read "how many WhatsApp
// messages has this workspace successfully sent this month". Deliberately
// separate from entitlementService.js (which decides "is this allowed") —
// this module only counts; entitlementService registers
// countMessagesThisMonth as its MESSAGE_QUOTA usage counter (see
// entitlementService.js's USAGE_COUNTERS map) exactly the same way it
// already does for countActiveSeats/countWhatsappAccounts/countContacts.
//
// Counting contract (see queue/sendQueue.js's single call site):
//   - incrementMessageUsage() is called ONLY after messageSender.js's
//     markSent() reports it actually updated a chat_history row (i.e. Meta
//     confirmed the send). Never called on enqueue, never on failure, never
//     on a retry attempt that didn't reach that transition.
//   - Bucketed by UTC calendar month (see messageUsageSchema.js for why —
//     not workspace_billing.current_period_end).
//   - Atomic per-workspace-per-month increment via INSERT ... ON CONFLICT
//     DO UPDATE, safe under concurrent BullMQ workers incrementing the same
//     workspace's row at once.

const pool = require('../db');

// First day of the current UTC calendar month, as a YYYY-MM-DD string —
// matches Postgres DATE semantics exactly (no time-of-day component), so
// this can be passed straight in as a bound param rather than relying on
// server-side date_trunc(), keeping the "current period" computation in
// one place regardless of caller.
function currentUtcPeriodStart() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}-01`;
}

// Atomically increments this workspace's message count for the current UTC
// calendar month, creating the row on first use. Never throws into the
// caller's send path — a usage-metering failure must never affect message
// delivery (mirrors the "audit logging must never break the calling
// request" contract in middleware/access.js's auditLog()). Returns the new
// count on success, or null if the increment failed (logged, swallowed).
async function incrementMessageUsage(workspaceId) {
  if (!workspaceId) return null;
  try {
    const periodStart = currentUtcPeriodStart();
    const { rows } = await pool.query(
      `INSERT INTO coexistence.workspace_message_usage (workspace_id, period_start, message_count)
       VALUES ($1, $2, 1)
       ON CONFLICT (workspace_id, period_start)
         DO UPDATE SET message_count = coexistence.workspace_message_usage.message_count + 1,
                        updated_at = NOW()
       RETURNING message_count`,
      [workspaceId, periodStart]
    );
    return rows[0]?.message_count != null ? Number(rows[0].message_count) : null;
  } catch (err) {
    console.error('[messageUsageService] incrementMessageUsage failed:', err.message);
    return null;
  }
}

// Reads this workspace's message count for the current UTC calendar month.
// Returns 0 if no row exists yet (workspace hasn't sent anything this
// month) — never null/undefined, so callers (e.g. a future USAGE_COUNTERS
// entry) can treat it exactly like the other counters in
// entitlementService.js, which all return a plain number.
async function countMessagesThisMonth(workspaceId) {
  if (!workspaceId) return 0;
  const periodStart = currentUtcPeriodStart();
  const { rows } = await pool.query(
    `SELECT message_count FROM coexistence.workspace_message_usage
      WHERE workspace_id = $1 AND period_start = $2`,
    [workspaceId, periodStart]
  );
  return rows[0]?.message_count != null ? Number(rows[0].message_count) : 0;
}

module.exports = {
  incrementMessageUsage,
  countMessagesThisMonth,
  currentUtcPeriodStart,
};