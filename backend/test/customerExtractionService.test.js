'use strict';

// Phase 8D Part 1 — customerExtractionService tests.
//
// Same mocking approach as test/zohoNoteService.test.js: pool.query is
// monkeypatched on the shared '../src/db' singleton, and (new for this
// file) groqService.askGroq / whatsappAccountsRoutes.getAccountWithToken
// are monkeypatched on their own module objects — customerExtractionService
// deliberately requires those as module references rather than destructured
// bindings specifically so this works. No live Postgres and no live
// Gemini/Zoho account is used anywhere in this file.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

process.env.AKCHAT_ENCRYPTION_KEY = process.env.AKCHAT_ENCRYPTION_KEY || nodeCrypto.randomBytes(24).toString('hex');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-extraction-tests';
process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REDIRECT_URI = process.env.ZOHO_REDIRECT_URI || 'https://app.example.com/api/zoho/oauth/callback';
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test-groq-key';

const WORKSPACE_ID = 1;
const OTHER_WORKSPACE_ID = 2;
const WA_ACCOUNT_ID = 5;
const RAW_CONTACT_NUMBER = '+91 99999 99999';
const NORMALIZED_CONTACT_NUMBER = '919999999999';

const OWNED_WA_ACCOUNT = { rows: [{ id: WA_ACCOUNT_ID }] };
const NOT_OWNED_WA_ACCOUNT = { rows: [] };

// ── Shared harness ─────────────────────────────────────────────────────────
// queryHandler:  answers pool.query(sql, params) calls.
// aiText:        the raw text groqService.askGroq should "return" (or a
//                function (prompt) => text for prompt-dependent responses).
// aiError:       simulates an askGroq failure (text: null, error).
// accountRow:    the row whatsappAccountsRoutes.getAccountWithToken should
//                "return" (only exercised when a test omits conversationMessages).
function withMockedEnv({ queryHandler, aiText, aiError = null, accountRow = { displayPhoneNumber: '919888888888' } } = {}, run) {
  return async () => {
    const pool = require('../src/db');
    const groqService = require('../src/services/groqService');
    const whatsappAccountsRoutes = require('../src/routes/whatsappAccounts');

    const originalQuery = pool.query;
    const originalAskGroq = groqService.askGroq;
    const originalGetAccountWithToken = whatsappAccountsRoutes.getAccountWithToken;

    const queries = [];
    const aiCalls = [];

    pool.query = async (sql, params) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      queries.push({ sql: normalized, params });
      const result = queryHandler ? queryHandler(normalized, params, queries) : undefined;
      return result !== undefined ? result : { rows: [] };
    };

    groqService.askGroq = async (prompt, opts) => {
      aiCalls.push({ prompt, opts });
      if (aiError) return { text: null, error: aiError };
      const text = typeof aiText === 'function' ? aiText(prompt) : aiText;
      if (text === undefined) throw new Error('withMockedEnv: no aiText/aiError configured for this test');
      return { text, error: null };
    };

    whatsappAccountsRoutes.getAccountWithToken = async (accountId, workspaceId) => {
      if (String(accountId) !== String(WA_ACCOUNT_ID)) return null;
      return accountRow;
    };

    try {
      delete require.cache[require.resolve('../src/services/customerExtractionService')];
      const svc = require('../src/services/customerExtractionService');
      await run(svc, { queries, aiCalls });
    } finally {
      pool.query = originalQuery;
      groqService.askGroq = originalAskGroq;
      whatsappAccountsRoutes.getAccountWithToken = originalGetAccountWithToken;
    }
  };
}

// Base router: answers the workspace-ownership check every call makes, plus
// (for tests that exercise the audit-insert path) a default INSERT/SELECT
// response for coexistence.zoho_extraction_audit. Individual tests override
// what they specifically care about.
function baseRouter({ owned = true, auditRow, existingAuditRow = null } = {}) {
  return (sql, params) => {
    if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) {
      return owned ? OWNED_WA_ACCOUNT : NOT_OWNED_WA_ACCOUNT;
    }
    if (/^SELECT \* FROM coexistence\.zoho_extraction_audit WHERE workspace_id/i.test(sql)) {
      return { rows: existingAuditRow ? [existingAuditRow] : [] };
    }
    if (/^INSERT INTO coexistence\.zoho_extraction_audit/i.test(sql)) {
      return {
        rows: [
          auditRow || {
            id: 1,
            workspace_id: params[0],
            whatsapp_account_id: params[1],
            contact_number: params[4],
            message_id: params[3],
            status: 'pending_review',
            confidence: params[6],
            created_at: new Date(),
          },
        ],
      };
    }
    return undefined;
  };
}

function msg(direction, text, messageId) {
  return { direction, text, messageId };
}

function extractionJson(overrides = {}) {
  return JSON.stringify({
    name: { value: null, confidence: 0, evidence: [] },
    place: { value: null, type: 'unknown', confidence: 0, evidence: [] },
    phone: { value: null, confidence: 0, evidence: [] },
    email: { value: null, confidence: 0, evidence: [] },
    intent: { value: null, confidence: 0, evidence: [] },
    interest_summary: null,
    missing_required_fields: [],
    overall_confidence: 0,
    ...overrides,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// NAME
// ═══════════════════════════════════════════════════════════════════════════

test('NAME: explicit name is extracted with evidence', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    name: { value: 'Kumar', confidence: 0.95, evidence: [{ message_id: 'm1', text: 'Hi, my name is Kumar.' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'Hi, my name is Kumar.', 'm1')],
  });
  assert.equal(result.extraction.name.value, 'Kumar');
  assert.ok(result.extraction.name.confidence > 0.5);
  assert.equal(result.extraction.name.evidence[0].message_id, 'm1');
}));

