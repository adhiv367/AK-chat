// Phase 7.4 — Universal Catalog Connection Layer: DATABASE FOUNDATION.
//
// One generic, source-agnostic connection table instead of a bespoke table
// per source (Shopify/Website/Google Sheet/CSV/Manual). This mirrors the
// existing coexistence.shopify_connections shape (workspace-scoped,
// encrypted-secret column, status lifecycle) but is not source-specific —
// `source` is a plain column reusing PRODUCT_SOURCES from commerceSchema.js,
// and `config` is a JSONB bag whose shape depends on `source`:
//   shopify       -> { shopDomain }                (token lives encrypted in `secret_encrypted`)
//   website       -> { feedUrl, format }            ('json' | 'csv')
//   google_sheet  -> { sheetUrl, sheetName }
//   csv           -> {}                              (no persistent config; each run is a manual upload)
//   manual        -> not applicable — manual entry never creates a connection row
//
// Same idempotent CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS +
// updated_at touch-trigger convention as commerceSchema.js / zohoSchema.js.
// Must run after ensureWorkspaceTables() and ensureCommerceTables() (FKs
// coexistence.workspaces; source values are validated against the same
// PRODUCT_SOURCES list commerceSchema.js already owns). See index.js boot
// order.
//
// Nothing here touches coexistence.products/product_variants/collections/
// inventory_levels or coexistence.shopify_connections/shopify_sync_state —
// this is a pure additive schema change that existing sync jobs (Shopify
// OAuth, if/when built) may migrate onto later, but 7.4 does not require
// that migration to ship.

const pool = require('../db');
const { PRODUCT_SOURCES } = require('./commerceSchema');

// Manual entry never needs a connection row (there's nothing to "connect" —
// products are typed in directly via the existing Product form/API), and
// 'other'/'meta' are reserved for future/legacy sources this layer doesn't
// drive yet.
const CONNECTABLE_SOURCES = ['shopify', 'website', 'google_sheet', 'csv'];

const CONNECTION_STATUSES = ['disconnected', 'connected', 'syncing', 'error'];
const SYNC_LOG_STATUSES = ['running', 'success', 'error'];
const SYNC_LOG_TRIGGERS = ['manual', 'scheduler', 'upload'];

function touchTriggerName(table) {
  return `trg_${table}_touch_updated_at`;
}
function touchFunctionName(table) {
  return `coexistence.${table}_touch_updated_at`;
}

async function ensureTouchTrigger(table) {
  await pool.query(`
    CREATE OR REPLACE FUNCTION ${touchFunctionName(table)}()
    RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`DROP TRIGGER IF EXISTS ${touchTriggerName(table)} ON coexistence.${table}`);
  await pool.query(`
    CREATE TRIGGER ${touchTriggerName(table)}
      BEFORE UPDATE ON coexistence.${table}
      FOR EACH ROW EXECUTE FUNCTION ${touchFunctionName(table)}()
  `);
}

async function ensureCatalogConnectionsTables() {
  // ── 1. coexistence.catalog_connections ──────────────────────────────────
  // One row per (workspace, source) — a workspace can have at most one
  // active connection per source, same invariant google_sheet_settings
  // already enforces for its single sheet-per-workspace case.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.catalog_connections (
      id                    BIGSERIAL PRIMARY KEY,
      workspace_id          BIGINT NOT NULL
        REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,

      source                TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'disconnected',
      config                JSONB NOT NULL DEFAULT '{}'::jsonb,

      -- AES-256-GCM ciphertext via util/crypto.js's encrypt() — e.g. a
      -- Shopify Admin API access token. Never plaintext, never logged,
      -- never serialized to the frontend. NULL for sources with no secret
      -- (google_sheet/website public feed, csv upload).
      secret_encrypted      TEXT,

      last_synced_at        TIMESTAMPTZ,
      last_error            TEXT,
      last_error_at         TIMESTAMPTZ,

      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT catalog_connections_source_check
        CHECK (source IN (${PRODUCT_SOURCES.map((s) => `'${s}'`).join(', ')})),
      CONSTRAINT catalog_connections_status_check
        CHECK (status IN (${CONNECTION_STATUSES.map((s) => `'${s}'`).join(', ')})),

      CONSTRAINT uq_catalog_connections_workspace_source
        UNIQUE (workspace_id, source)
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_catalog_connections_workspace_id ON coexistence.catalog_connections (workspace_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_catalog_connections_status ON coexistence.catalog_connections (workspace_id, status)`);

  await ensureTouchTrigger('catalog_connections');

  // ── 2. coexistence.catalog_sync_log ─────────────────────────────────────
  // Same shape as coexistence.contact_sync_log (Google Sheet contact sync)
  // — history/audit trail for every catalog import run, whether triggered
  // by a manual "Sync Now", the background scheduler, or a one-off CSV
  // upload.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.catalog_sync_log (
      id                BIGSERIAL PRIMARY KEY,
      workspace_id      BIGINT NOT NULL
        REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,
      connection_id     BIGINT
        REFERENCES coexistence.catalog_connections(id) ON DELETE CASCADE,

      source            TEXT NOT NULL,
      triggered_by      TEXT NOT NULL DEFAULT 'manual',
      status            TEXT NOT NULL DEFAULT 'running',

      rows_read         INTEGER NOT NULL DEFAULT 0,
      rows_created      INTEGER NOT NULL DEFAULT 0,
      rows_updated      INTEGER NOT NULL DEFAULT 0,
      rows_failed       INTEGER NOT NULL DEFAULT 0,
      error_message     TEXT,

      started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at       TIMESTAMPTZ,

      CONSTRAINT catalog_sync_log_source_check
        CHECK (source IN (${PRODUCT_SOURCES.map((s) => `'${s}'`).join(', ')})),
      CONSTRAINT catalog_sync_log_status_check
        CHECK (status IN (${SYNC_LOG_STATUSES.map((s) => `'${s}'`).join(', ')})),
      CONSTRAINT catalog_sync_log_triggered_by_check
        CHECK (triggered_by IN (${SYNC_LOG_TRIGGERS.map((s) => `'${s}'`).join(', ')}))
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_catalog_sync_log_workspace_id ON coexistence.catalog_sync_log (workspace_id, started_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_catalog_sync_log_connection_id ON coexistence.catalog_sync_log (connection_id)`);
}
module.exports = {
  ensureCatalogConnectionsTables,
  CONNECTABLE_SOURCES,
  CONNECTION_STATUSES,
  SYNC_LOG_STATUSES,
  SYNC_LOG_TRIGGERS,
};