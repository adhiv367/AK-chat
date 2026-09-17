'use strict';

// Phase 8F — AI -> Dynamic Field Mapping.
// Focused unit tests for the business-field additions layered onto
// customerExtractionService.js (buildPrompt's dynamic section,
// sanitizeBusinessFields/normalizeBusinessFieldValue, computeBusinessValidation).
// Pure-function level — no pool/gemini mocking needed for these (see
// businessFieldExtractionService.test.js for the orchestration-level tests).

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

process.env.AKCHAT_ENCRYPTION_KEY = process.env.AKCHAT_ENCRYPTION_KEY || nodeCrypto.randomBytes(24).toString('hex');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-extraction-tests';
process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REDIRECT_URI = process.env.ZOHO_REDIRECT_URI || 'https://app.example.com/api/zoho/oauth/callback';

const svc = require('../src/services/customerExtractionService');

function def(overrides = {}) {
  return {
    id: 1,
    fieldKey: 'roof_type',
    fieldLabel: 'Roof Type',
    description: null,
    fieldType: 'select',
    isRequired: false,
    fieldConfig: { options: ['Metal', 'Shingle'] },
    extractionInstruction: null,
    ...overrides,
  };
}

function ev(text, id = 'm1') {
  return [{ message_id: id, text }];
}

// ── buildBusinessFieldsPromptSection / buildPrompt ─────────────────────────

test('buildPrompt is unchanged (no business-fields section) when no field definitions given', () => {
  const prompt = svc.buildPrompt('Customer: hi', undefined);
  assert.ok(!prompt.includes('ADDITIONAL BUSINESS-SPECIFIC FIELDS'));
});

test('buildPrompt is unchanged when field definitions is an empty array', () => {
  const prompt = svc.buildPrompt('Customer: hi', []);
  assert.ok(!prompt.includes('ADDITIONAL BUSINESS-SPECIFIC FIELDS'));
});

test('buildPrompt never hardcodes a field name — it only appears when passed in', () => {
  const withoutFields = svc.buildPrompt('Customer: hi', []);
  assert.ok(!withoutFields.includes('roof_type'));
  assert.ok(!withoutFields.includes('pipe_name'));
});

test('buildPrompt includes configured field_key/label/type/required/options for each active definition', () => {
  const prompt = svc.buildPrompt('Customer: hi', [
    def(),
    def({ fieldKey: 'length_ft', fieldLabel: 'Length (ft)', fieldType: 'number', isRequired: true, fieldConfig: {} }),
  ]);
  assert.ok(prompt.includes('field_key: "roof_type"'));
  assert.ok(prompt.includes('"Metal"'));
  assert.ok(prompt.includes('"Shingle"'));
  assert.ok(prompt.includes('field_key: "length_ft"'));
  assert.ok(prompt.includes('required: true'));
  assert.ok(prompt.includes('"business_fields"'));
});

// ── normalizeBusinessFieldValue ────────────────────────────────────────────

test('normalizeBusinessFieldValue: text trims and rejects objects', () => {
  const d = def({ fieldType: 'text', fieldConfig: {} });
  assert.equal(svc.normalizeBusinessFieldValue(d, '  Copper pipe  '), 'Copper pipe');
  assert.equal(svc.normalizeBusinessFieldValue(d, { nested: true }), null);
  assert.equal(svc.normalizeBusinessFieldValue(d, ''), null);
});

test('normalizeBusinessFieldValue: number rejects non-numeric strings, never coerces', () => {
  const d = def({ fieldType: 'number', fieldConfig: {} });
  assert.equal(svc.normalizeBusinessFieldValue(d, '42'), 42);
  assert.equal(svc.normalizeBusinessFieldValue(d, 'forty-two'), null);
  assert.equal(svc.normalizeBusinessFieldValue(d, 'NaN'), null);
});

