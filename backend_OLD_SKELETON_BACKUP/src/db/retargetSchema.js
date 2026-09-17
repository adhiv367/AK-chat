// Retarget module — schema for retarget_customers + import/sync support.
// Mirrors the ensure*Tables() pattern used by db/instagramSchema.js:
// idempotent CREATE TABLE IF NOT EXISTS, called once on server startup.

const pool = require('../db');

async function ensureRetargetTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.retarget_customers (
      id BIGSERIAL PRIMARY KEY,
      name TEXT,
      phone TEXT,
      email TEXT,
      exit_url TEXT,
      retarget_type TEXT,
      timestamp TIMESTAMPTZ,
      source TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_retarget_customers_phone ON coexistence.retarget_customers (phone)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_retarget_customers_status ON coexistence.retarget_customers (status)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_retarget_customers_created_at ON coexistence.retarget_customers (created_at DESC)
  `);

  // ── Sheet sync settings (single active row — same pattern as
  // coexistence.google_sheet_settings, but scoped to Retarget) ────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.retarget_sheet_settings (
      id BIGSERIAL PRIMARY KEY,
      sheet_url TEXT NOT NULL,
      sheet_name TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      last_synced_row INTEGER NOT NULL DEFAULT 0,
      last_synced_at TIMESTAMPTZ,
      last_error_at TIMESTAMPTZ,
      last_error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── Sync history — one row per CSV import / Excel import / Sheet sync run
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.retarget_sync_log (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      triggered_by TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      duration_ms INTEGER,
      rows_total INTEGER NOT NULL DEFAULT 0,
      rows_imported INTEGER NOT NULL DEFAULT 0,
      rows_updated INTEGER NOT NULL DEFAULT 0,
      rows_skipped INTEGER NOT NULL DEFAULT 0,
      rows_errored INTEGER NOT NULL DEFAULT 0,
      errors JSONB NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'running',
      error_message TEXT
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_retarget_sync_log_started_at ON coexistence.retarget_sync_log (started_at DESC)
  `);

  console.log('[Retarget] Tables ensured.');
}

module.exports = { ensureRetargetTables };