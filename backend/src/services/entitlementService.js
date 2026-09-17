// Phase 5B — Entitlement Service.
//
// The ONE place that knows how to answer "is this workspace allowed to do
// X". Every creation path (invitations, workspace members, WhatsApp
// accounts, embedded signup, contact import) calls checkLimit() here instead
// of re-implementing its own counting/limit logic.
//
// Fail-closed contract: if anything in this module throws or the workspace
// has no resolvable plan/billing row, checkLimit() returns { allowed: false,
// reason: 'entitlement_lookup_failed' } — it NEVER falls back to "allow".
//
// A suspended/cancelled workspace is blocked from all NEW creation
// regardless of numeric usage (still under its seat/account/contact count)
// — see STATUS_BLOCKS_NEW_USAGE below. past_due is deliberately NOT in that
// set: a past-due workspace keeps working (per 5B-6, "a failed payment must
// not cause data loss" — and cutting off usage entirely, before rules for a
// dunning grace period exist, is a stronger penalty than Phase 5B asks for).
// Existing data is never deleted or hidden in any status.

const pool = require('../db');
// Phase 8A — registers the message-usage counter (see messageUsageService.js
// for the increment/read implementation and its counting contract). This
// is a pure USAGE_COUNTERS registration — checkLimit()'s behavior/logic is
// unchanged; MESSAGE_QUOTA simply goes from "no counter wired up" (always
// treated as unlimited/unchecked) to "has a real counter", the same way
// SEATS/WHATSAPP_ACCOUNTS/CONTACTS already work. Nothing in this phase
// calls checkLimit('monthly_message_quota', ...) from any send path —
// message sending is not enforced/blocked by this change.
const { countMessagesThisMonth } = require('./messageUsageService');

const LIMIT_TYPES = {
  SEATS: 'max_seats',
  WHATSAPP_ACCOUNTS: 'max_whatsapp_accounts',
  CONTACTS: 'max_contacts',
  MESSAGE_QUOTA: 'monthly_message_quota',
};

// Statuses in which NEW resource creation is blocked outright, independent
// of numeric limits. Existing data/read access is never affected by this
// module — it only gates creation-path calls that opt in to checkLimit().
//
// Phase 8B-2: 'trialing' is deliberately NOT in this set, so a trialing
// workspace is checked against its plan's numeric limits exactly like an
// 'active' workspace — full normal feature/resource access, no special
// casing needed anywhere else in this module.
const STATUS_BLOCKS_NEW_USAGE = new Set(['suspended', 'cancelled']);

// Phase 8B-3: trial expiry is checked lazily, right here, rather than via a
// background worker — every caller of getWorkspaceEntitlements() (i.e.
// every checkLimit() call) already reads status fresh, so this is the one
// place a stale 'trialing' row can be caught and corrected before it's
// used for an access decision.
//
// Loads the workspace's plan + billing state in one query. Returns null if
// no row exists (should not happen for any workspace created after this
// migration — see plansSchema.ensureBillingRowForNewWorkspace — but treated
// as a hard "deny" by checkLimit, never "allow", if it does).
async function getWorkspaceEntitlements(workspaceId) {
  if (!workspaceId) return null;
  const { rows } = await pool.query(
    `SELECT wb.status, wb.plan_id, wb.current_period_end, wb.cancel_at_period_end,
            wb.trial_ends_at,
            p.key AS plan_key, p.name AS plan_name, p.limits
       FROM coexistence.workspace_billing wb
       JOIN coexistence.plans p ON p.id = wb.plan_id
      WHERE wb.workspace_id = $1`,
    [workspaceId]
  );
  const row = rows[0];
  if (!row) return null;

  let status = row.status;
  if (status === 'trialing' && row.trial_ends_at && new Date(row.trial_ends_at) <= new Date()) {
    status = await expireTrialIfNeeded(workspaceId);
  }

  // Phase 8E-2: lazy manual-cancellation finalization, same pattern as trial
  // expiry above — checked here (not a background worker) so any read of
  // entitlements catches a workspace whose requested cancellation period has
  // elapsed. Only applies if the trial-expiry branch above did NOT already
  // move status away from 'trialing' this call (checked against the
  // possibly-updated `status`, not the stale `row.status`).
  if (
    (status === 'active' || status === 'trialing') &&
    row.cancel_at_period_end &&
    row.current_period_end &&
    new Date(row.current_period_end) <= new Date()
  ) {
    status = await finalizeCancellationIfNeeded(workspaceId);
  }

  return {
    status,
    planKey: row.plan_key,
    planName: row.plan_name,
    limits: row.limits || {},
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end,
  };
}

// Phase 8B-3: moves a single workspace's expired trial to 'suspended'.
// Workspace-scoped (WHERE workspace_id = $1 AND status = 'trialing') so it
// can never touch another workspace's row, and the status guard makes a
// concurrent double-call a harmless no-op (second call just updates 0
// rows). Returns the resulting status to use for THIS call, regardless of
// whether the UPDATE actually ran (e.g. it lost a race to another request
// that already flipped it — either way the correct status to hand back is
// 'suspended').
async function expireTrialIfNeeded(workspaceId) {
  await pool.query(
    `UPDATE coexistence.workspace_billing
        SET status = 'suspended', updated_at = NOW()
      WHERE workspace_id = $1 AND status = 'trialing'`,
    [workspaceId]
  );
  return 'suspended';
}

