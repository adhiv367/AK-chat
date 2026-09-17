// Phase 5B — Billing service.
//
// Provider-abstracted on purpose (5B-4): no billing provider existed in the
// codebase before this (confirmed by the Phase 5B audit), so nothing is
// hardcoded to Stripe/Razorpay/etc. BILLING_PROVIDER selects the active
// provider; only the 'manual' provider is implemented out of the box
// (checkout returns a message telling the OWNER billing is not yet
// configured, rather than a fake success). Wiring a real provider means
// adding one more entry to PROVIDERS below plus its webhook event mapper —
// no other file in this service, or any call site, needs to change.

const pool = require('../db');
const { getPlanByKey, getTrialDurationDays } = require('../db/plansSchema');

const ACTIVE_PROVIDER = process.env.BILLING_PROVIDER || 'manual';

// ── Provider interface ──────────────────────────────────────────────────
// Each provider must implement:
//   createCheckoutSession({ workspace, plan, user }) -> { url } | { message }
//   mapWebhookEvent(parsedBody) -> { type, providerEventId, providerCustomerId,
//                                    providerSubscriptionId, planKey, status,
//                                    currentPeriodEnd }
const PROVIDERS = {
  // No real payment processor is wired up. This keeps the foundation usable
  // and testable (checkout endpoint exists, returns a clear "not
  // configured" message) without ever pretending a payment happened.
  manual: {
    async createCheckoutSession({ workspace, plan }) {
      return {
        configured: false,
        message: `Billing provider is not yet configured. To enable ${plan.name}, an administrator must set BILLING_PROVIDER and its credentials.`,
      };
    },
    mapWebhookEvent() {
      throw new Error('manual provider does not receive webhooks');
    },
  },
};

function getProvider() {
  return PROVIDERS[ACTIVE_PROVIDER] || PROVIDERS.manual;
}

async function getBillingRow(workspaceId) {
  const { rows } = await pool.query(
    `SELECT wb.*, p.key AS plan_key, p.name AS plan_name, p.limits
       FROM coexistence.workspace_billing wb
       JOIN coexistence.plans p ON p.id = wb.plan_id
      WHERE wb.workspace_id = $1`,
    [workspaceId]
  );
  return rows[0] || null;
}

async function listPublicPlans() {
  const { rows } = await pool.query(
    `SELECT key, name, limits FROM coexistence.plans WHERE is_public = true ORDER BY id ASC`
  );
  return rows;
}

// Checkout initiation foundation (5B-4). Never trusts a client-supplied
// workspace_id — the route resolves `workspace` server-side via
// requireWorkspaceRole('OWNER') + loadMembership before calling this.
async function startCheckout({ workspace, planKey, user }) {
  const plan = await getPlanByKey(planKey);
  if (!plan || !plan.is_public) {
    const err = new Error('Unknown or non-purchasable plan');
    err.status = 400;
    throw err;
  }
  const provider = getProvider();
  const result = await provider.createCheckoutSession({ workspace, plan, user });
  return { provider: ACTIVE_PROVIDER, plan: { key: plan.key, name: plan.name }, ...result };
}

// Cancellation: marks cancel_at_period_end rather than deleting the
// workspace_billing row or any workspace data (5B-6 — "a failed payment
// must not cause data loss", and cancellation must not either). Actual
// status transition to 'cancelled' happens via the webhook when the
// provider confirms the period has ended, same as any real billing
// provider's own semantics.
async function requestCancellation(workspaceId) {
  const { rows } = await pool.query(
    `UPDATE coexistence.workspace_billing
        SET cancel_at_period_end = true, updated_at = NOW()
      WHERE workspace_id = $1
      RETURNING *`,
    [workspaceId]
  );
  if (rows.length === 0) {
    const err = new Error('No billing record found for this workspace');
    err.status = 404;
    throw err;
  }
  return rows[0];
}

// Phase 8B-2: 'trialing' added — webhook events may report a subscription
// as trialing (e.g. provider-side trial), and applyBillingEvent() must
// accept it like any other known status. See entitlementService.js for how
// 'trialing' is treated for feature/resource access (same as 'active').
const VALID_STATUSES = new Set(['active', 'past_due', 'suspended', 'cancelled', 'trialing']);

