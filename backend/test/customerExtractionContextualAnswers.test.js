'use strict';

// ZOHO PHASE 8 — REAL-WORLD RUNTIME FIX: Thanglish / one-word contextual
// answers were not producing a COMPLETE extraction (and therefore no Zoho
// Lead), even though the conversation clearly contained name + place +
// email once the Business's preceding question is taken into account
// (spec: "Peru?" -> "Klutch", "Entha ooru?" -> "Vellore", "Email iruka?" ->
// "klutchkavin@gmail.com").
//
// ROOT-CAUSE NOTE (found while writing this file): the OTHER extraction
// test files in this repo (customerExtractionService.test.js,
// customerExtractionBusinessFields.test.js, businessFieldExtractionService.test.js)
// mock `geminiService.askGemini`, but customerExtractionService.js has
// called `groqService.askGroq` exclusively since the Phase 8I Groq
// migration (see that file's own header comment). That mock target is
// stale and never intercepts the real call, so every test in those three
// files silently falls through to a real (key-less) askGroq call and
// asserts against a null/empty extraction — they were ALREADY failing
// before this change, unrelated to it. Flagging this here rather than
// silently fixing 100+ unrelated tests out of scope for this task; see
// the accompanying report for details.
//
// This file mocks `groqService.askGroq` — the module the code actually
// calls — so it exercises the REAL prompt (buildPrompt) this fix changes,
// plus the full sanitize -> evidence-integrity -> validation pipeline,
// exactly like the intended runtime path.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

process.env.AKCHAT_ENCRYPTION_KEY = process.env.AKCHAT_ENCRYPTION_KEY || nodeCrypto.randomBytes(24).toString('hex');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-contextual-extraction-tests';
process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REDIRECT_URI = process.env.ZOHO_REDIRECT_URI || 'https://app.example.com/api/zoho/oauth/callback';

const WORKSPACE_ID = 1;
const WA_ACCOUNT_ID = 5;
const RAW_CONTACT_NUMBER = '+91 99999 99999';

const OWNED_WA_ACCOUNT = { rows: [{ id: WA_ACCOUNT_ID }] };

function baseRouter() {
  return (sql, params) => {
    if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) return OWNED_WA_ACCOUNT;
    if (/^SELECT \* FROM coexistence\.zoho_extraction_audit WHERE workspace_id/i.test(sql)) return { rows: [] };
    if (/^INSERT INTO coexistence\.zoho_extraction_audit/i.test(sql)) {
      return {
        rows: [{
          id: 1,
          workspace_id: params[0],
          whatsapp_account_id: params[1],
          contact_number: params[4],
          message_id: params[3],
          status: 'pending_review',
          confidence: params[6],
          created_at: new Date(),
        }],
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

// aiText may be a string (fixed response) or a function(prompt) => string,
// matching the pattern used elsewhere in this repo's test suite, but wired
// to the module actually used in production: groqService.askGroq.
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

    whatsappAccountsRoutes.getAccountWithToken = async (accountId) => {
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

// ═══════════════════════════════════════════════════════════════════════════
// PROMPT: the new context/language rules actually reach the model
// ═══════════════════════════════════════════════════════════════════════════

test('PROMPT: buildPrompt includes the conversational-context rule and Thanglish guidance', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson(),
}, async (svc) => {
  const prompt = svc.buildPrompt('Business: Peru?\nCustomer: Klutch', []);
  assert.match(prompt, /immediately preceding question/i);
  assert.match(prompt, /Thanglish/i);
  assert.match(prompt, /Peru\?/);
  assert.match(prompt, /Entha ooru\?/);
}));

// ═══════════════════════════════════════════════════════════════════════════
// ONE-WORD CONTEXTUAL ANSWERS (the real-world failure this fixes)
// ═══════════════════════════════════════════════════════════════════════════

test('CONTEXTUAL: one-word reply to "Peru?" (name question) is extracted as name', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    name: { value: 'Klutch', confidence: 0.9, evidence: [{ message_id: 'm2', text: 'Klutch' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [
      msg('outgoing', 'Peru?', 'm1'),
      msg('incoming', 'Klutch', 'm2'),
    ],
  });
  assert.equal(result.extraction.name.value, 'Klutch');
  assert.equal(result.extraction.name.evidence[0].message_id, 'm2');
}));

test('CONTEXTUAL: one-word reply to "Entha ooru?" (location question) is extracted as residence', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    place: { value: 'Vellore', type: 'residence', confidence: 0.9, evidence: [{ message_id: 'm2', text: 'Vellore' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [
      msg('outgoing', 'Entha ooru?', 'm1'),
      msg('incoming', 'Vellore', 'm2'),
    ],
  });
  assert.equal(result.extraction.place.value, 'Vellore');
  assert.equal(result.extraction.place.type, 'residence');
}));

test('CONTEXTUAL: one-word/email-only reply to "Email iruka?" is extracted as email', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    email: { value: 'klutchkavin@gmail.com', confidence: 0.9, evidence: [{ message_id: 'm2', text: 'klutchkavin@gmail.com' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [
      msg('outgoing', 'Email iruka?', 'm1'),
      msg('incoming', 'klutchkavin@gmail.com', 'm2'),
    ],
  });
  assert.equal(result.extraction.email.value, 'klutchkavin@gmail.com');
}));

