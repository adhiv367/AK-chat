'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeImportCustomFields } = require('../src/routes/contacts.js');

// Phase 6 Part 2 — Excel/CSV import must never overwrite an existing
// contact's provenance (custom_fields.source), e.g. it must not turn a
// Shopify-synced customer into an "excel" one just because they were also
// present in a spreadsheet re-import.
test('existing shopify_sheet_sync source is preserved through an excel re-import', () => {
  const existing = { city: 'Chennai', purchaseCount: '5', source: 'shopify_sheet_sync' };
  const next = mergeImportCustomFields(existing, 'new-email@example.com');
  assert.equal(next.source, 'shopify_sheet_sync');
});

test('a contact with no source yet is stamped with excel', () => {
  const existing = { city: 'Chennai' };
  const next = mergeImportCustomFields(existing, '');
  assert.equal(next.source, 'excel');
});
test('a brand-new contact (no prior custom_fields) is stamped with excel', () => {
  const next = mergeImportCustomFields({}, 'a@b.com');
  assert.equal(next.source, 'excel');
});
test('unrelated custom_fields are preserved (only email/source change)', () => {
  const existing = {
    city: 'Chennai',
    purchaseCount: '5',
    source: 'shopify_sheet_sync',
    lastProduct: 'Widget',
    totalPurchaseAmount: '999',
  };
  const next = mergeImportCustomFields(existing, 'updated@example.com');
  assert.equal(next.city, 'Chennai');
  assert.equal(next.purchaseCount, '5');
  assert.equal(next.lastProduct, 'Widget');
  assert.equal(next.totalPurchaseAmount, '999');
  assert.equal(next.email, 'updated@example.com');
  assert.equal(next.source, 'shopify_sheet_sync');
});
test('blank import email does not clear an existing email', () => {
  const existing = { email: 'kept@example.com', source: 'manual' };
  const next = mergeImportCustomFields(existing, '');
  assert.equal(next.email, 'kept@example.com');
});
test('manual source is also preserved (not just shopify)', () => {
  const existing = { source: 'manual' };
  const next = mergeImportCustomFields(existing, '');
  assert.equal(next.source, 'manual');
});

