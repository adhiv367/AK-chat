// Phase 5B — Billing routes.
//
//   GET  /workspaces/:id/billing            — current plan/status/usage.
//                                              OWNER or ADMIN may read.
//   POST /workspaces/:id/billing/checkout   — start a plan upgrade/change.
//                                              OWNER ONLY (5B-5/5B-6).
//   POST /workspaces/:id/billing/cancel     — request cancellation.
//                                              OWNER ONLY.
//   POST /billing/webhook                   — public, signature-verified,
//                                              idempotent billing-provider
//                                              webhook.
//
// Every :id-based route resolves membership via loadMembership (copied
// pattern from routes/workspace.js — never trusts workspace_id from the
// client without re-checking req.membership) then gates the mutating routes
// with requireWorkspaceRole('OWNER'), NOT requireWorkspaceRole('ADMIN').
// This is intentionally stricter than the ADMIN-level gates elsewhere in
// workspace.js — ADMIN must never receive billing-management permission
// (5B-5), so this file does not reuse workspace.js's loadMembership export
// indirectly through ADMIN-level helpers; it re-resolves membership itself
// and checks the role explicitly.

const { Router } = require('express');
const pool = require('../db');
const { getMembership, getActiveWorkspaceById } = require('../middleware/workspaceContext');
const { requireWorkspaceRole, auditLog } = require('../middleware/access');
const { isPlatformAdmin } = require('../permissions');
const { getWorkspaceEntitlements, countActiveSeats, countWhatsappAccounts, countContacts, getUsageExceedingPlanLimits } = require('../services/entitlementService');
const { getBillingRow, listPublicPlans, startCheckout, requestCancellation, applyBillingEvent, getProvider, ACTIVE_PROVIDER, requestPlanChange, listPlanChangeRequests, adminSetPlan, adminStartOrRestartTrial, adminEndTrial } = require('../services/billingService');
const { countMessagesThisMonth } = require('../services/messageUsageService');
const { verifyBillingSignature } = require('../util/billingWebhookSignature');

const router = Router();          // authenticated, workspace-scoped management
const webhookRouter = Router();   // public, provider webhook

// Same 404-not-403 pattern as routes/workspace.js's loadMembership: an
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
    console.error('[billing] membership lookup error:', err.message);
    res.status(500).json({ error: 'Failed to resolve workspace' });
  }
}

// Phase 5C — Platform Admin variant of loadMembership, used ONLY by the two
// routes a platform administrator needs to reach without being a member of
// the target workspace: GET billing (item G) and POST set-plan (item F).
//
// Platform Admin (isPlatformAdmin(req.user) — the global legacy 'admin'
// role, never a workspace-level OWNER/ADMIN): resolves the workspace
// directly via getActiveWorkspaceById (exists + active, no membership
// check) and sets req.membership to a membership-shaped object with the
// synthetic role 'PLATFORM_ADMIN' (see permissions.js ROLE_LEVEL) so the
// existing requireWorkspaceRole(...) gate downstream keeps working
// unmodified. No workspace_members row is read, created, or implied.
//
// Everyone else: falls through to the exact original loadMembership
// behaviour — membership required, 404 if absent.
async function loadMembershipOrPlatformAdmin(req, res, next) {
  try {
    const workspaceId = req.params.id;
    if (isPlatformAdmin(req.user)) {
      const workspace = await getActiveWorkspaceById(workspaceId);
      if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
      req.membership = workspace; // role: 'PLATFORM_ADMIN'
      return next();
    }
    const membership = await getMembership(req.user.id, workspaceId);
    if (!membership) return res.status(404).json({ error: 'Workspace not found' });
    req.membership = membership;
    next();
  } catch (err) {
    console.error('[billing] membership lookup error:', err.message);
    res.status(500).json({ error: 'Failed to resolve workspace' });
  }
}

