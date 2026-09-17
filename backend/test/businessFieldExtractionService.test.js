'use strict';

// Phase 8F — AI -> Dynamic Field Mapping: orchestration-level tests for
// businessFieldExtractionService.js (connects 8E field definitions to the
// 8F-extended 8D extraction flow). Mocked pool.query / groqService.askGroq
// / whatsappAccountsRoutes.getAccountWithToken, same pattern as
// test/customerExtractionService.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

process.env.AKCHAT_ENCRYPTION_KEY = process.env.AKCHAT_ENCRYPTION_KEY || nodeCrypto.randomBytes(24).toString('hex');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-extraction-tests';
process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REDIRECT_URI = process.env.ZOHO_REDIRECT_URI || 'https://app.example.com/api/zoho/oauth/callback';
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test-groq-key';

const WORKSPACE_A = 10;
const WORKSPACE_B = 20;
const WA_ACCOUNT_A = 5;
const WA_ACCOUNT_B = 6;
const CONTACT_NUMBER = '+91 99999 99999';
const NORMALIZED_CONTACT = '919999999999';

function fieldDefRow(overrides = {}) {
  return {
    id: 1,
    workspace_id: WORKSPACE_A,
    whatsapp_account_id: WA_ACCOUNT_A,
    field_key: 'roof_type',
    field_label: 'Roof Type',
    description: null,
    field_type: 'select',
    is_required: true,
    field_scope: 'business_specific',
    field_config: { options: ['Metal', 'Shingle'] },
    zoho_target: null,
    extraction_key: null,
    extraction_instruction: 'What material is the roof made of',
    is_active: true,
    display_order: 0,
    config_version: 1,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

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

    whatsappAccountsRoutes.getAccountWithToken = async () => accountRow;

    try {
      delete require.cache[require.resolve('../src/services/businessFieldExtractionService')];
      delete require.cache[require.resolve('../src/services/customerExtractionService')];
      delete require.cache[require.resolve('../src/services/businessFieldDefinitionService')];
      delete require.cache[require.resolve('../src/services/businessFieldValueService')];
      const svc = require('../src/services/businessFieldExtractionService');
      await run(svc, { queries, aiCalls });
    } finally {
      pool.query = originalQuery;
      groqService.askGroq = originalAskGroq;
      whatsappAccountsRoutes.getAccountWithToken = originalGetAccountWithToken;
    }
  };
}

function baseRouter({ owned = true, defRows = [], auditRow, existingAuditRow = null } = {}) {
  return (sql, params) => {
    if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) {
      return owned ? { rows: [{ id: params[0] }] } : { rows: [] };
    }
    if (/^SELECT \* FROM coexistence\.zoho_field_mappings/i.test(sql)) {
      return { rows: defRows };
    }
    if (/^SELECT \* FROM coexistence\.zoho_extraction_audit/i.test(sql)) {
      return { rows: existingAuditRow ? [existingAuditRow] : [] };
    }
    if (/^INSERT INTO coexistence\.zoho_extraction_audit/i.test(sql)) {
      const row = auditRow || {
        id: 99,
        workspace_id: params[0],
        whatsapp_account_id: params[1],
        contact_number: params[4],
        message_id: params[3],
        extracted_data: JSON.parse(params[5]),
        confidence: params[6],
        evidence: JSON.parse(params[7]),
        status: 'pending_review',
        created_at: new Date(),
      };
      return { rows: [row] };
    }
    return undefined;
  };
}

const AI_TEXT_WITH_ROOF = JSON.stringify({
  name: { value: null, confidence: 0, evidence: [] },
  place: { value: null, type: 'unknown', confidence: 0, evidence: [] },
  phone: { value: null, confidence: 0, evidence: [] },
  email: { value: null, confidence: 0, evidence: [] },
  intent: { value: 'product enquiry', confidence: 0.7, evidence: [{ message_id: 'm1', text: 'metal roof please' }] },
  interest_summary: 'wants a metal roof',
  missing_required_fields: [],
  overall_confidence: 0.8,
  business_fields: {
    roof_type: { value: 'Metal', confidence: 0.85, evidence: [{ message_id: 'm1', text: 'metal roof please' }] },
  },
});

