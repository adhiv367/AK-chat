'use strict';

// Phase 8G — orchestration-level tests for zohoSyncService.js. This file
// does NOT re-test 8B/8C/8D/8E/8F internals (already covered by their own
// test files) — it mocks those already-tested service functions directly
// (monkeypatching the exported functions on the shared module objects,
// same singleton-module approach the rest of this codebase's test suite
// uses for pool.query) and asserts the 8G orchestration logic itself:
// connection-first resolution, incomplete-extraction short-circuit,
// create-vs-update selection, dynamic field mapping into the Lead,
// unmapped/dropped fields folded into the Note, and Lead-success/
// Note-failure partial success.

const test = require('node:test');
const assert = require('node:assert/strict');

const WORKSPACE_ID = 1;
const WA_ACCOUNT_ID = 5;
const OTHER_WA_ACCOUNT_ID = 6;
const CONTACT_NUMBER = '+91 99999 99999';

function baseExtraction(overrides = {}) {
  return {
    name: { value: 'Ravi Kumar', confidence: 0.9, evidence: [] },
    place: { value: 'Chennai', type: 'residence', confidence: 0.9, evidence: [] },
    phone: { value: null, confidence: 0, evidence: [] },
    email: { value: null, confidence: 0, evidence: [] },
    intent: { value: null, confidence: 0, evidence: [] },
    interest_summary: 'Interested in a metal roof',
    business_fields: {},
    ...overrides,
  };
}

function withMocks({
  connectionResolves = true,
  extractionResult,
  existingLink = null,
  createLeadResult,
  updateLeadResult,
  createNoteResult,
  createNoteError = null,
} = {}, run) {
  return async () => {
    const zohoLeadService = require('../src/services/zohoLeadService');
    const zohoNoteService = require('../src/services/zohoNoteService');
    const businessFieldExtractionService = require('../src/services/businessFieldExtractionService');

    const original = {
      resolveConnectionRow: zohoLeadService.resolveConnectionRow,
      getLinkedLead: zohoLeadService.getLinkedLead,
      createLead: zohoLeadService.createLead,
      updateLead: zohoLeadService.updateLead,
      upsertConversationNote: zohoNoteService.upsertConversationNote,
      extractBusinessFields: businessFieldExtractionService.extractBusinessFields,
    };

    // NOTE: kept as `createNote` in this harness's `calls`/param names for
    // minimal diff noise across this file's many tests — it now actually
    // mocks zohoNoteService.upsertConversationNote (Phase 8 Note
    // Consolidation FIX), the single-consolidated-Note-per-Lead entry
    // point zohoSyncService now calls instead of createNote.
    const calls = { createLead: [], updateLead: [], createNote: [], extractBusinessFields: [], resolveConnectionRow: [], getLinkedLead: [] };

    zohoLeadService.resolveConnectionRow = async (workspaceId, whatsappAccountId) => {
      calls.resolveConnectionRow.push({ workspaceId, whatsappAccountId });
      if (!connectionResolves) {
        const err = new Error('No Zoho CRM connection found for this WhatsApp account');
        err.status = 404;
        throw err;
      }
      return { id: 10, status: 'connected' };
    };

    businessFieldExtractionService.extractBusinessFields = async (params) => {
      calls.extractBusinessFields.push(params);
      return extractionResult;
    };

    zohoLeadService.getLinkedLead = async (workspaceId, whatsappAccountId, contactNumber) => {
      calls.getLinkedLead.push({ workspaceId, whatsappAccountId, contactNumber });
      return existingLink;
    };

    zohoLeadService.createLead = async (input) => {
      calls.createLead.push(input);
      return createLeadResult;
    };

    zohoLeadService.updateLead = async (input) => {
      calls.updateLead.push(input);
      return updateLeadResult;
    };

    zohoNoteService.upsertConversationNote = async (input) => {
      calls.createNote.push(input);
      if (createNoteError) throw createNoteError;
      return createNoteResult;
    };

    try {
      delete require.cache[require.resolve('../src/services/zohoSyncService')];
      const svc = require('../src/services/zohoSyncService');
      await run(svc, calls);
    } finally {
      Object.assign(zohoLeadService, {
        resolveConnectionRow: original.resolveConnectionRow,
        getLinkedLead: original.getLinkedLead,
        createLead: original.createLead,
        updateLead: original.updateLead,
      });
      zohoNoteService.upsertConversationNote = original.upsertConversationNote;
      businessFieldExtractionService.extractBusinessFields = original.extractBusinessFields;
    }
  };
}