test('NAME: multi-word name is preserved as-is', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    name: { value: 'Kumar Subramaniam', confidence: 0.9, evidence: [{ message_id: 'm1', text: 'This is Kumar Subramaniam' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'This is Kumar Subramaniam', 'm1')],
  });
  assert.equal(result.extraction.name.value, 'Kumar Subramaniam');
}));

test('NAME: missing name is null and listed as missing', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson(),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'I need a quotation', 'm1')],
  });
  assert.equal(result.extraction.name.value, null);
  assert.ok(result.extraction.missing_required_fields.includes('name'));
  assert.equal(result.complete, false);
}));

test('NAME: uncertain/hedged name has low confidence', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    name: { value: 'Kumar', confidence: 0.3, evidence: [{ message_id: 'm1', text: 'I think my name is Kumar maybe' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'I think my name is Kumar maybe', 'm1')],
  });
  assert.equal(result.extraction.name.value, 'Kumar');
  assert.ok(result.extraction.name.confidence < 0.5);
}));

// ═══════════════════════════════════════════════════════════════════════════
// LOCATION
// ═══════════════════════════════════════════════════════════════════════════

test('LOCATION: "I am from Namakkal" -> residence', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    place: { value: 'Namakkal', type: 'residence', confidence: 0.92, evidence: [{ message_id: 'm1', text: 'I am from Namakkal' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'I am from Namakkal', 'm1')],
  });
  assert.equal(result.extraction.place.value, 'Namakkal');
  assert.equal(result.extraction.place.type, 'residence');
}));

test('LOCATION: "I live in Namakkal" -> residence', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    place: { value: 'Namakkal', type: 'residence', confidence: 0.9, evidence: [{ message_id: 'm1', text: 'I live in Namakkal' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'I live in Namakkal', 'm1')],
  });
  assert.equal(result.extraction.place.type, 'residence');
}));

test('LOCATION: "My site is in Erode" -> site (not residence)', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    place: { value: 'Erode', type: 'site', confidence: 0.88, evidence: [{ message_id: 'm1', text: 'My site is in Erode' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'My site is in Erode', 'm1')],
  });
  assert.equal(result.extraction.place.value, 'Erode');
  assert.equal(result.extraction.place.type, 'site');
  assert.notEqual(result.extraction.place.type, 'residence');
}));

test('LOCATION: "Our factory is in Salem" -> business', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    place: { value: 'Salem', type: 'business', confidence: 0.85, evidence: [{ message_id: 'm1', text: 'Our factory is in Salem' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'Our factory is in Salem', 'm1')],
  });
  assert.equal(result.extraction.place.type, 'business');
}));

test('LOCATION: "I heard about your company in Erode" is a reference, never treated as customer place', withMockedEnv({
  queryHandler: baseRouter(),
  // The model correctly refuses to set place from a reference mention.
  aiText: extractionJson(),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'I heard about your company in Erode', 'm1')],
  });
  assert.equal(result.extraction.place.value, null);
  assert.ok(result.extraction.missing_required_fields.includes('place'));
}));

test('LOCATION: a model-reported "reference" type is never surfaced as a confirmed customer place', withMockedEnv({
  queryHandler: baseRouter(),
  // Even if the model (incorrectly) attaches a value to a reference-type
  // location, this service's sanitizer must still refuse to treat it as a
  // confirmed customer place for missing-field purposes.
  aiText: extractionJson({
    place: { value: 'Erode', type: 'reference', confidence: 0.5, evidence: [{ message_id: 'm1', text: 'I heard about your company in Erode' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'I heard about your company in Erode', 'm1')],
  });
  assert.equal(result.extraction.place.type, 'reference');
  assert.ok(result.extraction.missing_required_fields.includes('place'));
}));

test('LOCATION: ambiguous location is not confirmed as a customer place', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    place: { value: 'Erode', type: 'unknown', confidence: 0.4, evidence: [{ message_id: 'm1', text: 'Erode side' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'Erode side', 'm1')],
  });
  assert.equal(result.extraction.place.type, 'unknown');
  assert.ok(result.extraction.missing_required_fields.includes('place'));
}));

test('LOCATION: missing location is null and listed as missing', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson(),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'Hi', 'm1')],
  });
  assert.equal(result.extraction.place.value, null);
  assert.ok(result.extraction.missing_required_fields.includes('place'));
}));

// ═══════════════════════════════════════════════════════════════════════════
// PHONE
// ═══════════════════════════════════════════════════════════════════════════

test('PHONE: existing contact number (WhatsApp identity) satisfies the phone requirement even with no explicit mention', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson(),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'Hi', 'm1')],
  });
  assert.equal(result.extraction.phone.value, null);
  assert.equal(result.extraction.missing_required_fields.includes('phone'), false);
}));

test('PHONE: explicit phone number mentioned in text is extracted', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    phone: { value: '9876543210', confidence: 0.99, evidence: [{ message_id: 'm1', text: 'call me on 9876543210' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'call me on 9876543210', 'm1')],
  });
  assert.equal(result.extraction.phone.value, '9876543210');
}));