const CONVERSATION = [{ messageId: 'm1', direction: 'incoming', text: 'metal roof please' }];

test(
  'extractBusinessFields: loads active field definitions and feeds them into the extraction prompt',
  withMockedEnv(
    { queryHandler: baseRouter({ defRows: [fieldDefRow()] }), aiText: AI_TEXT_WITH_ROOF },
    async (svc, { aiCalls }) => {
      const result = await svc.extractBusinessFields({
        workspaceId: WORKSPACE_A,
        whatsappAccountId: WA_ACCOUNT_A,
        contactNumber: CONTACT_NUMBER,
        conversationMessages: CONVERSATION,
      });
      assert.equal(result.extraction.business_fields.roof_type.value, 'Metal');
      assert.equal(result.business.status, 'COMPLETE');
      assert.deepEqual(result.business.missing_required_fields, []);
      assert.ok(aiCalls[0].prompt.includes('field_key: "roof_type"'));
      assert.equal(result.fieldDefinitions.length, 1);
      assert.equal(result.fieldDefinitions[0].fieldKey, 'roof_type');
    }
  )
);

test(
  'extractBusinessFields: no configured fields -> works exactly like 8D (business_fields empty, prompt unchanged)',
  withMockedEnv(
    {
      queryHandler: baseRouter({ defRows: [] }),
      aiText: JSON.stringify({
        name: { value: null, confidence: 0, evidence: [] },
        place: { value: null, type: 'unknown', confidence: 0, evidence: [] },
        phone: { value: null, confidence: 0, evidence: [] },
        email: { value: null, confidence: 0, evidence: [] },
        intent: { value: null, confidence: 0, evidence: [] },
        interest_summary: null,
        missing_required_fields: [],
        overall_confidence: 0,
      }),
    },
    async (svc, { aiCalls }) => {
      const result = await svc.extractBusinessFields({
        workspaceId: WORKSPACE_A,
        whatsappAccountId: WA_ACCOUNT_A,
        contactNumber: CONTACT_NUMBER,
        conversationMessages: CONVERSATION,
      });
      assert.deepEqual(result.extraction.business_fields, {});
      assert.equal(result.business.status, 'COMPLETE');
      assert.ok(!aiCalls[0].prompt.includes('ADDITIONAL BUSINESS-SPECIFIC FIELDS'));
    }
  )
);

test(
  'extractBusinessFields: a required field missing from the conversation is reported INCOMPLETE, not guessed',
  withMockedEnv(
    {
      queryHandler: baseRouter({ defRows: [fieldDefRow()] }),
      aiText: JSON.stringify({
        name: { value: null, confidence: 0, evidence: [] },
        place: { value: null, type: 'unknown', confidence: 0, evidence: [] },
        phone: { value: null, confidence: 0, evidence: [] },
        email: { value: null, confidence: 0, evidence: [] },
        intent: { value: null, confidence: 0, evidence: [] },
        interest_summary: null,
        missing_required_fields: [],
        overall_confidence: 0,
        business_fields: {}, // model found nothing
      }),
    },
    async (svc) => {
      const result = await svc.extractBusinessFields({
        workspaceId: WORKSPACE_A,
        whatsappAccountId: WA_ACCOUNT_A,
        contactNumber: CONTACT_NUMBER,
        conversationMessages: [{ messageId: 'm1', direction: 'incoming', text: 'hello' }],
      });
      assert.equal(result.business.status, 'INCOMPLETE');
      assert.deepEqual(result.business.missing_required_fields, ['roof_type']);
    }
  )
);

