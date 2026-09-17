// Phase 6.1 — WhatsApp Flows: DATABASE FOUNDATION ONLY.
//
// This file creates THREE new, additive tables. No Flow UI, no Meta API
// integration, no Flow sending, and no webhook.js changes exist yet — that
// is explicitly out of scope for 6.1. This mirrors the zohoSchema.js /
// sequencesSchema.js convention: idempotent `CREATE TABLE IF NOT EXISTS` +
// `CREATE INDEX IF NOT EXISTS`, plain-TEXT + CHECK-constraint enums (not
// Postgres ENUM types) so future values can be added with a constraint
// migration, not a type migration.
//
// ── relationship this schema is built around ───────────────────────────
//   coexistence.workspaces          (existing, workspaceSchema.js)
//         │
//   coexistence.whatsapp_accounts   (existing table; workspace_id added by
//         │                          whatsappAccountsSchema.js)
//         ▼
//   coexistence.flows               (NEW — this file)
//         │  one row per Flow definition, scoped to a workspace and
//         │  optionally a specific WhatsApp account
//         ▼
//   coexistence.flow_versions       (NEW — this file)
//         │  one row per published/draft version of a flow's JSON
//         ▼
//   coexistence.flow_submissions    (NEW — this file)
//            one row per inbound Flow response from a contact
//
// Nothing here touches Zoho Integration, Campaign Studio, Automation
// Builder, CRM, Contacts, WhatsApp accounts, Authentication, Permissions,
// Phase 2 functionality, existing webhook behavior, existing message
// sending, or existing queues. This is a pure additive schema change.
//
// Must run after:
//   - ensureWorkspaceTables()             (FKs coexistence.workspaces)
//   - ensureWhatsappAccountsSaasColumns() (FKs coexistence.whatsapp_accounts)
//   - ensureTables()                      (FKs coexistence.akchat_users via created_by)
// See index.js boot order.

const pool = require('../db');

const FLOW_STATUSES = ['draft', 'published', 'deprecated'];

async function ensureFlowsTables() {
  // ── Table 1: flows ─────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.flows (
      id                   BIGSERIAL PRIMARY KEY,
      workspace_id         BIGINT NOT NULL
        REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,
      whatsapp_account_id  BIGINT
        REFERENCES coexistence.whatsapp_accounts(id) ON DELETE SET NULL,
      name                 TEXT NOT NULL,
      status               TEXT NOT NULL DEFAULT 'draft',
      field_mapping        JSONB NOT NULL DEFAULT '{}',
      created_by           BIGINT
        REFERENCES coexistence.akchat_users(id) ON DELETE SET NULL,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT flows_status_check CHECK (status IN (${FLOW_STATUSES.map((s) => `'${s}'`).join(', ')}))
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_flows_workspace_id
      ON coexistence.flows (workspace_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_flows_whatsapp_account_id
      ON coexistence.flows (whatsapp_account_id)
  `);

  // ── Table 2: flow_versions ─────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.flow_versions (
      id              BIGSERIAL PRIMARY KEY,
      flow_id         BIGINT NOT NULL
        REFERENCES coexistence.flows(id) ON DELETE CASCADE,
      version_number  INTEGER NOT NULL,
      flow_json       JSONB NOT NULL,
      meta_flow_id    TEXT,
      meta_status     TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT flow_versions_flow_id_version_number_key UNIQUE (flow_id, version_number)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_flow_versions_flow_id
      ON coexistence.flow_versions (flow_id)
  `);

  // ── Table 3: flow_submissions ──────────────────────────────────────
  // message_id is UNIQUE — this is the Flow submission idempotency key.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.flow_submissions (
      id                BIGSERIAL PRIMARY KEY,
      flow_id           BIGINT NOT NULL
        REFERENCES coexistence.flows(id) ON DELETE CASCADE,
      flow_version_id   BIGINT
        REFERENCES coexistence.flow_versions(id) ON DELETE SET NULL,
      workspace_id      BIGINT NOT NULL
        REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,
      contact_number    TEXT NOT NULL,
      message_id        TEXT NOT NULL UNIQUE,
      flow_token        TEXT,
      response_json     JSONB NOT NULL,
      parse_error       BOOLEAN NOT NULL DEFAULT false,
      mapped_at         TIMESTAMPTZ,
      received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_flow_submissions_flow_id
      ON coexistence.flow_submissions (flow_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_flow_submissions_workspace_id
      ON coexistence.flow_submissions (workspace_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_flow_submissions_contact_number
      ON coexistence.flow_submissions (contact_number)
  `);
}

module.exports = { ensureFlowsTables, FLOW_STATUSES };




