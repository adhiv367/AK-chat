// Retarget module — routes.
// CRUD on retarget customers + CSV/Excel import + Google Sheet connect/sync.
// No Contacts integration, no Broadcast, no WhatsApp, no Automation/Campaigns
// — those are Part 3.

const { Router } = require('express');
const multer = require('multer');
const controller = require('../controllers/retargetController');
const importController = require('../controllers/retargetImportController');
const syncController = require('../controllers/retargetSyncController');

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Existing CRUD ────────────────────────────────────────────────────────
// GET /api/retarget/customers?search=&status=&page=&limit=
router.get('/retarget/customers', controller.listCustomers);

// GET /api/retarget/customers/:id
router.get('/retarget/customers/:id', controller.getCustomer);

// POST /api/retarget/customers
router.post('/retarget/customers', controller.createCustomer);

// PUT /api/retarget/customers/:id
router.put('/retarget/customers/:id', controller.updateCustomer);

// DELETE /api/retarget/customers/:id
router.delete('/retarget/customers/:id', controller.deleteCustomer);

// ── CSV / Excel import ───────────────────────────────────────────────────
// POST /api/retarget/import — multipart/form-data, field name "file"
router.post('/retarget/import', upload.single('file'), importController.importFile);

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

module.exports = { router };