test('syncConversationToZoho: no connection -> fails fast, never calls extraction', withMocks({
  connectionResolves: false,
}, async (svc, calls) => {
  await assert.rejects(
    () => svc.syncConversationToZoho({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: CONTACT_NUMBER }),
    (err) => err.status === 404
  );
  assert.equal(calls.extractBusinessFields.length, 0);
}));

test('syncConversationToZoho: incomplete extraction -> synced:false, never calls Lead/Note services', withMocks({
  extractionResult: {
    extraction: baseExtraction({ place: { value: null, type: 'unknown', confidence: 0, evidence: [] } }),
    standard: { status: 'INCOMPLETE', missing_required_fields: ['place'], uncertain_fields: [] },
    business: { status: 'COMPLETE', extracted_fields: {}, missing_required_fields: [], uncertain_fields: [] },
    fieldDefinitions: [],
    complete: false,
    audit: null,
    error: null,
  },
}, async (svc, calls) => {
  const result = await svc.syncConversationToZoho({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: CONTACT_NUMBER });

  assert.equal(result.synced, false);
  assert.equal(result.reason, 'incomplete_extraction');
  assert.equal(calls.createLead.length, 0);
  assert.equal(calls.updateLead.length, 0);
  assert.equal(calls.createNote.length, 0);
}));

test('syncConversationToZoho: no existing link -> creates a new Lead with mapped business fields', withMocks({
  extractionResult: {
    extraction: baseExtraction({
      business_fields: { roof_type: { value: 'Metal', confidence: 0.9, evidence: [], previous: null, fieldKey: 'roof_type', fieldType: 'select', isRequired: true } },
    }),
    standard: { status: 'COMPLETE', missing_required_fields: [], uncertain_fields: [] },
    business: { status: 'COMPLETE', extracted_fields: { roof_type: { value: 'Metal', confidence: 0.9, evidence: [] } }, missing_required_fields: [], uncertain_fields: [] },
    fieldDefinitions: [{ fieldKey: 'roof_type', fieldLabel: 'Roof Type', zohoTarget: 'Roof_Type_Custom' }],
    complete: true,
    audit: { id: 42 },
    error: null,
  },
  existingLink: null,
  createLeadResult: { zohoLeadId: 'LEAD1', status: 'synced', created: true, droppedFields: [] },
  createNoteResult: { zohoNoteId: 'NOTE1', status: 'synced' },
}, async (svc, calls) => {
  const result = await svc.syncConversationToZoho({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: CONTACT_NUMBER });

  assert.equal(calls.createLead.length, 1);
  assert.equal(calls.updateLead.length, 0);
  assert.deepEqual(calls.createLead[0].extraFields, { Roof_Type_Custom: 'Metal' });
  assert.equal(result.synced, true);
  assert.equal(result.lead.zohoLeadId, 'LEAD1');
  assert.equal(result.note.zohoNoteId, 'NOTE1');
  assert.equal(result.partial, false);
  // Phase 8 Note Consolidation FIX: zohoSyncService no longer derives a
  // content-hash/audit-based idempotencyKey at all — upsertConversationNote
  // itself guarantees exactly one consolidated Note per Lead via its own
  // fixed idempotency key, keyed only on structured confirmed fields.
  assert.equal(calls.createNote[0].name, 'Ravi Kumar');
  assert.equal(calls.createNote[0].location, 'Chennai');
}));

test('syncConversationToZoho: existing link -> updates instead of creating', withMocks({
  extractionResult: {
    extraction: baseExtraction(),
    standard: { status: 'COMPLETE', missing_required_fields: [], uncertain_fields: [] },
    business: { status: 'COMPLETE', extracted_fields: {}, missing_required_fields: [], uncertain_fields: [] },
    fieldDefinitions: [],
    complete: true,
    audit: null,
    error: null,
  },
  existingLink: { zohoLeadId: 'LEAD1', status: 'synced' },
  updateLeadResult: { zohoLeadId: 'LEAD1', status: 'synced', created: false, droppedFields: [] },
}, async (svc, calls) => {
  const result = await svc.syncConversationToZoho({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: CONTACT_NUMBER });

  assert.equal(calls.createLead.length, 0);
  assert.equal(calls.updateLead.length, 1);
  assert.equal(result.lead.zohoLeadId, 'LEAD1');
}));

