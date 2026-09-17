// Phase 7.5 — Meta Commerce Catalog Integration: DATABASE FOUNDATION.
//
// Purely additive. This file:
//   1. Widens the EXISTING coexistence.meta_catalog_connections table
//      (created by commerceSchema.js §12) with the columns a real
//      connect/sync flow needs — an encrypted token, a cached business_id,
//      and connect/sync/error timestamps — via ADD COLUMN IF NOT EXISTS.
//      No existing column is renamed, retyped, or dropped, and no existing
//      row's status/catalog_id/workspace_id/whatsapp_account_id changes.
//   2. Adds three nullable columns to the EXISTING coexistence.products
//      table (owned by commerceSchema.js) so a product's Meta sync state
//      can be tracked without touching meta_product_id, source, or any
//      other existing column/constraint.
//   3. Creates ONE new table, coexistence.meta_catalog_sync_log — the
//      outbound-sync analogue of catalogConnectionsSchema.js's
//      coexistence.catalog_sync_log (same columns/shape), so Meta push
//      syncs get their own history/audit trail without mixing with the
//      inbound catalog_connections import log.
//
// Nothing here touches coexistence.catalog_connections, catalog_sync_log,
// shopify_connections, shopify_sync_state, product_variants, collections,
// inventory_levels, carts, orders, or any WhatsApp/Zoho/Instagram/Campaign
// table. Nothing here modifies WhatsApp messaging, catalog-import (Phase
// 7.4), Shopify, Google Sheet, or CSV behavior.
//
// Token handling: access_token_encrypted stores AES-256-GCM ciphertext via
// util/crypto.js's encrypt() — never plaintext, never logged, never sent to
// the frontend (see serializeConnection() in
// services/metaCatalogConnectionService.js). This column is populated ONLY
// when a connection is made with a token distinct from the WhatsApp
// account's own token; when the existing whatsapp_accounts.access_token_encrypted
// is reused, this column stays NULL and is never copied/duplicated.
//
// Must run after:
//   - ensureCommerceTables()  (owns coexistence.meta_catalog_connections /
//     coexistence.products, and coexistence.workspaces /
//     coexistence.whatsapp_accounts FKs)
// See index.js boot order — placed directly after ensureCommerceTables().

const pool = require('../db');

const PRODUCT_META_SYNC_STATUSES = ['not_synced', 'pending', 'synced', 'error'];
const META_SYNC_LOG_STATUSES = ['running', 'success', 'error'];
const META_SYNC_LOG_TRIGGERS = ['manual', 'scheduler', 'retry'];

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

// ── 1. Widen coexistence.meta_catalog_connections ──────────────────────────
async function ensureMetaCatalogConnectionsColumns() {
  // Only populated when a connection needs a token distinct from the
  // WhatsApp account's own Cloud API token. NULL means "reuse the parent
  // whatsapp_accounts.access_token_encrypted" (the default and expected
  // path — see metaCatalogConnectionService.resolveAccessToken()).
  await pool.query(`
    ALTER TABLE coexistence.meta_catalog_connections
      ADD COLUMN IF NOT EXISTS access_token_encrypted TEXT
  `);
  // Cached Meta Business Manager id the catalog belongs to, so repeated
  // catalog-list calls don't have to re-resolve it from the WABA every time.
  await pool.query(`
    ALTER TABLE coexistence.meta_catalog_connections
      ADD COLUMN IF NOT EXISTS business_id TEXT
  `);
  await pool.query(`
    ALTER TABLE coexistence.meta_catalog_connections
      ADD COLUMN IF NOT EXISTS connected_at TIMESTAMPTZ
  `);
  await pool.query(`
    ALTER TABLE coexistence.meta_catalog_connections
      ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ
  `);
  await pool.query(`
    ALTER TABLE coexistence.meta_catalog_connections
      ADD COLUMN IF NOT EXISTS last_error TEXT
  `);
  await pool.query(`
    ALTER TABLE coexistence.meta_catalog_connections
      ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ
  `);
  // meta_catalog_connections predates this file and never got the standard
  // touch-trigger commerceSchema.js gives every other table it owns — add
  // it now (idempotent, harmless to re-run).
  await ensureTouchTrigger('meta_catalog_connections');
}