// ─── GET /workspaces/:id/billing ─────────────────────────────────────────
// Readable by ADMIN+ (operational visibility into plan/usage is fine for
// ADMIN — it's *managing* billing that's OWNER-only) so the admin-settings
// UI can show "you're on the Free plan, 3/5 seats used" without every admin
// needing OWNER.
router.get('/workspaces/:id/billing', loadMembershipOrPlatformAdmin, requireWorkspaceRole('ADMIN'), async (req, res) => {
  try {
    const workspaceId = req.membership.id;
    const [entitlements, billingRow, seats, waAccounts, contacts, messagesUsed, publicPlans] = await Promise.all([
      getWorkspaceEntitlements(workspaceId),
      getBillingRow(workspaceId),
      countActiveSeats(workspaceId),
      countWhatsappAccounts(workspaceId),
      countContacts(workspaceId),
      // Phase 8G-2 — read-only display only. Reuses the existing counter;
      // never used for enforcement (checkLimit()/USAGE_COUNTERS are
      // untouched by this phase).
      countMessagesThisMonth(workspaceId),
      listPublicPlans(),
    ]);

    if (!entitlements || !billingRow) {
      return res.status(500).json({ error: 'No billing record found for this workspace. Please contact support.' });
    }

    // Phase 8G-2 — monthly message quota is whatever the plan's
    // `limits.monthly_message_quota` says (null/absent === unlimited),
    // mirroring how max_seats/max_whatsapp_accounts/max_contacts are
    // already read straight off entitlements.limits elsewhere in this
    // response. Purely derived for display; nothing here can block a send.
    const messageQuota = entitlements.limits ? entitlements.limits.monthly_message_quota : undefined;
    const messagesRemaining = (messageQuota === null || messageQuota === undefined)
      ? null
      : Math.max(messageQuota - messagesUsed, 0);

    res.json({
      plan: { key: entitlements.planKey, name: entitlements.planName, limits: entitlements.limits },
      status: entitlements.status,
      // Phase 8B-5 — trial fields, read-only. Sourced from the same
      // billingRow already fetched above (getBillingRow selects wb.*, which
      // already includes trial_started_at/trial_ends_at as of 8B-1) — no
      // new query, no new service function, no new endpoint.
      trialStartedAt: billingRow.trial_started_at || null,
      trialEndsAt: billingRow.trial_ends_at || null,
      currentPeriodEnd: entitlements.currentPeriodEnd,
      cancelAtPeriodEnd: entitlements.cancelAtPeriodEnd,
      usage: {
        seats, whatsappAccounts: waAccounts, contacts,
        // Phase 8G-2 — read-only WhatsApp message usage this month.
        messages: {
          used: messagesUsed,
          quota: messageQuota === undefined ? null : messageQuota,
          remaining: messagesRemaining,
        },
      },
      canManageBilling: req.membership.role === 'OWNER',
      availablePlans: publicPlans,
      // Phase 5C — manual billing. Platform Admin (isPlatformAdmin(req.user)
      // — the global legacy 'admin' role) can set the plan directly for ANY
      // active workspace, bypassing the request/approve flow, with no
      // membership requirement (see loadMembershipOrPlatformAdmin above).
      // Deliberately isPlatformAdmin(), NOT isAdmin() — isAdmin() also
      // returns true for a workspace-level OWNER/ADMIN, which must NEVER
      // see this control for their own workspace.
      canSetPlanDirectly: isPlatformAdmin(req.user),
    });
  } catch (err) {
    console.error('[billing] get error:', err.message);
    res.status(500).json({ error: 'Failed to load billing information' });
  }
});

// ─── POST /workspaces/:id/billing/checkout ───────────────────────────────
// OWNER ONLY. ADMIN is rejected by requireWorkspaceRole('OWNER') itself
// (ADMIN's roleLevel is below OWNER's — see permissions.js ROLE_LEVEL).
router.post('/workspaces/:id/billing/checkout', loadMembership, requireWorkspaceRole('OWNER'), async (req, res) => {
  const { planKey } = req.body || {};
  if (!planKey) return res.status(400).json({ error: 'planKey is required' });
  try {
    const result = await startCheckout({ workspace: { id: req.membership.id, name: req.membership.name }, planKey, user: req.user });
    await auditLog({ actor: req.user, action: 'billing.checkout_started', targetType: 'workspace', targetId: req.membership.id, payload: { planKey } });
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('[billing] checkout error:', err.message);
    res.status(status).json({ error: err.message || 'Failed to start checkout' });
  }
});

// ─── POST /workspaces/:id/billing/cancel ─────────────────────────────────
// OWNER ONLY.
router.post('/workspaces/:id/billing/cancel', loadMembership, requireWorkspaceRole('OWNER'), async (req, res) => {
  try {
    const row = await requestCancellation(req.membership.id);
    await auditLog({ actor: req.user, action: 'billing.cancel_requested', targetType: 'workspace', targetId: req.membership.id });
    res.json({ ok: true, cancelAtPeriodEnd: row.cancel_at_period_end, currentPeriodEnd: row.current_period_end });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('[billing] cancel error:', err.message);
    res.status(status).json({ error: err.message || 'Failed to request cancellation' });
  }
});

