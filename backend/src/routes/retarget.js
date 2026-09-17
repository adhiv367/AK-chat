// Retarget module — routes.
// CRUD on retarget customers + CSV/Excel import + Google Sheet connect/sync.
// Part 3 (Contacts bridge is contactSyncService.js; WhatsApp send is below)
// adds the Retarget reminder send flow, reusing the existing Broadcast/Meta
// template infrastructure — see services/retargetSendService.js.

const { Router } = require('express');
const multer = require('multer');
const { requirePermission, requireRole } = require('../middleware/access');
const controller = require('../controllers/retargetController');
const importController = require('../controllers/retargetImportController');
const syncController = require('../controllers/retargetSyncController');
const { sendRetargetReminders } = require('../services/retargetSendService');

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Existing CRUD ────────────────────────────────────────────────────────
// GET /api/retarget/customers?search=&status=&page=&limit=
router.get('/retarget/customers', controller.listCustomers);

// GET /api/retarget/customers/:id
router.get('/retarget/customers/:id', controller.getCustomer);

// POST /api/retarget/customers
// Phase 3B: Viewer must not be able to create/modify/delete CRM-style
// records via a direct API call just because the button is hidden.
router.post('/retarget/customers', requireRole('AGENT'), controller.createCustomer);

// PUT /api/retarget/customers/:id
router.put('/retarget/customers/:id', requireRole('AGENT'), controller.updateCustomer);

// DELETE /api/retarget/customers/:id
router.delete('/retarget/customers/:id', requireRole('AGENT'), controller.deleteCustomer);

// ── CSV / Excel import ───────────────────────────────────────────────────
// POST /api/retarget/import — multipart/form-data, field name "file"
router.post('/retarget/import', requireRole('AGENT'), upload.single('file'), importController.importFile);

// ── Google Sheet connect + sync ──────────────────────────────────────────
// GET /api/retarget/sheet — current sheet connection (or null)
router.get('/retarget/sheet', syncController.getSheetSettings);

// POST /api/retarget/sheet — connect/update the Google Sheet URL
router.post('/retarget/sheet', syncController.connectSheet);

// POST /api/retarget/sheet/sync-now — trigger an immediate sync
router.post('/retarget/sheet/sync-now', syncController.syncNow);

// ── Sync history (shared by CSV/Excel/Sheet runs) ────────────────────────
// GET /api/retarget/sync-history?limit=20
router.get('/retarget/sync-history', syncController.syncHistory);

// ── Retarget reminder send (manual trigger) ──────────────────────────────
// POST /api/retarget/send-reminders
// Body: { templateId: number, buttonIndex: number, retargetIds?: number[] }
// Sends the given APPROVED WhatsApp template (must have a dynamic URL
// button) to every 'pending' Retarget customer (or just retargetIds, if
// given — e.g. a selection made on the Retarget page), resolving each
// recipient's own exit URL. See services/retargetSendService.js.
router.post('/retarget/send-reminders', requirePermission('bulk-message'), async (req, res) => {
  try {
    // workspaceId always comes from req.workspace (attachWorkspace, mounted
    // ahead of this router in index.js) — never from the request body.
    const workspaceId = req.workspace?.id ?? null;
    const { templateId, buttonIndex, retargetIds } = req.body || {};
    const result = await sendRetargetReminders({
      templateId: templateId ? Number(templateId) : undefined,
      buttonIndex: buttonIndex !== undefined ? Number(buttonIndex) : undefined,
      retargetIds: Array.isArray(retargetIds) ? retargetIds.map(Number) : undefined,
      workspaceId,
    });
    res.json(result);
  } catch (err) {
    console.error('[retarget] POST /send-reminders error:', err.message);
    res.status(400).json({ error: err.message || 'Failed to send Retarget reminders' });
  }
});

module.exports = { router };