test('syncConversationToZoho: unmapped business fields + Zoho-dropped fields are folded into the Note, never lost', withMocks({
  extractionResult: {
    extraction: baseExtraction({ interest_summary: null }),
    standard: { status: 'COMPLETE', missing_required_fields: [], uncertain_fields: [] },
    business: {
      status: 'COMPLETE',
      extracted_fields: { pipe_size: { value: '2 inch', confidence: 0.8, evidence: [] } },
      missing_required_fields: [],
      uncertain_fields: [],
    },
    fieldDefinitions: [{ fieldKey: 'pipe_size', fieldLabel: 'Pipe Size', zohoTarget: null }],
    complete: true,
    audit: null,
    error: null,
  },
  createLeadResult: { zohoLeadId: 'LEAD1', status: 'synced', created: true, droppedFields: [{ apiName: 'Unsupported_Field', value: 'foo' }] },
  createNoteResult: { zohoNoteId: 'NOTE1', status: 'synced' },
}, async (svc, calls) => {
  const result = await svc.syncConversationToZoho({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: CONTACT_NUMBER });

  assert.equal(calls.createNote.length, 1);
  const dynamicFields = calls.createNote[0].dynamicFields;
  assert.ok(dynamicFields.some((f) => f.fieldLabel === 'Pipe Size' && f.value === '2 inch'));
  assert.ok(dynamicFields.some((f) => f.fieldLabel === 'Unsupported_Field' && f.value === 'foo'));
  assert.equal(result.unmappedFields.length, 1);
  assert.equal(result.droppedZohoFields.length, 1);
}));

test('syncConversationToZoho: Lead succeeds, Note fails -> partial success, Lead id preserved', withMocks({
  extractionResult: {
    extraction: baseExtraction(),
    standard: { status: 'COMPLETE', missing_required_fields: [], uncertain_fields: [] },
    business: { status: 'COMPLETE', extracted_fields: {}, missing_required_fields: [], uncertain_fields: [] },
    fieldDefinitions: [],
    complete: true,
    audit: null,
    error: null,
  },
  createLeadResult: { zohoLeadId: 'LEAD1', status: 'synced', created: true, droppedFields: [] },
  createNoteError: Object.assign(new Error('Zoho CRM rate limit exceeded'), { zohoStatus: 429 }),
}, async (svc, calls) => {
  const result = await svc.syncConversationToZoho({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: CONTACT_NUMBER });

  assert.equal(result.synced, true);
  assert.equal(result.partial, true);
  assert.equal(result.lead.zohoLeadId, 'LEAD1');
  assert.equal(result.note, null);
  assert.match(result.noteError, /rate limit/);
}));

// Phase 8J FIX — Fix 2 changed this test's premise. A COMPLETE sync with
// name+place actually extracted is no longer "nothing worth noting" — see
// the "baseline customer-information Note" tests below for that behavior.
// This test now covers the true edge case the old title described: name
// AND place both genuinely absent from the extraction object despite
// standard.status somehow reporting COMPLETE (defensive-only; 8D/8F never
// actually produce this combination in practice) — there truly is nothing,
// of any kind, to write into a Note.
test('syncConversationToZoho: never touches Lead/Note when there is truly nothing to note (no name/place/interest/business fields)', withMocks({
  extractionResult: {
    extraction: baseExtraction({
      interest_summary: null,
      name: { value: null, confidence: 0, evidence: [] },
      place: { value: null, type: 'unknown', confidence: 0, evidence: [] },
    }),
    standard: { status: 'COMPLETE', missing_required_fields: [], uncertain_fields: [] },
    business: { status: 'COMPLETE', extracted_fields: {}, missing_required_fields: [], uncertain_fields: [] },
    fieldDefinitions: [],
    complete: true,
    audit: null,
    error: null,
  },
  createLeadResult: { zohoLeadId: 'LEAD1', status: 'synced', created: true, droppedFields: [] },
}, async (svc, calls) => {
  const result = await svc.syncConversationToZoho({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: CONTACT_NUMBER });

  assert.equal(calls.createNote.length, 0);
  assert.equal(result.synced, true);
  assert.equal(result.partial, false);
  assert.equal(result.note, null);
}));

