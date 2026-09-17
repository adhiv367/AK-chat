// SaaS Phase 1 — Workspace / Tenant foundation.
//
// Mirrors the existing pattern in instagramSchema.js / retargetSchema.js:
// idempotent `CREATE TABLE IF NOT EXISTS`, called once on server startup.
// No migration framework is introduced; this file *is* the migration.
//
// This module does three things, in order, every boot:
//   1. Create `coexistence.workspaces` and `coexistence.workspace_members`
//      if they don't exist yet.
//   2. If there are zero workspaces, create exactly one default workspace
//      (see resolveDefaultWorkspaceName below).
//   3. Backfill a workspace_members row for every existing
//      coexistence.akchat_users row that doesn't already have one, mapping
//      their existing akchat_users.role to a workspace_role. This is a pure
//      additive INSERT — akchat_users.role is never modified.
//
// Nothing here touches contacts, messages, retarget, templates, workflows,
// CRM, Instagram, Shopify, or user_wa_assignments.

const pool = require('../db');

// Existing akchat_users.role -> SaaS workspace_role, per the agreed mapping.
// akchat_users.role itself is left untouched; this is only the value stored
// in workspace_members.workspace_role.
//
// Phase 3B note: bda_sales is remapped from the earlier placeholder 'MANAGER'
// to 'AGENT' — AGENT (inbox + contacts, scoped to assigned WhatsApp numbers)
// is what bda_sales has always actually behaved like (see
// permissions.js ROLE_PAGE_DEFAULTS.bda_sales and middleware/access.js
// buildWaScope/assertWaAccess/assertContactAccess). This only affects future
// inserts/role-changes (ensureMembershipForUser, PATCH /users/:id) — no
// existing workspace_members rows are migrated by this change.
const ROLE_TO_WORKSPACE_ROLE = {
  admin: 'OWNER',
  bda_sales: 'AGENT',
  viewer: 'VIEWER',
};
const DEFAULT_WORKSPACE_ROLE = 'VIEWER'; // fallback for any future/unknown role

function slugify(name) {
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'workspace';
}

// Resolution order (per Phase 1 decision):
//   1. WORKSPACE_NAME env var, if set and non-empty.
//   2. "Invi Creation" — the business identity actually found baked into
//      this codebase (services/retargetUrlResolver.js INVI_HOMEPAGE,
//      routes/webhook.js "Invi Creation AI Reply"), i.e. the real business
//      operating this installation. Not a blind hardcode — discovered
//      evidence from the existing code.
//   3. "Default Workspace" — final generic fallback.
function resolveDefaultWorkspaceName() {
  const envName = process.env.WORKSPACE_NAME && process.env.WORKSPACE_NAME.trim();
  if (envName) return envName;
  return 'Invi Creation';
}

