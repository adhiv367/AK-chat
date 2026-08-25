// Retarget module — controller layer.
// Translates HTTP req/res into calls on retargetService.js.

const retargetService = require('../services/retargetService');

async function listCustomers(req, res) {
  try {
    const { search = '', status = '', category = '', sent = '', active = '', page = 1, limit = 20 } = req.query;
    const result = await retargetService.listCustomers({ search, status, category, sent, active, page, limit });
    res.json(result);
  } catch (err) {
    console.error('[retarget] GET /retarget/customers error:', err.message);
    res.status(500).json({ error: 'Failed to fetch retarget customers' });
  }
}

async function getCustomer(req, res) {
  try {
    const customer = await retargetService.getCustomer(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Retarget customer not found' });
    res.json(customer);
  } catch (err) {
    console.error('[retarget] GET /retarget/customers/:id error:', err.message);
    res.status(500).json({ error: 'Failed to fetch retarget customer' });
  }
}

async function createCustomer(req, res) {
  try {
    const customer = await retargetService.createCustomer(req.body || {});
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
    const customer = await retargetService.updateCustomer(req.params.id, req.body || {});
    if (!customer) return res.status(404).json({ error: 'Retarget customer not found' });
    res.json(customer);
  } catch (err) {
    console.error('[retarget] PUT /retarget/customers/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update retarget customer' });
  }
}

async function deleteCustomer(req, res) {
  try {
    const ok = await retargetService.deleteCustomer(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Retarget customer not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[retarget] DELETE /retarget/customers/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete retarget customer' });
  }
}

module.exports = { listCustomers, getCustomer, createCustomer, updateCustomer, deleteCustomer };
