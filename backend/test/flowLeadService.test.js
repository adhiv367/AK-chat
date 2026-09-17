'use strict';

// Phase 6.11 — Flow -> Lead creation/update tests.
//
// Two layers, matching how the feature is actually wired:
//
//   1. flowLeadService.attemptFlowToLead() in isolation — mocks
//      zohoLeadService.getLinkedLead/createLead/updateLead directly (same
//      monkey-patch-the-module-export approach as
//      test/zohoSyncService.test.js / test/zohoSyncServiceIncompleteExtraction.test.js
//      already use for the exact same three functions). No real Postgres,
//      no real Zoho.
//
//   2. flowSubmissionService.recordFlowSubmission()'s Phase 6.11 hook —
//      mocks pool.query (same approach as test/flowSubmissionHistory.test.js)
//      plus flowLeadService.attemptFlowToLead itself, to prove the hook is
//      wired at the right point (after insert + after contact mapping) and
//      is correctly skipped on a duplicate message_id.

const test = require('node:test');
const assert = require('node:assert/strict');

const zohoLeadService = require('../src/services/zohoLeadService');
const flowLeadService = require('../src/services/flowLeadService');

function withMockedZohoLeadService(overrides, fn) {
  const original = {
    getLinkedLead: zohoLeadService.getLinkedLead,
    createLead: zohoLeadService.createLead,
    updateLead: zohoLeadService.updateLead,
  };
  Object.assign(zohoLeadService, overrides);
  return Promise.resolve()
    .then(fn)
    .finally(() => Object.assign(zohoLeadService, original));
}

const FLOW_ID = 6;
const FLOW_NAME = 'Dress Requirement';
const FIELD_MAPPING = {
  customer_name: 'name',
  dress_type: 'dress_type',
  dress_size: 'dress_size',
  preferred_color: 'preferred_color',
  budget: 'budget',
  delivery_location: 'delivery_location',
};
const RESPONSE_DATA = {
  flow_token: 'secret-token',
  customer_name: 'Nancy',
  dress_type: 'new_arrivals',
  dress_size: 'l',
  preferred_color: 'Violet',
  budget: '2000_plus',
  delivery_location: 'Hawkins',
};

function baseParams(overrides = {}) {
  return {
    flowId: FLOW_ID,
    flowName: FLOW_NAME,
    fieldMapping: FIELD_MAPPING,
    workspaceId: 1,
    whatsappAccountId: 5,
    contactNumber: '919999999999',
    responseData: RESPONSE_DATA,
    ...overrides,
  };
}

// 1. Valid Flow submission -> exactly one Lead (createLead called once).
test('attemptFlowToLead — valid submission creates exactly one Lead', async () => {
  let createCalls = 0;
  let getLinkedCalls = 0;
  await withMockedZohoLeadService({
    getLinkedLead: async () => { getLinkedCalls += 1; return null; },
    createLead: async (input) => { createCalls += 1; return { zohoLeadId: 'LEAD1', created: true, droppedFields: [] }; },
    updateLead: async () => { throw new Error('updateLead should not be called'); },
  }, async () => {
    const result = await flowLeadService.attemptFlowToLead(baseParams());
    assert.equal(result.attempted, true);
    assert.equal(result.ok, true);
    assert.equal(result.zohoLeadId, 'LEAD1');
    assert.equal(result.created, true);
    assert.equal(createCalls, 1);
    assert.equal(getLinkedCalls, 1);
  });
});

// 2 / 3. Existing linked Lead -> update instead of creating another Lead
// (this is also how "duplicate submission never duplicates a Lead" is
// guaranteed at the Lead-identity level — see flowSubmissionService's own
// message_id-level duplicate test below for the other half of that spec item).
test('attemptFlowToLead — existing linked Lead updates instead of creating another', async () => {
  let createCalls = 0;
  let updateCalls = 0;
  await withMockedZohoLeadService({
    getLinkedLead: async () => ({ zohoLeadId: 'LEAD1', status: 'synced' }),
    createLead: async () => { createCalls += 1; throw new Error('createLead should not be called'); },
    updateLead: async (input) => { updateCalls += 1; return { zohoLeadId: 'LEAD1', created: false, droppedFields: [] }; },
  }, async () => {
    const result = await flowLeadService.attemptFlowToLead(baseParams());
    assert.equal(result.ok, true);
    assert.equal(result.created, false);
    assert.equal(updateCalls, 1);
    assert.equal(createCalls, 0);
  });
});