test('CONTEXTUAL: full Thanglish sentence is extracted correctly', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    place: { value: 'Madurai', type: 'residence', confidence: 0.85, evidence: [{ message_id: 'm1', text: 'Madurai la iruken' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'Madurai la iruken', 'm1')],
  });
  assert.equal(result.extraction.place.value, 'Madurai');
  assert.equal(result.extraction.place.type, 'residence');
}));

test('CONTEXTUAL: mixed Thanglish + English conversation combines into one COMPLETE result', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    name: { value: 'Klutch', confidence: 0.9, evidence: [{ message_id: 'm2', text: 'Klutch' }] },
    place: { value: 'Vellore', type: 'residence', confidence: 0.9, evidence: [{ message_id: 'm4', text: 'Vellore' }] },
    email: { value: 'klutchkavin@gmail.com', confidence: 0.9, evidence: [{ message_id: 'm6', text: 'klutchkavin@gmail.com' }] },
    intent: { value: 'interested in blue kurthi', confidence: 0.8, evidence: [{ message_id: 'm7', text: 'Enaku blue kurthi venum' }] },
    interest_summary: 'Wants a blue kurthi',
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [
      msg('outgoing', 'Peru?', 'm1'),
      msg('incoming', 'Klutch', 'm2'),
      msg('outgoing', 'Entha ooru?', 'm3'),
      msg('incoming', 'Vellore', 'm4'),
      msg('outgoing', 'Email iruka?', 'm5'),
      msg('incoming', 'klutchkavin@gmail.com', 'm6'),
      msg('incoming', 'Enaku blue kurthi venum', 'm7'),
    ],
  });
  assert.equal(result.extraction.name.value, 'Klutch');
  assert.equal(result.extraction.place.value, 'Vellore');
  assert.equal(result.extraction.email.value, 'klutchkavin@gmail.com');
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.complete, true);
  assert.equal(result.extraction.missing_required_fields.length, 0);
}));

// ═══════════════════════════════════════════════════════════════════════════
// AI question followed by customer one-word answer — generic, no hardcoded phrase
// ═══════════════════════════════════════════════════════════════════════════

test('CONTEXTUAL: AI asks a question, customer answers with one word (generic, English)', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    name: { value: 'Kavin', confidence: 0.9, evidence: [{ message_id: 'm2', text: 'Kavin' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [
      msg('outgoing', 'May I know your name?', 'm1'),
      msg('incoming', 'Kavin', 'm2'),
    ],
  });
  assert.equal(result.extraction.name.value, 'Kavin');
}));

// ═══════════════════════════════════════════════════════════════════════════
// An unrelated place mention must NOT become the customer's residence
// ═══════════════════════════════════════════════════════════════════════════

test('CONTEXTUAL: a place mentioned only as a reference (not answering a residence question) is not surfaced as residence', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    place: { value: 'Erode', type: 'reference', confidence: 0.7, evidence: [{ message_id: 'm1', text: 'I heard about your shop in Erode' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'I heard about your shop in Erode', 'm1')],
  });
  // "reference" type must never satisfy the residence/site/business
  // requirement — place stays required-but-missing for CRM purposes.
  assert.equal(result.extraction.place.type, 'reference');
  assert.ok(result.extraction.validation.missing_required_fields.includes('place'));
}));

// ═══════════════════════════════════════════════════════════════════════════
// EXISTING ENGLISH BEHAVIOR MUST STILL PASS
// ═══════════════════════════════════════════════════════════════════════════

test('EXISTING BEHAVIOR: standard English full-sentence extraction still works unchanged', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    name: { value: 'Ravi', confidence: 0.95, evidence: [{ message_id: 'm1', text: 'Hi, my name is Ravi' }] },
    place: { value: 'Chennai', type: 'residence', confidence: 0.9, evidence: [{ message_id: 'm2', text: 'I live in Chennai' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [
      msg('incoming', 'Hi, my name is Ravi', 'm1'),
      msg('incoming', 'I live in Chennai', 'm2'),
    ],
  });
  assert.equal(result.extraction.name.value, 'Ravi');
  assert.equal(result.extraction.place.value, 'Chennai');
  assert.equal(result.extraction.place.type, 'residence');
  assert.equal(result.status, 'COMPLETE');
}));

test('EXISTING BEHAVIOR: a name mentioned about someone else is still rejected by the third-party guard', withMockedEnv({
  queryHandler: baseRouter(),
  aiText: extractionJson({
    name: { value: 'Ravi', confidence: 0.9, evidence: [{ message_id: 'm1', text: 'I spoke to my brother Ravi yesterday' }] },
  }),
}, async (svc) => {
  const result = await svc.extractCustomerInformation({
    workspaceId: WORKSPACE_ID,
    whatsappAccountId: WA_ACCOUNT_ID,
    contactNumber: RAW_CONTACT_NUMBER,
    conversationMessages: [msg('incoming', 'I spoke to my brother Ravi yesterday', 'm1')],
  });
  assert.equal(result.extraction.name.value, null);
}));


