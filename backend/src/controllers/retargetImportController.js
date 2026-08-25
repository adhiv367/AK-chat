// Retarget module — import controller.
// Handles multipart/form-data CSV/Excel uploads (field name "file").
// Every run — success or failure — is recorded in retarget_sync_log so it
// shows up in Sync History alongside Google Sheet syncs.

const retargetImportService = require('../services/retargetImportService');
const retargetSheetRepository = require('../repositories/retargetSheetRepository');

async function importFile(req, res) {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const filename = req.file.originalname || '';
  const source = filename.toLowerCase().endsWith('.csv') ? 'csv_import' : 'excel_import';

  const log = await retargetSheetRepository.startSyncLog({ source, triggeredBy: 'manual' });

  try {
    const result = await retargetImportService.importFromBuffer(req.file.buffer, filename, source);
    await retargetSheetRepository.finishSyncLog(log.id, result);
    res.json({ ok: true, ...result, logId: log.id });
  } catch (err) {
    await retargetSheetRepository.failSyncLog(log.id, err.message);
    const status = err.status || 500;
    if (status !== 500) return res.status(status).json({ error: err.message });
    console.error('[retarget] import error:', err.message);
    res.status(500).json({ error: 'Failed to import file' });
  }
}

module.exports = { importFile };