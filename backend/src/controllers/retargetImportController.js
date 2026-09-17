// Retarget module — import controller.
// Handles multipart/form-data CSV/Excel uploads (field name "file").
// Every run — success or failure — is recorded in retarget_sync_log so it
// shows up in Sync History alongside Google Sheet syncs.
//
// Phase 3F-1 fix: retargetImportService.importFromBuffer() and every
// retargetSheetRepository.*SyncLog() call require workspaceId — but this
// controller never read req.workspace and never passed one through, so
// every CSV/Excel import ran with workspaceId=undefined. That created
// Retarget customers (and their mirrored Contacts) with workspace_id NULL,
// invisible to the uploading workspace, and logged the run under a
// NULL-scoped sync_log row. This is the same class of bug already fixed for
// the Google Sheet sync path in retargetSyncController.js (see that file's
// "Phase 3E fix" note) — fixed here the same way: derive workspaceId once
// from req.workspace.id (attachWorkspace middleware, mounted ahead of this
// router in index.js) and thread it through every call. Never trust a
// workspaceId supplied by the client (query/body/params).

const retargetImportService = require('../services/retargetImportService');
const retargetSheetRepository = require('../repositories/retargetSheetRepository');

async function importFile(req, res) {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const workspaceId = req.workspace?.id ?? null;
  if (!workspaceId) return res.status(400).json({ error: 'No workspace found for this account.' });

  const filename = req.file.originalname || '';
  const source = filename.toLowerCase().endsWith('.csv') ? 'csv_import' : 'excel_import';

  const log = await retargetSheetRepository.startSyncLog({ source, triggeredBy: 'manual' }, workspaceId);

  try {
    const result = await retargetImportService.importFromBuffer(req.file.buffer, filename, source, workspaceId);
    await retargetSheetRepository.finishSyncLog(log.id, result, workspaceId);
    res.json({ ok: true, ...result, logId: log.id });
  } catch (err) {
    await retargetSheetRepository.failSyncLog(log.id, err.message, workspaceId);
    const status = err.status || 500;
    if (status !== 500) return res.status(status).json({ error: err.message });
    console.error('[retarget] import error:', err.message);
    res.status(500).json({ error: 'Failed to import file' });
  }
}

module.exports = { importFile };