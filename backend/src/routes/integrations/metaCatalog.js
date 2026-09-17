// Phase 7.5 — Meta Commerce Catalog Integration: routes.
//
// Mounted under /api (see index.js changes), after authMiddleware +
// attachWorkspace — same slot pattern as routes/catalogConnections.js.
// Every statement is scoped to req.workspace.id (never a client-supplied
// value) PLUS a :whatsappAccountId route param that every handler
// re-validates belongs to that workspace before touching anything —
// same double-scoping convention as routes/products.js's variant/collection
// sub-routes.
//
// Permission model: reuses the existing 'products' page-permission key for
// reads and adminOnly for connect/disconnect/sync/retry — no new
// permission key added, exactly mirroring routes/catalogConnections.js.

'use strict';

const { Router } = require('express');
const pool = require('../../db');
const { requirePermission, adminOnly } = require('../../middleware/access');
const connectionService = require('../../services/metaCatalogConnectionService');
const syncService = require('../../services/metaCatalogSyncService');

const router = Router();

function getWorkspaceId(req, res) {
  const workspaceId = req.workspace?.id ?? null;
  if (!workspaceId) {
    res.status(400).json({ error: 'No workspace found for this account.' });
    return null;
  }
  return workspaceId;
}

async function assertAccountInWorkspace(workspaceId, whatsappAccountId) {
  const { rows } = await pool.query(
    `SELECT id FROM coexistence.whatsapp_accounts WHERE id = $1 AND workspace_id = $2`,
    [whatsappAccountId, workspaceId]
  );
  return !!rows[0];
}

function handleError(res, err, fallback) {
  console.error('[metaCatalogRoutes]', fallback, '-', err.message);
  res.status(err.status || 500).json({ error: err.status ? err.message : fallback });
}

// GET /api/meta-catalog/connections — every Meta catalog connection for this workspace
router.get('/meta-catalog/connections', requirePermission('products'), async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const connections = await connectionService.listConnections(workspaceId);
    res.json(connections);
  } catch (err) {
    handleError(res, err, 'Failed to load Meta catalog connections');
  }
});

// GET /api/meta-catalog/:whatsappAccountId/connection — this account's connection (or null)
router.get('/meta-catalog/:whatsappAccountId/connection', requirePermission('products'), async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    if (!(await assertAccountInWorkspace(workspaceId, req.params.whatsappAccountId))) {
      return res.status(404).json({ error: 'WhatsApp account not found' });
    }
    const connection = await connectionService.getConnection(workspaceId, req.params.whatsappAccountId);
    res.json(connection);
  } catch (err) {
    handleError(res, err, 'Failed to load Meta catalog connection');
  }
});

// GET /api/meta-catalog/:whatsappAccountId/catalogs — catalogs available to connect
router.get('/meta-catalog/:whatsappAccountId/catalogs', requirePermission('products'), async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    if (!(await assertAccountInWorkspace(workspaceId, req.params.whatsappAccountId))) {
      return res.status(404).json({ error: 'WhatsApp account not found' });
    }
    const catalogs = await connectionService.listAvailableCatalogs(workspaceId, req.params.whatsappAccountId);
    res.json(catalogs);
  } catch (err) {
    handleError(res, err, 'Failed to list Meta catalogs');
  }
});

// POST /api/meta-catalog/:whatsappAccountId/connect — connect/select a catalog
// body: { catalogId, businessId?, token? }
router.post('/meta-catalog/:whatsappAccountId/connect', adminOnly, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    if (!(await assertAccountInWorkspace(workspaceId, req.params.whatsappAccountId))) {
      return res.status(404).json({ error: 'WhatsApp account not found' });
    }
    const { catalogId, businessId, token } = req.body || {};
    const connection = await connectionService.connectCatalog(workspaceId, req.params.whatsappAccountId, { catalogId, businessId, token });
    res.json(connection);
  } catch (err) {
    handleError(res, err, 'Failed to connect Meta catalog');
  }
});

// DELETE /api/meta-catalog/:whatsappAccountId/connection — disconnect
router.delete('/meta-catalog/:whatsappAccountId/connection', adminOnly, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    if (!(await assertAccountInWorkspace(workspaceId, req.params.whatsappAccountId))) {
      return res.status(404).json({ error: 'WhatsApp account not found' });
    }
    const result = await connectionService.disconnectCatalog(workspaceId, req.params.whatsappAccountId, req.body?.catalogId);
    res.json(result);
  } catch (err) {
    handleError(res, err, 'Failed to disconnect Meta catalog');
  }
});

// POST /api/meta-catalog/:whatsappAccountId/sync-now — manual outbound push
router.post('/meta-catalog/:whatsappAccountId/sync-now', adminOnly, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    if (!(await assertAccountInWorkspace(workspaceId, req.params.whatsappAccountId))) {
      return res.status(404).json({ error: 'WhatsApp account not found' });
    }
    const connection = await connectionService.getConnection(workspaceId, req.params.whatsappAccountId);
    if (!connection) return res.status(404).json({ error: 'No Meta catalog connection for this account' });

    const result = await syncService.runSync(workspaceId, req.params.whatsappAccountId, connection, { triggeredBy: 'manual' });
    res.json(result);
  } catch (err) {
    handleError(res, err, 'Sync failed');
  }
});

// POST /api/meta-catalog/:whatsappAccountId/products/:productId/retry — per-product retry
router.post('/meta-catalog/:whatsappAccountId/products/:productId/retry', adminOnly, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    if (!(await assertAccountInWorkspace(workspaceId, req.params.whatsappAccountId))) {
      return res.status(404).json({ error: 'WhatsApp account not found' });
    }
    const connection = await connectionService.getConnection(workspaceId, req.params.whatsappAccountId);
    if (!connection) return res.status(404).json({ error: 'No Meta catalog connection for this account' });

    const result = await syncService.retryProduct(workspaceId, req.params.whatsappAccountId, connection, req.params.productId);
    res.json(result);
  } catch (err) {
    handleError(res, err, 'Retry failed');
  }
});

// GET /api/meta-catalog/:whatsappAccountId/sync-log — recent sync runs
router.get('/meta-catalog/:whatsappAccountId/sync-log', requirePermission('products'), async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    if (!(await assertAccountInWorkspace(workspaceId, req.params.whatsappAccountId))) {
      return res.status(404).json({ error: 'WhatsApp account not found' });
    }
    const rows = await syncService.listSyncLog(workspaceId, req.params.whatsappAccountId);
    res.json(rows);
  } catch (err) {
    handleError(res, err, 'Failed to load Meta catalog sync log');
  }
});

module.exports = { router };