// ── 2. Per-product Meta sync state on coexistence.products ─────────────────
async function ensureProductMetaSyncColumns() {
  await pool.query(`
    ALTER TABLE coexistence.products
      ADD COLUMN IF NOT EXISTS meta_sync_status TEXT NOT NULL DEFAULT 'not_synced'
  `);
  await pool.query(`
    ALTER TABLE coexistence.products
      ADD COLUMN IF NOT EXISTS meta_last_synced_at TIMESTAMPTZ
  `);
  await pool.query(`
    ALTER TABLE coexistence.products
      ADD COLUMN IF NOT EXISTS meta_last_error TEXT
  `);
  // DROP+ADD CHECK is idempotent and purely additive to the allowed set —
  // never removes a previously-valid value, so no existing row can be
  // invalidated (same convention as
  // commerceSchema.js's ensureProductSourceConstraintWidened()).
  await pool.query(`ALTER TABLE coexistence.products DROP CONSTRAINT IF EXISTS products_meta_sync_status_check`);
  await pool.query(`
    ALTER TABLE coexistence.products ADD CONSTRAINT products_meta_sync_status_check
      CHECK (meta_sync_status IN (${PRODUCT_META_SYNC_STATUSES.map((s) => `'${s}'`).join(', ')}))
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_products_meta_sync_status
      ON coexistence.products (workspace_id, meta_sync_status)
  `);
}

// ── 3. coexistence.meta_catalog_sync_log ────────────────────────────────────
// Outbound-push analogue of coexistence.catalog_sync_log (Phase 7.4,
// inbound import). Kept as its own table rather than reusing
// catalog_sync_log so the two sync directions (pull-in vs push-out) never
// share rows/status semantics, and so nothing about the existing inbound
// import log's shape or constraints needs to change.
async function ensureMetaCatalogSyncLogTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.meta_catalog_sync_log (
      id                BIGSERIAL PRIMARY KEY,
      workspace_id      BIGINT NOT NULL
        REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,
      whatsapp_account_id BIGINT
        REFERENCES coexistence.whatsapp_accounts(id) ON DELETE SET NULL,
      connection_id     BIGINT
        REFERENCES coexistence.meta_catalog_connections(id) ON DELETE CASCADE,

      triggered_by      TEXT NOT NULL DEFAULT 'manual',
      status            TEXT NOT NULL DEFAULT 'running',

      rows_read         INTEGER NOT NULL DEFAULT 0,
      rows_created      INTEGER NOT NULL DEFAULT 0,
      rows_updated      INTEGER NOT NULL DEFAULT 0,
      rows_failed       INTEGER NOT NULL DEFAULT 0,
      error_message     TEXT,

      started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at       TIMESTAMPTZ,

      CONSTRAINT meta_catalog_sync_log_status_check
        CHECK (status IN (${META_SYNC_LOG_STATUSES.map((s) => `'${s}'`).join(', ')})),
      CONSTRAINT meta_catalog_sync_log_triggered_by_check
        CHECK (triggered_by IN (${META_SYNC_LOG_TRIGGERS.map((s) => `'${s}'`).join(', ')}))
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_meta_catalog_sync_log_workspace_id ON coexistence.meta_catalog_sync_log (workspace_id, started_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_meta_catalog_sync_log_connection_id ON coexistence.meta_catalog_sync_log (connection_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_meta_catalog_sync_log_whatsapp_account_id ON coexistence.meta_catalog_sync_log (whatsapp_account_id)`);
}

async function ensureMetaCatalogTables() {
  await ensureMetaCatalogConnectionsColumns();
  await ensureProductMetaSyncColumns();
  await ensureMetaCatalogSyncLogTable();
}

module.exports = {
  ensureMetaCatalogTables,
  ensureMetaCatalogConnectionsColumns,
  ensureProductMetaSyncColumns,
  ensureMetaCatalogSyncLogTable,
  PRODUCT_META_SYNC_STATUSES,
  META_SYNC_LOG_STATUSES,
  META_SYNC_LOG_TRIGGERS,
};







