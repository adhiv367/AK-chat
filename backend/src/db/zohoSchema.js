// Phase 8A — Zoho CRM Integration: ARCHITECTURE + SCHEMA FOUNDATION ONLY.
//
// This file creates FOUR new, additive tables. No OAuth routes, no Zoho API
// calls, no lead-sync logic, no AI extraction logic, and no frontend UI
// exist yet — that is explicitly out of scope for 8A. This mirrors the
// sequencesSchema.js Phase 7A convention: idempotent `CREATE TABLE IF NOT
// EXISTS` + `CREATE INDEX IF NOT EXISTS`, local updated_at touch-triggers,
// plain-TEXT + CHECK-constraint enums (not Postgres ENUM types) so future
// values can be added with a constraint migration, not a type migration.
//
// ── SaaS relationship this schema is built around ──────────────────────
//   coexistence.workspaces
//         │  (existing, workspaceSchema.js)
//         ▼
//   coexistence.whatsapp_accounts   (existing table; workspace_id added by
//         │                          whatsappAccountsSchema.js)
//         ▼
//   coexistence.zoho_connections    (NEW — this file)
//         │  one connection per WhatsApp account, never per-customer-lead
//         ▼
//   coexistence.zoho_lead_links     (NEW — future idempotent Lead
//                                     create/update keying; no sync logic
//                                     runs yet)
//
// Every table below carries BOTH workspace_id AND whatsapp_account_id
// directly (not just resolvable via a join) so every future route can
// filter on both without a join, exactly mirroring the isolation model
// already used by instagramWorkspaceSchema.js / contactsWorkspaceSchema.js
// for their respective child tables. workspace_id is intentionally
// redundant with whatsapp_account_id -> workspace_id (an account can never
// change workspace in this codebase), but keeping it as its own column
// means "no cross-workspace access" can be enforced as a single WHERE
// clause on the child table itself, without trusting a join to not have
// been forgotten in some future route.
//
// AKChat WhatsApp Account -> ONE Zoho CRM connection -> MANY Zoho Leads.
// This file does NOT create a new Zoho organization/tenant concept — a
// zoho_connections row simply records which existing Zoho CRM account
// (identified by the org's own accounts-server "api_domain"/data-center
// and, where available, an org id string reported by Zoho) a given AKChat
// WhatsApp account has been connected to via OAuth (8B).
//
// Token handling: access_token_encrypted / refresh_token_encrypted store
// ciphertext produced by util/crypto.js's encrypt() (AES-256-GCM, the same
// helper already used for WhatsApp access tokens) — never plaintext, never
// logged, never sent to the frontend. 8A only reserves these columns; no
// OAuth flow writes them yet.
//
// Must run after:
//   - ensureWorkspaceTables()             (FKs coexistence.workspaces)
//   - ensureWhatsappAccountsSaasColumns() (FKs coexistence.whatsapp_accounts;
//                                           that table's workspace_id column
//                                           must already exist so this
//                                           file's app-level isolation
//                                           checks have something to
//                                           validate against)
// See index.js boot order — placed alongside/after ensureWhatsappAccountsSaasColumns(),
// same reasoning as ensureWorkspaceDefaultsTable() being placed right after it.

const pool = require('../db');

// Connection lifecycle. 'disconnected' is the state before OAuth (8B) ever
// runs, and also the state after a user explicitly disconnects or a token
// refresh permanently fails (see last_error). 'error' = actively connected
// before but currently failing (e.g. refresh token revoked on Zoho's side) —
// kept distinct from 'disconnected' so the future UI can show "reconnect
// needed" instead of "never connected".
// Phase 8B Part 2 adds 'reauth_required': a connected connection whose
// refresh token has permanently failed (revoked on Zoho's side, etc.) and
// needs the user to redo the OAuth consent screen — distinct from 'error',
// which Part 1 used as a stand-in for this same condition before this
// value existed. Kept additive: existing 'error' rows are left as-is by
// the migration below (no backfill), new failures are written as
// 'reauth_required' by zohoTokenService.js/zohoConnectionService.js going
// forward.
const ZOHO_CONNECTION_STATUSES = ['disconnected', 'connected', 'error', 'reauth_required'];

// Zoho's own multi-data-center hosting. Recorded so 8B's OAuth/API calls
// know which regional API base URL to use (Zoho CRM is NOT single-region).
// Kept as free-form-but-constrained TEXT rather than assuming this list is
// exhaustive forever — Zoho has added data centers over time.
const ZOHO_DATA_CENTERS = ['com', 'eu', 'in', 'com.au', 'jp', 'ca'];