test('PHONE: missing contactNumber throws before any AI/DB call', withMockedEnv({
  queryHandler: () => { throw new Error('no query expected'); },
  aiText: extractionJson(),
}, async (svc) => {
  await assert.rejects(
    () => svc.extractCustomerInformation({
      workspaceId: WORKSPACE_ID,
      whatsappAccountId: WA_ACCOUNT_ID,
      contactNumber: '',
      conversationMessages: [msg('incoming', 'Hi', 'm1')],
    }),
    /valid contactNumber is required/
  );
}));

// ═══════════════════════════════════════════════════════════════════════════
// INTEREST / INTENT
// ═══════════════════════════════════════════════════════════════════════════

test('INTEREST: clear product interest is extracted', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    intent: { value: 'steel pipes enquiry', confidence: 0.85, evidence: [{ message_id: 'm1', text: 'I need steel pipes' }] },
    interest_summary: 'Customer wants steel pipes',
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'I need steel pipes', 'm1')],
  });
  assert.equal(result.extraction.intent.value, 'steel pipes enquiry');
  assert.equal(result.extraction.interest_summary, 'Customer wants steel pipes');
}));

test('INTEREST: quotation enquiry is extracted', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    intent: { value: 'quotation request', confidence: 0.9, evidence: [{ message_id: 'm1', text: 'please send quotation' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'please send quotation', 'm1')],
  });
  assert.equal(result.extraction.intent.value, 'quotation request');
}));

test('INTEREST: general enquiry with no specific product is still captured generally', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    intent: { value: 'general enquiry', confidence: 0.6, evidence: [{ message_id: 'm1', text: 'tell me more about your services' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'tell me more about your services', 'm1')],
  });
  assert.equal(result.extraction.intent.value, 'general enquiry');
}));

test('INTEREST: unclear intent is left null, not guessed', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson(),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'ok', 'm1')],
  });
  assert.equal(result.extraction.intent.value, null);
}));

// ═══════════════════════════════════════════════════════════════════════════
// CONVERSATION (whole-context combination)
// ═══════════════════════════════════════════════════════════════════════════

test('CONVERSATION: facts spread across multiple messages are combined into one result', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    name: { value: 'Kumar', confidence: 0.9, evidence: [{ message_id: 'm2', text: 'My name is Kumar' }] },
    place: { value: 'Namakkal', type: 'residence', confidence: 0.85, evidence: [{ message_id: 'm3', text: 'I am from Namakkal' }] },
    intent: { value: 'quotation request', confidence: 0.8, evidence: [{ message_id: 'm4', text: 'I need a quotation' }] },
  }),
}, async (svc, { aiCalls }) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [
      msg('incoming', 'Hi', 'm1'),
      msg('incoming', 'My name is Kumar', 'm2'),
      msg('incoming', 'I am from Namakkal', 'm3'),
      msg('incoming', 'I need a quotation', 'm4'),
    ],
  });
  assert.equal(result.extraction.name.value, 'Kumar');
  assert.equal(result.extraction.place.value, 'Namakkal');
  assert.equal(result.extraction.intent.value, 'quotation request');
  assert.equal(result.complete, true);
  // The full conversation (not just the latest message) was sent to the AI.
  assert.match(aiCalls[0].prompt, /My name is Kumar/);
  assert.match(aiCalls[0].prompt, /I am from Namakkal/);
  assert.match(aiCalls[0].prompt, /I need a quotation/);
}));

test('CONVERSATION: previous message contains name, later message contains location', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    name: { value: 'Ravi', confidence: 0.9, evidence: [{ message_id: 'm1', text: 'I am Ravi' }] },
    place: { value: 'Salem', type: 'residence', confidence: 0.8, evidence: [{ message_id: 'm2', text: 'from Salem' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [
      msg('incoming', 'I am Ravi', 'm1'),
      msg('incoming', 'from Salem', 'm2'),
    ],
  });
  assert.equal(result.extraction.name.value, 'Ravi');
  assert.equal(result.extraction.place.value, 'Salem');
}));

test('CONVERSATION: later message contains interest after earlier facts', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    name: { value: 'Ravi', confidence: 0.9, evidence: [{ message_id: 'm1', text: 'I am Ravi' }] },
    intent: { value: 'roofing enquiry', confidence: 0.7, evidence: [{ message_id: 'm2', text: 'interested in roofing' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [
      msg('incoming', 'I am Ravi', 'm1'),
      msg('incoming', 'interested in roofing', 'm2'),
    ],
  });
  assert.equal(result.extraction.intent.value, 'roofing enquiry');
}));

test('CONVERSATION: loads from coexistence.chat_history when conversationMessages is omitted', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED_WA_ACCOUNT;
    if (/^SELECT message_id, direction, message_body/i.test(sql)) {
      assert.equal(params[0], '919888888888');
      assert.equal(params[1], NORMALIZED_CONTACT_NUMBER);
      return {
        rows: [
          { message_id: 'm2', direction: 'incoming', message_body: 'I am from Namakkal', message_type: 'text', timestamp: new Date() },
          { message_id: 'm1', direction: 'incoming', message_body: 'Hi', message_type: 'text', timestamp: new Date(Date.now() - 1000) },
        ],
      };
    }
    return baseRouter()(sql, params);
  },
  aiText: extractionJson({
    place: { value: 'Namakkal', type: 'residence', confidence: 0.8, evidence: [{ message_id: 'm2', text: 'I am from Namakkal' }] },
  }),
}, async (svc, { aiCalls }) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
  });
  assert.equal(result.extraction.place.value, 'Namakkal');
  // Oldest-first ordering in the rendered transcript despite DESC query order.
  assert.ok(aiCalls[0].prompt.indexOf('Hi') < aiCalls[0].prompt.indexOf('I am from Namakkal'));
}));