test('normalizeBusinessFieldValue: boolean only accepts true/false-ish, never guesses', () => {
  const d = def({ fieldType: 'boolean', fieldConfig: {} });
  assert.equal(svc.normalizeBusinessFieldValue(d, true), true);
  assert.equal(svc.normalizeBusinessFieldValue(d, 'yes'), true);
  assert.equal(svc.normalizeBusinessFieldValue(d, 'no'), false);
  assert.equal(svc.normalizeBusinessFieldValue(d, 'maybe'), null);
  assert.equal(svc.normalizeBusinessFieldValue(d, 1), null);
});

test('normalizeBusinessFieldValue: date normalizes to YYYY-MM-DD, rejects invalid dates', () => {
  const d = def({ fieldType: 'date', fieldConfig: {} });
  assert.equal(svc.normalizeBusinessFieldValue(d, '2025-03-14'), '2025-03-14');
  assert.equal(svc.normalizeBusinessFieldValue(d, 'not a date'), null);
});

test('normalizeBusinessFieldValue: select only accepts an exactly-configured option', () => {
  const d = def({ fieldType: 'select', fieldConfig: { options: ['Metal', 'Shingle'] } });
  assert.equal(svc.normalizeBusinessFieldValue(d, 'Metal'), 'Metal');
  assert.equal(svc.normalizeBusinessFieldValue(d, 'Tile'), null); // not in configured options
  assert.equal(svc.normalizeBusinessFieldValue(d, 'metal'), null); // case-sensitive; not a configured option
});

test('normalizeBusinessFieldValue: multiselect drops values not in options, dedupes', () => {
  const d = def({ fieldType: 'multiselect', fieldConfig: { options: ['A', 'B', 'C'] } });
  assert.deepEqual(svc.normalizeBusinessFieldValue(d, ['A', 'B', 'A', 'Z']), ['A', 'B']);
  assert.equal(svc.normalizeBusinessFieldValue(d, ['Z']), null); // nothing valid survives
  assert.equal(svc.normalizeBusinessFieldValue(d, 'A'), null); // not an array at all
});

// ── sanitizeBusinessFields ──────────────────────────────────────────────────

test('sanitizeBusinessFields: evidence is mandatory for a value', () => {
  const defs = [def({ fieldType: 'text', fieldConfig: {} })];
  const raw = { roof_type: { value: 'Metal', confidence: 0.9, evidence: [] } };
  const result = svc.sanitizeBusinessFields(raw, defs);
  assert.equal(result.roof_type.value, null);
  assert.equal(result.roof_type.confidence, 0);
});

test('sanitizeBusinessFields: unknown field_keys from the model are ignored', () => {
  const defs = [def()];
  const raw = { roof_type: { value: 'Metal', confidence: 0.9, evidence: ev('metal roof') }, made_up_field: { value: 'x', confidence: 1, evidence: ev('x') } };
  const result = svc.sanitizeBusinessFields(raw, defs);
  assert.ok(!('made_up_field' in result));
  assert.equal(result.roof_type.value, 'Metal');
});

test('sanitizeBusinessFields: always includes one entry per active definition, even with no model output', () => {
  const defs = [def({ fieldKey: 'a' }), def({ fieldKey: 'b' })];
  const result = svc.sanitizeBusinessFields({}, defs);
  assert.deepEqual(Object.keys(result).sort(), ['a', 'b']);
  assert.equal(result.a.value, null);
  assert.equal(result.b.value, null);
});

test('sanitizeBusinessFields: malformed (non-object) business_fields degrades safely, never throws', () => {
  const defs = [def()];
  assert.doesNotThrow(() => svc.sanitizeBusinessFields('not an object', defs));
  assert.doesNotThrow(() => svc.sanitizeBusinessFields(null, defs));
  assert.doesNotThrow(() => svc.sanitizeBusinessFields(['array', 'not', 'object'], defs));
  const result = svc.sanitizeBusinessFields('garbage', defs);
  assert.equal(result.roof_type.value, null);
});