test(
  'extractBusinessFields: WhatsApp-account isolation — fields configured for account A never leak to account B',
  withMockedEnv(
    {
      queryHandler: (sql, params) => {
        if (/^SELECT id FROM coexistence\.whatsapp_accounts/i.test(sql)) {
          // Only WA_ACCOUNT_B is owned by this call's workspace in this test.
          return String(params[0]) === String(WA_ACCOUNT_B) ? { rows: [{ id: WA_ACCOUNT_B }] } : { rows: [] };
        }
        if (/^SELECT \* FROM coexistence\.zoho_field_mappings/i.test(sql)) {
          // Even though account A has a "roof_type" field configured, a
          // query scoped to account B must never return it — simulate the
          // DB WHERE clause by checking the actual params passed.
          if (String(params[1]) === String(WA_ACCOUNT_A)) return { rows: [fieldDefRow()] };
          return { rows: [] }; // account B has no fields configured
        }
        return undefined;
      },
      aiText: AI_TEXT_WITH_ROOF,
    },
    async (svc, { aiCalls }) => {
      const result = await svc.extractBusinessFields({
        workspaceId: WORKSPACE_A,
        whatsappAccountId: WA_ACCOUNT_B,
        contactNumber: CONTACT_NUMBER,
        conversationMessages: CONVERSATION,
      });
      assert.deepEqual(result.fieldDefinitions, []);
      assert.ok(!aiCalls[0].prompt.includes('roof_type'));
    }
  )
);

test(
  'extractBusinessFields: workspace isolation — whatsappAccountId belonging to a different workspace is rejected',
  withMockedEnv({ queryHandler: baseRouter({ owned: false }) }, async (svc) => {
    await assert.rejects(
      () =>
        svc.extractBusinessFields({
          workspaceId: WORKSPACE_B,
          whatsappAccountId: WA_ACCOUNT_A, // actually belongs to WORKSPACE_A
          contactNumber: CONTACT_NUMBER,
          conversationMessages: CONVERSATION,
        }),
      /not found in this workspace/i
    );
  })
);

test(
  'extractBusinessFields: malformed AI output degrades safely (no throw), business fields all missing/null',
  withMockedEnv(
    { queryHandler: baseRouter({ defRows: [fieldDefRow()] }), aiText: 'this is not json' },
    async (svc) => {
      const result = await svc.extractBusinessFields({
        workspaceId: WORKSPACE_A,
        whatsappAccountId: WA_ACCOUNT_A,
        contactNumber: CONTACT_NUMBER,
        conversationMessages: CONVERSATION,
      });
      assert.equal(result.extraction.business_fields.roof_type.value, null);
      assert.equal(result.business.status, 'INCOMPLETE');
    }
  )
);

test(
  'extractBusinessFields: idempotency — a repeated call for the same latest message does not call the AI again',
  withMockedEnv(
    {
      queryHandler: baseRouter({
        defRows: [fieldDefRow()],
        existingAuditRow: {
          id: 5,
          workspace_id: WORKSPACE_A,
          whatsapp_account_id: WA_ACCOUNT_A,
          contact_number: NORMALIZED_CONTACT,
          message_id: 'm1',
          status: 'pending_review',
          confidence: 0.8,
          created_at: new Date(),
          extracted_data: {
            name: { value: null, confidence: 0, evidence: [], previous: null },
            place: { value: null, type: 'unknown', confidence: 0, evidence: [], previous: null },
            phone: { value: null, confidence: 0, evidence: [], previous: null },
            email: { value: null, confidence: 0, evidence: [], previous: null },
            intent: { value: null, confidence: 0, evidence: [], previous: null },
            interest_summary: null,
            missing_required_fields: [],
            overall_confidence: 0.8,
            business_fields: {
              roof_type: { value: 'Metal', confidence: 0.85, evidence: [{ message_id: 'm1', text: 'metal roof please' }], previous: null, fieldKey: 'roof_type', fieldType: 'select', isRequired: true },
            },
            parse_error: null,
          },
        },
      }),
      aiText: AI_TEXT_WITH_ROOF,
    },
    async (svc, { aiCalls }) => {
      const result = await svc.extractBusinessFields({
        workspaceId: WORKSPACE_A,
        whatsappAccountId: WA_ACCOUNT_A,
        contactNumber: CONTACT_NUMBER,
        conversationMessages: CONVERSATION,
      });
      assert.equal(aiCalls.length, 0, 'AI must not be called again for the same latest message');
      assert.equal(result.extraction.business_fields.roof_type.value, 'Metal');
      assert.equal(result.business.status, 'COMPLETE');
    }
  )
);