// ── Phase 8J FIX — Fix 2: Suresh's scenario ──────────────────────────────
// A valid, COMPLETE first-time Lead sync (name + place confirmed) whose
// interest_summary happens to come back empty this run, and with no
// unmapped/dropped business fields either, must still get a baseline
// customer-information Note built ONLY from already-confirmed fields —
// never silently completing with zero Note at all.
test('syncConversationToZoho: Suresh-style message (name+place+email, no stated interest) -> Note is built from confirmed fields only', withMocks({
  extractionResult: {
    extraction: baseExtraction({
      name: { value: 'Suresh', confidence: 0.9, evidence: [] },
      place: { value: 'Madurai', type: 'residence', confidence: 0.9, evidence: [] },
      email: { value: 'suresh@test.com', confidence: 0.9, evidence: [] },
      interest_summary: null,
    }),
    standard: { status: 'COMPLETE', missing_required_fields: [], uncertain_fields: [] },
    business: { status: 'COMPLETE', extracted_fields: {}, missing_required_fields: [], uncertain_fields: [] },
    fieldDefinitions: [],
    complete: true,
    audit: null,
    error: null,
  },
  createLeadResult: { zohoLeadId: 'LEAD-SURESH', status: 'synced', created: true, droppedFields: [] },
  createNoteResult: { zohoNoteId: 'NOTE-SURESH', status: 'synced' },
}, async (svc, calls) => {
  const result = await svc.syncConversationToZoho({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: CONTACT_NUMBER });

  assert.equal(calls.createNote.length, 1);
  assert.equal(calls.createNote[0].name, 'Suresh');
  assert.equal(calls.createNote[0].location, 'Madurai');
  assert.equal(calls.createNote[0].email, 'suresh@test.com');
  // Never fabricates an interest that was never actually stated.
  assert.equal(calls.createNote[0].interest, null);
  assert.equal(result.synced, true);
  assert.equal(result.partial, false);
  assert.equal(result.note.zohoNoteId, 'NOTE-SURESH');
}));

// Confirmed standard fields (name/place) and a real interest_summary are
// both passed through to the consolidated Note together — neither
// overrides nor duplicates the other.
test('syncConversationToZoho: confirmed name/place fields and real interest_summary are both passed through together', withMocks({
  extractionResult: {
    extraction: baseExtraction(), // has interest_summary: 'Interested in a metal roof'
    standard: { status: 'COMPLETE', missing_required_fields: [], uncertain_fields: [] },
    business: { status: 'COMPLETE', extracted_fields: {}, missing_required_fields: [], uncertain_fields: [] },
    fieldDefinitions: [],
    complete: true,
    audit: null,
    error: null,
  },
  createLeadResult: { zohoLeadId: 'LEAD1', status: 'synced', created: true, droppedFields: [] },
  createNoteResult: { zohoNoteId: 'NOTE1', status: 'synced' },
}, async (svc, calls) => {
  await svc.syncConversationToZoho({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: CONTACT_NUMBER });

  assert.equal(calls.createNote.length, 1);
  assert.equal(calls.createNote[0].interest, 'Interested in a metal roof');
  assert.equal(calls.createNote[0].name, 'Ravi Kumar');
  assert.equal(calls.createNote[0].location, 'Chennai');
}));