// Future lead-link lifecycle (zoho_lead_links.status). 8A only reserves the
// column/table; no code writes to it yet. 'pending' = AKChat has decided a
// lead should exist in Zoho but hasn't confirmed the create/update call
// succeeded; 'synced' = confirmed; 'failed' = last attempt errored (message
// in last_error, retry is a future-phase concern).
const ZOHO_LEAD_LINK_STATUSES = ['pending', 'synced', 'failed'];

// Future extraction-audit decision/status values (zoho_extraction_audit.status).
// 8A only reserves the column; no AI extraction code writes it yet.
const ZOHO_EXTRACTION_STATUSES = ['pending_review', 'approved', 'rejected', 'auto_applied'];

async function ensureZohoTables() {
  // ── 1. coexistence.zoho_connections ─────────────────────────────────────
  // One row per AKChat WhatsApp account's Zoho CRM connection. Strong
  // isolation: UNIQUE(workspace_id, whatsapp_account_id) below guarantees a
  // given WhatsApp account can have at most one Zoho connection, and that
  // connection can never be silently shared across workspaces even if a
  // future bug supplied a mismatched pair.
  //
  // zoho_org_id / zoho_api_domain / zoho_data_center are all nullable
  // because they are only known once OAuth (8B) actually completes — 8A
  // creates the row shape, not populated rows.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.zoho_connections (
      id                        BIGSERIAL PRIMARY KEY,
      workspace_id              BIGINT NOT NULL REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,
      whatsapp_account_id       BIGINT NOT NULL REFERENCES coexistence.whatsapp_accounts(id) ON DELETE CASCADE,

      -- Zoho-side identity of the connected CRM org, discovered during
      -- OAuth (8B). Not a new tenant concept on AKChat's side — see file
      -- header ("one connection -> many leads", never one-org-per-customer).
      zoho_org_id               TEXT,
      zoho_api_domain           TEXT,
      zoho_data_center          TEXT,

      status                    TEXT NOT NULL DEFAULT 'disconnected',

      -- AES-256-GCM ciphertext via util/crypto.js encrypt() — never
      -- plaintext at rest, never logged, never serialized to the frontend.
      access_token_encrypted    TEXT,
      refresh_token_encrypted   TEXT,
      token_expires_at          TIMESTAMPTZ,

      -- Space-delimited Zoho OAuth scope string granted at connect time,
      -- so a future route can verify a required scope is present before
      -- attempting an API call, without decrypting the token to find out.
      scopes                    TEXT,

      connected_at              TIMESTAMPTZ,
      connected_by              BIGINT REFERENCES coexistence.akchat_users(id) ON DELETE SET NULL,
      last_success_at           TIMESTAMPTZ,
      last_error                TEXT,
      last_error_at             TIMESTAMPTZ,

      created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT zoho_connections_status_check
        CHECK (status IN (${ZOHO_CONNECTION_STATUSES.map((s) => `'${s}'`).join(', ')})),
      CONSTRAINT zoho_connections_data_center_check
        CHECK (zoho_data_center IS NULL OR zoho_data_center IN (${ZOHO_DATA_CENTERS.map((s) => `'${s}'`).join(', ')})),

      -- The core isolation guarantee (see spec §4A): a given WhatsApp
      -- account can have at most one Zoho connection, and it is always
      -- scoped to the workspace that account itself belongs to.
      CONSTRAINT uq_zoho_connections_workspace_account
        UNIQUE (workspace_id, whatsapp_account_id)
    )
  `);

  // ── Phase 8B Part 2 — additive status-constraint migration ─────────────
  // The table may already exist from Part 1/8A with the narrower
  // zoho_connections_status_check (no 'reauth_required'). DROP + re-ADD is
  // safe/idempotent here: it runs every boot, always drops-if-present then
  // recreates the SAME constraint name with the current (now wider) allowed
  // set, and never touches existing row data — a plain additive migration,
  // not a table rewrite. Column defaults/shape are untouched.
  await pool.query(`
    ALTER TABLE coexistence.zoho_connections
      DROP CONSTRAINT IF EXISTS zoho_connections_status_check
  `);
  await pool.query(`
    ALTER TABLE coexistence.zoho_connections
      ADD CONSTRAINT zoho_connections_status_check
      CHECK (status IN (${ZOHO_CONNECTION_STATUSES.map((s) => `'${s}'`).join(', ')}))
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_zoho_connections_workspace_id
      ON coexistence.zoho_connections (workspace_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_zoho_connections_whatsapp_account_id
      ON coexistence.zoho_connections (whatsapp_account_id)
  `);
  // Foundation for 8B's token-refresh sweep: efficiently find connected
  // connections whose token is at/near expiry. Partial on status='connected'
  // so disconnected/error rows never bloat this index.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_zoho_connections_token_expiry
      ON coexistence.zoho_connections (token_expires_at)
      WHERE status = 'connected'
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION coexistence.zoho_connections_touch_updated_at()
    RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    DROP TRIGGER IF EXISTS trg_zoho_connections_touch_updated_at ON coexistence.zoho_connections
  `);
  await pool.query(`
    CREATE TRIGGER trg_zoho_connections_touch_updated_at
      BEFORE UPDATE ON coexistence.zoho_connections
      FOR EACH ROW EXECUTE FUNCTION coexistence.zoho_connections_touch_updated_at()
  `);

  // ── 2. coexistence.zoho_lead_links ──────────────────────────────────────
  // Future idempotent create/update keying: workspace + whatsapp_account +
  // contact_number -> zoho_lead_id. No sync logic writes here yet (8C+).
  // contact_number is TEXT to match the existing wa_number/contact_number
  // convention used throughout this codebase (see sequencesSchema.js header
  // and contactsWorkspaceSchema.js) — no new/duplicated contact identity
  // model is introduced.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.zoho_lead_links (
      id                    BIGSERIAL PRIMARY KEY,
      workspace_id          BIGINT NOT NULL REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,
      whatsapp_account_id   BIGINT NOT NULL REFERENCES coexistence.whatsapp_accounts(id) ON DELETE CASCADE,
      zoho_connection_id    BIGINT NOT NULL REFERENCES coexistence.zoho_connections(id) ON DELETE CASCADE,

      contact_number        TEXT NOT NULL,
      zoho_lead_id          TEXT,

      status                TEXT NOT NULL DEFAULT 'pending',
      last_synced_at        TIMESTAMPTZ,
      last_error            TEXT,

      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT zoho_lead_links_status_check
        CHECK (status IN (${ZOHO_LEAD_LINK_STATUSES.map((s) => `'${s}'`).join(', ')})),

      -- Idempotency guarantee for the future sync logic (spec §4B): one
      -- lead-link row per (workspace, whatsapp account, contact number).
      CONSTRAINT uq_zoho_lead_links_identity
        UNIQUE (workspace_id, whatsapp_account_id, contact_number)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_zoho_lead_links_workspace_id
      ON coexistence.zoho_lead_links (workspace_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_zoho_lead_links_whatsapp_account_id
      ON coexistence.zoho_lead_links (whatsapp_account_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_zoho_lead_links_zoho_connection_id
      ON coexistence.zoho_lead_links (zoho_connection_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_zoho_lead_links_contact_number
      ON coexistence.zoho_lead_links (contact_number)
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION coexistence.zoho_lead_links_touch_updated_at()
    RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    DROP TRIGGER IF EXISTS trg_zoho_lead_links_touch_updated_at ON coexistence.zoho_lead_links
  `);
  await pool.query(`
    CREATE TRIGGER trg_zoho_lead_links_touch_updated_at
      BEFORE UPDATE ON coexistence.zoho_lead_links
      FOR EACH ROW EXECUTE FUNCTION coexistence.zoho_lead_links_touch_updated_at()
  `);

  // ── 3. coexistence.zoho_field_mappings ──────────────────────────────────
  // Future workspace/WhatsApp-account-specific business field configuration
  // (spec §4C). Deliberately data-driven — no Standard Roofs / ABC Steels
  // hardcoding anywhere in this schema or elsewhere in this codebase.
  // field_config is JSONB so each business can define its own field set
  // (e.g. {length, breadth, roof_type, site_location} or {pipe_name,
  // weight, size, quantity}) without any source-code or schema change.
  //
  // zoho_target is nullable/free-form on purpose (spec §7 — Zoho Free Plan
  // constraint): 8A does not assume arbitrary custom Zoho fields exist on
  // every plan. A field can map to a standard Zoho Lead field, a Zoho Note,
  // or (once the customer's Zoho edition allows it, in a later phase) an
  // actual Zoho custom-field API name — this table only reserves the
  // column; no field IDs are hardcoded here.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.zoho_field_mappings (
      id                    BIGSERIAL PRIMARY KEY,
      workspace_id          BIGINT NOT NULL REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,
      whatsapp_account_id   BIGINT NOT NULL REFERENCES coexistence.whatsapp_accounts(id) ON DELETE CASCADE,

      field_key             TEXT NOT NULL,
      field_label           TEXT NOT NULL,
      field_type            TEXT NOT NULL DEFAULT 'text',

      -- Where this field's value should land on the Zoho side once mapping
      -- is actually implemented (future phase). NULL = "not yet mapped;
      -- stored on AKChat's side only", which is the only state 8A produces.
      zoho_target           TEXT,

      -- Extensible per-field config (e.g. dropdown options, validation) so
      -- new field shapes never require a schema change.
      field_config          JSONB NOT NULL DEFAULT '{}'::jsonb,

      is_active             BOOLEAN NOT NULL DEFAULT true,
      display_order         INTEGER NOT NULL DEFAULT 0,

      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT uq_zoho_field_mappings_key
        UNIQUE (workspace_id, whatsapp_account_id, field_key)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_zoho_field_mappings_workspace_id
      ON coexistence.zoho_field_mappings (workspace_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_zoho_field_mappings_whatsapp_account_id
      ON coexistence.zoho_field_mappings (whatsapp_account_id)
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION coexistence.zoho_field_mappings_touch_updated_at()
    RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    DROP TRIGGER IF EXISTS trg_zoho_field_mappings_touch_updated_at ON coexistence.zoho_field_mappings
  `);
  await pool.query(`
    CREATE TRIGGER trg_zoho_field_mappings_touch_updated_at
      BEFORE UPDATE ON coexistence.zoho_field_mappings
      FOR EACH ROW EXECUTE FUNCTION coexistence.zoho_field_mappings_touch_updated_at()
  `);
  // ── 4. coexistence.zoho_extraction_audit ────────────────────────────────
  // Future AI extraction/audit trail (spec §4D). No extraction logic writes
  // here yet — 8A only reserves the shape. conversation_id / message_id are
  // TEXT (not FKs) because this codebase's messages table primary keying
  // convention was not confirmed during this audit as a stable numeric id
  // suitable for a hard FK; keeping them as free-form reference columns
  // avoids guessing an FK target that later turns out wrong, while still
  // being indexed for lookup.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.zoho_extraction_audit (
      id                    BIGSERIAL PRIMARY KEY,
      workspace_id          BIGINT NOT NULL REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,
      whatsapp_account_id   BIGINT NOT NULL REFERENCES coexistence.whatsapp_accounts(id) ON DELETE CASCADE,

      conversation_id       TEXT,
      message_id            TEXT,
      contact_number        TEXT,

      -- The extracted structured data itself (shape defined by
      -- zoho_field_mappings.field_key per workspace/account — never
      -- hardcoded here), plus the model's confidence and the evidence
      -- (e.g. quoted source text/message ids) it based the extraction on.
      extracted_data        JSONB NOT NULL DEFAULT '{}'::jsonb,
      confidence             NUMERIC(4,3),
      evidence              JSONB NOT NULL DEFAULT '[]'::jsonb,

      status                TEXT NOT NULL DEFAULT 'pending_review',
      reviewed_by           BIGINT REFERENCES coexistence.akchat_users(id) ON DELETE SET NULL,
      reviewed_at           TIMESTAMPTZ,

      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT zoho_extraction_audit_status_check
        CHECK (status IN (${ZOHO_EXTRACTION_STATUSES.map((s) => `'${s}'`).join(', ')})),
      CONSTRAINT zoho_extraction_audit_confidence_range_check
        CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_zoho_extraction_audit_workspace_id
      ON coexistence.zoho_extraction_audit (workspace_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_zoho_extraction_audit_whatsapp_account_id
      ON coexistence.zoho_extraction_audit (whatsapp_account_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_zoho_extraction_audit_contact_number
      ON coexistence.zoho_extraction_audit (contact_number)
      WHERE contact_number IS NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_zoho_extraction_audit_status
      ON coexistence.zoho_extraction_audit (workspace_id, status)
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION coexistence.zoho_extraction_audit_touch_updated_at()
    RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    DROP TRIGGER IF EXISTS trg_zoho_extraction_audit_touch_updated_at ON coexistence.zoho_extraction_audit
  `);
  await pool.query(`
    CREATE TRIGGER trg_zoho_extraction_audit_touch_updated_at
      BEFORE UPDATE ON coexistence.zoho_extraction_audit
      FOR EACH ROW EXECUTE FUNCTION coexistence.zoho_extraction_audit_touch_updated_at()
  `);
  // ── 5. coexistence.zoho_lead_notes ──────────────────────────────────────
  // Phase 8C Part 2 — additive-only. Idempotency ledger for Zoho CRM Notes
  // created against an already-linked Lead (coexistence.zoho_lead_links).
  // A Note is a repeatable sub-resource (many Notes can legitimately exist
  // per Lead over time), unlike zoho_lead_links' "at most one Lead per
  // contact" identity — so this is a NEW table rather than a column bolted
  // onto zoho_lead_links, per spec §3 ("smallest safe change" that does not
  // distort an existing table's identity).
  //
  // idempotency_key is a SHA-256 hex digest of the (title, content) the
  // caller supplied (see zohoNoteService.computeIdempotencyKey), or a
  // caller-supplied key when one is provided. Same atomic-claim pattern as
  // zoho_lead_links (spec §9B): `INSERT ... ON CONFLICT ... DO NOTHING
  // RETURNING *`, so a retried/duplicate submission of the *same* Note
  // event never creates a second Zoho Note — the UNIQUE constraint is the
  // concurrency guard, not a SELECT-then-INSERT race.
  //
  // Limitation (documented per spec §3): idempotency here is scoped to
  // "same lead + same idempotency key", using AKChat's own ledger — it
  // cannot detect or prevent a Note being created twice if the *caller*
  // computes a different idempotency key for what a human would consider
  // the same event (e.g. re-summarizing the same conversation with
  // slightly different wording). True cross-restart/crash reconciliation
  // (a stuck 'pending' row after a crash between the Zoho call and the
  // status update) is the same two-system-write limitation zohoLeadService.js
  // documents for zoho_lead_links, deferred to the future retry/audit
  // architecture (8H) — this table does not attempt to solve it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.zoho_lead_notes (
      id                    BIGSERIAL PRIMARY KEY,
      workspace_id          BIGINT NOT NULL REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,
      whatsapp_account_id   BIGINT NOT NULL REFERENCES coexistence.whatsapp_accounts(id) ON DELETE CASCADE,
      zoho_connection_id    BIGINT NOT NULL REFERENCES coexistence.zoho_connections(id) ON DELETE CASCADE,

      zoho_lead_id          TEXT NOT NULL,
      contact_number        TEXT NOT NULL,
      idempotency_key       TEXT NOT NULL,
      zoho_note_id          TEXT,

      status                TEXT NOT NULL DEFAULT 'pending',
      last_error            TEXT,

      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT zoho_lead_notes_status_check
        CHECK (status IN ('pending', 'synced', 'failed')),

      -- Idempotency guarantee (spec §3, §9): one Note row per (workspace,
      -- whatsapp account, Zoho Lead, idempotency key) — a retried identical
      -- submission is resolved by reading this row back, never by calling
      -- Zoho's Notes API a second time.
      CONSTRAINT uq_zoho_lead_notes_identity
        UNIQUE (workspace_id, whatsapp_account_id, zoho_lead_id, idempotency_key)
    )
  `);
  // ── Phase 8 Zoho Note Consolidation FIX — additive column ──────────────
  // note_fields stores the CURRENT structured, already-merged contents of
  // the single consolidated "AKChat conversation sync" Note for a Lead
  // (see zohoNoteService.js's upsertConversationNote): { name, location,
  // email, phone, interest, dynamic: { [fieldKey]: { label, value } } }.
  // This is AKChat-side bookkeeping only (never sent to Zoho as-is; Zoho
  // only ever receives the rendered plain-text Note_Content) — it exists so
  // a later sync can merge newly-confirmed information into what's already
  // in the Note without re-reading it back from Zoho and without
  // duplicating a line that's already present. Nullable-safe default of
  // '{}' so every pre-existing row (created before this column existed)
  // reads back as "nothing recorded yet" rather than NULL-related errors.
  await pool.query(`
    ALTER TABLE coexistence.zoho_lead_notes
      ADD COLUMN IF NOT EXISTS note_fields JSONB NOT NULL DEFAULT '{}'::jsonb
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_zoho_lead_notes_workspace_id
      ON coexistence.zoho_lead_notes (workspace_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_zoho_lead_notes_whatsapp_account_id
      ON coexistence.zoho_lead_notes (whatsapp_account_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_zoho_lead_notes_zoho_lead_id
      ON coexistence.zoho_lead_notes (zoho_lead_id)
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION coexistence.zoho_lead_notes_touch_updated_at()
    RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    DROP TRIGGER IF EXISTS trg_zoho_lead_notes_touch_updated_at ON coexistence.zoho_lead_notes
  `);
  await pool.query(`
    CREATE TRIGGER trg_zoho_lead_notes_touch_updated_at
      BEFORE UPDATE ON coexistence.zoho_lead_notes
      FOR EACH ROW EXECUTE FUNCTION coexistence.zoho_lead_notes_touch_updated_at()
  `);
}
module.exports = {
  ensureZohoTables,
  ZOHO_CONNECTION_STATUSES,
  ZOHO_DATA_CENTERS,
  ZOHO_LEAD_LINK_STATUSES,
  ZOHO_EXTRACTION_STATUSES,
};