// Phase 8E-2: moves a workspace's requested-but-not-yet-finalized
// cancellation to 'cancelled' once its current billing period has actually
// ended. Provider-agnostic — reuses only existing workspace_billing fields
// (cancel_at_period_end, current_period_end, status), no new columns.
//
// The WHERE clause is the sole source of truth (not the caller's cached
// `row`), so this is concurrency-safe/idempotent the same way
// expireTrialIfNeeded is: a second concurrent/duplicate call simply matches
// zero rows (status is no longer 'active'/'trialing') and is a harmless
// no-op. Workspace-scoped by workspace_id in the WHERE clause, so it can
// never touch another workspace's row. Deliberately does not touch
// suspended/cancelled/past_due rows — those are left exactly as-is.
async function finalizeCancellationIfNeeded(workspaceId) {
  await pool.query(
    `UPDATE coexistence.workspace_billing
        SET status = 'cancelled', updated_at = NOW()
      WHERE workspace_id = $1
        AND status IN ('active', 'trialing')
        AND cancel_at_period_end = true
        AND current_period_end IS NOT NULL
        AND current_period_end <= NOW()`,
    [workspaceId]
  );
  return 'cancelled';
}

async function countActiveSeats(workspaceId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM coexistence.workspace_members
      WHERE workspace_id = $1 AND status IN ('active', 'pending')`,
    [workspaceId]
  );
  return rows[0].n;
}

async function countWhatsappAccounts(workspaceId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM coexistence.whatsapp_accounts WHERE workspace_id = $1`,
    [workspaceId]
  );
  return rows[0].n;
}

async function countContacts(workspaceId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM coexistence.contacts WHERE workspace_id = $1`,
    [workspaceId]
  );
  return rows[0].n;
}

const USAGE_COUNTERS = {
  [LIMIT_TYPES.SEATS]: countActiveSeats,
  [LIMIT_TYPES.WHATSAPP_ACCOUNTS]: countWhatsappAccounts,
  [LIMIT_TYPES.CONTACTS]: countContacts,
  // Phase 8A — metering only (see messageUsageService.js). checkLimit()
  // will correctly evaluate monthly_message_quota if a caller ever asks,
  // but no caller does yet — no send path has been wired to call
  // checkLimit(LIMIT_TYPES.MESSAGE_QUOTA, ...) in this phase.
  [LIMIT_TYPES.MESSAGE_QUOTA]: countMessagesThisMonth,
};

// checkLimit(workspaceId, limitType, requestedIncrement = 1)
//   -> { allowed, limitType, current, max, planKey, status, reason? }
//
// `max === null` means unlimited for that dimension (legacy_unlimited plan,
// or a plan explicitly configured with no cap). requestedIncrement lets a
// bulk operation (e.g. contact import of N rows) ask "can I add N more" in
// one call rather than N sequential calls.
async function checkLimit(workspaceId, limitType, requestedIncrement = 1) {
  try {
    if (!workspaceId) {
      return { allowed: false, limitType, reason: 'no_workspace' };
    }
    const ent = await getWorkspaceEntitlements(workspaceId);
    if (!ent) {
      // Fail closed: no billing row is an entitlement-lookup failure, not
      // an "unlimited" default.
      return { allowed: false, limitType, reason: 'entitlement_lookup_failed' };
    }
    if (STATUS_BLOCKS_NEW_USAGE.has(ent.status)) {
      return {
        allowed: false, limitType, reason: 'billing_status_blocked',
        status: ent.status, planKey: ent.planKey,
      };
    }

    const max = ent.limits ? ent.limits[limitType] : undefined;
    if (max === null || max === undefined && !(limitType in (ent.limits || {}))) {
      // null explicitly, OR the key is simply absent from this plan's limits
      // object (treated as "no cap configured for this dimension" — a plan
      // author must add a numeric cap to actually restrict it; absence is
      // not an error condition worth failing closed over, since it's a
      // deliberate plan-authoring choice, not a lookup failure).
      return { allowed: true, limitType, current: null, max: null, planKey: ent.planKey, status: ent.status };
    }

    const counter = USAGE_COUNTERS[limitType];
    if (!counter) {
      // Unknown limit type wired up wrong by a caller — fail closed rather
      // than silently allow.
      return { allowed: false, limitType, reason: 'unknown_limit_type' };
    }
    const current = await counter(workspaceId);
    const allowed = (current + requestedIncrement) <= max;
    return { allowed, limitType, current, max, planKey: ent.planKey, status: ent.status };
  } catch (err) {
    console.error(`[entitlementService] checkLimit(${limitType}) failed:`, err.message);
    return { allowed: false, limitType, reason: 'entitlement_lookup_failed' };
  }
}

// Convenience for routes: turns a failed checkLimit() result into the
// structured 403 body the frontend expects (see Phase 5B section 4).
function limitExceededResponse(result) {
  return {
    error: 'limit_reached',
    limitType: result.limitType,
    current: result.current ?? null,
    max: result.max ?? null,
    planKey: result.planKey || null,
    status: result.status || null,
    reason: result.reason || 'limit_exceeded',
    message: result.reason === 'billing_status_blocked'
      ? `Your workspace's billing is ${result.status}. Upgrade or contact billing to continue.`
      : `You've reached your plan's limit for ${humanizeLimitType(result.limitType)}. Upgrade your plan to continue.`,
  };
}