// ── Phase 8I FIX — PART 3 regression: Arun's scenario ────────────────────
// A prior attempt's Note failed (401) and left a zoho_lead_notes row
// 'failed'. THIS retry's re-run extraction comes back with no note-worthy
// content at all (interest_summary null, nothing unmapped/dropped, AND —
// for this defensive test — name/place also absent from the extraction
// object so Fix 2's baseline-Note fallback can't fill the gap either,
// isolating this test to the unresolved-obligation bookkeeping path
// itself). The still-unresolved Note obligation means the sync must NOT be
// reported as full/completed success, and it must NOT silently drop the
// Note forever.
test('syncConversationToZoho: empty note content on retry, but a prior Note attempt is still failed for this Lead -> stays partial, never falsely "completed"', withMocks({
  extractionResult: {
    extraction: baseExtraction({
      interest_summary: null,
      name: { value: null, confidence: 0, evidence: [] },
      place: { value: null, type: 'unknown', confidence: 0, evidence: [] },
    }),
    standard: { status: 'COMPLETE', missing_required_fields: [], uncertain_fields: [] },
    business: { status: 'COMPLETE', extracted_fields: {}, missing_required_fields: [], uncertain_fields: [] },
    fieldDefinitions: [],
    complete: true,
    audit: null,
    error: null,
  },
  existingLink: { zohoLeadId: '1410618000000545002' },
  updateLeadResult: { zohoLeadId: '1410618000000545002', status: 'synced', created: false, droppedFields: [] },
}, async (svc, calls) => {
  const pool = require('../src/db');
  const originalQuery = pool.query;
  const dbCalls = [];
  pool.query = async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    dbCalls.push({ sql: s, params });
    if (/^SELECT 1 FROM coexistence\.zoho_lead_notes/.test(s)) {
      // Simulate Arun's still-failed prior Note attempt for this Lead.
      return { rows: [{ '?column?': 1 }] };
    }
    if (/^SELECT attempt_count, max_attempts FROM coexistence\.zoho_sync_state/.test(s)) {
      return { rows: [{ attempt_count: 6, max_attempts: 8 }] };
    }
    return { rows: [] };
  };

  try {
    const result = await svc.syncConversationToZoho({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: CONTACT_NUMBER });

    // Must never call createNote with empty content — the fix is about
    // bookkeeping honesty, not fabricating a Note submission.
    assert.equal(calls.createNote.length, 0);

    // Root-cause regression guard: this must NOT be reported/recorded as a
    // full, non-partial success.
    assert.equal(result.partial, true, 'must stay partial — a prior Note attempt for this Lead is still unresolved');
    assert.equal(result.note, null);
    assert.ok(result.noteError, 'must surface a noteError explaining the sync is still open');

    const upsert = dbCalls.find((c) => /INSERT INTO coexistence\.zoho_sync_state/.test(c.sql));
    assert.ok(upsert, 'expected a zoho_sync_state upsert');
    assert.match(upsert.sql, /sync_status = 'note_pending'/, 'must record note_pending, never completed, while the Note is still unresolved');
    assert.doesNotMatch(upsert.sql, /'completed'/, 'must never mark this row completed while an earlier Note attempt is still failed');

    // ── Phase 8J FIX — Fix 1 regression guard ──────────────────────────
    // This is the exact condition that was previously misclassified as
    // permanent_failure (~100y delay, 2126). It must now be
    // retryable_failure with a real, bounded backoff.
    assert.match(upsert.sql, /failure_type = \$6/, 'sanity: failure_type is parameterized');
    assert.equal(upsert.params[5], 'retryable_failure', 'the unresolved-Note-obligation condition must classify as retryable_failure, never permanent_failure');
    const delayMs = Number(upsert.params[7]);
    assert.ok(delayMs > 0, 'must have a real, positive backoff');
    assert.ok(delayMs < 1000 * 60 * 60 * 24, 'must be a normal bounded backoff (< 1 day), never the ~100-year permanent-failure placeholder');
  } finally {
    pool.query = originalQuery;
  }
}));

test('syncConversationToZoho: every call is scoped to the exact workspace/account passed in (isolation)', withMocks({
  extractionResult: {
    extraction: baseExtraction(),
    standard: { status: 'COMPLETE', missing_required_fields: [], uncertain_fields: [] },
    business: { status: 'COMPLETE', extracted_fields: {}, missing_required_fields: [], uncertain_fields: [] },
    fieldDefinitions: [],
    complete: true,
    audit: null,
    error: null,
  },
  createLeadResult: { zohoLeadId: 'LEAD1', status: 'synced', created: true, droppedFields: [] },
}, async (svc, calls) => {
  await svc.syncConversationToZoho({ workspaceId: WORKSPACE_ID, whatsappAccountId: OTHER_WA_ACCOUNT_ID, contactNumber: CONTACT_NUMBER });

  assert.equal(calls.resolveConnectionRow[0].whatsappAccountId, OTHER_WA_ACCOUNT_ID);
  assert.equal(calls.extractBusinessFields[0].whatsappAccountId, OTHER_WA_ACCOUNT_ID);
  assert.equal(calls.getLinkedLead[0].whatsappAccountId, OTHER_WA_ACCOUNT_ID);
  assert.equal(calls.createLead[0].whatsappAccountId, OTHER_WA_ACCOUNT_ID);
}));

test('syncConversationToZoho: rejects missing ids before any service call', async () => {
  const svc = require('../src/services/zohoSyncService');
  await assert.rejects(() => svc.syncConversationToZoho({ whatsappAccountId: WA_ACCOUNT_ID, contactNumber: CONTACT_NUMBER }), /workspaceId is required/);
  await assert.rejects(() => svc.syncConversationToZoho({ workspaceId: WORKSPACE_ID, contactNumber: CONTACT_NUMBER }), /whatsappAccountId is required/);
  await assert.rejects(() => svc.syncConversationToZoho({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID }), /valid contactNumber is required/);
});