test('sanitizeBusinessFields: invalid select value is dropped, not coerced', () => {
  const defs = [def({ fieldConfig: { options: ['Metal', 'Shingle'] } })];
  const raw = { roof_type: { value: 'Thatch', confidence: 0.9, evidence: ev('thatched roof') } };
  const result = svc.sanitizeBusinessFields(raw, defs);
  assert.equal(result.roof_type.value, null);
});

test('sanitizeBusinessFields: preserves an explicit customer correction via "previous"', () => {
  const defs = [def({ fieldType: 'number', fieldConfig: {} })];
  const raw = {
    roof_type: {
      value: 60,
      confidence: 0.8,
      evidence: ev('actually it is 60 feet', 'm2'),
      previous: { value: 45, confidence: 0.7, evidence: ev('it is 45 feet', 'm1') },
    },
  };
  const result = svc.sanitizeBusinessFields(raw, defs);
  assert.equal(result.roof_type.value, 60);
  assert.equal(result.roof_type.previous.value, 45);
});

// ── computeBusinessValidation ───────────────────────────────────────────────

function field(value, confidence, isRequired, evidence) {
  return { value, confidence, evidence: evidence || (value !== null ? ev('x') : []), previous: null, isRequired: !!isRequired };
}

test('computeBusinessValidation: a missing REQUIRED field makes overall status INCOMPLETE', () => {
  const businessFields = { roof_type: field(null, 0, true) };
  const v = svc.computeBusinessValidation(businessFields);
  assert.equal(v.status, 'INCOMPLETE');
  assert.deepEqual(v.missing_required_fields, ['roof_type']);
});

test('computeBusinessValidation: a missing NON-required field does not block completeness', () => {
  const businessFields = { roof_type: field(null, 0, false) };
  const v = svc.computeBusinessValidation(businessFields);
  assert.equal(v.status, 'COMPLETE');
  assert.deepEqual(v.missing_required_fields, []);
});

test('computeBusinessValidation: a low-confidence value is UNCERTAIN, never COMPLETE', () => {
  const businessFields = { roof_type: field('Metal', 0.3, false) };
  const v = svc.computeBusinessValidation(businessFields);
  assert.equal(v.status, 'UNCERTAIN');
  assert.deepEqual(v.uncertain_fields, ['roof_type']);
  assert.ok(!('roof_type' in v.missing_required_fields));
});

test('computeBusinessValidation: uncertain fields are never silently promoted to confirmed/complete', () => {
  const businessFields = {
    a: field('X', 0.9, false),
    b: field('Y', 0.2, false), // uncertain
  };
  const v = svc.computeBusinessValidation(businessFields);
  assert.equal(v.status, 'UNCERTAIN');
});

test('computeBusinessValidation: all confirmed (or not-provided/non-required) -> COMPLETE', () => {
  const businessFields = { a: field('X', 0.9, false), b: field(null, 0, false) };
  const v = svc.computeBusinessValidation(businessFields);
  assert.equal(v.status, 'COMPLETE');
});

test('computeBusinessValidation: extracted_fields only includes confirmed/uncertain, not missing', () => {
  const businessFields = { a: field('X', 0.9, false), b: field(null, 0, true) };
  const v = svc.computeBusinessValidation(businessFields);
  assert.deepEqual(Object.keys(v.extracted_fields), ['a']);
});

// ── enforceEvidenceIntegrity applies to business fields too ────────────────

