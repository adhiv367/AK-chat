// Phase 4H — Workspace-Level Defaults foundation.
//
// STEP 1 audit findings (see Phase 4H brief) that shaped this design:
//   - Default WhatsApp account: coexistence.whatsapp_accounts already has a
//     workspace-scoped `is_default` boolean (Phase 2B), with the existing
//     invariant "at most one is_default=true row per workspace" already
//     enforced by routes/whatsappAccounts.js (create/delete flows). There is
//     therefore NO new column/table for this — Phase 4H only adds a way to
//     *change* the default outside of create/delete (see the new
//     POST /whatsapp-accounts/:id/set-default route) and reads the existing
//     column back on GET /workspaces/:id/defaults. Duplicating it into a
//     second column here would create exactly the "two competing sources of
//     truth" the brief explicitly warns against.
//   - Timezone: coexistence.workspaces.timezone already exists (Phase 4E /
//     workspaceSchema.js) and is already workspace-scoped. Not duplicated
//     here either — GET /workspaces/:id/defaults simply reflects it back
//     alongside the new settings below.
//   - Campaign / automation / contact / notification defaults: no existing
//     workspace-scoped structure for any of these four. A single new table
//     (rather than four, or a pile of new columns on `workspaces`) keeps this
//     additive and easy to extend later — each category is its own JSONB
//     column so future phases can grow a category's shape without a schema
//     migration every time.
//
// Mirrors the existing idempotent `CREATE TABLE IF NOT EXISTS` + backfill
// convention used throughout db/*Schema.js (workspaceSchema.js,
// whatsappAccountsSchema.js, etc).

const pool = require('../db');

// Safe, minimal starting values — deliberately small. Every one of these is
// a foundation flag/string a later phase can build on; Phase 4H does not
// wire any of them into campaign sending, the automation engine, Client
// Directory, or a notification platform. Storing them is the whole scope.
const DEFAULT_CAMPAIGN_DEFAULTS = Object.freeze({
  defaultSchedulingMode: 'immediate', // 'immediate' | 'scheduled'
});
const DEFAULT_AUTOMATION_DEFAULTS = Object.freeze({
  enabledByDefault: true,
});
const DEFAULT_CONTACT_DEFAULTS = Object.freeze({
  defaultStatus: 'new',
});
const DEFAULT_NOTIFICATION_DEFAULTS = Object.freeze({
  emailEnabled: true,
  inAppEnabled: true,
});

// Whitelisted keys + validators per category. PUT /workspaces/:id/defaults
// sanitizes against this — unknown keys are dropped and mistyped values are
// rejected, rather than trusting the client body into JSONB verbatim.
const SCHEMAS = {
  campaign: {
    defaults: DEFAULT_CAMPAIGN_DEFAULTS,
    fields: {
      defaultSchedulingMode: (v) => (v === 'immediate' || v === 'scheduled') ? v : undefined,
    },
  },
  automation: {
    defaults: DEFAULT_AUTOMATION_DEFAULTS,
    fields: {
      enabledByDefault: (v) => (typeof v === 'boolean') ? v : undefined,
    },
  },
  contact: {
    defaults: DEFAULT_CONTACT_DEFAULTS,
    fields: {
      defaultStatus: (v) => (typeof v === 'string' && v.trim() && v.length <= 40) ? v.trim() : undefined,
    },
  },
  notification: {
    defaults: DEFAULT_NOTIFICATION_DEFAULTS,
    fields: {
      emailEnabled: (v) => (typeof v === 'boolean') ? v : undefined,
      inAppEnabled: (v) => (typeof v === 'boolean') ? v : undefined,
    },
  },
};

// Merge `incoming` (untrusted, from req.body) over `current` (already-stored
// JSONB, trusted) using the whitelist for `category`. Unknown keys are
// dropped; invalid values for a known key are ignored (current value wins)
// rather than rejecting the whole request, so a partial/typo'd payload can
// never wipe out the rest of a workspace's saved defaults.
function sanitizeCategory(category, incoming, current) {
  const schema = SCHEMAS[category];
  const base = { ...schema.defaults, ...(current || {}) };
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return base;
  const out = { ...base };
  for (const [key, validate] of Object.entries(schema.fields)) {
    if (Object.prototype.hasOwnProperty.call(incoming, key)) {
      const val = validate(incoming[key]);
      if (val !== undefined) out[key] = val;
    }
  }
  return out;
}

async function ensureWorkspaceDefaultsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.workspace_defaults (
      workspace_id         BIGINT PRIMARY KEY
                              REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,
      campaign_defaults     JSONB NOT NULL DEFAULT '{}'::jsonb,
      automation_defaults   JSONB NOT NULL DEFAULT '{}'::jsonb,
      contact_defaults      JSONB NOT NULL DEFAULT '{}'::jsonb,
      notification_defaults JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Backfill: every workspace that predates this table (all of them, on the
  // first boot after this migration ships) gets exactly one defaults row
  // with the safe starting values above. Existing workspaces (Invi Creation
  // included) are never modified beyond gaining this new row — nothing
  // here touches workspaces, whatsapp_accounts, campaigns, automations,
  // contacts, or notifications themselves.
  const { rowCount } = await pool.query(
    `INSERT INTO coexistence.workspace_defaults
       (workspace_id, campaign_defaults, automation_defaults, contact_defaults, notification_defaults)
     SELECT w.id, $1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb
       FROM coexistence.workspaces w
      WHERE NOT EXISTS (
        SELECT 1 FROM coexistence.workspace_defaults wd WHERE wd.workspace_id = w.id
      )`,
    [
      JSON.stringify(DEFAULT_CAMPAIGN_DEFAULTS),
      JSON.stringify(DEFAULT_AUTOMATION_DEFAULTS),
      JSON.stringify(DEFAULT_CONTACT_DEFAULTS),
      JSON.stringify(DEFAULT_NOTIFICATION_DEFAULTS),
    ]
  );
  if (rowCount > 0) {
    console.log(`[workspace-defaults] Phase 4H: backfilled defaults for ${rowCount} workspace(s)`);
  }
}

// Create a defaults row for exactly one newly-created workspace. Safe to
// call inside an existing transaction (pass the transaction client) — used
// by POST /workspaces so a brand-new workspace never depends on another
// workspace's defaults or waits for a server restart to get its own row.
async function ensureDefaultsRowForWorkspace(client, workspaceId) {
  await client.query(
    `INSERT INTO coexistence.workspace_defaults
       (workspace_id, campaign_defaults, automation_defaults, contact_defaults, notification_defaults)
     VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb)
     ON CONFLICT (workspace_id) DO NOTHING`,
    [
      workspaceId,
      JSON.stringify(DEFAULT_CAMPAIGN_DEFAULTS),
      JSON.stringify(DEFAULT_AUTOMATION_DEFAULTS),
      JSON.stringify(DEFAULT_CONTACT_DEFAULTS),
      JSON.stringify(DEFAULT_NOTIFICATION_DEFAULTS),
    ]
  );
}

module.exports = {
  ensureWorkspaceDefaultsTable,
  ensureDefaultsRowForWorkspace,
  sanitizeCategory,
  DEFAULT_CAMPAIGN_DEFAULTS,
  DEFAULT_AUTOMATION_DEFAULTS,
  DEFAULT_CONTACT_DEFAULTS,
  DEFAULT_NOTIFICATION_DEFAULTS,
};