test(
  'extractBusinessFields: no secret/token fields ever appear in the returned extraction/fieldDefinitions',
  withMockedEnv(
    { queryHandler: baseRouter({ defRows: [fieldDefRow()] }), aiText: AI_TEXT_WITH_ROOF },
    async (svc) => {
      const result = await svc.extractBusinessFields({
        workspaceId: WORKSPACE_A,
        whatsappAccountId: WA_ACCOUNT_A,
        contactNumber: CONTACT_NUMBER,
        conversationMessages: CONVERSATION,
      });
      const serialized = JSON.stringify(result);
      assert.ok(!/access_token|refresh_token|client_secret|oauth/i.test(serialized));
    }
  )
);

test(
  'extractBusinessFields: preview mode (persist:false) never writes an audit row',
  withMockedEnv(
    {
      queryHandler: (sql, params) => {
        if (/^INSERT INTO coexistence\.zoho_extraction_audit/i.test(sql)) {
          throw new Error('must not INSERT when persist:false');
        }
        return baseRouter({ defRows: [fieldDefRow()] })(sql, params);
      },
      aiText: AI_TEXT_WITH_ROOF,
    },
    async (svc) => {
      const result = await svc.extractBusinessFields({
        workspaceId: WORKSPACE_A,
        whatsappAccountId: WA_ACCOUNT_A,
        contactNumber: CONTACT_NUMBER,
        conversationMessages: CONVERSATION,
        persist: false,
      });
      assert.equal(result.audit, null);
      assert.equal(result.extraction.business_fields.roof_type.value, 'Metal');
    }
  )
);

// ── extractAndApply ─────────────────────────────────────────────────────

test(
  'extractAndApply: applyToContact=false never writes contact values (default preview-only)',
  withMockedEnv(
    { queryHandler: baseRouter({ defRows: [fieldDefRow()] }), aiText: AI_TEXT_WITH_ROOF },
    async (svc, { queries }) => {
      const result = await svc.extractAndApply({
        workspaceId: WORKSPACE_A,
        whatsappAccountId: WA_ACCOUNT_A,
        contactNumber: CONTACT_NUMBER,
        conversationMessages: CONVERSATION,
      });
      assert.equal(result.applied, null);
      assert.ok(!queries.some((q) => /UPDATE coexistence\.contacts/i.test(q.sql)));
    }
  )
);

test(
  'extractAndApply: applyToContact=true writes only CONFIRMED values via the existing 8E write path',
  withMockedEnv(
    {
      queryHandler: (sql, params) => {
        if (/^SELECT id, custom_fields FROM coexistence\.contacts/i.test(sql)) {
          return { rows: [{ id: 42, custom_fields: {} }] };
        }
        if (/^UPDATE coexistence\.contacts/i.test(sql)) {
          return { rows: [{ custom_fields: { business_fields: { [String(WA_ACCOUNT_A)]: { roof_type: 'Metal' } } } }] };
        }
        return baseRouter({ defRows: [fieldDefRow()] })(sql, params);
      },
      aiText: AI_TEXT_WITH_ROOF,
    },
    async (svc) => {
      const result = await svc.extractAndApply({
        workspaceId: WORKSPACE_A,
        whatsappAccountId: WA_ACCOUNT_A,
        contactNumber: CONTACT_NUMBER,
        conversationMessages: CONVERSATION,
        contactId: 42,
        applyToContact: true,
      });
      assert.deepEqual(result.applied, { roof_type: 'Metal' });
    }
  )
);

test(
  'extractAndApply: throws if applyToContact=true without a contactId',
  withMockedEnv(
    { queryHandler: baseRouter({ defRows: [fieldDefRow()] }), aiText: AI_TEXT_WITH_ROOF },
    async (svc) => {
      await assert.rejects(
        () =>
          svc.extractAndApply({
            workspaceId: WORKSPACE_A,
            whatsappAccountId: WA_ACCOUNT_A,
            contactNumber: CONTACT_NUMBER,
            conversationMessages: CONVERSATION,
            applyToContact: true,
          }),
        /contactId is required/i
      );
    }
  )
);