function humanizeLimitType(limitType) {
  switch (limitType) {
    case LIMIT_TYPES.SEATS: return 'workspace seats';
    case LIMIT_TYPES.WHATSAPP_ACCOUNTS: return 'connected WhatsApp accounts';
    case LIMIT_TYPES.CONTACTS: return 'contacts';
    case LIMIT_TYPES.MESSAGE_QUOTA: return 'monthly messages';
    default: return limitType;
  }
}

// Phase 5C — downgrade guard. Given a workspace and a *target* plan's
// limits object (e.g. the plan being requested/set, not the current one),
// returns the list of dimensions where current usage already exceeds the
// target's cap. Empty array means the downgrade/switch is safe.
//
// Reuses USAGE_COUNTERS (the same counters checkLimit() uses) rather than
// re-implementing counting — SEATS/WHATSAPP_ACCOUNTS/CONTACTS only;
// MESSAGE_QUOTA has no counter wired up (it is not enforced on creation
// paths today) so it is skipped here too, consistent with checkLimit().
async function getUsageExceedingPlanLimits(workspaceId, targetLimits) {
  const exceeding = [];
  if (!workspaceId || !targetLimits) return exceeding;

  for (const limitType of Object.keys(USAGE_COUNTERS)) {
    const max = targetLimits[limitType];
    if (max === null || max === undefined) continue; // unlimited / uncapped on the target plan
    const counter = USAGE_COUNTERS[limitType];
    const current = await counter(workspaceId);
    if (current > max) {
      exceeding.push({ limitType, current, max });
    }
  }
  return exceeding;
}

// Phase 8F-2 — Plan-gated feature entitlements (FOUNDATION ONLY).
//
// No new table/column: a plan's boolean feature flags live inside the
// existing `limits` JSONB, under a `features` sub-object, e.g.
//   plans.limits = { max_seats: 5, ..., features: { sample_feature_a: true } }
// This keeps everything readable through the same getWorkspaceEntitlements()
// call checkLimit() already uses, workspace/plan-scoped by construction
// (there is exactly one billing row per workspace, joined to exactly one
// plan row).
//
// Deliberately NOT touched by this phase: no production feature is gated
// (req #9), no commercial feature/pricing mapping is decided (req #7) — the
// BUILTIN_PLANS seed data in plansSchema.js is left as-is. FEATURE_KEYS
// below is only a small neutral set to prove the mechanism.
const FEATURE_KEYS = {
  SAMPLE_FEATURE_A: 'sample_feature_a',
  SAMPLE_FEATURE_B: 'sample_feature_b',
  // Phase 8F-6: first real feature-gate pilot, covering Sequence Studio
  // routes (routes/sequences.js). No BUILTIN_PLANS entry grants this yet
  // (deliberately — plan mapping is a separate, later decision), so Sequence
  // Studio is blocked by default until a plan explicitly sets
  // limits.features.sequence_studio = true.
  SEQUENCE_STUDIO: 'sequence_studio',
};

// hasFeature(workspaceId, featureKey) -> Promise<boolean>
//
// Fail-closed, same contract as checkLimit(): a missing workspace, a
// workspace with no resolvable billing/plan row, an unknown/unset feature
// key, or any thrown error all resolve to `false` — never `true` by
// default. A feature is enabled only if the workspace's *current* plan
// explicitly sets `limits.features[featureKey] === true`.
async function hasFeature(workspaceId, featureKey) {
  try {
    if (!workspaceId || !featureKey) return false;
    const ent = await getWorkspaceEntitlements(workspaceId);
    if (!ent) return false;
    const features = (ent.limits && ent.limits.features) || {};
    return features[featureKey] === true;
  } catch (err) {
    console.error(`[entitlementService] hasFeature(${featureKey}) failed:`, err.message);
    return false;
  }
}
module.exports = {
  LIMIT_TYPES,
  FEATURE_KEYS,
  getWorkspaceEntitlements,
  checkLimit,
  hasFeature,
  limitExceededResponse,
  countActiveSeats,
  countWhatsappAccounts,
  countContacts,
  getUsageExceedingPlanLimits,
  expireTrialIfNeeded,
  finalizeCancellationIfNeeded,
  // Phase 8A — exported (additive only) so tests can assert the
  // MESSAGE_QUOTA counter is correctly registered without needing to mock
  // the DB pool to exercise checkLimit()/getUsageExceedingPlanLimits()
  // end-to-end. Not used by any behavioral change to checkLimit() itself.
  USAGE_COUNTERS,
};