// 4. Workspace / WhatsApp-account isolation — the exact identifiers passed
// in are the exact identifiers forwarded to getLinkedLead/createLead, never
// substituted or defaulted.
test('attemptFlowToLead — forwards exact workspace/account/contact identifiers (isolation)', async () => {
  const seen = {};
  await withMockedZohoLeadService({
    getLinkedLead: async (workspaceId, whatsappAccountId, contactNumber) => {
      seen.getLinked = { workspaceId, whatsappAccountId, contactNumber };
      return null;
    },
    createLead: async (input) => {
      seen.create = input;
      return { zohoLeadId: 'LEAD9', created: true, droppedFields: [] };
    },
    updateLead: async () => { throw new Error('not expected'); },
  }, async () => {
    await flowLeadService.attemptFlowToLead(baseParams({ workspaceId: 42, whatsappAccountId: 7, contactNumber: '911111111111' }));
    assert.deepEqual(seen.getLinked, { workspaceId: 42, whatsappAccountId: 7, contactNumber: '911111111111' });
    assert.equal(seen.create.workspaceId, 42);
    assert.equal(seen.create.whatsappAccountId, 7);
    assert.equal(seen.create.contactNumber, '911111111111');
  });
});

// 5. Flow field_mapping correctly determines customer name — arbitrary
// mapping, no hardcoded field keys.
test('resolveCustomerName — uses field_mapping to find the "name"-targeted field, arbitrary key', async () => {
  assert.equal(flowLeadService.resolveCustomerName(FIELD_MAPPING, RESPONSE_DATA), 'Nancy');

  // A totally different Flow with a differently-named submitted key still
  // resolves correctly, because it's driven by field_mapping, not a
  // hardcoded key name.
  const otherMapping = { full_name: 'name', roof_type: 'roof_type' };
  const otherData = { full_name: 'Priya', roof_type: 'metal' };
  assert.equal(flowLeadService.resolveCustomerName(otherMapping, otherData), 'Priya');

  // No field mapped to "name" -> null, never a guessed name.
  assert.equal(flowLeadService.resolveCustomerName({ roof_type: 'roof_type' }, { roof_type: 'metal' }), null);
});

// 6. Description contains submitted customer details.
// 7. Description contains the exact required phrase.
test('buildDescription — one line, includes submitted details, flow name/id, and exact required phrase', async () => {
  const description = flowLeadService.buildDescription({
    fieldMapping: FIELD_MAPPING,
    responseData: RESPONSE_DATA,
    flowName: FLOW_NAME,
    flowId: FLOW_ID,
  });

  assert.equal(description.includes('\n'), false, 'description must be one line');
  assert.match(description, /Customer Name: Nancy/);
  assert.match(description, /Dress Type: new_arrivals/);
  assert.match(description, /Dress Size: l/);
  assert.match(description, /Preferred Color: Violet/);
  assert.match(description, /Budget: 2000_plus/);
  assert.match(description, /Delivery Location: Hawkins/);
  assert.match(description, /Flow: Dress Requirement \(ID: 6\)/);
  assert.ok(description.includes('created from WhatsApp Flow Form'));

  // flow_token must never leak into the Lead description even though it's
  // present in responseData — it isn't part of field_mapping.
  assert.equal(description.includes('secret-token'), false);
});

// 8. Lead creation failure does NOT throw / does not fail the caller.
test('attemptFlowToLead — Lead creation failure is caught, never thrown', async () => {
  await withMockedZohoLeadService({
    getLinkedLead: async () => null,
    createLead: async () => { throw new Error('Zoho CRM API request failed (500)'); },
    updateLead: async () => { throw new Error('not expected'); },
  }, async () => {
    const result = await flowLeadService.attemptFlowToLead(baseParams());
    assert.equal(result.attempted, true);
    assert.equal(result.ok, false);
    assert.match(result.reason, /Zoho CRM API request failed/);
  });
});

