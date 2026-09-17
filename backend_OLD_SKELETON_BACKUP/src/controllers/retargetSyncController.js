// Retarget module — Google Sheet sync controller.
// Connect a sheet, trigger a manual sync, and read sync history.
// No background scheduler here (per spec, only "Sync Now" is required for
// Retarget) — mirrors routes/googleSheetSettings.js for the parts that do
// overlap (settings CRUD + manual sync + log).

const retargetSheetRepository = require('../repositories/retargetSheetRepository');
const { fetchNewRetargetRows } = require('../services/retargetSheetService');
const { importRows } = require('../services/retargetImportService');

async function getSheetSettings(req, res) {
  try {
    const settings = await retargetSheetRepository.getSettings();
    res.json(settings);
  } catch (err) {
    console.error('[retarget] GET sheet settings error:', err.message);
    res.status(500).json({ error: 'Failed to load sheet settings' });
  }
}

async function connectSheet(req, res) {
  try {
    const { sheetUrl, sheetName } = req.body || {};
    if (!sheetUrl || !sheetUrl.trim()) {
      return res.status(400).json({ error: 'sheetUrl is required' });
    }
    const settings = await retargetSheetRepository.saveSettings({
      sheetUrl: sheetUrl.trim(),
      sheetName: sheetName?.trim() || null,
    });
    res.json(settings);
  } catch (err) {
    console.error('[retarget] connect sheet error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to connect Google Sheet' });
  }
}

async function syncNow(req, res) {
  const settings = await retargetSheetRepository.getSettings();
  if (!settings) {
    return res.status(400).json({ error: 'No Google Sheet connected yet. Connect one first.' });
  }

  const log = await retargetSheetRepository.startSyncLog({ source: 'sheet_sync', triggeredBy: 'manual' });

  try {
    const { newRows, totalDataRows } = await fetchNewRetargetRows(settings.sheet_url, settings.last_synced_row);
    const result = await importRows(newRows, 'sheet_sync');

    await retargetSheetRepository.updateCursor(settings.id, { lastSyncedRow: totalDataRows });
    const finished = await retargetSheetRepository.finishSyncLog(log.id, result);

    res.json({ ok: true, ...result, log: finished });
  } catch (err) {
    console.error('[retarget] sync-now error:', err.message);
    await retargetSheetRepository.markError(settings.id, err.message);
    await retargetSheetRepository.failSyncLog(log.id, err.message);
    res.status(500).json({ error: err.message || 'Sync failed' });
  }
}

async function syncHistory(req, res) {
  try {
    const { limit = 20 } = req.query;
    const rows = await retargetSheetRepository.listSyncLog(limit);
    res.json(rows);
  } catch (err) {
    console.error('[retarget] sync history error:', err.message);
    res.status(500).json({ error: 'Failed to load sync history' });
  }
}

module.exports = { getSheetSettings, connectSheet, syncNow, syncHistory };