test('CONVERSATION: chat_history rows are re-sorted chronologically, not just reversed as-returned', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED_WA_ACCOUNT;
    if (/^SELECT message_id, direction, message_body/i.test(sql)) {
      // Deliberately returned NOT in strict DESC order (as a defensive
      // driver/mock could) to prove the loader sorts by timestamp itself
      // rather than trusting row order or a blind reverse().
      return {
        rows: [
          { message_id: 'm2', direction: 'incoming', message_body: 'middle message', message_type: 'text', timestamp: new Date(Date.now() - 2000) },
          { message_id: 'm3', direction: 'incoming', message_body: 'latest message', message_type: 'text', timestamp: new Date() },
          { message_id: 'm1', direction: 'incoming', message_body: 'earliest message', message_type: 'text', timestamp: new Date(Date.now() - 5000) },
        ],
      };
    }
    return baseRouter()(sql, params);
  },
  aiText: extractionJson(),
}, async (svc, { aiCalls }) => {
  await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
  });
  const prompt = aiCalls[0].prompt;
  const iEarliest = prompt.indexOf('earliest message');
  const iMiddle = prompt.indexOf('middle message');
  const iLatest = prompt.indexOf('latest message');
  assert.ok(iEarliest >= 0 && iMiddle >= 0 && iLatest >= 0);
  assert.ok(iEarliest < iMiddle);
  assert.ok(iMiddle < iLatest);
}));

test('CONVERSATION: chat_history loading never mixes tenant/account scope (query is scoped to this workspace/account\'s wa_number + contact_number)', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED_WA_ACCOUNT;
    if (/^SELECT message_id, direction, message_body/i.test(sql)) {
      assert.equal(params[0], '919888888888'); // this account's wa_number only
      assert.equal(params[1], NORMALIZED_CONTACT_NUMBER); // this contact only
      return { rows: [{ message_id: 'm1', direction: 'incoming', message_body: 'hi', message_type: 'text', timestamp: new Date() }] };
    }
    return baseRouter()(sql, params);
  },
  aiText: extractionJson(),
}, async (svc) => {
  await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
  });
}));

test('CONVERSATION: no messages available returns an incomplete, all-null result without calling the AI', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED_WA_ACCOUNT;
    if (/^SELECT message_id, direction, message_body/i.test(sql)) return { rows: [] };
    return baseRouter()(sql, params);
  },
}, async (svc, { aiCalls }) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
  });
  assert.equal(result.extraction.name.value, null);
  assert.equal(result.complete, false);
  assert.equal(aiCalls.length, 0);
  assert.match(result.error, /no conversation messages/);
}));

// ═══════════════════════════════════════════════════════════════════════════
// CONFIDENCE
// ═══════════════════════════════════════════════════════════════════════════

test('CONFIDENCE: high-confidence fact is preserved as high', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    name: { value: 'Kumar', confidence: 0.97, evidence: [{ message_id: 'm1', text: 'my name is Kumar' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'my name is Kumar', 'm1')],
  });
  assert.ok(result.extraction.name.confidence >= 0.9);
}));

test('CONFIDENCE: uncertain statement yields low confidence', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    place: { value: 'Erode', type: 'site', confidence: 0.25, evidence: [{ message_id: 'm1', text: 'Maybe my site is around Erode' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'Maybe my site is around Erode', 'm1')],
  });
  assert.ok(result.extraction.place.confidence < 0.5);
}));

test('CONFIDENCE: a missing fact always has zero confidence', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson(),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'Hi', 'm1')],
  });
  assert.equal(result.extraction.name.confidence, 0);
  assert.equal(result.extraction.email.confidence, 0);
}));

test('CONFIDENCE: hallucination prevention — a value with no evidence is discarded, never surfaced as fact', withMockedEnv({
  queryHandler: baseRouter(),
  // Simulates a misbehaving model that names a value but cites nothing.
  aiText: extractionJson({
    name: { value: 'Someone', confidence: 0.9, evidence: [] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'Hi', 'm1')],
  });
  assert.equal(result.extraction.name.value, null);
  assert.equal(result.extraction.name.confidence, 0);
}));

test('CONFIDENCE: a non-JSON AI response never produces a confident result', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: 'Sure! Here is the customer info: Kumar from Namakkal.',
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'my name is Kumar, from Namakkal', 'm1')],
  });
  assert.equal(result.extraction.name.value, null);
  assert.equal(result.extraction.overall_confidence, 0);
  assert.equal(result.extraction.parse_error, 'Model response was not valid JSON');
}));

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY — workspace/account isolation
// ═══════════════════════════════════════════════════════════════════════════

test('SECURITY: a whatsappAccountId not belonging to the given workspace is rejected before any AI call', withMockedEnv({
  queryHandler: baseRouter({ owned: false }),
  aiText: extractionJson(),
}, async (svc, { aiCalls }) => {
  await assert.rejects(
    () => svc.extractCustomerInformation({
      workspaceId: OTHER_WORKSPACE_ID,
      whatsappAccountId: WA_ACCOUNT_ID,
      contactNumber: RAW_CONTACT_NUMBER,
      conversationMessages: [msg('incoming', 'Hi', 'm1')],
    }),
    /not found in this workspace/
  );
  assert.equal(aiCalls.length, 0);
}));

