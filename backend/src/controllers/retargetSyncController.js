// Retarget module — Google Sheet sync controller.
// Connect a sheet, trigger a manual sync, and read sync history.
// No background scheduler here (per spec, only "Sync Now" is required for
// Retarget) — mirrors routes/googleSheetSettings.js for the parts that do
// overlap (settings CRUD + manual sync + log).
//
// Phase 3E fix: retargetSheetRepository.js and retargetImportService.js were
// both built (Phase 3C-4) to require workspaceId on every call — but this
// controller was never updated to read req.workspace and pass it through,
// so every call below ran with workspaceId=undefined. That collapsed every
// workspace's "connected sheet" onto a single NULL-scoped row and created
// Retarget customers / mirrored Contacts with no workspace attribution.
// Fixed by deriving workspaceId once per request from req.workspace.id
// (attachWorkspace middleware — see routes/retarget.js) and threading it
// through every repository/service call, exactly as routes/retarget.js
// already does for the other retarget endpoints. Never trust a workspaceId
// supplied by the client (query/body) — req.workspace is server-derived.

const retargetSheetRepository = require('../repositories/retargetSheetRepository');
const { fetchNewRetargetRows } = require('../services/retargetSheetService');
const { importRows } = require('../services/retargetImportService');

async function getSheetSettings(req, res) {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(400).json({ error: 'No workspace found for this account.' });

    const settings = await retargetSheetRepository.getSettings(workspaceId);
    res.json(settings);
  } catch (err) {
    console.error('[retarget] GET sheet settings error:', err.message);
    res.status(500).json({ error: 'Failed to load sheet settings' });
  }
}

async function connectSheet(req, res) {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(400).json({ error: 'No workspace found for this account.' });

    const { sheetUrl, sheetName } = req.body || {};
    if (!sheetUrl || !sheetUrl.trim()) {
      return res.status(400).json({ error: 'sheetUrl is required' });
    }
    const settings = await retargetSheetRepository.saveSettings({
      sheetUrl: sheetUrl.trim(),
      sheetName: sheetName?.trim() || null,
    }, workspaceId);
    res.json(settings);
  } catch (err) {
    console.error('[retarget] connect sheet error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to connect Google Sheet' });
  }
}

async function syncNow(req, res) {
  const workspaceId = req.workspace?.id ?? null;
  if (!workspaceId) return res.status(400).json({ error: 'No workspace found for this account.' });

  const settings = await retargetSheetRepository.getSettings(workspaceId);
  if (!settings) {
    return res.status(400).json({ error: 'No Google Sheet connected yet. Connect one first.' });
  }

  const log = await retargetSheetRepository.startSyncLog({ source: 'sheet_sync', triggeredBy: 'manual' }, workspaceId);

  try {
    const { newRows, totalDataRows } = await fetchNewRetargetRows(settings.sheet_url, settings.last_synced_row);
    const result = await importRows(newRows, 'sheet_sync', workspaceId);

    await retargetSheetRepository.updateCursor(settings.id, { lastSyncedRow: totalDataRows }, workspaceId);
    const finished = await retargetSheetRepository.finishSyncLog(log.id, result, workspaceId);

    res.json({ ok: true, ...result, log: finished });
  } catch (err) {
    console.error('[retarget] sync-now error:', err.message);
    await retargetSheetRepository.markError(settings.id, err.message, workspaceId);
    await retargetSheetRepository.failSyncLog(log.id, err.message, workspaceId);
    res.status(500).json({ error: err.message || 'Sync failed' });
  }
}

async function syncHistory(req, res) {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(400).json({ error: 'No workspace found for this account.' });

    const { limit = 20 } = req.query;
    const rows = await retargetSheetRepository.listSyncLog(limit, workspaceId);
    res.json(rows);
  } catch (err) {
    console.error('[retarget] sync history error:', err.message);
    res.status(500).json({ error: 'Failed to load sync history' });
  }
}

module.exports = { getSheetSettings, connectSheet, syncNow, syncHistory };


