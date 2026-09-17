// Phase 5B — Plans, entitlements & billing schema.
//
// Mirrors the existing pattern in workspaceSchema.js / whatsappAccountsSchema.js:
// idempotent `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`, called
// once on server startup, no migration framework. This file *is* the
// migration.
//
// Three additive tables, none of which touch any existing table's meaning:
//   coexistence.plans            — authoritative plan definitions (limits).
//   coexistence.workspace_billing — 1:1 with workspaces; current plan +
//                                    billing/subscription state.
//   coexistence.billing_events    — webhook idempotency ledger.
//
// Grandfathering: the pre-existing "Invi Creation" workspace (and any other
// workspace that already existed before this migration ever ran) is put on
// the built-in 'legacy_unlimited' plan with status 'active' — never a paid
// plan, never deleted/blocked, per Phase 5B section 7. This runs exactly
// once per database, same pattern as the onboarding_completed backfill in
// workspaceSchema.js.

const pool = require('../db');

// Built-in plan catalog. `limits: null` for a given key means "unlimited"
// for that dimension. These are seeded rows, not hardcoded checks — the
// entitlement service always reads limits from the DB row, never from this
// object directly, so admins can tune limits without a deploy.
const BUILTIN_PLANS = [
  {
    key: 'legacy_unlimited',
    name: 'Legacy (Grandfathered)',
    // Not publicly purchasable — only ever assigned by the one-time
    // grandfathering backfill below.
    is_public: false,
    limits: { max_seats: null, max_whatsapp_accounts: null, max_contacts: null, monthly_message_quota: null },
  },
  {
    key: 'free',
    name: 'Free',
    is_public: true,
    limits: { max_seats: 2, max_whatsapp_accounts: 1, max_contacts: 250, monthly_message_quota: 1000 },
  },
  {
    key: 'starter',
    name: 'Starter',
    is_public: true,
    limits: { max_seats: 5, max_whatsapp_accounts: 2, max_contacts: 2500, monthly_message_quota: 10000 },
  },
  {
    key: 'growth',
    name: 'Growth',
    is_public: true,
    limits: { max_seats: 20, max_whatsapp_accounts: 5, max_contacts: 25000, monthly_message_quota: 100000 },
  },
];

// Phase 8F-2: boolean feature flags are NOT a new column/table — they live
// inside each plan's existing `limits` JSONB under a `features` sub-object
// (e.g. { ...numeric caps, features: { some_key: true } }), read via
// entitlementService.hasFeature(workspaceId, featureKey). BUILTIN_PLANS
// below is intentionally left without any `features` entries: this phase
// only builds the mechanism and does not decide which plan gets which
// feature (a commercial/pricing decision out of scope here).

// New workspaces (created after this migration first runs) default here.
const DEFAULT_NEW_WORKSPACE_PLAN_KEY = 'free';