// 9. Missing Zoho connection does NOT throw — surfaced as a safe result.
test('attemptFlowToLead — missing Zoho connection is caught, never thrown', async () => {
  await withMockedZohoLeadService({
    getLinkedLead: async () => { const err = new Error('No Zoho CRM connection found for this WhatsApp account'); err.status = 404; throw err; },
    createLead: async () => { throw new Error('not expected'); },
    updateLead: async () => { throw new Error('not expected'); },
  }, async () => {
    const result = await flowLeadService.attemptFlowToLead(baseParams());
    assert.equal(result.attempted, true);
    assert.equal(result.ok, false);
    assert.match(result.reason, /No Zoho CRM connection found/);
  });
});

// Missing identifiers -> not even attempted (never crashes upstream).
test('attemptFlowToLead — missing workspace/account/contact never attempts, never throws', async () => {
  const result = await flowLeadService.attemptFlowToLead(baseParams({ whatsappAccountId: null }));
  assert.equal(result.attempted, false);
  assert.equal(result.ok, false);
});

// Never leaks secrets in the returned reason.
test('attemptFlowToLead — never leaks tokens/secrets in the returned reason', async () => {
  await withMockedZohoLeadService({
    getLinkedLead: async () => null,
    createLead: async () => { const err = new Error('Zoho CRM API request failed (401: unauthorized)'); throw err; },
    updateLead: async () => { throw new Error('not expected'); },
  }, async () => {
    const result = await flowLeadService.attemptFlowToLead(baseParams());
    assert.equal(result.ok, false);
    assert.equal(/access_token|refresh_token|Bearer|oauthtoken/i.test(result.reason), false);
  });
});

// ── Layer 2: flowSubmissionService's Phase 6.11 hook ─────────────────────

const pool = require('../src/db');
const flowSubmissionService = require('../src/services/flowSubmissionService');
const messageSender = require('../src/services/messageSender');
const flowFieldMappingService = require('../src/services/flowFieldMappingService');

function installHookTestDb({ existingSubmissionMessageIds = [] } = {}) {
  const original = pool.query;
  pool.query = async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (/FROM coexistence\.chat_history/.test(s)) {
      // The original outgoing Flow send that produced this flow_token.
      return { rows: [{ message_id: 'wamid.out1', template_meta: JSON.stringify({ flowId: FLOW_ID, metaFlowId: 'meta-flow-1' }) }] };
    }
    if (/FROM coexistence\.flow_versions/.test(s)) {
      return { rows: [{ id: 100 }] };
    }
    if (/INSERT INTO coexistence\.flow_submissions/.test(s)) {
      const messageId = params[4];
      if (existingSubmissionMessageIds.includes(messageId)) {
        return { rows: [], rowCount: 0 }; // ON CONFLICT DO NOTHING — duplicate
      }
      return { rows: [{ id: 555 }], rowCount: 1 };
    }
    if (/UPDATE coexistence\.flow_submissions SET mapped_at/.test(s)) {
      return { rows: [] };
    }
    if (/SELECT name, field_mapping FROM coexistence\.flows/.test(s)) {
      return { rows: [{ name: FLOW_NAME, field_mapping: FIELD_MAPPING }] };
    }
    throw new Error(`Unmocked query in flowLeadService.test.js hook layer: ${s}`);
  };
  return { restore() { pool.query = original; } };
}

function withMockedResolveAccount(fn) {
  const original = messageSender.resolveAccount;
  messageSender.resolveAccount = async () => ({ account: { workspaceId: 1, id: 5, displayPhoneNumber: '911234567890' } });
  return Promise.resolve().then(fn).finally(() => { messageSender.resolveAccount = original; });
}

function withMockedContactMapping(fn) {
  const original = flowFieldMappingService.mapFlowSubmissionToContact;
  flowFieldMappingService.mapFlowSubmissionToContact = async () => ({ attempted: false, mapped: [], skipped: [] });
  return Promise.resolve().then(fn).finally(() => { flowFieldMappingService.mapFlowSubmissionToContact = original; });
}

