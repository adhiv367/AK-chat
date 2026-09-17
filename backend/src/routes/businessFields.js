// Phase 8E — Dynamic Business Fields: authenticated CRUD API.
//
// Mounted after the global `authMiddleware + attachWorkspace` pair (see
// index.js), same as contactFieldsRouter — req.workspace is always
// server-derived from the session by then, never client input.
//
// whatsappAccountId is always supplied by the caller (query for GET,
// body for mutations) and is verified against req.workspace.id via
// businessFieldDefinitionService's assertWhatsappAccountInWorkspace on
// every call — a whatsappAccountId belonging to a different workspace is
// rejected with 404, never silently scoped away.
//
// Mutations are gated behind requirePermission('admin-settings:fields'),
// the same permission key routes/contactFields.js already uses for
// managing custom field definitions — this is the same class of
// admin-settings capability, not a new permission surface.

const { Router } = require('express');
const { requirePermission, requireRole } = require('../middleware/access');
const fieldDefinitions = require('../services/businessFieldDefinitionService');
const fieldValues = require('../services/businessFieldValueService');
const fieldExtraction = require('../services/businessFieldExtractionService'); // Phase 8F — AI -> Dynamic Field Mapping

const router = Router();

function whatsappAccountIdFrom(req) {
  const raw = req.query.whatsappAccountId ?? req.body?.whatsappAccountId;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function handleError(res, err, fallbackMessage) {
  if (err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error('[businessFields]', err.message);
  return res.status(500).json({ error: fallbackMessage });
}

// GET /api/business-fields?whatsappAccountId=&includeInactive=
router.get('/business-fields', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });
    const whatsappAccountId = whatsappAccountIdFrom(req);
    if (!whatsappAccountId) return res.status(400).json({ error: 'whatsappAccountId is required' });

    const includeInactive = req.query.includeInactive !== 'false';
    const definitions = await fieldDefinitions.listFieldDefinitions(workspaceId, whatsappAccountId, { includeInactive });
    res.json(definitions);
  } catch (err) {
    handleError(res, err, 'Failed to fetch business field definitions');
  }
});

// POST /api/business-fields { whatsappAccountId, fieldKey, fieldLabel, ... }
router.post('/business-fields', requirePermission('admin-settings:fields'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });
    const whatsappAccountId = whatsappAccountIdFrom(req);
    if (!whatsappAccountId) return res.status(400).json({ error: 'whatsappAccountId is required' });

    const created = await fieldDefinitions.createFieldDefinition(workspaceId, whatsappAccountId, req.body || {});
    res.status(201).json(created);
  } catch (err) {
    handleError(res, err, 'Failed to create business field definition');
  }
});

// PUT /api/business-fields/:id { whatsappAccountId, ... }
router.put('/business-fields/:id', requirePermission('admin-settings:fields'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });
    const whatsappAccountId = whatsappAccountIdFrom(req);
    if (!whatsappAccountId) return res.status(400).json({ error: 'whatsappAccountId is required' });

    const updated = await fieldDefinitions.updateFieldDefinition(workspaceId, whatsappAccountId, req.params.id, req.body || {});
    res.json(updated);
  } catch (err) {
    handleError(res, err, 'Failed to update business field definition');
  }
});

// POST /api/business-fields/:id/activate { whatsappAccountId }
router.post('/business-fields/:id/activate', requirePermission('admin-settings:fields'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });
    const whatsappAccountId = whatsappAccountIdFrom(req);
    if (!whatsappAccountId) return res.status(400).json({ error: 'whatsappAccountId is required' });

    const updated = await fieldDefinitions.setFieldActive(workspaceId, whatsappAccountId, req.params.id, true);
    res.json(updated);
  } catch (err) {
    handleError(res, err, 'Failed to activate business field');
  }
});

// POST /api/business-fields/:id/deactivate { whatsappAccountId }
router.post('/business-fields/:id/deactivate', requirePermission('admin-settings:fields'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });
    const whatsappAccountId = whatsappAccountIdFrom(req);
    if (!whatsappAccountId) return res.status(400).json({ error: 'whatsappAccountId is required' });

    const updated = await fieldDefinitions.setFieldActive(workspaceId, whatsappAccountId, req.params.id, false);
    res.json(updated);
  } catch (err) {
    handleError(res, err, 'Failed to deactivate business field');
  }
});

