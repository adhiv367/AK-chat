'use strict';

// Phase 8G — pure unit tests for zohoFieldMappingService.js. No DB, no
// network, no mocking required — this file is deliberately side-effect-free.

const test = require('node:test');
const assert = require('node:assert/strict');

const { mapBusinessFieldsToZoho, renderUnmappedFieldsNote } = require('../src/services/zohoFieldMappingService');

function def(overrides = {}) {
  return { fieldKey: 'roof_type', fieldLabel: 'Roof Type', zohoTarget: null, ...overrides };
}

test('mapBusinessFieldsToZoho maps a field to its configured zoho_target', () => {
  const extracted = { roof_type: { value: 'Metal', confidence: 0.9, evidence: [] } };
  const defs = [def({ zohoTarget: 'Roof_Type_Custom' })];

  const { mappedFields, unmappedFields } = mapBusinessFieldsToZoho(extracted, defs);

  assert.deepEqual(mappedFields, { Roof_Type_Custom: 'Metal' });
  assert.deepEqual(unmappedFields, []);
});

test('mapBusinessFieldsToZoho preserves a field with no zoho_target as unmapped, never drops it', () => {
  const extracted = { pipe_size: { value: '2 inch', confidence: 0.8, evidence: [] } };
  const defs = [def({ fieldKey: 'pipe_size', fieldLabel: 'Pipe Size', zohoTarget: null })];

  const { mappedFields, unmappedFields } = mapBusinessFieldsToZoho(extracted, defs);

  assert.deepEqual(mappedFields, {});
  assert.equal(unmappedFields.length, 1);
  assert.equal(unmappedFields[0].fieldKey, 'pipe_size');
  assert.equal(unmappedFields[0].value, '2 inch');
});

test('mapBusinessFieldsToZoho never hardcodes/assumes a business field name — driven entirely by definitions', () => {
  const extracted = {
    totally_custom_field_a: { value: 'X', confidence: 1, evidence: [] },
    totally_custom_field_b: { value: 'Y', confidence: 1, evidence: [] },
  };
  const defs = [
    def({ fieldKey: 'totally_custom_field_a', fieldLabel: 'A', zohoTarget: 'Custom_A' }),
    def({ fieldKey: 'totally_custom_field_b', fieldLabel: 'B', zohoTarget: null }),
  ];

  const { mappedFields, unmappedFields } = mapBusinessFieldsToZoho(extracted, defs);

  assert.deepEqual(mappedFields, { Custom_A: 'X' });
  assert.equal(unmappedFields.length, 1);
  assert.equal(unmappedFields[0].fieldKey, 'totally_custom_field_b');
});

test('mapBusinessFieldsToZoho skips null/empty/undefined values entirely', () => {
  const extracted = {
    a: { value: null, confidence: 0, evidence: [] },
    b: { value: '', confidence: 0, evidence: [] },
    c: { value: undefined, confidence: 0, evidence: [] },
  };
  const defs = [def({ fieldKey: 'a', zohoTarget: 'A' }), def({ fieldKey: 'b', zohoTarget: 'B' }), def({ fieldKey: 'c' })];

  const { mappedFields, unmappedFields } = mapBusinessFieldsToZoho(extracted, defs);

  assert.deepEqual(mappedFields, {});
  assert.deepEqual(unmappedFields, []);
});

test('mapBusinessFieldsToZoho handles a field with no matching definition (falls back to raw key as label)', () => {
  const extracted = { mystery_field: { value: 'Z', confidence: 0.5, evidence: [] } };
  const { mappedFields, unmappedFields } = mapBusinessFieldsToZoho(extracted, []);

  assert.deepEqual(mappedFields, {});
  assert.equal(unmappedFields[0].fieldLabel, 'mystery_field');
});

test('renderUnmappedFieldsNote renders a readable line per field', () => {
  const text = renderUnmappedFieldsNote([
    { fieldKey: 'pipe_size', fieldLabel: 'Pipe Size', value: '2 inch' },
    { fieldKey: 'quantity', fieldLabel: 'Quantity', value: 12 },
  ]);
  assert.equal(text, 'Pipe Size: 2 inch\nQuantity: 12');
});

test('renderUnmappedFieldsNote returns empty string for no fields', () => {
  assert.equal(renderUnmappedFieldsNote([]), '');
  assert.equal(renderUnmappedFieldsNote(undefined), '');
});

test('renderUnmappedFieldsNote serializes array/object values without throwing', () => {
  const text = renderUnmappedFieldsNote([
    { fieldKey: 'options', fieldLabel: 'Options', value: ['a', 'b'] },
    { fieldKey: 'meta', fieldLabel: 'Meta', value: { x: 1 } },
  ]);
  assert.equal(text, 'Options: a, b\nMeta: {"x":1}');
});




