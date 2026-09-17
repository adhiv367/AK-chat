// Retarget module — controller layer.
// Translates HTTP req/res into calls on retargetService.js.

const retargetService = require('../services/retargetService');

async function listCustomers(req, res) {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.json({ rows: [], total: 0, page: 1, limit: 20 });
    const { search = '', status = '', category = '', sent = '', active = '', page = 1, limit = 20 } = req.query;
    const result = await retargetService.listCustomers(workspaceId, { search, status, category, sent, active, page, limit });
    res.json(result);
  } catch (err) {
    console.error('[retarget] GET /retarget/customers error:', err.message);
    res.status(500).json({ error: 'Failed to fetch retarget customers' });
  }
}

async function getCustomer(req, res) {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(404).json({ error: 'Retarget customer not found' });
    const customer = await retargetService.getCustomer(req.params.id, workspaceId);
    if (!customer) return res.status(404).json({ error: 'Retarget customer not found' });
    res.json(customer);
  } catch (err) {
    console.error('[retarget] GET /retarget/customers/:id error:', err.message);
    res.status(500).json({ error: 'Failed to fetch retarget customer' });
  }
}

async function createCustomer(req, res) {
  try {
    const workspaceId = req.workspace?.id ?? null;
    // Fail closed: without a resolved workspace we must never let a write
    // fall through to an orphaned (workspace_id IS NULL) row — matches the
    // guard used by every other write endpoint in this codebase (see
    // categories.js, contacts.js, mediaLibrary.js, broadcasts.js, etc.).
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });
    const customer = await retargetService.createCustomer(req.body || {}, workspaceId);
    res.status(201).json(customer);
  } catch (err) {
    const status = err.status || 500;
    if (status !== 500) return res.status(status).json({ error: err.message });
    console.error('[retarget] POST /retarget/customers error:', err.message);
    res.status(500).json({ error: 'Failed to create retarget customer' });
  }
}

async function updateCustomer(req, res) {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(404).json({ error: 'Retarget customer not found' });
    const customer = await retargetService.updateCustomer(req.params.id, req.body || {}, workspaceId);
    if (!customer) return res.status(404).json({ error: 'Retarget customer not found' });
    res.json(customer);
  } catch (err) {
    console.error('[retarget] PUT /retarget/customers/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update retarget customer' });
  }
}

async function deleteCustomer(req, res) {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(404).json({ error: 'Retarget customer not found' });
    const ok = await retargetService.deleteCustomer(req.params.id, workspaceId);
    if (!ok) return res.status(404).json({ error: 'Retarget customer not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[retarget] DELETE /retarget/customers/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete retarget customer' });
  }
}

module.exports = { listCustomers, getCustomer, createCustomer, updateCustomer, deleteCustomer };