function nfmReplyFor(responseData) {
  return { name: 'flow', body: 'Sent', response_json: JSON.stringify(responseData) };
}

// 1 (integration). A fresh, valid submission triggers exactly one
// Flow -> Lead attempt (createLead called once).
test('recordFlowSubmission — valid non-duplicate submission triggers exactly one Lead attempt', async () => {
  const db = installHookTestDb();
  let leadAttempts = 0;
  await withMockedResolveAccount(() => withMockedContactMapping(() => withMockedZohoLeadService({
    getLinkedLead: async () => null,
    createLead: async () => { leadAttempts += 1; return { zohoLeadId: 'LEAD1', created: true, droppedFields: [] }; },
    updateLead: async () => { throw new Error('not expected'); },
  }, async () => {
    const result = await flowSubmissionService.recordFlowSubmission({
      nfmReply: nfmReplyFor(RESPONSE_DATA),
      messageId: 'wamid.in1',
      phoneNumberId: 'pn1',
      contactNumber: '919999999999',
      waNumber: '911234567890',
    });
    assert.equal(result.ok, true);
    assert.equal(leadAttempts, 1);
  })));
  db.restore();
});

// 2 (integration). Duplicate message_id -> flow_submissions insert is a
// no-op (rowCount 0) -> Flow -> Lead is never attempted again.
test('recordFlowSubmission — duplicate message_id never attempts a Lead', async () => {
  const db = installHookTestDb({ existingSubmissionMessageIds: ['wamid.dup1'] });
  let leadAttempts = 0;
  await withMockedResolveAccount(() => withMockedContactMapping(() => withMockedZohoLeadService({
    getLinkedLead: async () => null,
    createLead: async () => { leadAttempts += 1; return { zohoLeadId: 'LEAD1', created: true, droppedFields: [] }; },
    updateLead: async () => { throw new Error('not expected'); },
  }, async () => {
    const result = await flowSubmissionService.recordFlowSubmission({
      nfmReply: nfmReplyFor(RESPONSE_DATA),
      messageId: 'wamid.dup1',
      phoneNumberId: 'pn1',
      contactNumber: '919999999999',
      waNumber: '911234567890',
    });
    assert.equal(result.ok, true);
    assert.equal(result.duplicate, true);
    assert.equal(leadAttempts, 0);
  })));
  db.restore();
});

// 8 (integration). Lead creation failure must not fail the Flow submission.
test('recordFlowSubmission — Lead creation failure does not fail the Flow submission', async () => {
  const db = installHookTestDb();
  await withMockedResolveAccount(() => withMockedContactMapping(() => withMockedZohoLeadService({
    getLinkedLead: async () => null,
    createLead: async () => { throw new Error('Zoho CRM API request failed (500)'); },
    updateLead: async () => { throw new Error('not expected'); },
  }, async () => {
    const result = await flowSubmissionService.recordFlowSubmission({
      nfmReply: nfmReplyFor(RESPONSE_DATA),
      messageId: 'wamid.in2',
      phoneNumberId: 'pn1',
      contactNumber: '919999999999',
      waNumber: '911234567890',
    });
    assert.equal(result.ok, true); // submission itself still succeeds
  })));
  db.restore();
});

// 9 (integration). Missing Zoho connection does not fail the Flow submission.
test('recordFlowSubmission — missing Zoho connection does not fail the Flow submission', async () => {
  const db = installHookTestDb();
  await withMockedResolveAccount(() => withMockedContactMapping(() => withMockedZohoLeadService({
    getLinkedLead: async () => { const err = new Error('No Zoho CRM connection found for this WhatsApp account'); err.status = 404; throw err; },
    createLead: async () => { throw new Error('not expected'); },
    updateLead: async () => { throw new Error('not expected'); },
  }, async () => {
    const result = await flowSubmissionService.recordFlowSubmission({
      nfmReply: nfmReplyFor(RESPONSE_DATA),
      messageId: 'wamid.in3',
      phoneNumberId: 'pn1',
      contactNumber: '919999999999',
      waNumber: '911234567890',
    });
    assert.equal(result.ok, true); // submission itself still succeeds
  })));
  db.restore();
});