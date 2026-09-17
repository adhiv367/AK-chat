// One-time Google Sheet configuration + manual sync trigger + sync log.
// Mounted under /api (see index.js changes). Admin-only for write actions;
// any authenticated user with access to the target-message page can view.

const { Router } = require('express');
const pool = require('../db');
const { requirePermission, adminOnly } = require('../middleware/access');
const { runSyncTick } = require('../services/sheetSyncScheduler');

const router = Router();

// GET /api/google-sheet-settings — current config (or null if never set up)
router.get('/google-sheet-settings', requirePermission('admin-settings:general'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, sheet_url, sheet_name, is_active, last_synced_row, last_synced_at,
              last_error_at, last_error_message, created_at, updated_at
         FROM coexistence.google_sheet_settings ORDER BY id DESC LIMIT 1`
    );
    res.json(rows[0] || null);
  } catch (err) {
    console.error('[googleSheetSettings] get error:', err.message);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// POST /api/google-sheet-settings — save (one row only; upserts the single config row)
router.post('/google-sheet-settings', adminOnly, async (req, res) => {
  try {
    const { sheetUrl, sheetName } = req.body || {};
    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl is required' });

    const { rows: existing } = await pool.query(
      `SELECT id, sheet_url FROM coexistence.google_sheet_settings ORDER BY id DESC LIMIT 1`
    );

    let row;
    if (existing.length > 0) {
      // Changing the sheet URL resets the sync cursor — otherwise rows in a
      // brand-new sheet would be skipped as "already synced".
      const resetCursor = existing[0].sheet_url !== sheetUrl.trim();
      const { rows } = await pool.query(
        `UPDATE coexistence.google_sheet_settings
            SET sheet_url = $1, sheet_name = $2, is_active = TRUE, updated_at = NOW()
                ${resetCursor ? ', last_synced_row = 0, last_synced_at = NULL' : ''}
          WHERE id = $3
          RETURNING *`,
        [sheetUrl.trim(), sheetName || null, existing[0].id]
      );
      row = rows[0];
    } else {
      const { rows } = await pool.query(
        `INSERT INTO coexistence.google_sheet_settings (sheet_url, sheet_name)
         VALUES ($1, $2) RETURNING *`,
        [sheetUrl.trim(), sheetName || null]
      );
      row = rows[0];
    }
    res.json(row);
  } catch (err) {
    console.error('[googleSheetSettings] save error:', err.message);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// POST /api/google-sheet-settings/sync-now — trigger an immediate sync tick
router.post('/google-sheet-settings/sync-now', adminOnly, async (req, res) => {
  try {
    await runSyncTick('manual');
    res.json({ ok: true });
  } catch (err) {
    console.error('[googleSheetSettings] sync-now error:', err.message);
    res.status(500).json({ error: err.message || 'Sync failed' });
  }
});

// GET /api/google-sheet-settings/sync-log — last 20 sync runs
router.get('/google-sheet-settings/sync-log', requirePermission('admin-settings:general'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, started_at, finished_at, rows_read, contacts_created, contacts_updated,
              rows_skipped, status, error_message, triggered_by
         FROM coexistence.contact_sync_log ORDER BY started_at DESC LIMIT 20`
    );
    res.json(rows);
  } catch (err) {
    console.error('[googleSheetSettings] sync-log error:', err.message);
    res.status(500).json({ error: 'Failed to load sync log' });
  }
});

module.exports = { router };
