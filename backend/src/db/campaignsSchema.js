// Phase 6 Part 1 — Campaign Studio foundation.
//
// coexistence.campaigns is a NEW table (unlike most db/*Schema.js files,
// which only ALTER a pre-existing table). It is the campaign "envelope"
// that Campaign Studio manages: audience + template/message config +
// lifecycle status. It deliberately does NOT duplicate any existing
// sending/tracking table — per-recipient execution (Part 2) reuses the
// existing coexistence.broadcasts / coexistence.broadcast_logs tables the
// same way routes/targetMessage.js already does today (create a DRAFT
// broadcast, then send through the existing /broadcasts/:id/send pipeline).
// The nullable `broadcast_id` column below is the seam Part 2 will use to
// link a campaign to the broadcast that actually executes it — added now,
// in the foundation, so Part 2 needs no further schema change to wire
// execution up.
//
// Must run after ensureWorkspaceTables() (FKs coexistence.workspaces),
// after ensureTables() (FKs coexistence.akchat_users via created_by), after
// ensureTemplatesWorkspaceColumns() (FKs coexistence.message_templates —
// campaigns must be able to reference an existing, workspace-owned
// template), and after ensureBroadcastsWorkspaceColumns() (FKs
// coexistence.broadcasts, which by that point is guaranteed to exist and
// be workspace-scoped). See index.js boot order.

const pool = require('../db');

const STATUSES = ['draft', 'scheduled', 'queued', 'running', 'paused', 'completed', 'cancelled', 'failed'];

async function ensureCampaignsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.campaigns (
      id              BIGSERIAL PRIMARY KEY,
      workspace_id    BIGINT NOT NULL REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,

      name            TEXT NOT NULL,
      description     TEXT,

      -- 'whatsapp' today; kept as a free column (not an enum) so a future
      -- channel (e.g. 'instagram') doesn't need a migration to add.
      channel         TEXT NOT NULL DEFAULT 'whatsapp',
      -- 'broadcast' today (one-off blast); room for future campaign types
      -- (e.g. 'drip') without a schema change.
      campaign_type   TEXT NOT NULL DEFAULT 'broadcast',

      status          TEXT NOT NULL DEFAULT 'draft',

      -- ── Audience reference (Phase 5 integration) ──────────────────────
      -- 'contacts'  -> audience_contact_ids is authoritative (static/selected list)
      -- 'filters'   -> audience_filters + audience_combinator are authoritative
      --                (saved-segment / dynamic audience, resolved fresh at
      --                every read and again at send time — see
      --                services/audienceFilter.js#buildAudienceWhere).
      audience_type        TEXT NOT NULL DEFAULT 'filters',
      audience_filters      JSONB NOT NULL DEFAULT '[]'::jsonb,
      audience_combinator   TEXT NOT NULL DEFAULT 'AND',
      audience_contact_ids  JSONB NOT NULL DEFAULT '[]'::jsonb,
      -- Last resolved size, cached purely for list/detail display. NEVER
      -- trusted for sending — Part 2 always re-resolves the audience
      -- server-side immediately before enqueueing.
      audience_size_cached  INTEGER,
      audience_resolved_at  TIMESTAMPTZ,

      -- ── Message / template reference ──────────────────────────────────
      from_number       TEXT,
      template_id        BIGINT REFERENCES coexistence.message_templates(id) ON DELETE SET NULL,
      message_type       TEXT NOT NULL DEFAULT 'template',
      body               TEXT,
      variable_mapping   JSONB NOT NULL DEFAULT '{}'::jsonb,
      media_library_id   BIGINT REFERENCES coexistence.media_library(id) ON DELETE SET NULL,
      caption            TEXT,

      -- ── Execution linkage (Part 2 uses this; NULL until first send) ────
      broadcast_id       BIGINT REFERENCES coexistence.broadcasts(id) ON DELETE SET NULL,

      created_by         BIGINT REFERENCES coexistence.akchat_users(id) ON DELETE SET NULL,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      scheduled_at       TIMESTAMPTZ,
      started_at         TIMESTAMPTZ,
      completed_at       TIMESTAMPTZ,

      CONSTRAINT campaigns_status_check CHECK (status IN (${STATUSES.map((s) => `'${s}'`).join(', ')})),
      CONSTRAINT campaigns_audience_type_check CHECK (audience_type IN ('contacts', 'filters'))
    )
  `);

  // Phase 6 Part 2 — customer SELECTION persistence (separate from the
  // audience DEFINITION above). `audience_contact_ids` stays the
  // authoritative definition for a static ('contacts') audience; these two
  // columns instead record which of the RESOLVED customers (dynamic or
  // static) the user explicitly checked in Step 4, so Save Draft -> reopen
  // restores the same checkboxes. Added via ALTER so this file still works
  // against a DB where coexistence.campaigns already exists from Part 1.
  // `selected_contact_ids` is NEVER the audience count (e.g. 187) — always
  // real contact ids, e.g. [1008, 2550, 2429]. `select_all_matching` is a
  // separate explicit flag for "Select all N matching customers", so that
  // mode is never approximated by dumping every id into the array.
  await pool.query(`
    ALTER TABLE coexistence.campaigns
      ADD COLUMN IF NOT EXISTS selected_contact_ids JSONB NOT NULL DEFAULT '[]'::jsonb
  `);
  await pool.query(`
    ALTER TABLE coexistence.campaigns
      ADD COLUMN IF NOT EXISTS select_all_matching BOOLEAN NOT NULL DEFAULT false
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_campaigns_workspace_id ON coexistence.campaigns (workspace_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_campaigns_workspace_status ON coexistence.campaigns (workspace_id, status)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_campaigns_workspace_channel ON coexistence.campaigns (workspace_id, channel)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_campaigns_scheduled_at ON coexistence.campaigns (scheduled_at)
      WHERE status = 'scheduled'
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_campaigns_broadcast_id ON coexistence.campaigns (broadcast_id)
      WHERE broadcast_id IS NOT NULL
  `);

  // updated_at auto-touch, same pattern used elsewhere in this codebase for
  // mutable rows (kept local to this table via a dedicated trigger function
  // rather than reusing a shared one that might not exist in every install).
  await pool.query(`
    CREATE OR REPLACE FUNCTION coexistence.campaigns_touch_updated_at()
    RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    DROP TRIGGER IF EXISTS trg_campaigns_touch_updated_at ON coexistence.campaigns
  `);
  await pool.query(`
    CREATE TRIGGER trg_campaigns_touch_updated_at
      BEFORE UPDATE ON coexistence.campaigns
      FOR EACH ROW EXECUTE FUNCTION coexistence.campaigns_touch_updated_at()
  `);
}

module.exports = { ensureCampaignsTable, CAMPAIGN_STATUSES: STATUSES };