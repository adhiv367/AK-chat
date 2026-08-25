// Retarget module — service layer.
// Validation + orchestration sits here; SQL stays in retargetRepository.js.
//
// Every create/update also mirrors the customer into coexistence.contacts
// (Contacts <-> Retarget integration) via contactSyncService's
// upsertContactFromRetarget — the same bridge used by CSV/Excel import and
// Google Sheet sync in retargetImportService.js, so manual API writes stay
// consistent with imported ones.

const retargetRepository = require('../repositories/retargetRepository');
const { upsertContactFromRetarget } = require('./contactSyncService');

function normalizeInput(body = {}) {
  return {
    name: body.name?.trim() || null,
    phone: body.phone?.trim() || null,
    email: body.email?.trim() || null,
    exitUrl: body.exitUrl?.trim() || null,
    retargetType: body.retargetType?.trim() || null,
    timestamp: body.timestamp || null,
    source: body.source?.trim() || null,
    status: body.status?.trim() || 'pending',
  };
}

// Mirrors a Retarget customer into Contacts. Never throws — a Contacts sync
// hiccup (e.g. no WhatsApp account connected yet) must not fail the
// Retarget create/update itself; it's logged and skipped instead.
async function syncContactSafely(retargetCustomer) {
  try {
    await upsertContactFromRetarget(retargetCustomer);
  } catch (err) {
    console.error('[retarget] contact sync error:', err.message);
  }
}

async function listCustomers({ search, status, category, sent, active, page, limit }) {
  return retargetRepository.findAll({ search, status, category, sent, active, page, limit });
}

async function getCustomer(id) {
  return retargetRepository.findById(id);
}

async function createCustomer(body) {
  const data = normalizeInput(body);
  if (!data.phone && !data.email) {
    const err = new Error('Phone or email is required');
    err.status = 400;
    throw err;
  }
  const customer = await retargetRepository.create(data);
  await syncContactSafely(customer);
  return customer;
}

async function updateCustomer(id, body) {
  const existing = await retargetRepository.findById(id);
  if (!existing) return null;

  const patch = {};
  if (body.name !== undefined) patch.name = body.name?.trim() || null;
  if (body.phone !== undefined) patch.phone = body.phone?.trim() || null;
  if (body.email !== undefined) patch.email = body.email?.trim() || null;
  if (body.exitUrl !== undefined) patch.exitUrl = body.exitUrl?.trim() || null;
  if (body.retargetType !== undefined) patch.retargetType = body.retargetType?.trim() || null;
  if (body.timestamp !== undefined) patch.timestamp = body.timestamp || null;
  if (body.source !== undefined) patch.source = body.source?.trim() || null;
  if (body.status !== undefined) patch.status = body.status?.trim() || 'pending';

  const customer = await retargetRepository.update(id, patch);
  if (customer) await syncContactSafely(customer);
  return customer;
}

async function deleteCustomer(id) {
  return retargetRepository.remove(id);
}

module.exports = { listCustomers, getCustomer, createCustomer, updateCustomer, deleteCustomer };