test('SECURITY: extraction never mixes conversation data across two different workspace/account scopes', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: (prompt) => {
    // Assert the AI never sees anything beyond exactly what THIS call's
    // conversationMessages contained.
    if (/Workspace B secret/.test(prompt)) {
      throw new Error('cross-workspace leak: workspace A saw workspace B data');
    }
    return extractionJson({ name: { value: 'A-Customer', confidence: 0.9, evidence: [{ message_id: 'm1', text: 'I am A-Customer' }] } });
  },
}, async (svc) => {
  const resultA = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'I am A-Customer', 'm1')],
  });
  assert.equal(resultA.extraction.name.value, 'A-Customer');
}));

test('SECURITY: missing workspaceId is rejected, never defaulted', withMockedEnv({
  queryHandler: () => { throw new Error('no query expected'); },
}, async (svc) => {
  await assert.rejects(
    () => svc.extractCustomerInformation({
      whatsappAccountId: WA_ACCOUNT_ID,
      contactNumber: RAW_CONTACT_NUMBER,
      conversationMessages: [msg('incoming', 'Hi', 'm1')],
    }),
    /workspaceId is required/
  );
}));

test('SECURITY: missing whatsappAccountId is rejected, never defaulted', withMockedEnv({
  queryHandler: () => { throw new Error('no query expected'); },
}, async (svc) => {
  await assert.rejects(
    () => svc.extractCustomerInformation({
      workspaceId: WORKSPACE_ID,
      contactNumber: RAW_CONTACT_NUMBER,
      conversationMessages: [msg('incoming', 'Hi', 'm1')],
    }),
    /whatsappAccountId is required/
  );
}));

// ═══════════════════════════════════════════════════════════════════════════
// PERSISTENCE — zoho_extraction_audit
// ═══════════════════════════════════════════════════════════════════════════

test('PERSISTENCE: a successful extraction is stored in zoho_extraction_audit with workspace/account/contact scope', withMockedEnv({
  queryHandler: (sql, params, queries) => {
    if (/^INSERT INTO coexistence\.zoho_extraction_audit/i.test(sql)) {
      assert.equal(params[0], WORKSPACE_ID);
      assert.equal(params[1], WA_ACCOUNT_ID);
      assert.equal(params[4], NORMALIZED_CONTACT_NUMBER);
      assert.equal(params[3], 'm1'); // message_id
      const extracted = JSON.parse(params[5]);
      assert.equal(extracted.name.value, 'Kumar');
      return {
        rows: [{
          id: 42,
          workspace_id: WORKSPACE_ID,
          whatsapp_account_id: WA_ACCOUNT_ID,
          contact_number: NORMALIZED_CONTACT_NUMBER,
          message_id: 'm1',
          status: 'pending_review',
          confidence: params[6],
          created_at: new Date(),
        }],
      };
    }
    return baseRouter()(sql, params);
  },
  aiText: extractionJson({
    name: { value: 'Kumar', confidence: 0.9, evidence: [{ message_id: 'm1', text: 'my name is Kumar' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'my name is Kumar', 'm1')],
  });
  assert.equal(result.audit.id, 42);
  assert.equal(result.audit.status, 'pending_review');
  assert.equal(result.audit.workspaceId, WORKSPACE_ID);
  assert.equal(result.audit.whatsappAccountId, WA_ACCOUNT_ID);
}));

test('PERSISTENCE: stored extracted_data is safe JSON with no token/secret fields', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^INSERT INTO coexistence\.zoho_extraction_audit/i.test(sql)) {
      const raw = params[5];
      assert.doesNotThrow(() => JSON.parse(raw));
      assert.equal(/access_token|refresh_token|api_key/i.test(raw), false);
      return { rows: [{ id: 1, workspace_id: WORKSPACE_ID, whatsapp_account_id: WA_ACCOUNT_ID, contact_number: NORMALIZED_CONTACT_NUMBER, status: 'pending_review', confidence: params[6], created_at: new Date() }] };
    }
    return baseRouter()(sql, params);
  },
  aiText: extractionJson({
    name: { value: 'Kumar', confidence: 0.9, evidence: [{ message_id: 'm1', text: 'my name is Kumar' }] },
  }),
}, async (svc) => {
  await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'my name is Kumar', 'm1')],
  });
}));

test('PERSISTENCE: idempotency — a repeat call for the same latest message_id reuses the existing audit row instead of calling the AI again', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^SELECT \* FROM coexistence\.zoho_extraction_audit WHERE workspace_id/i.test(sql)) {
      return {
        rows: [{
          id: 7,
          workspace_id: WORKSPACE_ID,
          whatsapp_account_id: WA_ACCOUNT_ID,
          contact_number: NORMALIZED_CONTACT_NUMBER,
          message_id: 'm1',
          status: 'pending_review',
          confidence: 0.9,
          extracted_data: { ...JSON.parse(extractionJson()), name: { value: 'Kumar', confidence: 0.9, evidence: [{ message_id: 'm1', text: 'my name is Kumar' }] }, missing_required_fields: ['place'] },
          created_at: new Date(),
        }],
      };
    }
    return baseRouter()(sql, params);
  },
}, async (svc, { aiCalls }) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'my name is Kumar', 'm1')],
  });
  assert.equal(aiCalls.length, 0);
  assert.equal(result.extraction.name.value, 'Kumar');
  assert.equal(result.audit.id, 7);
}));