// Applies a verified billing event to workspace_billing. Idempotent: the
// caller (routes/billing.js webhook handler) inserts into
// coexistence.billing_events with a UNIQUE(provider, provider_event_id)
// constraint FIRST, inside the same transaction, and skips calling this at
// all if that insert hits a conflict — see routes/billing.js.
async function applyBillingEvent(client, { workspaceId, planKey, status, providerCustomerId, providerSubscriptionId, currentPeriodEnd }) {
  if (status && !VALID_STATUSES.has(status)) {
    throw new Error(`Invalid billing status from webhook: ${status}`);
  }
  const setParts = ['updated_at = NOW()'];
  const params = [];
  let i = 1;

  if (planKey) {
    const plan = await getPlanByKey(planKey);
    if (!plan) throw new Error(`Unknown plan key from webhook: ${planKey}`);
    setParts.push(`plan_id = $${i++}`); params.push(plan.id);
  }
  if (status) { setParts.push(`status = $${i++}`); params.push(status); }
  if (providerCustomerId) { setParts.push(`provider_customer_id = $${i++}`); params.push(providerCustomerId); }
  if (providerSubscriptionId) { setParts.push(`provider_subscription_id = $${i++}`); params.push(providerSubscriptionId); }
  if (currentPeriodEnd) { setParts.push(`current_period_end = $${i++}`); params.push(currentPeriodEnd); }
  if (status === 'active' || status === 'trialing') { setParts.push(`cancel_at_period_end = false`); }

  setParts.push(`billing_provider = $${i++}`); params.push(ACTIVE_PROVIDER);
  params.push(workspaceId);

  const { rows } = await client.query(
    `UPDATE coexistence.workspace_billing SET ${setParts.join(', ')}
      WHERE workspace_id = $${i}
      RETURNING *`,
    params
  );
  return rows[0] || null;
}

// ── Phase 5C — Manual Billing / Zero Payment Gateway ─────────────────────
//
// No payment gateway is involved anywhere below. This is a request/approve
// workflow only: an OWNER submits a request (requestPlanChange), it sits
// pending, and a platform administrator manually applies the plan
// (adminSetPlan). Both reuse applyPlanToWorkspace() for the actual plan
// mutation so there is exactly one place that writes plan_id onto
// workspace_billing — same "single source of truth" principle the
// checkout/webhook path already follows via applyBillingEvent().

// Writes the new plan onto workspace_billing. Shared by adminSetPlan() so
// the manual path and any future payment-provider path never diverge on
// how a plan change is actually persisted.
async function applyPlanToWorkspace(client, workspaceId, planId) {
  const { rows } = await client.query(
    `UPDATE coexistence.workspace_billing
        SET plan_id = $1, status = 'active', updated_at = NOW()
      WHERE workspace_id = $2
      RETURNING *`,
    [planId, workspaceId]
  );
  return rows[0] || null;
}

// OWNER-only (enforced by the route) request for a plan change. Rejects a
// second pending request for the same workspace — the partial unique index
// on plan_change_requests(workspace_id) WHERE status='pending' is the hard
// backstop; this check gives a clean 409 instead of a raw constraint error.
async function requestPlanChange(workspaceId, planKey, user) {
  const plan = await getPlanByKey(planKey);
  if (!plan || !plan.is_public) {
    const err = new Error('Unknown or non-purchasable plan');
    err.status = 400;
    throw err;
  }

  const { rows: existing } = await pool.query(
    `SELECT id FROM coexistence.plan_change_requests
      WHERE workspace_id = $1 AND status = 'pending'`,
    [workspaceId]
  );
  if (existing.length > 0) {
    const err = new Error('A plan change request is already pending for this workspace');
    err.status = 409;
    throw err;
  }

  const { rows } = await pool.query(
    `INSERT INTO coexistence.plan_change_requests (workspace_id, requested_plan_id, requested_by, status)
     VALUES ($1, $2, $3, 'pending')
     RETURNING *`,
    [workspaceId, plan.id, user?.id || null]
  );
  return { ...rows[0], requested_plan_key: plan.key, requested_plan_name: plan.name };
}

