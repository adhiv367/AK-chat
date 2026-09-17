// Phase 7.4 — Catalog Connection Layer: routes.
//
// Mounted under /api (see index.js changes — same slot as
// googleSheetSettings.js). Every statement is scoped to req.workspace.id
// (attachWorkspace middleware, mounted before this router in index.js) —
// never a client-supplied value — same isolation model as
// routes/products.js and routes/googleSheetSettings.js.
//
// Permission model: reuses the existing 'products' page-permission key
// (permissions.js) for read/connect actions — no new permission added —
// and adminOnly for anything that stores a secret or triggers a sync,
// mirroring googleSheetSettings.js's adminOnly-on-write pattern.

const { Router } = require('express');
const multer = require('multer');
const pool = require('../db');
const { requirePermission, adminOnly } = require('../middleware/access');
const { encrypt } = require('../util/crypto');
const { runImport } = require('../services/catalogImportService');
const { runSyncTickForConnection } = require('../services/catalogSyncScheduler');
const { CONNECTABLE_SOURCES } = require('../db/catalogConnectionsSchema');

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function serializeConnection(row) {
  if (!row) return null;
  const { secret_encrypted, ...rest } = row;
  return { ...rest, hasSecret: !!secret_encrypted };
}

// GET /api/catalog-connections — every connection for this workspace
router.get('/catalog-connections', requirePermission('products'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(400).json({ error: 'No workspace found for this account.' });

    const { rows } = await pool.query(
      `SELECT * FROM coexistence.catalog_connections WHERE workspace_id = $1 ORDER BY source`,
      [workspaceId]
    );
    res.json(rows.map(serializeConnection));
  } catch (err) {
    console.error('[catalogConnections] list error:', err.message);
    res.status(500).json({ error: 'Failed to load catalog connections' });
  }
});

// POST /api/catalog-connections — create/update a connection (Shopify, Website, Google Sheet)
// body: { source, config: {...}, secret? }
router.post('/catalog-connections', adminOnly, async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(400).json({ error: 'No workspace found for this account.' });

    const { source, config, secret } = req.body || {};
    if (!CONNECTABLE_SOURCES.includes(source)) {
      return res.status(400).json({ error: `source must be one of: ${CONNECTABLE_SOURCES.join(', ')}` });
    }

    const secretEncrypted = secret ? encrypt(secret) : null;

    const { rows } = await pool.query(
      `INSERT INTO coexistence.catalog_connections (workspace_id, source, config, secret_encrypted, status)
       VALUES ($1, $2, $3, $4, 'connected')
       ON CONFLICT (workspace_id, source) DO UPDATE
         SET config = EXCLUDED.config,
             secret_encrypted = COALESCE(EXCLUDED.secret_encrypted, coexistence.catalog_connections.secret_encrypted),
             status = 'connected',
             last_error = NULL, last_error_at = NULL, updated_at = NOW()
       RETURNING *`,
      [workspaceId, source, config || {}, secretEncrypted]
    );
    res.json(serializeConnection(rows[0]));
  } catch (err) {
    console.error('[catalogConnections] save error:', err.message);
    res.status(500).json({ error: 'Failed to save catalog connection' });
  }
});

// DELETE /api/catalog-connections/:source — disconnect
router.delete('/catalog-connections/:source', adminOnly, async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(400).json({ error: 'No workspace found for this account.' });

    await pool.query(
      `DELETE FROM coexistence.catalog_connections WHERE workspace_id = $1 AND source = $2`,
      [workspaceId, req.params.source]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[catalogConnections] delete error:', err.message);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

// POST /api/catalog-connections/:source/sync-now — manual sync trigger (Shopify/Website/Google Sheet)
router.post('/catalog-connections/:source/sync-now', adminOnly, async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(400).json({ error: 'No workspace found for this account.' });

    const { rows } = await pool.query(
      `SELECT * FROM coexistence.catalog_connections WHERE workspace_id = $1 AND source = $2`,
      [workspaceId, req.params.source]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Connection not found' });

    await runSyncTickForConnection(rows[0], 'manual');
    res.json({ ok: true });
  } catch (err) {
    console.error('[catalogConnections] sync-now error:', err.message);
    res.status(500).json({ error: 'Sync failed' });
  }
});

// POST /api/catalog-connections/csv-import — one-off CSV/Excel upload (no persistent connection)
router.post('/catalog-connections/csv-import', adminOnly, upload.single('file'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(400).json({ error: 'No workspace found for this account.' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // CSV has no persistent config; upsert (or reuse) a lightweight
    // connection row purely so this run shows up in the same connections
    // list / sync log as the other sources.
    const { rows } = await pool.query(
      `INSERT INTO coexistence.catalog_connections (workspace_id, source, config, status, last_synced_at)
       VALUES ($1, 'csv', '{}'::jsonb, 'connected', NOW())
       ON CONFLICT (workspace_id, source) DO UPDATE
         SET status = 'connected', last_synced_at = NOW(), updated_at = NOW()
       RETURNING *`,
      [workspaceId]
    );
    const connection = rows[0];

    const result = await runImport(workspaceId, connection, {
      triggeredBy: 'upload',
      context: { buffer: req.file.buffer, filename: req.file.originalname },
    });
    res.json(result);
  } catch (err) {
    console.error('[catalogConnections] csv-import error:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Import failed' });
  }
});

// GET /api/catalog-connections/sync-log — recent import runs for this workspace
router.get('/catalog-connections/sync-log', requirePermission('products'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(400).json({ error: 'No workspace found for this account.' });

    const { rows } = await pool.query(
      `SELECT * FROM coexistence.catalog_sync_log
        WHERE workspace_id = $1
        ORDER BY started_at DESC LIMIT 50`,
      [workspaceId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[catalogConnections] sync-log error:', err.message);
    res.status(500).json({ error: 'Failed to load sync log' });
  }
});

module.exports = { router };

