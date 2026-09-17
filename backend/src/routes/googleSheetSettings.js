// One-time Google Sheet configuration + manual sync trigger + sync log.
// Mounted under /api (see index.js changes). Admin-only for write actions;
// any authenticated user with access to the target-message page can view.
//
// Phase 3E fix: every query here used to read/write the single "active"
// settings row globally, with no workspace filter — so any workspace's
// admin could see/overwrite another workspace's sheet connection, and
// "Sync Now" (via services/sheetSyncScheduler.js#runSyncTick) synced every
// workspace's sheet at once from one button click. google_sheet_settings
// and contact_sync_log now carry workspace_id (db/googleSheetWorkspaceSchema.js),
// so every statement below is scoped to req.workspace.id (attachWorkspace
// middleware, mounted before this router in index.js) — never a client-
// supplied value — and "Sync Now" runs only this workspace's tick via
// runSyncTickForWorkspace(), not the global runSyncTick().

const { Router } = require('express');
const pool = require('../db');
const { requirePermission, adminOnly } = require('../middleware/access');
const { runSyncTickForWorkspace } = require('../services/sheetSyncScheduler');

const router = Router();

// GET /api/google-sheet-settings — current config for this workspace (or null if never set up)
router.get('/google-sheet-settings', requirePermission('admin-settings:general'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(400).json({ error: 'No workspace found for this account.' });

    const { rows } = await pool.query(
      `SELECT id, sheet_url, sheet_name, is_active, last_synced_row, last_synced_at,
              last_error_at, last_error_message, created_at, updated_at
         FROM coexistence.google_sheet_settings
        WHERE workspace_id = $1
        ORDER BY id DESC LIMIT 1`,
      [workspaceId]
    );
    res.json(rows[0] || null);
  } catch (err) {
    console.error('[googleSheetSettings] get error:', err.message);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// POST /api/google-sheet-settings — save (one row per workspace; upserts this workspace's config row)
router.post('/google-sheet-settings', adminOnly, async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(400).json({ error: 'No workspace found for this account.' });

    const { sheetUrl, sheetName } = req.body || {};
    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl is required' });

    const { rows: existing } = await pool.query(
      `SELECT id, sheet_url FROM coexistence.google_sheet_settings
        WHERE workspace_id = $1
        ORDER BY id DESC LIMIT 1`,
      [workspaceId]
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
          WHERE id = $3 AND workspace_id = $4
          RETURNING *`,
        [sheetUrl.trim(), sheetName || null, existing[0].id, workspaceId]
      );
      row = rows[0];
    } else {
      const { rows } = await pool.query(
        `INSERT INTO coexistence.google_sheet_settings (workspace_id, sheet_url, sheet_name)
         VALUES ($1, $2, $3) RETURNING *`,
        [workspaceId, sheetUrl.trim(), sheetName || null]
      );
      row = rows[0];
    }
    res.json(row);
  } catch (err) {
    console.error('[googleSheetSettings] save error:', err.message);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// POST /api/google-sheet-settings/sync-now — trigger an immediate sync tick for THIS workspace only
router.post('/google-sheet-settings/sync-now', adminOnly, async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(400).json({ error: 'No workspace found for this account.' });

    const { rows } = await pool.query(
      `SELECT * FROM coexistence.google_sheet_settings WHERE workspace_id = $1 AND is_active = TRUE ORDER BY id DESC LIMIT 1`,
      [workspaceId]
    );
    const settings = rows[0];
    if (!settings) return res.status(400).json({ error: 'No Google Sheet connected yet. Connect one first.' });

    await runSyncTickForWorkspace(settings, 'manual');
    res.json({ ok: true });
  } catch (err) {
    console.error('[googleSheetSettings] sync-now error:', err.message);
    res.status(500).json({ error: err.message || 'Sync failed' });
  }
});

// GET /api/google-sheet-settings/sync-log — last 20 sync runs for this workspace
router.get('/google-sheet-settings/sync-log', requirePermission('admin-settings:general'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(400).json({ error: 'No workspace found for this account.' });

    const { rows } = await pool.query(
      `SELECT id, started_at, finished_at, rows_read, contacts_created, contacts_updated,
              rows_skipped, status, error_message, triggered_by
         FROM coexistence.contact_sync_log
        WHERE workspace_id = $1
        ORDER BY started_at DESC LIMIT 20`,
      [workspaceId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[googleSheetSettings] sync-log error:', err.message);
    res.status(500).json({ error: 'Failed to load sync log' });
  }
});

module.exports = { router };