// History for the BillingTab / admin UI, newest first.
async function listPlanChangeRequests(workspaceId) {
  const { rows } = await pool.query(
    `SELECT r.*, p.key AS requested_plan_key, p.name AS requested_plan_name
       FROM coexistence.plan_change_requests r
       JOIN coexistence.plans p ON p.id = r.requested_plan_id
      WHERE r.workspace_id = $1
      ORDER BY r.created_at DESC`,
    [workspaceId]
  );
  return rows;
}
// Platform-administrator manual plan set. Caller (route) has already
// verified global isAdmin(adminUser) and that the admin is a member of the
// target workspace. `downgradeGuard` is entitlementService's
// getUsageExceedingPlanLimits(workspaceId, targetLimits) — passed in by the
// caller rather than required() here to avoid a circular require between
// billingService and entitlementService.
//
// Transactional: validation happens before any write, and if a downgrade is
// unsafe nothing is written — no partial update to workspace_billing or
// plan_change_requests (per Phase 5C "database safety").
async function adminSetPlan(workspaceId, planKey, adminUser, { checkUsageExceedsLimits } = {}) {
  const plan = await getPlanByKey(planKey);
  if (!plan) {
    const err = new Error('Unknown plan');
    err.status = 400;
    throw err;
  }
  if (typeof checkUsageExceedsLimits === 'function') {
    const exceeding = await checkUsageExceedsLimits(workspaceId, plan.limits || {});
    if (exceeding && exceeding.length > 0) {
      const err = new Error(
        `Cannot switch to ${plan.name} because current usage exceeds the plan limits (${exceeding.map(e => e.limitType).join(', ')}).`
      );
      err.status = 409;
      err.exceeding = exceeding;
      throw err;
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const updated = await applyPlanToWorkspace(client, workspaceId, plan.id);
    if (!updated) {
      const err = new Error('No billing record found for this workspace');
      err.status = 404;
      throw err;
    }

    // Resolve the workspace's pending request, if any — this admin action
    // is treated as its approval even if the admin picked the plan directly
    // rather than clicking "approve" on a specific request row.
    await client.query(
      `UPDATE coexistence.plan_change_requests
          SET status = 'approved', resolved_at = NOW(), resolved_by = $1
        WHERE workspace_id = $2 AND status = 'pending'`,
      [adminUser?.id || null, workspaceId]
    );

    await client.query('COMMIT');
    return { ...updated, plan_key: plan.key, plan_name: plan.name };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
// ── Phase 8B-6 — Platform-admin trial controls ────────────────────────────
//
// Reuses the exact workspace_billing.status/trial_started_at/trial_ends_at
// fields from 8B-1..8B-5 — no new columns, no new tables. Caller (route)
// has already verified isPlatformAdmin(adminUser); this function performs
// no authorization itself, same division of responsibility as adminSetPlan.
// No payment gateway, no plan/pricing change: 'start'/'restart' only touch
// status + the two trial timestamp columns and leave plan_id untouched;
// 'end' mirrors entitlementService.expireTrialIfNeeded's own convention
// (trialing -> 'suspended') so a manually-ended trial looks identical, to
// every other part of the app, to one that expired naturally.
async function adminStartOrRestartTrial(workspaceId, { durationDays } = {}) {
  const days = Number.isFinite(durationDays) && durationDays > 0 ? durationDays : getTrialDurationDays();
  const { rows } = await pool.query(
    `UPDATE coexistence.workspace_billing
        SET status = 'trialing',
            trial_started_at = NOW(),
            trial_ends_at = NOW() + ($2 || ' days')::interval,
            updated_at = NOW()
      WHERE workspace_id = $1
      RETURNING *`,
    [workspaceId, String(days)]
  );
  if (rows.length === 0) {
    const err = new Error('No billing record found for this workspace');
    err.status = 404;
    throw err;
  }
  return rows[0];
}
// Workspace-scoped, status-guarded exactly like expireTrialIfNeeded — a
// workspace that is not currently 'trialing' is left untouched (409, not a
// silent no-op) rather than letting an admin accidentally flip an
// active/paid workspace to 'suspended'.
async function adminEndTrial(workspaceId) {
  const { rows } = await pool.query(
    `UPDATE coexistence.workspace_billing
        SET status = 'suspended',
            trial_ends_at = NOW(),
            updated_at = NOW()
      WHERE workspace_id = $1 AND status = 'trialing'
      RETURNING *`,
    [workspaceId]
  );
  if (rows.length === 0) {
    const err = new Error('Workspace is not currently on a trial');
    err.status = 409;
    throw err;
  }
  return rows[0];
}
module.exports = {
  ACTIVE_PROVIDER,
  adminStartOrRestartTrial,
  adminEndTrial,
  getProvider,
  getBillingRow,
  listPublicPlans,
  startCheckout,
  requestCancellation,
  applyBillingEvent,
  VALID_STATUSES,
  requestPlanChange,
  listPlanChangeRequests,
  adminSetPlan,
};