// Phase 8B-4: trial duration is a config point, not a hardcoded pricing
// decision — TRIAL_DURATION_DAYS env var, defaulting to 14. Falls back to
// the default on anything non-numeric or <= 0 rather than producing a
// nonsensical trial window.
const DEFAULT_TRIAL_DURATION_DAYS = 14;
function getTrialDurationDays() {
  const raw = Number(process.env.TRIAL_DURATION_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TRIAL_DURATION_DAYS;
}

async function ensurePlansTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.plans (
      id         BIGSERIAL PRIMARY KEY,
      key        TEXT NOT NULL UNIQUE,
      name       TEXT NOT NULL,
      is_public  BOOLEAN NOT NULL DEFAULT true,
      limits     JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.workspace_billing (
      id                     BIGSERIAL PRIMARY KEY,
      workspace_id           BIGINT NOT NULL UNIQUE REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,
      plan_id                BIGINT NOT NULL REFERENCES coexistence.plans(id),
      status                 TEXT NOT NULL DEFAULT 'active',
      billing_provider       TEXT,
      provider_customer_id   TEXT,
      provider_subscription_id TEXT,
      current_period_end     TIMESTAMPTZ,
      cancel_at_period_end   BOOLEAN NOT NULL DEFAULT false,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT workspace_billing_status_check
        CHECK (status IN ('active', 'past_due', 'suspended', 'cancelled'))
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_workspace_billing_provider_customer
      ON coexistence.workspace_billing (provider_customer_id)
  `);

  // Phase 8B-1 — trial database foundation only. Additive columns; no
  // expiry logic, no assignment to new workspaces yet (later phases).
  await pool.query(`
    ALTER TABLE coexistence.workspace_billing
      ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS trial_ends_at     TIMESTAMPTZ
  `);

  // Add 'trialing' to the status check constraint while preserving every
  // existing allowed status. DROP/ADD is idempotent here: re-running this
  // on a DB that already has the updated constraint just replaces it with
  // an identical one, and no existing rows are touched (their `status`
  // values are unaffected since 'trialing' is additive, not a rename).
  await pool.query(`
    ALTER TABLE coexistence.workspace_billing
      DROP CONSTRAINT IF EXISTS workspace_billing_status_check
  `);
  await pool.query(`
    ALTER TABLE coexistence.workspace_billing
      ADD CONSTRAINT workspace_billing_status_check
      CHECK (status IN ('active', 'past_due', 'suspended', 'cancelled', 'trialing'))
  `);

  // Idempotency ledger for billing webhooks. provider + provider_event_id is
  // unique so a redelivered event is a no-op (ON CONFLICT DO NOTHING at the
  // call site), mirroring the "duplicate webhook handled idempotently"
  // requirement (5B-4 / test #10).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.billing_events (
      id                 BIGSERIAL PRIMARY KEY,
      provider           TEXT NOT NULL,
      provider_event_id  TEXT NOT NULL,
      event_type         TEXT,
      workspace_id       BIGINT REFERENCES coexistence.workspaces(id) ON DELETE SET NULL,
      payload            JSONB,
      processed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (provider, provider_event_id)
    )
  `);

  await seedBuiltinPlans();
  await grandfatherPreExistingWorkspaces();
}

async function seedBuiltinPlans() {
  for (const plan of BUILTIN_PLANS) {
    await pool.query(
      `INSERT INTO coexistence.plans (key, name, is_public, limits)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [plan.key, plan.name, plan.is_public, JSON.stringify(plan.limits)]
    );
  }
}

async function getPlanByKey(key) {
  const { rows } = await pool.query(`SELECT * FROM coexistence.plans WHERE key = $1`, [key]);
  return rows[0] || null;
}

// One-time-only backfill (detected the same way workspaceSchema.js detects
// onboardingColumnIsNew): every workspace that already has no
// workspace_billing row the moment this migration introduces the table gets
// the legacy_unlimited plan, active status. A workspace created AFTER this
// has already run (i.e. a genuinely new workspace with no billing row for a
// different reason) does NOT match this backfill's intent — but since new
// workspaces are always given a billing row synchronously at creation time
// (see routes/workspace.js POST /workspaces, updated below), the only rows
// this ever catches in practice are pre-Phase-5B workspaces. Safe to run on
// every boot: it only inserts for workspaces that still have zero billing
// rows, which a normal restart never produces once this has run.
async function grandfatherPreExistingWorkspaces() {
  const legacyPlan = await getPlanByKey('legacy_unlimited');
  if (!legacyPlan) return; // should not happen; seed runs first

  const { rows: orphaned } = await pool.query(`
    SELECT w.id FROM coexistence.workspaces w
     WHERE NOT EXISTS (
       SELECT 1 FROM coexistence.workspace_billing wb WHERE wb.workspace_id = w.id
     )
  `);

  for (const w of orphaned) {
    await pool.query(
      `INSERT INTO coexistence.workspace_billing (workspace_id, plan_id, status, billing_provider)
       VALUES ($1, $2, 'active', 'none')
       ON CONFLICT (workspace_id) DO NOTHING`,
      [w.id, legacyPlan.id]
    );
  }
  if (orphaned.length > 0) {
    console.log(`[plans] Phase 5B: grandfathered ${orphaned.length} pre-existing workspace(s) onto legacy_unlimited plan`);
  }
}

// Called synchronously by routes/workspace.js POST /workspaces so a
// brand-new workspace never has a moment without a billing row (avoids it
// being swept up by grandfathering on a later boot, and avoids the
// entitlement service ever having to guess a default for a missing row).
//
// Phase 8B-4: every eligible new workspace starts on 'trialing' with
// trial_started_at = now and trial_ends_at = now + TRIAL_DURATION_DAYS,
// instead of 'active'. This only affects the INSERT path for a workspace
// that has no billing row yet — ON CONFLICT (workspace_id) DO NOTHING means
// an existing row (including any grandfathered legacy row, which is always
// inserted separately by grandfatherPreExistingWorkspaces() with its own
// 'active'/no-trial-fields INSERT) is never touched or overwritten here.
async function ensureBillingRowForNewWorkspace(client, workspaceId) {
  const { rows } = await (client || pool).query(
    `SELECT id FROM coexistence.plans WHERE key = $1`,
    [DEFAULT_NEW_WORKSPACE_PLAN_KEY]
  );
  const plan = rows[0];
  if (!plan) return null; // seed hasn't run yet; should not happen post-boot

  const trialDays = getTrialDurationDays();
  await (client || pool).query(
    `INSERT INTO coexistence.workspace_billing
       (workspace_id, plan_id, status, billing_provider, trial_started_at, trial_ends_at)
     VALUES ($1, $2, 'trialing', 'none', NOW(), NOW() + ($3 || ' days')::interval)
     ON CONFLICT (workspace_id) DO NOTHING`,
    [workspaceId, plan.id, String(trialDays)]
  );
  return plan.id;
}
module.exports = {
  ensurePlansTables,
  getPlanByKey,
  ensureBillingRowForNewWorkspace,
  BUILTIN_PLANS,
  DEFAULT_NEW_WORKSPACE_PLAN_KEY,
  getTrialDurationDays,
  DEFAULT_TRIAL_DURATION_DAYS,
};