async function ensureWorkspaceTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.workspaces (
      id         BIGSERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      slug       TEXT NOT NULL UNIQUE,
      status     TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.workspace_members (
      id             BIGSERIAL PRIMARY KEY,
      workspace_id   BIGINT NOT NULL REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,
      user_id        BIGINT NOT NULL REFERENCES coexistence.akchat_users(id) ON DELETE CASCADE,
      workspace_role TEXT NOT NULL DEFAULT 'VIEWER',
      status         TEXT NOT NULL DEFAULT 'active',
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (workspace_id, user_id)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_workspace_members_user_id
      ON coexistence.workspace_members (user_id)
  `);

  // Phase 4D — invitation foundation. Purely additive, nullable columns on
  // the existing workspace_members table; no new table, no change to any
  // existing row's meaning. invite_token is only ever non-null while a
  // membership is 'pending' (see routes/invitations.js) and is cleared the
  // moment it's used or replaced, making it effectively single-use.
  await pool.query(`
    ALTER TABLE coexistence.workspace_members
      ADD COLUMN IF NOT EXISTS invite_token TEXT,
      ADD COLUMN IF NOT EXISTS invite_expires_at TIMESTAMPTZ
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_members_invite_token
      ON coexistence.workspace_members (invite_token)
      WHERE invite_token IS NOT NULL
  `);

  // Phase 4E — Workspace Business Configuration. Purely additive, nullable
  // columns on the existing workspaces table (except onboarding_completed,
  // which defaults to false so any brand-new workspace still goes through
  // setup). No new table; existing rows are untouched except for the
  // one-time backfill below. This is what routes/workspace.js's
  // GET/PUT /workspaces/:id/onboarding and middleware/workspaceContext.js's
  // getMembership()/getWorkspacesForUser() already read/write — those files
  // are unchanged by this migration, they were simply waiting on these
  // columns to exist.
  // Detect, before adding it, whether onboarding_completed already existed —
  // this tells us whether this boot is the one true moment the column is
  // being introduced (fresh migration) vs. a normal restart on a database
  // that already has it. Used below to make the grandfathering backfill a
  // genuine one-time action, not something that re-runs (and could stomp a
  // real in-progress onboarding) on every subsequent boot.
  const { rows: colCheck } = await pool.query(`
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'coexistence' AND table_name = 'workspaces'
       AND column_name = 'onboarding_completed'
  `);
  const onboardingColumnIsNew = colCheck.length === 0;

  await pool.query(`
    ALTER TABLE coexistence.workspaces
      ADD COLUMN IF NOT EXISTS business_name TEXT,
      ADD COLUMN IF NOT EXISTS business_phone TEXT,
      ADD COLUMN IF NOT EXISTS business_email TEXT,
      ADD COLUMN IF NOT EXISTS business_address TEXT,
      ADD COLUMN IF NOT EXISTS timezone TEXT,
      ADD COLUMN IF NOT EXISTS logo_url TEXT,
      ADD COLUMN IF NOT EXISTS website TEXT,
      ADD COLUMN IF NOT EXISTS currency TEXT,
      ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN NOT NULL DEFAULT false
  `);

  // One-time-only backfill (see onboardingColumnIsNew above): every
  // workspace that already existed the moment onboarding_completed was
  // introduced (Invi Creation included) is grandfathered to true so it
  // never gets routed into a setup flow it never had. Runs exactly once,
  // ever, for a given database — later boots see onboardingColumnIsNew ===
  // false and skip this entirely, so a genuinely new workspace created
  // after this migration keeps its real onboarding_completed = false and
  // is never silently flipped to true by a server restart. Touches only
  // onboarding_completed, never the business_* fields.
  if (onboardingColumnIsNew) {
    const { rowCount } = await pool.query(`
      UPDATE coexistence.workspaces SET onboarding_completed = true
    `);
    if (rowCount > 0) {
      console.log(`[workspace] Phase 4E: grandfathered ${rowCount} pre-existing workspace(s) to onboarding_completed = true`);
    }
  }

  await seedDefaultWorkspaceAndBackfillMembers();
}

async function seedDefaultWorkspaceAndBackfillMembers() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Ensure exactly one default workspace exists.
    const { rows: existing } = await client.query(
      'SELECT id FROM coexistence.workspaces ORDER BY id ASC LIMIT 1'
    );

    if (existing.length > 0) {
      // Default workspace already exists — this is a normal restart, not the
      // one-time migration moment. Do NOT run the legacy backfill here: it
      // used to re-run on every boot and silently sweep ANY user lacking a
      // membership row (including brand-new SaaS users created afterward,
      // for an entirely different workspace) into this first/default
      // workspace — a real tenant-isolation bug. New users already receive
      // correct, workspace-scoped membership at creation time via
      // ensureMembershipForUser() (see routes/users.js), so no catch-all
      // sweep is needed or safe here.
      await client.query('COMMIT');
      return;
    }

    // 2. First boot ever against this database (zero workspaces exist yet):
    //    create the default workspace AND, in this exact one-time moment
    //    only, backfill every pre-existing akchat_users row into it. This is
    //    the genuine one-time migration — bringing legacy, pre-workspace
    //    users into the newly-introduced workspace concept. It cannot run
    //    again on any later boot because `existing.length > 0` from then on.
    const name = resolveDefaultWorkspaceName();
    let slug = slugify(name);

    // Extremely unlikely on an empty table, but keep slug unique defensively.
    const { rows: slugClash } = await client.query(
      'SELECT 1 FROM coexistence.workspaces WHERE slug = $1',
      [slug]
    );
    if (slugClash.length > 0) slug = `${slug}-${Date.now()}`;

    const { rows: inserted } = await client.query(
      `INSERT INTO coexistence.workspaces (name, slug, status)
       VALUES ($1, $2, 'active')
       RETURNING id`,
      [name, slug]
    );
    const workspaceId = inserted[0].id;
    console.log(`[workspace] Created default workspace "${name}" (slug: ${slug}, id: ${workspaceId})`);

    // One-time-only backfill: every existing user (all of them, since the
    // workspace_members table was just created and is empty) gets a
    // membership row in this newly-created default workspace. Existing
    // akchat_users.role is read but never written.
    const { rows: users } = await client.query(
      `SELECT au.id, au.role
         FROM coexistence.akchat_users au
        WHERE NOT EXISTS (
          SELECT 1 FROM coexistence.workspace_members wm
           WHERE wm.workspace_id = $1 AND wm.user_id = au.id
        )`,
      [workspaceId]
    );

    for (const u of users) {
      const workspaceRole = ROLE_TO_WORKSPACE_ROLE[u.role] || DEFAULT_WORKSPACE_ROLE;
      await client.query(
        `INSERT INTO coexistence.workspace_members (workspace_id, user_id, workspace_role, status)
         VALUES ($1, $2, $3, 'active')
         ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        [workspaceId, u.id, workspaceRole]
      );
    }

    if (users.length > 0) {
      console.log(`[workspace] One-time migration: backfilled ${users.length} pre-existing user(s) into workspace ${workspaceId}`);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[workspace] seed/backfill failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

// Add a single user to the default (first) workspace. Used by the user
// creation endpoint so a newly created user doesn't have to wait for a
// server restart to get a workspace_members row. Safe to call with an
// existing transaction client. No-op (returns null) if no workspace exists
// yet — should not happen post-boot, but never throws for this reason since
// workspace membership is not required for the app's core auth to work.
async function ensureMembershipForUser(client, userId, akchatRole, workspaceId = null) {
  if (!workspaceId) {
    const { rows: existing } = await client.query(
      'SELECT id FROM coexistence.workspaces ORDER BY id ASC LIMIT 1'
    );
    if (existing.length === 0) return null;
    workspaceId = existing[0].id;
  }
  const workspaceRole = ROLE_TO_WORKSPACE_ROLE[akchatRole] || DEFAULT_WORKSPACE_ROLE;
  await client.query(
    `INSERT INTO coexistence.workspace_members (workspace_id, user_id, workspace_role, status)
     VALUES ($1, $2, $3, 'active')
     ON CONFLICT (workspace_id, user_id) DO NOTHING`,
    [workspaceId, userId, workspaceRole]
  );
  return workspaceId;
}

module.exports = {
  ensureWorkspaceTables,
  ensureMembershipForUser,
  ROLE_TO_WORKSPACE_ROLE,
  DEFAULT_WORKSPACE_ROLE,
  resolveDefaultWorkspaceName,
  slugify,
};

