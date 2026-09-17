'use strict';

// Phase 8H Part 2 — tests for the incomplete-extraction observability +
// bookkeeping fix in zohoSyncService.js:
//   - the standard.status !== 'COMPLETE' branch now logs safely (no
//     message content/tokens/secrets) via zohoSafeLogger
//   - it persists a dedicated, non-retryable-by-the-scheduler
//     zoho_sync_state row (sync_status='incomplete') via the new
//     recordIncompleteExtraction() helper
//   - the existing `{ synced:false, reason:'incomplete_extraction', ... }`
//     return shape is unchanged
//   - a later retry with a COMPLETE extraction can still create a Lead
//     (progress incomplete -> Lead creation happens via a normal
//     re-invocation of syncConversationToZoho, not a special "resume" path)
//
// Follows the same two mocking patterns already established in this
// suite: zohoSyncService.test.js's withMocks() for the orchestration-level
// service-call assertions, and zohoSyncServiceBookkeeping.test.js's
// installDb() for asserting exact SQL/params against the shared pool
// singleton.

const test = require('node:test');
const assert = require('node:assert/strict');

const WORKSPACE_ID = 1;
const WA_ACCOUNT_ID = 5;
const CONTACT_NUMBER = '+91 99999 99999';
const { normalizePhone } = require('../src/services/contactSyncService');
const NORMALIZED_CONTACT_NUMBER = normalizePhone(CONTACT_NUMBER);

function installDb(query) {
  const pool = require('../src/db');
  const original = pool.query;
  pool.query = query;
  return () => { pool.query = original; };
}

function freshSyncService() {
  delete require.cache[require.resolve('../src/services/zohoSyncService')];
  return require('../src/services/zohoSyncService');
}

function baseExtraction(overrides = {}) {
  return {
    name: { value: 'Ravi Kumar', confidence: 0.9, evidence: [] },
    place: { value: null, type: 'unknown', confidence: 0, evidence: [] },
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
      createNote: zohoNoteService.createNote,
      extractBusinessFields: businessFieldExtractionService.extractBusinessFields,
    };

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

    zohoNoteService.createNote = async (input) => {
      calls.createNote.push(input);
      return createNoteResult;
    };

    try {
      const svc = freshSyncService();
      await run(svc, calls);
    } finally {
      Object.assign(zohoLeadService, {
        resolveConnectionRow: original.resolveConnectionRow,
        getLinkedLead: original.getLinkedLead,
        createLead: original.createLead,
        updateLead: original.updateLead,
      });
      zohoNoteService.createNote = original.createNote;
      businessFieldExtractionService.extractBusinessFields = original.extractBusinessFields;
    }
  };
}

const INCOMPLETE_EXTRACTION_RESULT = {
  extraction: baseExtraction(),
  standard: { status: 'INCOMPLETE', missing_required_fields: ['place'], uncertain_fields: ['name'] },
  business: { status: 'COMPLETE', extracted_fields: {}, missing_required_fields: [], uncertain_fields: [] },
  fieldDefinitions: [],
  complete: false,
  audit: null,
  error: null,
};

const COMPLETE_EXTRACTION_RESULT = {
  extraction: baseExtraction({ place: { value: 'Chennai', type: 'residence', confidence: 0.9, evidence: [] } }),
  standard: { status: 'COMPLETE', missing_required_fields: [], uncertain_fields: [] },
  business: { status: 'COMPLETE', extracted_fields: {}, missing_required_fields: [], uncertain_fields: [] },
  fieldDefinitions: [],
  complete: true,
  audit: null,
  error: null,
};

// ── safe logging ─────────────────────────────────────────────────────────