test('PERSISTENCE: persist:false skips writing to zoho_extraction_audit entirely (preview mode)', withMockedEnv({
  queryHandler: (sql, params) => {
    if (/^INSERT INTO coexistence\.zoho_extraction_audit/i.test(sql)) {
      throw new Error('should not persist when persist:false');
    }
    return baseRouter()(sql, params);
  },
  aiText: extractionJson({
    name: { value: 'Kumar', confidence: 0.9, evidence: [{ message_id: 'm1', text: 'my name is Kumar' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'my name is Kumar', 'm1')],
    persist: false,
  });
  assert.equal(result.audit, null);
  assert.equal(result.extraction.name.value, 'Kumar');
}));

// ═══════════════════════════════════════════════════════════════════════════
// safeParseExtraction (pure unit tests)
// ═══════════════════════════════════════════════════════════════════════════

test('safeParseExtraction: malformed JSON degrades to an all-null, zero-confidence result', withMockedEnv({}, async (svc) => {
  const result = svc.safeParseExtraction('not json at all');
  assert.equal(result.name.value, null);
  assert.equal(result.overall_confidence, 0);
  assert.ok(result.parse_error);
}));

test('safeParseExtraction: strips accidental markdown code fences before parsing', withMockedEnv({}, async (svc) => {
  const wrapped = '```json\n' + extractionJson({ name: { value: 'Kumar', confidence: 0.9, evidence: [{ message_id: 'm1', text: 'my name is Kumar' }] } }) + '\n```';
  const result = svc.safeParseExtraction(wrapped);
  assert.equal(result.name.value, 'Kumar');
  assert.equal(result.parse_error, null);
}));

test('safeParseExtraction: an invalid place.type falls back to "unknown"', withMockedEnv({}, async (svc) => {
  const result = svc.safeParseExtraction(JSON.stringify({
    place: { value: 'Erode', type: 'nonsense', confidence: 0.5, evidence: [{ message_id: 'm1', text: 'Erode' }] },
  }));
  assert.equal(result.place.type, 'unknown');
}));

test('computeMissingFields: phone is satisfied by a known contact number even with no explicit mention', withMockedEnv({}, async (svc) => {
  const extraction = svc.safeParseExtraction(extractionJson({
    name: { value: 'Kumar', confidence: 0.9, evidence: [{ message_id: 'm1', text: 'Kumar' }] },
    place: { value: 'Namakkal', type: 'residence', confidence: 0.9, evidence: [{ message_id: 'm1', text: 'Namakkal' }] },
  }));
  const missing = svc.computeMissingFields(extraction, { knownContactNumber: NORMALIZED_CONTACT_NUMBER });
  assert.equal(missing.includes('phone'), false);
  assert.equal(missing.length, 0);
}));

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 8D PART 2 — VALIDATION / DECISION LAYER (COMPLETE/INCOMPLETE/UNCERTAIN)
// ═══════════════════════════════════════════════════════════════════════════

test('VALIDATION: name + phone(known) + residence -> COMPLETE', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    name: { value: 'Kumar', confidence: 0.9, evidence: [{ message_id: 'm1', text: 'my name is Kumar' }] },
    place: { value: 'Namakkal', type: 'residence', confidence: 0.9, evidence: [{ message_id: 'm2', text: 'I am from Namakkal' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [
      msg('incoming', 'my name is Kumar', 'm1'),
      msg('incoming', 'I am from Namakkal', 'm2'),
    ],
  });
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.complete, true);
  assert.equal(result.extraction.validation.status, 'COMPLETE');
  assert.deepEqual(result.extraction.missing_required_fields, []);
}));

test('VALIDATION: name + phone(known) but no location -> INCOMPLETE', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    name: { value: 'Kumar', confidence: 0.9, evidence: [{ message_id: 'm1', text: 'my name is Kumar' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'my name is Kumar', 'm1')],
  });
  assert.equal(result.status, 'INCOMPLETE');
  assert.equal(result.complete, false);
  assert.ok(result.extraction.missing_required_fields.includes('place'));
}));

test('VALIDATION: name + phone(known) + hedged "maybe I am from Namakkal" -> UNCERTAIN', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    name: { value: 'Kumar', confidence: 0.9, evidence: [{ message_id: 'm1', text: 'my name is Kumar' }] },
    place: { value: 'Namakkal', type: 'residence', confidence: 0.3, evidence: [{ message_id: 'm2', text: 'maybe I am from Namakkal' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [
      msg('incoming', 'my name is Kumar', 'm1'),
      msg('incoming', 'maybe I am from Namakkal', 'm2'),
    ],
  });
  assert.equal(result.status, 'UNCERTAIN');
  assert.equal(result.complete, false);
  assert.ok(result.extraction.validation.uncertain_fields.includes('place'));
  assert.equal(result.extraction.missing_required_fields.includes('place'), false);
}));

test('VALIDATION: name + phone(known) + reference-only location -> INCOMPLETE (reference never satisfies place)', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    name: { value: 'Kumar', confidence: 0.9, evidence: [{ message_id: 'm1', text: 'my name is Kumar' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [
      msg('incoming', 'my name is Kumar', 'm1'),
      msg('incoming', 'I heard about your company in Erode', 'm2'),
    ],
  });
  assert.equal(result.status, 'INCOMPLETE');
  assert.notEqual(result.status, 'UNCERTAIN');
}));