test('enforceEvidenceIntegrity strips a business field citing a message_id not in the conversation', () => {
  const messages = [{ messageId: 'm1', direction: 'incoming', text: 'metal roof' }];
  const extraction = {
    name: { value: null, confidence: 0, evidence: [], previous: null },
    place: { value: null, type: 'unknown', confidence: 0, evidence: [], previous: null },
    phone: { value: null, confidence: 0, evidence: [], previous: null },
    email: { value: null, confidence: 0, evidence: [], previous: null },
    intent: { value: null, confidence: 0, evidence: [], previous: null },
    interest_summary: null,
    missing_required_fields: [],
    overall_confidence: 0,
    business_fields: {
      roof_type: { value: 'Metal', confidence: 0.9, evidence: [{ message_id: 'm999-fake', text: 'metal roof' }], previous: null },
    },
    parse_error: null,
  };
  const result = svc.enforceEvidenceIntegrity(extraction, messages);
  assert.equal(result.business_fields.roof_type.value, null);
});

test('enforceEvidenceIntegrity preserves a business field value of false/0 (falsy but valid)', () => {
  const messages = [{ messageId: 'm1', direction: 'incoming', text: 'no warranty needed' }];
  const extraction = {
    name: { value: null, confidence: 0, evidence: [], previous: null },
    place: { value: null, type: 'unknown', confidence: 0, evidence: [], previous: null },
    phone: { value: null, confidence: 0, evidence: [], previous: null },
    email: { value: null, confidence: 0, evidence: [], previous: null },
    intent: { value: null, confidence: 0, evidence: [], previous: null },
    interest_summary: null,
    missing_required_fields: [],
    overall_confidence: 0,
    business_fields: {
      wants_warranty: { value: false, confidence: 0.9, evidence: [{ message_id: 'm1', text: 'no warranty needed' }], previous: null },
    },
    parse_error: null,
  };
  const result = svc.enforceEvidenceIntegrity(extraction, messages);
  assert.equal(result.business_fields.wants_warranty.value, false);
});

// ── safeParseExtraction end-to-end (parse -> sanitize -> shape) ────────────

test('safeParseExtraction: full round trip with dynamic fields, mixed valid/invalid', () => {
  const defs = [
    def({ fieldKey: 'roof_type', fieldType: 'select', fieldConfig: { options: ['Metal', 'Shingle'] } }),
    def({ fieldKey: 'length_ft', fieldType: 'number', fieldConfig: {}, isRequired: true }),
  ];
  const raw = JSON.stringify({
    name: { value: 'Ravi', confidence: 0.9, evidence: [{ message_id: 'm1', text: 'this is Ravi' }] },
    place: { value: null, type: 'unknown', confidence: 0, evidence: [] },
    phone: { value: null, confidence: 0, evidence: [] },
    email: { value: null, confidence: 0, evidence: [] },
    intent: { value: null, confidence: 0, evidence: [] },
    interest_summary: null,
    missing_required_fields: [],
    overall_confidence: 0.9,
    business_fields: {
      roof_type: { value: 'Metal', confidence: 0.8, evidence: [{ message_id: 'm2', text: 'metal roof please' }] },
      length_ft: { value: 'not-a-number', confidence: 0.5, evidence: [{ message_id: 'm2', text: 'x' }] },
      unconfigured_key: { value: 'ignored', confidence: 1, evidence: [{ message_id: 'm2', text: 'x' }] },
    },
  });
  const extraction = svc.safeParseExtraction(raw, defs);
  assert.equal(extraction.name.value, 'Ravi');
  assert.equal(extraction.business_fields.roof_type.value, 'Metal');
  assert.equal(extraction.business_fields.length_ft.value, null); // invalid number, dropped
  assert.ok(!('unconfigured_key' in extraction.business_fields));
});

test('safeParseExtraction: malformed JSON degrades to empty extraction with full business_fields shape', () => {
  const defs = [def({ fieldKey: 'roof_type' })];
  const extraction = svc.safeParseExtraction('not json at all {{{', defs);
  assert.equal(extraction.parse_error, 'Model response was not valid JSON');
  assert.deepEqual(Object.keys(extraction.business_fields), ['roof_type']);
  assert.equal(extraction.business_fields.roof_type.value, null);
});