test('incomplete extraction logs safely: only ids/status/missing/uncertain fields, no message content or secrets', withMocks({
  extractionResult: INCOMPLETE_EXTRACTION_RESULT,
}, async (svc) => {
  const safeLog = require('../src/services/zohoSafeLogger');
  const originalInfo = safeLog.info;
  const logged = [];
  safeLog.info = (message, context) => { logged.push({ message, context }); };
  const restoreDb = installDb(async () => ({ rows: [] }));
  try {
    await svc.syncConversationToZoho({
      workspaceId: WORKSPACE_ID,
      whatsappAccountId: WA_ACCOUNT_ID,
      contactNumber: CONTACT_NUMBER,
      conversationMessages: [{ role: 'user', content: 'my secret address is 12 Example Street, super-secret-token-abc' }],
    });

    const line = logged.find((l) => /incomplete extraction/i.test(l.message));
    assert.ok(line, 'expected an incomplete-extraction log line');
    assert.equal(line.context.workspaceId, WORKSPACE_ID);
    assert.equal(line.context.whatsappAccountId, WA_ACCOUNT_ID);
    assert.equal(line.context.contactNumber, NORMALIZED_CONTACT_NUMBER);
    assert.equal(line.context.standardStatus, 'INCOMPLETE');
    assert.deepEqual(line.context.missingRequiredFields, ['place']);
    assert.deepEqual(line.context.uncertainFields, ['name']);

    const serialized = JSON.stringify(line);
    assert.doesNotMatch(serialized, /Example Street/);
    assert.doesNotMatch(serialized, /super-secret-token/);
  } finally {
    safeLog.info = originalInfo;
    restoreDb();
  }
}));

// ── bookkeeping row ──────────────────────────────────────────────────────

test('incomplete extraction creates a zoho_sync_state row with a dedicated non-retried status', withMocks({
  extractionResult: INCOMPLETE_EXTRACTION_RESULT,
}, async (svc) => {
  const calls = [];
  const restoreDb = installDb(async (sql, params) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return { rows: [] };
  });
  try {
    await svc.syncConversationToZoho({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: CONTACT_NUMBER });

    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /INSERT INTO coexistence\.zoho_sync_state/);
    assert.match(calls[0].sql, /'incomplete'/);
    // never mis-classified as a Zoho API failure
    assert.doesNotMatch(calls[0].sql, /retryable_failure|permanent_failure|reauth_required/);
    assert.equal(calls[0].params[0], WORKSPACE_ID);
    assert.equal(calls[0].params[1], WA_ACCOUNT_ID);
    assert.equal(calls[0].params[2], 10, 'zohoConnectionId from resolveConnectionRow');
    assert.equal(calls[0].params[3], NORMALIZED_CONTACT_NUMBER);
  } finally {
    restoreDb();
  }
}));

test('incomplete extraction bookkeeping write failures are swallowed (non-fatal)', withMocks({
  extractionResult: INCOMPLETE_EXTRACTION_RESULT,
}, async (svc) => {
  const restoreDb = installDb(async () => { throw new Error('db unavailable'); });
  try {
    await assert.doesNotReject(() =>
      svc.syncConversationToZoho({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: CONTACT_NUMBER })
    );
  } finally {
    restoreDb();
  }
}));

// ── return shape unchanged ──────────────────────────────────────────────

test('incomplete extraction keeps the existing return shape', withMocks({
  extractionResult: INCOMPLETE_EXTRACTION_RESULT,
}, async (svc, calls) => {
  const restoreDb = installDb(async () => ({ rows: [] }));
  try {
    const result = await svc.syncConversationToZoho({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: CONTACT_NUMBER });

    assert.equal(result.synced, false);
    assert.equal(result.reason, 'incomplete_extraction');
    assert.equal(result.lead, null);
    assert.equal(result.note, null);
    assert.equal(result.partial, false);
    assert.equal(result.noteError, null);
    assert.deepEqual(result.unmappedFields, []);
    assert.deepEqual(result.droppedZohoFields, []);
    assert.equal(calls.createLead.length, 0);
    assert.equal(calls.updateLead.length, 0);
    assert.equal(calls.createNote.length, 0);
  } finally {
    restoreDb();
  }
}));

// ── later retry with COMPLETE extraction progresses to Lead creation ────