// ─── Phase 5C — Manual Billing / Zero Payment Gateway ────────────────────
// No payment gateway anywhere below. OWNER requests a plan; a platform
// administrator manually approves/sets it. Payment collection happens
// outside the application.

// ─── POST /workspaces/:id/billing/request-plan-change ────────────────────
// OWNER ONLY, same gate as checkout/cancel above.
router.post('/workspaces/:id/billing/request-plan-change', loadMembership, requireWorkspaceRole('OWNER'), async (req, res) => {
  const { planKey } = req.body || {};
  if (!planKey) return res.status(400).json({ error: 'planKey is required' });
  try {
    const request = await requestPlanChange(req.membership.id, planKey, req.user);
    await auditLog({ actor: req.user, action: 'billing.plan_change_requested', targetType: 'workspace', targetId: req.membership.id, payload: { planKey } });
    res.json({
      id: request.id,
      status: request.status,
      requestedPlan: { key: request.requested_plan_key, name: request.requested_plan_name },
      createdAt: request.created_at,
    });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('[billing] request-plan-change error:', err.message);
    res.status(status).json({ error: err.message || 'Failed to submit plan change request' });
  }
});

// ─── GET /workspaces/:id/billing/plan-requests ────────────────────────────
// ADMIN+ readable, same tier as GET .../billing above (operational
// visibility, not management).
router.get('/workspaces/:id/billing/plan-requests', loadMembership, requireWorkspaceRole('ADMIN'), async (req, res) => {
  try {
    const rows = await listPlanChangeRequests(req.membership.id);
    res.json({
      requests: rows.map(r => ({
        id: r.id,
        status: r.status,
        requestedPlan: { key: r.requested_plan_key, name: r.requested_plan_name },
        note: r.note,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at,
        resolvedBy: r.resolved_by,
      })),
    });
  } catch (err) {
    console.error('[billing] plan-requests list error:', err.message);
    res.status(500).json({ error: 'Failed to load plan change requests' });
  }
});

// ─── POST /workspaces/:id/billing/set-plan ────────────────────────────────
// Platform Admin ONLY (isPlatformAdmin(req.user) — the global legacy
// 'admin' role). No membership in the target workspace is required —
// loadMembershipOrPlatformAdmin resolves ANY active workspace directly for
// a platform admin (see comment above) with no fake workspace_members row
// ever created. A normal workspace OWNER/ADMIN reaching this route (they
// necessarily have a real membership, so loadMembershipOrPlatformAdmin
// falls through to the plain membership lookup for them) is rejected by
// the isPlatformAdmin() check below — deliberately NOT isAdmin(), which
// would incorrectly also let a workspace-level OWNER/ADMIN through.
router.post('/workspaces/:id/billing/set-plan', loadMembershipOrPlatformAdmin, async (req, res) => {
  if (!isPlatformAdmin(req.user)) {
    return res.status(403).json({ error: 'Administrator access required' });
  }
  const { planKey } = req.body || {};
  if (!planKey) return res.status(400).json({ error: 'planKey is required' });
  try {
    const result = await adminSetPlan(req.membership.id, planKey, req.user, {
      checkUsageExceedsLimits: getUsageExceedingPlanLimits,
    });
    await auditLog({ actor: req.user, action: 'billing.plan_set_by_admin', targetType: 'workspace', targetId: req.membership.id, payload: { planKey } });
    res.json({ ok: true, plan: { key: result.plan_key, name: result.plan_name } });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('[billing] set-plan error:', err.message);
    res.status(status).json({ error: err.message || 'Failed to set plan', exceeding: err.exceeding || undefined });
  }
});

