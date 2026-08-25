// Retarget module — sheet settings + sync history repository.
// Owns every SQL statement against coexistence.retarget_sheet_settings and
// coexistence.retarget_sync_log. Same layering rule as retargetRepository.js:
// nothing above this layer should touch `pool` directly.

const pool = require('../db');

const SETTINGS_COLUMNS = `
  id, sheet_url, sheet_name, is_active, last_synced_row, last_synced_at,
  last_error_at, last_error_message, created_at, updated_at
`;

// ── Sheet settings (single active row) ──────────────────────────────────
async function getSettings() {
  const { rows } = await pool.query(
    `SELECT ${SETTINGS_COLUMNS} FROM coexistence.retarget_sheet_settings
      ORDER BY id DESC LIMIT 1`
  );
  return rows[0] || null;
}

// Upserts the single settings row. Changing the sheet URL resets the sync
// cursor, otherwise rows in a brand-new sheet would be skipped as
// "already synced" (same rule as routes/googleSheetSettings.js).
async function saveSettings({ sheetUrl, sheetName }) {
  const existing = await getSettings();

  if (existing) {
    const resetCursor = existing.sheet_url !== sheetUrl;
    const { rows } = await pool.query(
      `UPDATE coexistence.retarget_sheet_settings
          SET sheet_url = $1, sheet_name = $2, is_active = TRUE, updated_at = NOW()
              ${resetCursor ? ', last_synced_row = 0, last_synced_at = NULL' : ''}
        WHERE id = $3
        RETURNING ${SETTINGS_COLUMNS}`,
      [sheetUrl, sheetName || null, existing.id]
    );
    return rows[0];
  }

  const { rows } = await pool.query(
    `INSERT INTO coexistence.retarget_sheet_settings (sheet_url, sheet_name)
     VALUES ($1, $2) RETURNING ${SETTINGS_COLUMNS}`,
    [sheetUrl, sheetName || null]
  );
  return rows[0];
}

async function updateCursor(id, { lastSyncedRow, errorMessage = null }) {
  const { rows } = await pool.query(
    `UPDATE coexistence.retarget_sheet_settings
        SET last_synced_row = $1, last_synced_at = NOW(),
            last_error_at = $2::timestamptz, last_error_message = $3, updated_at = NOW()
      WHERE id = $4
      RETURNING ${SETTINGS_COLUMNS}`,
    [lastSyncedRow, errorMessage ? new Date().toISOString() : null, errorMessage, id]
  );
  return rows[0];
}

async function markError(id, errorMessage) {
  const { rows } = await pool.query(
    `UPDATE coexistence.retarget_sheet_settings
        SET last_error_at = NOW(), last_error_message = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING ${SETTINGS_COLUMNS}`,
    [String(errorMessage).slice(0, 500), id]
  );
  return rows[0];
}

// ── Sync history ─────────────────────────────────────────────────────────
async function startSyncLog({ source, triggeredBy = null }) {
  const { rows } = await pool.query(
    `INSERT INTO coexistence.retarget_sync_log (source, triggered_by, status)
     VALUES ($1, $2, 'running') RETURNING id, started_at`,
    [source, triggeredBy]
  );
  return rows[0];
}

async function finishSyncLog(id, { total = 0, imported = 0, updated = 0, skipped = 0, errors = [] } = {}) {
  const { rows } = await pool.query(
    `UPDATE coexistence.retarget_sync_log
        SET finished_at = NOW(),
            duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000,
            rows_total = $1, rows_imported = $2, rows_updated = $3,
            rows_skipped = $4, rows_errored = $5, errors = $6::jsonb,
            status = 'success'
      WHERE id = $7
      RETURNING *`,
    [total, imported, updated, skipped, errors.length, JSON.stringify(errors), id]
  );
  return rows[0];
}

async function failSyncLog(id, errorMessage) {
  const { rows } = await pool.query(
    `UPDATE coexistence.retarget_sync_log
        SET finished_at = NOW(),
            duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000,
            status = 'error', error_message = $1
      WHERE id = $2
      RETURNING *`,
    [String(errorMessage).slice(0, 500), id]
  );
  return rows[0];
}

async function listSyncLog(limit = 20) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const { rows } = await pool.query(
    `SELECT id, source, triggered_by, started_at, finished_at, duration_ms,
            rows_total, rows_imported, rows_updated, rows_skipped, rows_errored,
            errors, status, error_message
       FROM coexistence.retarget_sync_log
       ORDER BY started_at DESC
       LIMIT $1`,
    [safeLimit]
  );
  return rows;
}

module.exports = {
  getSettings,
  saveSettings,
  updateCursor,
  markError,
  startSyncLog,
  finishSyncLog,
  failSyncLog,
  listSyncLog,
};