test('a later incoming message with COMPLETE extraction creates the Lead (incomplete -> Lead progress)', async () => {
  const zohoLeadService = require('../src/services/zohoLeadService');
  const zohoNoteService = require('../src/services/zohoNoteService');
  const businessFieldExtractionService = require('../src/services/businessFieldExtractionService');

  const original = {
    resolveConnectionRow: zohoLeadService.resolveConnectionRow,
    getLinkedLead: zohoLeadService.getLinkedLead,
    createLead: zohoLeadService.createLead,
    extractBusinessFields: businessFieldExtractionService.extractBusinessFields,
    createNote: zohoNoteService.createNote,
  };

  let extractionCallCount = 0;
  zohoLeadService.resolveConnectionRow = async () => ({ id: 10, status: 'connected' });
  zohoLeadService.getLinkedLead = async () => null;
  zohoLeadService.createLead = async (input) => ({ zohoLeadId: 'LEAD1', status: 'synced', created: true, droppedFields: [] });
  zohoNoteService.createNote = async () => ({ zohoNoteId: 'NOTE1', status: 'synced' });
  businessFieldExtractionService.extractBusinessFields = async () => {
    extractionCallCount += 1;
    return extractionCallCount === 1 ? INCOMPLETE_EXTRACTION_RESULT : COMPLETE_EXTRACTION_RESULT;
  };

  const restoreDb = installDb(async () => ({ rows: [] }));
  try {
    const svc = freshSyncService();

    const firstResult = await svc.syncConversationToZoho({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: CONTACT_NUMBER });
    assert.equal(firstResult.synced, false);
    assert.equal(firstResult.reason, 'incomplete_extraction');

    // Simulates the webhook handler re-invoking sync on the next inbound
    // WhatsApp message — no special "resume" path, just a normal call.
    const secondResult = await svc.syncConversationToZoho({ workspaceId: WORKSPACE_ID, whatsappAccountId: WA_ACCOUNT_ID, contactNumber: CONTACT_NUMBER });
    assert.equal(secondResult.synced, true);
    assert.equal(secondResult.lead.zohoLeadId, 'LEAD1');
  } finally {
    restoreDb();
    Object.assign(zohoLeadService, {
      resolveConnectionRow: original.resolveConnectionRow,
      getLinkedLead: original.getLinkedLead,
      createLead: original.createLead,
    });
    zohoNoteService.createNote = original.createNote;
    businessFieldExtractionService.extractBusinessFields = original.extractBusinessFields;
  }
});

// ── scheduler never retries 'incomplete' rows ────────────────────────────

test('the reconciliation scheduler claim query excludes the incomplete status (no infinite retry loop)', async () => {
  const pool = require('../src/db');
  const originalConnect = pool.connect;
  const dispatch = async (sql) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^BEGIN$|^COMMIT$|^ROLLBACK$/.test(s)) return { rows: [] };
    if (/SELECT id\s+FROM coexistence\.zoho_sync_state/.test(s)) {
      assert.match(s, /sync_status IN \('pending', 'lead_synced', 'note_pending'\)/);
      assert.doesNotMatch(s, /'incomplete'/);
      return { rows: [] };
    }
    return { rows: [] };
  };
  pool.connect = async () => ({ query: dispatch, release() {} });
  try {
    delete require.cache[require.resolve('../src/services/zohoReconciliationService')];
    const zohoReconciliationService = require('../src/services/zohoReconciliationService');
    const ids = await zohoReconciliationService.claimDueSyncStateRows(10);
    assert.deepEqual(ids, []);
  } finally {
    pool.connect = originalConnect;
  }
});

test('ZOHO_SYNC_STATUSES includes incomplete as a distinct, non-Zoho-failure status', () => {
  const { ZOHO_SYNC_STATUSES } = require('../src/db/zohoSyncStateSchema');
  assert.ok(ZOHO_SYNC_STATUSES.includes('incomplete'));
});