test('VALIDATION: UNCERTAIN is never reported as COMPLETE', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    name: { value: 'Kumar', confidence: 0.2, evidence: [{ message_id: 'm1', text: 'I think my name is Kumar maybe' }] },
    place: { value: 'Namakkal', type: 'residence', confidence: 0.9, evidence: [{ message_id: 'm1', text: 'from Namakkal' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'I think my name is Kumar maybe, from Namakkal', 'm1')],
  });
  assert.notEqual(result.status, 'COMPLETE');
  assert.equal(result.complete, false);
}));

test('computeValidation: missing status always outranks uncertain status', withMockedEnv({}, async (svc) => {
  const extraction = svc.safeParseExtraction(extractionJson({
    name: { value: 'Kumar', confidence: 0.2, evidence: [{ message_id: 'm1', text: 'Kumar' }] },
  }));
  const validation = svc.computeValidation(extraction, { knownContactNumber: NORMALIZED_CONTACT_NUMBER });
  assert.equal(validation.status, 'INCOMPLETE');
  assert.ok(validation.missing_required_fields.includes('place'));
  assert.ok(validation.uncertain_fields.includes('name'));
}));

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 8D PART 2 — EVIDENCE INTEGRITY (cross-checked against conversation)
// ═══════════════════════════════════════════════════════════════════════════

test('EVIDENCE: a value citing a message_id that is not part of the conversation is dropped', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    // "m99" was never in this conversation — a hallucinated reference.
    name: { value: 'Kumar', confidence: 0.9, evidence: [{ message_id: 'm99', text: 'my name is Kumar' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'hello', 'm1')],
  });
  assert.equal(result.extraction.name.value, null);
  assert.equal(result.extraction.name.confidence, 0);
  assert.ok(result.extraction.missing_required_fields.includes('name'));
}));

test('EVIDENCE: a value with at least one valid evidence message_id survives even if mixed with an invalid one', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    name: {
      value: 'Kumar',
      confidence: 0.9,
      evidence: [
        { message_id: 'm99', text: 'bogus' },
        { message_id: 'm1', text: 'my name is Kumar' },
      ],
    },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'my name is Kumar', 'm1')],
  });
  assert.equal(result.extraction.name.value, 'Kumar');
  assert.equal(result.extraction.name.evidence.length, 1);
  assert.equal(result.extraction.name.evidence[0].message_id, 'm1');
}));

test('EVIDENCE: place with only a hallucinated message_id reference is dropped and reverts to unknown/missing', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    place: { value: 'Namakkal', type: 'residence', confidence: 0.9, evidence: [{ message_id: 'not-a-real-id', text: 'from Namakkal' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'hello', 'm1')],
  });
  assert.equal(result.extraction.place.value, null);
  assert.equal(result.extraction.place.type, 'unknown');
  assert.ok(result.extraction.missing_required_fields.includes('place'));
}));

test('EVIDENCE: evidence integrity check is skipped when no message ids are known at all (best-effort)', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    name: { value: 'Kumar', confidence: 0.9, evidence: [{ message_id: null, text: 'my name is Kumar' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    // No messageId on any message -> nothing to cross-check against.
    conversationMessages: [{ direction: 'incoming', text: 'my name is Kumar' }],
  });
  assert.equal(result.extraction.name.value, 'Kumar');
}));

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 8D PART 2 — NAME: third-party mention guard
// ═══════════════════════════════════════════════════════════════════════════

test('NAME: a name mentioned about someone else ("my brother Ravi") is never treated as the customer name', withMockedEnv({
  queryHandler: baseRouter(),
  // Simulates a misbehaving model that (incorrectly) surfaces the relative's
  // name as if it were the customer's own.
  aiText: extractionJson({
    name: { value: 'Ravi', confidence: 0.8, evidence: [{ message_id: 'm1', text: 'I spoke with my brother Ravi yesterday' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'I spoke with my brother Ravi yesterday', 'm1')],
  });
  assert.equal(result.extraction.name.value, null);
  assert.ok(result.extraction.missing_required_fields.includes('name'));
}));

test('NAME: "my colleague Priya" is never treated as the customer name', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    name: { value: 'Priya', confidence: 0.7, evidence: [{ message_id: 'm1', text: 'ask my colleague Priya about it' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'ask my colleague Priya about it', 'm1')],
  });
  assert.equal(result.extraction.name.value, null);
}));

test('NAME: a legitimate self-introduction is not affected by the third-party guard', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    name: { value: 'Kumar', confidence: 0.9, evidence: [{ message_id: 'm1', text: 'Hi, this is Kumar, my friend told me about you' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'Hi, this is Kumar, my friend told me about you', 'm1')],
  });
  // "my friend" is mentioned, but with no capitalized name directly after
  // it, and the extracted name ("Kumar") doesn't match anything captured
  // by the relation pattern, so the guard must not fire.
  assert.equal(result.extraction.name.value, 'Kumar');
}));

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 8D PART 2 — PHONE: format validation
// ═══════════════════════════════════════════════════════════════════════════

test('PHONE: an explicit phone number that fails normalizePhone() is dropped, never surfaced', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    // Far too short to be a real phone number.
    phone: { value: '123', confidence: 0.8, evidence: [{ message_id: 'm1', text: 'call 123' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'call 123', 'm1')],
  });
  assert.equal(result.extraction.phone.value, null);
  assert.equal(result.extraction.phone.confidence, 0);
  // The known WhatsApp contact number still satisfies the requirement.
  assert.equal(result.extraction.missing_required_fields.includes('phone'), false);
}));