// ─── POST /workspaces/:id/billing/admin/trial ─────────────────────────────
// Phase 8B-6. Platform Admin ONLY (isPlatformAdmin(req.user) — the global
// legacy 'admin' role), same gate shape as set-plan above: loadMembership-
// OrPlatformAdmin resolves the target workspace (with or without the admin
// being a member), then isPlatformAdmin() is checked explicitly so a
// workspace-level OWNER/ADMIN — who necessarily has a real membership and
// so falls through to the plain membership branch — is rejected with 403,
// never treated as authorized just because they hold a real membership row.
//
// body: { action: 'start' | 'restart' | 'end', durationDays?: number }
// 'start' and 'restart' are the same operation (both (re)set trial_started_at
// to now and recompute trial_ends_at) — an alias, not two code paths, since
// "start a trial for a workspace that already had one" and "restart" are
// the same billing-state transition.
router.post('/workspaces/:id/billing/admin/trial', loadMembershipOrPlatformAdmin, async (req, res) => {
  if (!isPlatformAdmin(req.user)) {
    return res.status(403).json({ error: 'Administrator access required' });
  }
  const { action, durationDays } = req.body || {};
  if (action !== 'start' && action !== 'restart' && action !== 'end') {
    return res.status(400).json({ error: "action must be 'start', 'restart', or 'end'" });
  }
  try {
    const row = action === 'end'
      ? await adminEndTrial(req.membership.id)
      : await adminStartOrRestartTrial(req.membership.id, { durationDays: Number(durationDays) });

    await auditLog({
      actor: req.user,
      action: action === 'end' ? 'billing.admin_trial_ended' : 'billing.admin_trial_started',
      targetType: 'workspace',
      targetId: req.membership.id,
      payload: action === 'end' ? {} : { durationDays: durationDays || null },
    });

    res.json({
      ok: true,
      status: row.status,
      trialStartedAt: row.trial_started_at,
      trialEndsAt: row.trial_ends_at,
    });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('[billing] admin trial error:', err.message);
    res.status(status).json({ error: err.message || 'Failed to update trial' });
  }
});

// ─── POST /billing/webhook ────────────────────────────────────────────────
// Public (no session). Signature MUST verify. Body is whatever the active
// provider sends; provider.mapWebhookEvent() normalizes it. Idempotent via
// the UNIQUE(provider, provider_event_id) constraint on billing_events — a
// redelivered event is caught by the INSERT ... ON CONFLICT DO NOTHING and
// short-circuits before applyBillingEvent ever runs a second time.
webhookRouter.post('/billing/webhook', async (req, res) => {
  const verified = verifyBillingSignature(req);
  if (verified === false) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }
  if (verified === null) {
    // Not configured — never process an unverifiable webhook as if it were
    // trusted. This is the fail-closed twin of Meta's verifyMetaSignature
    // null case, but billing money-state changes get zero benefit of the
    // doubt (Meta's webhook.js explicitly documents choosing to proceed
    // when unconfigured for its own lower-stakes case; billing does not).
    console.error('[billing] webhook received but BILLING_WEBHOOK_SECRET is not configured — rejecting');
    return res.status(501).json({ error: 'Billing webhooks are not configured' });
  }
  const providerModule = getProvider();

  let mapped;
  try {
    mapped = providerModule.mapWebhookEvent(req.body);
  } catch (err) {
    console.error('[billing] webhook payload could not be mapped:', err.message);
    return res.status(400).json({ error: 'Unrecognized webhook payload' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: inserted } = await client.query(
      `INSERT INTO coexistence.billing_events (provider, provider_event_id, event_type, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (provider, provider_event_id) DO NOTHING
       RETURNING id`,
      [ACTIVE_PROVIDER, mapped.providerEventId, mapped.type, JSON.stringify(req.body)]
    );

    if (inserted.length === 0) {
      // Already processed this exact event before — idempotent no-op.
      await client.query('COMMIT');
      return res.status(200).json({ ok: true, duplicate: true });
    }

    let workspaceId = mapped.workspaceId || null;
    if (!workspaceId && mapped.providerCustomerId) {
      const { rows } = await client.query(
        `SELECT workspace_id FROM coexistence.workspace_billing WHERE provider_customer_id = $1`,
        [mapped.providerCustomerId]
      );
      workspaceId = rows[0]?.workspace_id || null;
    }
    if (!workspaceId) {
      await client.query('ROLLBACK');
      console.error('[billing] webhook event could not be resolved to a workspace:', mapped.type);
      return res.status(202).json({ ok: true, unresolved: true });
    }

    await applyBillingEvent(client, {
      workspaceId,
      planKey: mapped.planKey,
      status: mapped.status,
      providerCustomerId: mapped.providerCustomerId,
      providerSubscriptionId: mapped.providerSubscriptionId,
      currentPeriodEnd: mapped.currentPeriodEnd,
    });

    await client.query(
      `UPDATE coexistence.billing_events SET workspace_id = $1 WHERE id = $2`,
      [workspaceId, inserted[0].id]
    );

    await client.query('COMMIT');
    res.status(200).json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[billing] webhook processing error:', err.message);
    res.status(500).json({ error: 'Failed to process webhook' });
  } finally {
    client.release();
  }
});
module.exports = { router, webhookRouter };