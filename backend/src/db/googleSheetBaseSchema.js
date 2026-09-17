// Base tables for Google Sheet contact sync — these predate the workspace
// model (see googleSheetWorkspaceSchema.js's header) and were apparently
// never included in this codebase's own migrations, only assumed to exist.
// This file creates them in their pre-workspace shape; googleSheetWorkspaceSchema.js's
// ensureGoogleSheetWorkspaceColumns() then ALTERs them to add workspace_id,
// exactly as it already expects. Must run BEFORE that function — see index.js boot order.

const pool = require('../db');

async function ensureGoogleSheetBaseTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.google_sheet_settings (
      id                  BIGSERIAL PRIMARY KEY,
      sheet_url           TEXT NOT NULL,
      sheet_name          TEXT,
      is_active           BOOLEAN NOT NULL DEFAULT TRUE,
      last_synced_row     INTEGER NOT NULL DEFAULT 0,
      last_synced_at      TIMESTAMPTZ,
      last_error_at       TIMESTAMPTZ,
      last_error_message  TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.contact_sync_log (
      id                BIGSERIAL PRIMARY KEY,
      started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at       TIMESTAMPTZ,
      rows_read         INTEGER,
      contacts_created  INTEGER,
      contacts_updated  INTEGER,
      rows_skipped      INTEGER,
      status            TEXT,
      error_message     TEXT,
      triggered_by      TEXT
    )
  `);
}

module.exports = { ensureGoogleSheetBaseTables };