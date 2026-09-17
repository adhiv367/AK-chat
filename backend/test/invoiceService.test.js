'use strict';

// Phase 8C-2 — focused service tests only (invoice service foundation).
// Mocks pool.query (same no-live-Postgres approach as
// test/trialSchema.test.js / test/planChangeRequests.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/db');

function withMockedPool(dispatch, fn) {
  const originalQuery = pool.query;
  pool.query = dispatch;
  return fn().finally(() => {
    pool.query = originalQuery;
  });
}

test('createInvoice: inserts a workspace-scoped row', async () => {
  let captured = null;
  await withMockedPool(async (sql, params) => {
    captured = { sql, params };
    assert.match(sql, /INSERT INTO coexistence\.workspace_invoices/);
    return { rows: [{ id: 1, workspace_id: params[0], invoice_number: params[1], status: params[2] }] };
  }, async () => {
    const { createInvoice } = require('../src/services/invoiceService');
    const invoice = await createInvoice(42, { invoiceNumber: 'INV-001', currency: 'USD' });
    assert.equal(invoice.workspace_id, 42);
    assert.equal(invoice.invoice_number, 'INV-001');
  });
  assert.equal(captured.params[0], 42);
});

test('getInvoiceById: scopes SELECT by workspace_id', async () => {
  await withMockedPool(async (sql, params) => {
    assert.match(sql, /WHERE id = \$1 AND workspace_id = \$2/);
    assert.deepEqual(params, [7, 42]);
    return { rows: [{ id: 7, workspace_id: 42 }] };
  }, async () => {
    const { getInvoiceById } = require('../src/services/invoiceService');
    const invoice = await getInvoiceById(42, 7);
    assert.equal(invoice.id, 7);
  });
});

test('listWorkspaceInvoices: scopes SELECT by workspace_id', async () => {
  await withMockedPool(async (sql, params) => {
    assert.match(sql, /WHERE workspace_id = \$1/);
    assert.equal(params[0], 42);
    return { rows: [{ id: 1, workspace_id: 42 }, { id: 2, workspace_id: 42 }] };
  }, async () => {
    const { listWorkspaceInvoices } = require('../src/services/invoiceService');
    const invoices = await listWorkspaceInvoices(42);
    assert.equal(invoices.length, 2);
    assert.ok(invoices.every(i => i.workspace_id === 42));
  });
});

test('updateInvoiceStatus: scopes UPDATE by workspace_id and returns the row', async () => {
  await withMockedPool(async (sql, params) => {
    assert.match(sql, /UPDATE coexistence\.workspace_invoices/);
    assert.match(sql, /WHERE id = \$3 AND workspace_id = \$4/);
    assert.deepEqual(params, ['paid', null, 7, 42]);
    return { rows: [{ id: 7, workspace_id: 42, status: 'paid' }] };
  }, async () => {
    const { updateInvoiceStatus } = require('../src/services/invoiceService');
    const invoice = await updateInvoiceStatus(42, 7, 'paid');
    assert.equal(invoice.status, 'paid');
  });
});

test('workspace isolation: update targeting another workspace finds nothing -> 404', async () => {
  await withMockedPool(async () => ({ rows: [] }), async () => {
    const { updateInvoiceStatus } = require('../src/services/invoiceService');
    await assert.rejects(
      () => updateInvoiceStatus(999, 7, 'paid'),
      err => err.status === 404
    );
  });
});

test('invalid status is rejected before hitting the DB', async () => {
  let queried = false;
  await withMockedPool(async () => { queried = true; return { rows: [] }; }, async () => {
    const { createInvoice, updateInvoiceStatus } = require('../src/services/invoiceService');
    await assert.rejects(
      () => createInvoice(42, { invoiceNumber: 'INV-002', currency: 'USD', status: 'not_a_status' }),
      err => err.status === 400
    );
    await assert.rejects(
      () => updateInvoiceStatus(42, 7, 'not_a_status'),
      err => err.status === 400
    );
  });
  assert.equal(queried, false, 'should never query the DB with an invalid status');
});
test('duplicate invoice_number: unique violation (23505) becomes a safe 409', async () => {
  await withMockedPool(async () => {
    const err = new Error('duplicate key value violates unique constraint "uq_workspace_invoices_invoice_number"');
    err.code = '23505';
    throw err;
  }, async () => {
    const { createInvoice } = require('../src/services/invoiceService');
    await assert.rejects(
      () => createInvoice(42, { invoiceNumber: 'INV-001', currency: 'USD' }),
      err => err.status === 409 && !/constraint/i.test(err.message)
    );
  });
});