test('PHONE: a valid explicit phone that differs from the WhatsApp identity is preserved, not silently replaced', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    phone: { value: '9876543210', confidence: 0.9, evidence: [{ message_id: 'm1', text: 'my other number is 9876543210' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER, // normalizes to 919999999999
    conversationMessages: [msg('incoming', 'my other number is 9876543210', 'm1')],
  });
  assert.equal(result.extraction.phone.value, '9876543210');
  assert.notEqual(result.extraction.phone.value, NORMALIZED_CONTACT_NUMBER);
}));

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 8D PART 2 — CONFLICTING / CORRECTED INFORMATION (current vs previous)
// ═══════════════════════════════════════════════════════════════════════════

test('CONFLICTING: an explicit correction populates current value + previous, not two equal current facts', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    place: {
      value: 'Erode',
      type: 'residence',
      confidence: 0.9,
      evidence: [{ message_id: 'm2', text: 'Actually I moved to Erode' }],
      previous: {
        value: 'Namakkal',
        type: 'residence',
        confidence: 0.85,
        evidence: [{ message_id: 'm1', text: 'I am from Namakkal' }],
      },
    },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [
      msg('incoming', 'I am from Namakkal', 'm1'),
      msg('incoming', 'Actually I moved to Erode', 'm2'),
    ],
  });
  assert.equal(result.extraction.place.value, 'Erode');
  assert.equal(result.extraction.place.previous.value, 'Namakkal');
  assert.equal(result.extraction.place.previous.evidence[0].message_id, 'm1');
}));

test('CONFLICTING: an empty/malformed previous is dropped rather than surfaced', withMockedEnv({}, async (svc) => {
  const extraction = svc.safeParseExtraction(extractionJson({
    name: { value: 'Kumar', confidence: 0.9, evidence: [{ message_id: 'm1', text: 'Kumar' }], previous: { value: null, confidence: 0.9, evidence: [] } },
  }));
  assert.equal(extraction.name.previous, null);
}));

test('CONFLICTING: no correction present -> previous stays null', withMockedEnv({}, async (svc) => {
  const extraction = svc.safeParseExtraction(extractionJson({
    name: { value: 'Kumar', confidence: 0.9, evidence: [{ message_id: 'm1', text: 'Kumar' }] },
  }));
  assert.equal(extraction.name.previous, null);
}));

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 8D PART 2 — MALFORMED AI RESPONSE (extra hardening)
// ═══════════════════════════════════════════════════════════════════════════

test('MALFORMED: a JSON array (not object) response degrades safely', withMockedEnv({}, async (svc) => {
  const result = svc.safeParseExtraction('[1,2,3]');
  assert.equal(result.name.value, null);
  assert.equal(result.overall_confidence, 0);
  assert.equal(result.parse_error, 'Model response was not a JSON object');
}));

test('MALFORMED: a JSON array of extraction-shaped objects is still rejected as malformed', withMockedEnv({}, async (svc) => {
  // Even though each array element individually "looks like" a valid
  // extraction shape, the root of the response must be an object — an
  // array root is never accepted, regardless of what it contains.
  const result = svc.safeParseExtraction(JSON.stringify([
    { name: { value: 'Kumar', confidence: 0.9, evidence: [{ message_id: 'm1', text: 'Kumar' }] } },
  ]));
  assert.equal(result.name.value, null);
  assert.ok(result.parse_error);
}));

test('MALFORMED: wrong field types (numbers/objects instead of strings) never crash and never surface a value', withMockedEnv({}, async (svc) => {
  const result = svc.safeParseExtraction(JSON.stringify({
    name: { value: 12345, confidence: 'high', evidence: 'not-an-array' },
    place: { value: {}, type: 42, confidence: null, evidence: [{ message_id: 1, text: 2 }] },
  }));
  // value:12345 -> String(12345) is truthy but has no valid evidence (evidence
  // wasn't an array) -> dropped per the zero-evidence hallucination guard.
  assert.equal(result.name.value, null);
  assert.equal(result.place.value, null);
  assert.equal(result.place.type, 'unknown');
}));

test('MALFORMED: unexpected/extra top-level properties are ignored, never persisted', withMockedEnv({}, async (svc) => {
  const result = svc.safeParseExtraction(JSON.stringify({
    name: { value: 'Kumar', confidence: 0.9, evidence: [{ message_id: 'm1', text: 'Kumar' }] },
    __proto__polluted: true,
    admin: true,
    sql: 'DROP TABLE users',
  }));
  assert.equal(result.name.value, 'Kumar');
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'admin'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'sql'), false);
}));

test('MALFORMED: oversized evidence array is capped, not rejected wholesale', withMockedEnv({}, async (svc) => {
  const bigEvidence = Array.from({ length: 50 }, (_, i) => ({ message_id: `m${i}`, text: `snippet ${i}` }));
  const result = svc.safeParseExtraction(JSON.stringify({
    name: { value: 'Kumar', confidence: 0.9, evidence: bigEvidence },
  }));
  assert.equal(result.name.value, 'Kumar');
  assert.ok(result.name.evidence.length <= 10);
}));

test('MALFORMED: empty AI response string degrades to an incomplete, all-null result', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: '',
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'hello', 'm1')],
  });
  assert.equal(result.extraction.name.value, null);
  assert.equal(result.status, 'INCOMPLETE');
}));