// DELETE /api/business-fields/:id?whatsappAccountId= — only succeeds when
// already inactive and no contact holds a stored value (see
// businessFieldDefinitionService.deleteFieldDefinition).
router.delete('/business-fields/:id', requirePermission('admin-settings:fields'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });
    const whatsappAccountId = whatsappAccountIdFrom(req);
    if (!whatsappAccountId) return res.status(400).json({ error: 'whatsappAccountId is required' });

    await fieldDefinitions.deleteFieldDefinition(workspaceId, whatsappAccountId, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err, 'Failed to delete business field definition');
  }
});

// GET /api/business-fields/values/:contactId?whatsappAccountId=
router.get('/business-fields/values/:contactId', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });
    const whatsappAccountId = whatsappAccountIdFrom(req);
    if (!whatsappAccountId) return res.status(400).json({ error: 'whatsappAccountId is required' });

    const values = await fieldValues.getContactBusinessFieldValues(workspaceId, whatsappAccountId, req.params.contactId);
    res.json(values);
  } catch (err) {
    handleError(res, err, 'Failed to fetch business field values');
  }
});

// PUT /api/business-fields/values/:contactId { whatsappAccountId, values: {...} }
// Phase 7.11 fix (F-3): write-gate matching the Phase 7.11 F-1/F-2 pattern
// (contacts.js / messages.js) for a write endpoint with no dedicated
// permission key — VIEWER must not be able to write contact field values
// via a direct API call just because the button is hidden.
router.put('/business-fields/values/:contactId', requireRole('AGENT'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });
    const whatsappAccountId = whatsappAccountIdFrom(req);
    if (!whatsappAccountId) return res.status(400).json({ error: 'whatsappAccountId is required' });

    const values = await fieldValues.setContactBusinessFieldValues(
      workspaceId,
      whatsappAccountId,
      req.params.contactId,
      req.body?.values || {}
    );
    res.json(values);
  } catch (err) {
    handleError(res, err, 'Failed to save business field values');
  }
});

// ── Phase 8F — AI -> Dynamic Field Mapping ─────────────────────────────────
// workspaceId is ALWAYS server-resolved from req.workspace (never client
// input, spec 8F §7); whatsappAccountId is still verified against that
// workspace by the underlying services before anything else runs.

// POST /api/business-fields/extract
//   { whatsappAccountId, contactNumber, persist? }
// Extracts the current conversation's standard 8D fields AND this
// account's configured 8E business fields. persist defaults to true
// (writes/reuses a zoho_extraction_audit row, matching 8D); pass
// persist:false for a pure preview with no write.
// Phase 7.11 fix (F-3): same write-gate as above — extraction can persist
// values (persist defaults to true), so it's a write endpoint and must not
// be reachable by VIEWER.
router.post('/business-fields/extract', requireRole('AGENT'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });
    const whatsappAccountId = whatsappAccountIdFrom(req);
    if (!whatsappAccountId) return res.status(400).json({ error: 'whatsappAccountId is required' });
    const contactNumber = req.body?.contactNumber;
    if (!contactNumber) return res.status(400).json({ error: 'contactNumber is required' });

    const persist = req.body?.persist !== false;
    const result = await fieldExtraction.extractBusinessFields({
      workspaceId,
      whatsappAccountId,
      contactNumber,
      persist,
    });
    res.json(result);
  } catch (err) {
    handleError(res, err, 'Failed to extract business fields');
  }
});

// POST /api/business-fields/extract/apply
//   { whatsappAccountId, contactNumber, contactId }
// Runs the same extraction, then explicitly writes only the CONFIRMED
// (non-uncertain) business-field values to the contact's stored values via
// the existing 8E safe validate-then-write path. Never automatic — this is
// an explicit, single, caller-initiated action, and is NOT Zoho sync (8G).
router.post(
  '/business-fields/extract/apply',
  requirePermission('admin-settings:fields'),
  async (req, res) => {
    try {
      const workspaceId = req.workspace?.id ?? null;
      if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });
      const whatsappAccountId = whatsappAccountIdFrom(req);
      if (!whatsappAccountId) return res.status(400).json({ error: 'whatsappAccountId is required' });
      const contactNumber = req.body?.contactNumber;
      if (!contactNumber) return res.status(400).json({ error: 'contactNumber is required' });
      const contactId = req.body?.contactId;
      if (!contactId) return res.status(400).json({ error: 'contactId is required' });

      const result = await fieldExtraction.extractAndApply({
        workspaceId,
        whatsappAccountId,
        contactNumber,
        contactId,
        applyToContact: true,
        persist: req.body?.persist !== false,
      });
      res.json(result);
    } catch (err) {
      handleError(res, err, 'Failed to extract and apply business fields');
    }
  }
);

module.exports = { router };