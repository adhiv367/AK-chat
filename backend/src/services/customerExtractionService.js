// Phase 8D Part 1+2 — AI CUSTOMER INFORMATION EXTRACTION.
//
//   WhatsApp conversation -> AI extraction -> structured customer facts
//   -> evidence -> confidence -> completeness decision -> validation-ready
//   result
//
// This service NEVER creates/updates a Zoho Lead or Note, and NEVER calls
// any Zoho service — that is explicitly out of scope until 8G (automatic
// CRM sync, after 8E/8F build the business-field mapping + validation this
// depends on). It only produces a structured, audited, validation-ready
// extraction result.
//
// ── Part 2 additions (hardening) ─────────────────────────────────────────
// Part 1 already produced a structured/sanitized/audited result. Part 2
// layers a decision on top of it without changing that foundation:
//   - a COMPLETE / INCOMPLETE / UNCERTAIN validation decision (§2/§3)
//   - evidence cross-checked against the actual conversation's message ids,
//     not just "shape looks right" (§4)
//   - a lightweight guard against a name mentioned about someone else in
//     the conversation, e.g. "my brother Ravi" (§7)
//   - phone values that don't survive normalizePhone() are treated as
//     invalid rather than surfaced as a fact (§8)
//   - a minimal current/previous correction shape for name/place/phone/
//     email/intent, for conversations where the customer corrects an
//     earlier statement (§6)
// See computeValidation() below for the decision layer itself.
//
// ── Architecture reuse (spec §1) ─────────────────────────────────────────
// This file reuses:
//   - groqService.askGroq()                -> Phase 8I: a dedicated Groq
//     wrapper (env-configured GROQ_API_KEY, never hard-coded), used ONLY
//     for extraction. The existing WhatsApp AI reply path in
//     aiReplyService.js is untouched and keeps using geminiService.askGemini()
//     with GEMINI_API_KEY exactly as before.
//   - routes/whatsappAccounts.getAccountWithToken() -> the SAME
//     workspace-scoped account lookup used throughout the codebase, used
//     here ONLY to resolve the account's display_phone_number (chat_history
//     is keyed by wa_number, not whatsapp_account_id) — the access token on
//     the returned row is never read or persisted by this file.
//   - zohoConnectionService.assertWhatsappAccountInWorkspace() -> the SAME
//     "does this whatsapp_account_id actually belong to this workspace_id"
//     isolation check every other Zoho-adjacent service in this codebase
//     uses, so workspace/account isolation is enforced identically here.
//   - contactSyncService.normalizePhone()  -> the SAME phone normalization
//     convention used by zohoLeadService/zohoNoteService/contacts.js.
//   - coexistence.chat_history             -> the SAME message table
//     routes/messages.js reads from (wa_number + contact_number scoping),
//     when the caller doesn't already have the messages in hand.
//   - coexistence.zoho_extraction_audit    -> the Phase 8A table reserved
//     exactly for this purpose (workspace_id, whatsapp_account_id,
//     conversation/message reference, extracted_data JSONB, confidence,
//     evidence JSONB, status, timestamps). No schema change was needed.
//
// ── Idempotency (spec §13) ────────────────────────────────────────────────
// chat_history.message_id is the only stable per-event reference this
// codebase currently exposes for an inbound message. When the caller
// supplies (or this service resolves) a latest inbound message_id, a
// SELECT-before-INSERT against zoho_extraction_audit
// (workspace_id + whatsapp_account_id + contact_number + message_id) is
// used to avoid creating unlimited duplicate audit rows for the exact same
// conversation state. This is a best-effort, non-atomic check (no unique
// DB constraint was added — see spec §12, "smallest safe change"; a
// concurrent duplicate insert is possible under a race). True event-level
// idempotency with a DB-enforced constraint is deferred to 8H, exactly as
// instructed. When no message_id is available (e.g. caller passes raw
// conversationMessages with no ids), every call creates a new audit row.
//
// ── Hallucination safety (spec §10) ──────────────────────────────────────
// The prompt explicitly forbids inventing values, and this service treats
// the model as untrusted input: every field is validated against a strict
// shape after JSON parsing, unknown/malformed fields are dropped rather
// than guessed, and a model response that fails to parse as valid JSON
// never becomes a "confident" result — see safeParseExtraction().

const pool = require('../db');
// Phase 8I — customer-detail extraction now uses Groq exclusively (the
// existing WhatsApp AI reply path in aiReplyService.js keeps using
// geminiService untouched; this file no longer references geminiService).
const groqService = require('./groqService');
// Required as a module reference (not destructured) so tests can monkeypatch
// whatsappAccountsRoutes.getAccountWithToken the same way pool.query is
// monkeypatched elsewhere in this codebase's test suite — a destructured
// binding would freeze the pre-patch function reference.
const whatsappAccountsRoutes = require('../routes/whatsappAccounts');
const zohoConnectionService = require('./zohoConnectionService');
const { normalizePhone } = require('./contactSyncService');

const DEFAULT_DATA_WINDOW = "INTERVAL '90 days'";
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 1000;

const PLACE_TYPES = ['residence', 'site', 'business', 'reference', 'unknown'];

// ── Phase 8F — dynamic business-field prompt section ──────────────────────
// Renders the workspace/account's active 8E field definitions into prompt
// instructions the model can follow WITHOUT this file ever hardcoding any
// business-specific field name (spec 8F §1). Purely additive: when no
// definitions are configured, buildPrompt() behaves exactly as it did
// before 8F (spec 8F "If no business-specific fields are configured,
// extraction must still work using existing 8D behavior").
function describeFieldType(def) {
  if (def.fieldType === 'select' || def.fieldType === 'multiselect') {
    const options = Array.isArray(def.fieldConfig?.options) ? def.fieldConfig.options : [];
    return `${def.fieldType} (allowed options: ${options.map((o) => JSON.stringify(o)).join(', ')})`;
  }
  return def.fieldType;
}

function buildBusinessFieldsPromptSection(fieldDefinitions) {
  if (!Array.isArray(fieldDefinitions) || fieldDefinitions.length === 0) return '';
  const lines = fieldDefinitions.map((def) => {
    const parts = [
      `- field_key: "${def.fieldKey}"`,
      `label: "${def.fieldLabel}"`,
      `type: ${describeFieldType(def)}`,
      `required: ${def.isRequired ? 'true' : 'false'}`,
    ];
    if (def.description) parts.push(`description: ${def.description}`);
    if (def.extractionInstruction) parts.push(`extraction guidance: ${def.extractionInstruction}`);
    return parts.join(' | ');
  });

  return [
    '',
    'ADDITIONAL BUSINESS-SPECIFIC FIELDS TO EXTRACT:',
    'The business configured the following extra fields for THIS WhatsApp account only. Extract each ONLY if',
    'explicitly supported by the conversation text — never invent a value, and never borrow a value from one',
    'field to fill another. Respect each field\'s type exactly (for "select"/"multiselect", the value(s) must be',
    'exactly one of the listed allowed options, matched to the closest allowed option based on meaning; if',
    'nothing in the conversation clearly matches an allowed option, leave the value null). If the customer',
    'explicitly corrects an earlier value for one of these fields, populate "previous" the same way as the',
    'standard fields above.',
    ...lines,
    '',
    'For EACH field above (using its exact field_key), add an entry to a top-level "business_fields" object in',
    'your JSON response, keyed by field_key, in this shape (omit a key entirely if you found nothing — do NOT',
    'invent a null placeholder for every configured field, only include field_keys with an actual finding OR a',
    'correction):',
    '  "business_fields": { "<field_key>": { "value": <string|number|boolean|string[]|null>, "confidence": number, "evidence": [{"message_id": string|null, "text": string}], "previous": null|{"value": ..., "confidence": number, "evidence": [...]} }, ... }',
  ].join('\n');
}

// ── Prompt design (spec §14) ─────────────────────────────────────────────
function buildPrompt(conversationText, fieldDefinitions) {
  return [
    'You are an information-extraction engine for a WhatsApp business chat.',
    'You will be given a WhatsApp conversation between a business and a customer.',
    'Extract ONLY facts about the CUSTOMER that are explicitly supported by the conversation text.',
    '',
    'STRICT RULES:',
    '1. Never invent a name, phone number, email, location, or intent that is not supported by the text.',
    '2. If a fact is not present, its value must be null and it must be listed in missing_required_fields if required.',
    '3. Distinguish customer FACTS from mere REFERENCES. Example: "I heard about your company in Erode" is a',
    '   reference to how the customer heard about the business, NOT the customer\'s own location — do not set place from it.',
    '4. Distinguish location semantics. Classify any customer location mention into exactly one of:',
    '   "residence" (e.g. "I am from X", "I live in X", "my native is X", "I am staying in X"),',
    '   "site" (e.g. "my site is in X"), "business" (e.g. "our factory/shop/office is in X"),',
    '   "reference" (e.g. "I heard about you in X", "I saw your ad in X" — NOT the customer\'s own location), or',
    '   "unknown" if the location is mentioned but its relationship to the customer is unclear.',
    '   Only "residence", "site", or "business" types represent an actual customer place; "reference" and',
    '   "unknown" types must NOT be treated as the customer\'s location for CRM purposes.',
    '5. Lower your confidence for hedged/uncertain language ("I think", "maybe", "around", "probably").',
    '   Confidence must be a number between 0 and 1.',
    '6. Consider the WHOLE conversation, not just the most recent message — facts may be established earlier.',
    '7. Every non-null field must include evidence: the exact message_id (if given) and the verbatim text',
    '   snippet that supports it.',
    '8. The minimum information required to create a CRM Lead is: name, place (residence/site/business type),',
    '   and phone (the WhatsApp number itself may already satisfy this — treat it as known if provided below).',
    '9. Identify the customer\'s general interest/intent (e.g. product enquiry, quotation request, service',
    '   enquiry, appointment) in your own general terms — do not assume any single business vertical.',
    '10. A name only counts as the CUSTOMER\'s own name when the customer is stating it about themselves',
    '    (e.g. "my name is X", "this is X", "X here"). A name mentioned about someone else (e.g. "I spoke to',
    '    my brother Ravi", "ask my colleague Priya") is NOT the customer\'s name — leave name null in that case.',
    '11. If the customer explicitly corrects an earlier statement (e.g. first giving one place/name/number,',
    '    then later saying it changed, e.g. "actually" / "sorry I meant" / "correction"), set the field\'s value',
    '    to the corrected/newest value and additionally populate that field\'s "previous" with the superseded',
    '    value (same shape, its own evidence). If nothing was corrected, omit "previous" or set it to null.',
    '12. CONVERSATIONAL CONTEXT (critical): Customers very often reply with a single word or a short phrase',
    '    that only makes sense as a direct answer to the Business\'s immediately preceding question — it is',
    '    NOT a random standalone fact. When a "Business" message asks for a specific piece of information',
    '    (the customer\'s name, city/town/location, email, phone, or what they are interested in), interpret',
    '    the very next "Customer" message as the answer to THAT specific question, even if it is just one',
    '    word and contains no explicit label like "my name is" or "I live in". Example: Business asks "May I',
    '    know your name?" and Customer replies "Kavin" -> name = "Kavin". Business asks "Which city are you',
    '    from?" and Customer replies "Namakkal" -> place = "Namakkal", type "residence". Business asks "Email',
    '    iruka?" (asking for their email) and Customer replies with an email address -> email = that address.',
    '    A bare one-word reply immediately following the relevant question is sufficient evidence on its own',
    '    (cite that reply\'s own message_id/text as the evidence) — do not require a full sentence. "Business"',
    '    messages are always the business\'s own questions/prompts/replies and must NEVER themselves be read as',
    '    customer facts, even when the question itself mentions a place or name (e.g. asking "Entha ooru?"',
    '    is not itself a location fact).',
    '13. LANGUAGE: The conversation may be in English, Tamil, or Thanglish (Tamil written in Latin script,',
    '    often mixed with English words), or any other language/script. Understand the MEANING regardless of',
    '    language or script — never skip or ignore non-English or code-mixed text. Common Thanglish patterns:',
    '    "Peru?" / "Ungal peru?" (asking for name), "Entha ooru?" / "Eppadi ooru?" (asking which town/city),',
    '    "... la irukken" / "... la iruken" (residing in ...), "Email iruka?" (asking for email), "venum"',
    '    (want/need — expresses product interest), "pathi therinjukanum" (want to know about ...). Treat a',
    '    short reply to one of these exactly like the equivalent English question/answer pair.',
    '',
    'Respond with STRICT JSON ONLY — no markdown, no code fences, no commentary — matching exactly this shape',
    '(the "previous" key is optional and only used when a fact was explicitly corrected):',
    '{',
    '  "name": { "value": string|null, "confidence": number, "evidence": [{"message_id": string|null, "text": string}], "previous": null|{"value": string, "confidence": number, "evidence": [...]} },',
    '  "place": { "value": string|null, "type": "residence"|"site"|"business"|"reference"|"unknown", "confidence": number, "evidence": [...], "previous": null|{"value": string, "type": string, "confidence": number, "evidence": [...]} },',
    '  "phone": { "value": string|null, "confidence": number, "evidence": [...], "previous": null|{...} },',
    '  "email": { "value": string|null, "confidence": number, "evidence": [...], "previous": null|{...} },',
    '  "intent": { "value": string|null, "confidence": number, "evidence": [...], "previous": null|{...} },',
    '  "interest_summary": string|null,',
    '  "missing_required_fields": string[],',
    '  "overall_confidence": number',
    '}',
    buildBusinessFieldsPromptSection(fieldDefinitions),
    '',
    'Conversation (oldest first):',
    conversationText,
    '',
    'JSON:',
  ].join('\n');
}

function truncate(str, max) {
  if (!str) return '';
  const s = String(str);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// Renders the conversation into a simple, model-friendly transcript.
// Each line carries the message_id (when known) so the model can cite it
// back verbatim in `evidence`.
function renderConversation(messages) {
  return messages
    .map((m) => {
      const who = m.direction === 'outgoing' ? 'Business' : 'Customer';
      const id = m.messageId ? ` [id:${m.messageId}]` : '';
      return `${who}${id}: ${truncate(m.text, MAX_MESSAGE_CHARS)}`;
    })
    .join('\n');
}

// ── Field validation helpers (spec §10 — never trust raw model output) ───
function num(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function str(v) {
  if (v === null || v === undefined) return null;
  // Reject objects/arrays outright rather than stringifying them into
  // something like "[object Object]" — a wrong-typed value from the model
  // (spec §10) must never become a surfaced "fact".
  if (typeof v === 'object') return null;
  const s = String(v).trim();
  return s ? s : null;
}

function sanitizeEvidence(evidence) {
  if (!Array.isArray(evidence)) return [];
  return evidence
    .filter((e) => e && typeof e === 'object')
    .slice(0, 10)
    .map((e) => ({
      message_id: e.message_id != null ? String(e.message_id).slice(0, 200) : null,
      text: truncate(e.text, 500),
    }))
    .filter((e) => e.text);
}

function sanitizeFieldBase(raw) {
  if (!raw || typeof raw !== 'object') {
    return { value: null, confidence: 0, evidence: [] };
  }
  const value = str(raw.value);
  const evidence = sanitizeEvidence(raw.evidence);
  // Hallucination guard: a field with a value but zero supporting evidence
  // is never treated as confirmed — its confidence is clamped to 0 and the
  // value is dropped rather than surfaced as a "fact" with nothing behind it.
  if (value && evidence.length === 0) {
    return { value: null, confidence: 0, evidence: [] };
  }
  return {
    value,
    confidence: value ? num(raw.confidence) : 0,
    evidence,
  };
}

// Wraps sanitizeFieldBase with the optional current/previous correction
// shape (spec §6). "previous" is only kept when it itself sanitizes to a
// real value — a malformed/empty previous is simply dropped, never treated
// as an error.
function sanitizeField(raw) {
  const current = sanitizeFieldBase(raw);
  let previous = null;
  if (raw && typeof raw === 'object' && raw.previous && typeof raw.previous === 'object') {
    const sanitizedPrevious = sanitizeFieldBase(raw.previous);
    if (sanitizedPrevious.value) previous = sanitizedPrevious;
  }
  return { ...current, previous };
}

function sanitizePlaceBase(raw) {
  const base = sanitizeFieldBase(raw);
  let type = typeof raw?.type === 'string' ? raw.type.toLowerCase().trim() : 'unknown';
  if (!PLACE_TYPES.includes(type)) type = 'unknown';
  // A reference/unknown-type location is never a confirmed customer place —
  // preserve the distinction (spec §5) rather than collapsing it away.
  if (!base.value) type = 'unknown';
  return { ...base, type };
}

function sanitizePlace(raw) {
  const current = sanitizePlaceBase(raw);
  let previous = null;
  if (raw && typeof raw === 'object' && raw.previous && typeof raw.previous === 'object') {
    const sanitizedPrevious = sanitizePlaceBase(raw.previous);
    if (sanitizedPrevious.value) previous = sanitizedPrevious;
  }
  return { ...current, previous };
}

// ── Phase 8F — dynamic business-field value sanitization ──────────────────
// Mirrors sanitizeFieldBase()/sanitizeField() for the standard fields, but
// type-checked/coerced/normalized against each field's OWN configured
// field_type (spec 8F §4) instead of always being a string. Never invents
// or coerces a misleading value: anything that doesn't cleanly validate
// against the configured type/options is dropped (value -> null), never
// guessed or force-cast (spec 8F §4 "Invalid values must be rejected/
// dropped, not coerced into misleading data").
function normalizeBusinessFieldValue(def, rawValue) {
  if (rawValue === null || rawValue === undefined) return null;
  switch (def.fieldType) {
    case 'text': {
      if (typeof rawValue === 'object') return null;
      const s = String(rawValue).trim();
      return s ? s : null;
    }
    case 'number': {
      const n = Number(rawValue);
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean': {
      if (typeof rawValue === 'boolean') return rawValue;
      // Be lenient about how the model might phrase a boolean, but never
      // guess when the phrasing is ambiguous.
      if (typeof rawValue === 'string') {
        const s = rawValue.trim().toLowerCase();
        if (s === 'true' || s === 'yes') return true;
        if (s === 'false' || s === 'no') return false;
      }
      return null;
    }
    case 'date': {
      if (typeof rawValue !== 'string' && typeof rawValue !== 'number') return null;
      const parsed = new Date(rawValue);
      if (Number.isNaN(parsed.getTime())) return null;
      return parsed.toISOString().slice(0, 10);
    }
    case 'select': {
      if (typeof rawValue !== 'object' || rawValue === null) {
        const options = Array.isArray(def.fieldConfig?.options) ? def.fieldConfig.options : [];
        if (typeof rawValue === 'string' && options.includes(rawValue)) return rawValue;
      }
      return null;
    }
    case 'multiselect': {
      const options = Array.isArray(def.fieldConfig?.options) ? def.fieldConfig.options : [];
      if (!Array.isArray(rawValue)) return null;
      const filtered = rawValue.filter((v) => typeof v === 'string' && options.includes(v));
      // Dedupe while preserving order.
      const deduped = [...new Set(filtered)];
      return deduped.length > 0 ? deduped : null;
    }
    default:
      return null;
  }
}

function sanitizeBusinessFieldEntryBase(def, raw) {
  if (!raw || typeof raw !== 'object') return { value: null, confidence: 0, evidence: [] };
  const value = normalizeBusinessFieldValue(def, raw.value);
  const evidence = sanitizeEvidence(raw.evidence);
  // Evidence is mandatory for a value (spec 8F §2) — a value with no
  // supporting evidence is never surfaced as a fact.
  if (value !== null && evidence.length === 0) {
    return { value: null, confidence: 0, evidence: [] };
  }
  return {
    value,
    confidence: value !== null ? num(raw.confidence) : 0,
    evidence,
  };
}

function sanitizeBusinessFieldEntry(def, raw) {
  const current = sanitizeBusinessFieldEntryBase(def, raw);
  let previous = null;
  if (raw && typeof raw === 'object' && raw.previous && typeof raw.previous === 'object') {
    const sanitizedPrevious = sanitizeBusinessFieldEntryBase(def, raw.previous);
    if (sanitizedPrevious.value !== null) previous = sanitizedPrevious;
  }
  return { ...current, previous, fieldKey: def.fieldKey, fieldType: def.fieldType, isRequired: !!def.isRequired };
}

// Builds the sanitized business_fields map, ONE entry per currently-active
// configured field definition (so downstream missing/uncertain/confirmed
// validation — spec 8F §3 — always has a complete, predictable shape to
// work from, exactly mirroring how emptyExtraction() always has all five
// standard fields present even when nothing was found). Unknown field_keys
// returned by the model (not a configured active definition) are silently
// ignored — this file never persists or surfaces a field that isn't
// currently configured for this workspace/account (spec 8F §1/§8).
function sanitizeBusinessFields(rawBusinessFields, fieldDefinitions) {
  const raw = rawBusinessFields && typeof rawBusinessFields === 'object' && !Array.isArray(rawBusinessFields)
    ? rawBusinessFields
    : {};
  const result = {};
  for (const def of fieldDefinitions || []) {
    result[def.fieldKey] = sanitizeBusinessFieldEntry(def, raw[def.fieldKey]);
  }
  return result;
}

function emptyBusinessFields(fieldDefinitions) {
  const result = {};
  for (const def of fieldDefinitions || []) {
    result[def.fieldKey] = {
      value: null,
      confidence: 0,
      evidence: [],
      previous: null,
      fieldKey: def.fieldKey,
      fieldType: def.fieldType,
      isRequired: !!def.isRequired,
    };
  }
  return result;
}

// ── Name validation (spec §7) ─────────────────────────────────────────────
// A name mentioned about someone ELSE in the conversation ("I spoke with my
// brother Ravi") must never be surfaced as the customer's own name, even if
// the model (incorrectly) returns it with a value + evidence. This is a
// defensive backstop on top of the prompt instruction (rule 10 above), not
// a replacement for it — the model is still the primary classifier.
const THIRD_PARTY_RELATION_WORDS = [
  'brother', 'sister', 'father', 'mother', 'dad', 'mom', 'wife', 'husband',
  'son', 'daughter', 'friend', 'colleague', 'coworker', 'co-worker',
  'uncle', 'aunt', 'cousin', 'neighbour', 'neighbor', 'boss', 'manager',
  'partner', 'client', 'customer',
];
// NOTE: the relation-word match itself is deliberately case-insensitive
// ("My Brother Ravi" should still be caught), but the captured NAME must
// stay case-SENSITIVE ([A-Z] to require an actual capitalized word) — a
// single combined /i regex would make [A-Z] match lowercase letters too
// and defeat the whole point of this check. Matching is done in two steps
// for exactly that reason.
const THIRD_PARTY_RELATION_RE = new RegExp(
  `\\bmy\\s+(?:${THIRD_PARTY_RELATION_WORDS.join('|')})\\b`,
  'i'
);
const CAPITALIZED_NAME_AFTER_RE = /^(?:\s+\w+){0,2}\s+([A-Z][a-zA-Z]+)/;

function isLikelyThirdPartyName(nameValue, evidence) {
  if (!nameValue || !Array.isArray(evidence) || evidence.length === 0) return false;
  const lowerName = nameValue.toLowerCase();
  return evidence.some((e) => {
    const text = String(e.text || '');
    const relationMatch = THIRD_PARTY_RELATION_RE.exec(text);
    if (!relationMatch) return false;
    const after = text.slice(relationMatch.index + relationMatch[0].length);
    const nameMatch = CAPITALIZED_NAME_AFTER_RE.exec(after);
    if (!nameMatch) return false;
    const captured = nameMatch[1].toLowerCase();
    // Only treat this as a rejection when the flagged relation-name in the
    // text actually overlaps with the extracted name — a name elsewhere in
    // a longer message shouldn't be penalized by an unrelated relation
    // mention.
    return captured === lowerName || lowerName.split(/\s+/).includes(captured);
  });
}

function guardCustomerName(name) {
  if (isLikelyThirdPartyName(name.value, name.evidence)) {
    return { value: null, confidence: 0, evidence: [], previous: name.previous };
  }
  return name;
}

// ── Phone validation (spec §8) ────────────────────────────────────────────
// Reuses the SAME normalizePhone() as contactSyncService/zohoLeadService —
// no second phone-normalization system. A value that doesn't survive
// normalization (too short, too long, no digits) is never surfaced as a
// fact; this never invents or corrects a phone number, it only drops one
// that can't possibly be valid.
function guardPhone(phone) {
  if (phone.value && !normalizePhone(phone.value)) {
    return { value: null, confidence: 0, evidence: [], previous: phone.previous };
  }
  return phone;
}

// Parses the model's raw text into the validated extraction shape. Never
// throws; a malformed/non-JSON response degrades to an all-null, zero-
// confidence result rather than ever surfacing invented data.
function safeParseExtraction(rawText, fieldDefinitions) {
  let parsed;
  try {
    let cleaned = String(rawText || '').trim();
    // Defensive: strip accidental ```json fences even though the prompt
    // forbids them — cheap and never harmful.
    cleaned = cleaned.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return emptyExtraction('Model response was not valid JSON', fieldDefinitions);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return emptyExtraction('Model response was not a JSON object', fieldDefinitions);
  }

  const name = guardCustomerName(sanitizeField(parsed.name));
  const place = sanitizePlace(parsed.place);
  const phone = guardPhone(sanitizeField(parsed.phone));
  const email = sanitizeField(parsed.email);
  const intent = sanitizeField(parsed.intent);
  const interestSummary = str(parsed.interest_summary);

  const missing = Array.isArray(parsed.missing_required_fields)
    ? parsed.missing_required_fields.filter((f) => typeof f === 'string').slice(0, 20)
    : [];

  const overallConfidence = num(parsed.overall_confidence);

  // Phase 8F — malformed AI output for business_fields degrades safely
  // (drops to an all-null map) instead of ever throwing or crashing the
  // whole extraction (spec 8F §2 "Malformed AI output must degrade safely").
  let businessFields;
  try {
    businessFields = sanitizeBusinessFields(parsed.business_fields, fieldDefinitions);
  } catch {
    businessFields = emptyBusinessFields(fieldDefinitions);
  }

  return {
    name,
    place,
    phone,
    email,
    intent,
    interest_summary: interestSummary,
    missing_required_fields: missing,
    overall_confidence: overallConfidence,
    business_fields: businessFields,
    parse_error: null,
  };
}

function emptyExtraction(parseError, fieldDefinitions) {
  return {
    name: { value: null, confidence: 0, evidence: [], previous: null },
    place: { value: null, type: 'unknown', confidence: 0, evidence: [], previous: null },
    phone: { value: null, confidence: 0, evidence: [], previous: null },
    email: { value: null, confidence: 0, evidence: [], previous: null },
    intent: { value: null, confidence: 0, evidence: [], previous: null },
    interest_summary: null,
    missing_required_fields: [],
    overall_confidence: 0,
    business_fields: emptyBusinessFields(fieldDefinitions),
    parse_error: parseError || null,
  };
}

// ── Evidence integrity (spec §4) ──────────────────────────────────────────
// Cross-checks each field's evidence against the message ids ACTUALLY
// present in the conversation this call was given, not just "looks like an
// evidence object". A model can cite a message_id that doesn't exist in
// this conversation at all (a hallucinated reference) — that evidence item
// is stripped, and if that empties a field's evidence, the value is
// dropped too (same rule sanitizeField already applies to zero evidence).
// Only runs when the caller actually has known message ids to check
// against; when none are available (e.g. a raw safeParseExtraction() unit
// call, or a conversation with no message ids at all) this is a no-op —
// best-effort, matching the rest of this file's non-blocking posture.
function knownMessageIdSet(messages) {
  const set = new Set();
  (messages || []).forEach((m) => {
    if (m && m.messageId != null) set.add(String(m.messageId));
  });
  return set;
}

function filterEvidenceByKnownIds(evidence, knownIds) {
  if (!knownIds || knownIds.size === 0) return evidence;
  return evidence.filter((e) => e.message_id == null || knownIds.has(String(e.message_id)));
}

function enforceEvidenceIntegrityOnField(field, knownIds) {
  if (!knownIds || knownIds.size === 0) return field;
  let value = field.value;
  let confidence = field.confidence;
  let evidence = filterEvidenceByKnownIds(field.evidence, knownIds);
  // `value !== null` (not a truthiness check) — a business field's value
  // may legitimately be `false`, `0`, or an array, all falsy-ish but valid.
  if (value !== null && value !== undefined && evidence.length === 0) {
    value = null;
    confidence = 0;
  }
  let previous = field.previous;
  if (previous) {
    const prevEvidence = filterEvidenceByKnownIds(previous.evidence, knownIds);
    previous = prevEvidence.length === 0 ? null : { ...previous, evidence: prevEvidence };
  }
  return { ...field, value, confidence, evidence, previous };
}

function enforceEvidenceIntegrity(extraction, messages) {
  const knownIds = knownMessageIdSet(messages);
  if (knownIds.size === 0) return extraction;

  const businessFields = extraction.business_fields
    ? Object.fromEntries(
        Object.entries(extraction.business_fields).map(([key, field]) => [
          key,
          enforceEvidenceIntegrityOnField(field, knownIds),
        ])
      )
    : extraction.business_fields;

  return {
    ...extraction,
    name: enforceEvidenceIntegrityOnField(extraction.name, knownIds),
    place: (() => {
      const p = enforceEvidenceIntegrityOnField(extraction.place, knownIds);
      return p.value ? p : { ...p, type: 'unknown' };
    })(),
    phone: enforceEvidenceIntegrityOnField(extraction.phone, knownIds),
    email: enforceEvidenceIntegrityOnField(extraction.email, knownIds),
    intent: enforceEvidenceIntegrityOnField(extraction.intent, knownIds),
    business_fields: businessFields,
  };
}

// ── Validation / decision layer (spec §2, §3) ─────────────────────────────
// Distinguishes COMPLETE / INCOMPLETE / UNCERTAIN on top of the sanitized
// extraction. A field is:
//   - "missing"   when it has no value, OR (place only) its type isn't one
//                 of the customer-place types (residence/site/business) —
//                 a reference/unknown-type location never satisfies the
//                 place requirement, matching spec §3's examples.
//   - "uncertain" when it has a value of the right shape/type but the
//                 model's own confidence is below CONFIDENCE_CONFIRM_THRESHOLD
//                 (hedged language like "maybe", "I think", "around").
//   - "confirmed" otherwise.
// Overall status: any "missing" field -> INCOMPLETE (missing always takes
// priority over uncertain, matching spec §3's "reference location" example
// being INCOMPLETE rather than UNCERTAIN); no missing but some "uncertain"
// -> UNCERTAIN; everything confirmed -> COMPLETE. UNCERTAIN is never
// reported as COMPLETE.
const CONFIDENCE_CONFIRM_THRESHOLD = 0.55;
const PLACE_REQUIRED_TYPES = ['residence', 'site', 'business'];

function fieldStatus(field, { requireTypes } = {}) {
  if (!field || !field.value) return 'missing';
  if (requireTypes && !requireTypes.includes(field.type)) return 'missing';
  return field.confidence >= CONFIDENCE_CONFIRM_THRESHOLD ? 'confirmed' : 'uncertain';
}

function computeValidation(extraction, { knownContactNumber } = {}) {
  const nameStatus = fieldStatus(extraction.name);
  const placeStatus = fieldStatus(extraction.place, { requireTypes: PLACE_REQUIRED_TYPES });
  const phoneStatus = knownContactNumber ? 'confirmed' : fieldStatus(extraction.phone);

  const fields = { name: nameStatus, place: placeStatus, phone: phoneStatus };
  const missing_required_fields = Object.keys(fields).filter((k) => fields[k] === 'missing');
  const uncertain_fields = Object.keys(fields).filter((k) => fields[k] === 'uncertain');

  let status;
  if (missing_required_fields.length > 0) status = 'INCOMPLETE';
  else if (uncertain_fields.length > 0) status = 'UNCERTAIN';
  else status = 'COMPLETE';

  return { status, fields, missing_required_fields, uncertain_fields };
}

// ── Phase 8F — business-field validation layer ────────────────────────────
// Separate from computeValidation() (which only ever judges the five
// standard 8D fields, unchanged, for backward compatibility) — this judges
// the dynamically-configured business fields the exact same way: missing /
// uncertain / confirmed per field, and an overall status that can NEVER
// report UNCERTAIN as COMPLETE (spec 8F §3).
function businessFieldStatus(field) {
  if (field.value === null || field.value === undefined) {
    return field.isRequired ? 'missing' : 'not_provided';
  }
  return field.confidence >= CONFIDENCE_CONFIRM_THRESHOLD ? 'confirmed' : 'uncertain';
}

function computeBusinessValidation(businessFields) {
  const fields = {};
  const extracted = {};
  const missing_required_fields = [];
  const uncertain_fields = [];

  for (const [key, field] of Object.entries(businessFields || {})) {
    const status = businessFieldStatus(field);
    fields[key] = status;
    if (status === 'missing') missing_required_fields.push(key);
    if (status === 'uncertain') uncertain_fields.push(key);
    if (status === 'confirmed' || status === 'uncertain') {
      extracted[key] = { value: field.value, confidence: field.confidence, evidence: field.evidence };
    }
  }

  let status;
  if (missing_required_fields.length > 0) status = 'INCOMPLETE';
  else if (uncertain_fields.length > 0) status = 'UNCERTAIN';
  else status = 'COMPLETE';

  const confidences = Object.values(businessFields || {})
    .filter((f) => f.value !== null && f.value !== undefined)
    .map((f) => f.confidence);
  const overall_confidence = confidences.length
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length
    : 0;

  return { status, fields, extracted_fields: extracted, missing_required_fields, uncertain_fields, overall_confidence };
}

// Fills missing_required_fields (spec §8) from the extraction itself —
// name + place are always required; phone is considered satisfied whenever
// a known contact number was supplied to this service (the WhatsApp number
// itself), matching spec §8's "the WhatsApp/contact number may already be
// known from the conversation/contact identity" note. Kept as a thin
// wrapper over computeValidation() (Part 2's decision layer) so existing
// callers/tests of this exact function signature keep working unchanged.
function computeMissingFields(extraction, { knownContactNumber } = {}) {
  return computeValidation(extraction, { knownContactNumber }).missing_required_fields;
}

// ── Conversation loading (spec §7, §11) ──────────────────────────────────
// Only used when the caller doesn't already supply conversationMessages.
// Scoped strictly to workspace_id -> whatsapp_account_id -> wa_number +
// contact_number, mirroring routes/messages.js's own scoping — never mixes
// conversations across workspaces/accounts (spec §11).
async function loadConversationMessages({ workspaceId, whatsappAccountId, contactNumber }) {
  const account = await whatsappAccountsRoutes.getAccountWithToken(whatsappAccountId, workspaceId);
  if (!account) {
    const err = new Error('WhatsApp account not found in this workspace');
    err.status = 404;
    throw err;
  }
  const waNumber = String(account.displayPhoneNumber || '').replace(/\D/g, '');
  if (!waNumber) {
    const err = new Error('WhatsApp account has no phone number configured');
    err.status = 409;
    throw err;
  }

  const { rows } = await pool.query(
    `SELECT message_id, direction, message_body, message_type, timestamp
       FROM coexistence.chat_history
      WHERE wa_number = $1
        AND contact_number = $2
        AND timestamp >= NOW() - ${DEFAULT_DATA_WINDOW}
        AND message_type <> 'status'
      ORDER BY timestamp DESC
      LIMIT $3`,
    [waNumber, contactNumber, MAX_MESSAGES]
  );

  // The query above is scoped to exactly this workspace's WhatsApp account
  // (via waNumber, resolved from whatsappAccountId + workspaceId above) and
  // this one contact_number — never any other tenant/account's messages.
  //
  // DESC + LIMIT fetches the most recent MAX_MESSAGES rows, which is
  // correct for "the last N messages" but leaves them newest-first. The
  // prompt needs chronological (oldest-first) order (spec §6: "consider
  // the WHOLE conversation... facts may be established earlier"), so the
  // fetched page is explicitly re-sorted ascending by timestamp here
  // rather than relying on a blind .reverse() of however the driver
  // happened to return the DESC page — this is correct regardless of
  // row ordering ties or how the caller's mock/driver returns rows.
  return rows
    .slice()
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .map((r) => ({
      messageId: r.message_id || null,
      direction: r.direction,
      text: r.message_body || '',
      timestamp: r.timestamp,
    }))
    .filter((m) => m.text && m.text.trim());
}

function latestInboundMessageId(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].direction === 'incoming' && messages[i].messageId) {
      return messages[i].messageId;
    }
  }
  return null;
}

// ── Persistence (spec §12) ────────────────────────────────────────────────
// Reuses coexistence.zoho_extraction_audit exactly as-is — no schema
// change was required. Stores workspace/account/contact scope, the
// conversation/message reference, the sanitized structured result,
// overall confidence, evidence, and a 'pending_review' status (this
// service never auto-applies/approves anything — that decision belongs to
// a later phase's review/validation step, see spec §17).
async function persistExtractionAudit({ workspaceId, whatsappAccountId, contactNumber, messageId, extraction }) {
  const evidence = [
    ...extraction.name.evidence.map((e) => ({ field: 'name', ...e })),
    ...extraction.place.evidence.map((e) => ({ field: 'place', ...e })),
    ...extraction.phone.evidence.map((e) => ({ field: 'phone', ...e })),
    ...extraction.email.evidence.map((e) => ({ field: 'email', ...e })),
    ...extraction.intent.evidence.map((e) => ({ field: 'intent', ...e })),
    // Superseded values (spec §6) are kept in the audit trail too, tagged
    // distinctly so a reviewer can see what was corrected and why.
    ...(extraction.name.previous?.evidence || []).map((e) => ({ field: 'name_previous', ...e })),
    ...(extraction.place.previous?.evidence || []).map((e) => ({ field: 'place_previous', ...e })),
    ...(extraction.phone.previous?.evidence || []).map((e) => ({ field: 'phone_previous', ...e })),
    // Phase 8F — business-field evidence, tagged by their own field_key so
    // a reviewer can distinguish which configured field each snippet
    // supports (same "field_previous" convention as the standard fields).
    ...Object.entries(extraction.business_fields || {}).flatMap(([key, field]) => [
      ...(field.evidence || []).map((e) => ({ field: key, ...e })),
      ...((field.previous?.evidence) || []).map((e) => ({ field: `${key}_previous`, ...e })),
    ]),
  ];

  const { rows } = await pool.query(
    `INSERT INTO coexistence.zoho_extraction_audit
       (workspace_id, whatsapp_account_id, conversation_id, message_id, contact_number,
        extracted_data, confidence, evidence, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending_review')
     RETURNING *`,
    [
      workspaceId,
      whatsappAccountId,
      contactNumber || null,
      messageId || null,
      contactNumber || null,
      JSON.stringify(extraction),
      extraction.overall_confidence,
      JSON.stringify(evidence),
    ]
  );
  return rows[0];
}

// Best-effort idempotency check (see file header) — only meaningful when a
// stable messageId is available. Never throws; a lookup failure just falls
// through to creating a new row.
async function findExistingAudit({ workspaceId, whatsappAccountId, contactNumber, messageId }) {
  if (!messageId) return null;
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.zoho_extraction_audit
      WHERE workspace_id = $1 AND whatsapp_account_id = $2
        AND contact_number = $3 AND message_id = $4
      ORDER BY created_at DESC
      LIMIT 1`,
    [workspaceId, whatsappAccountId, contactNumber || null, messageId]
  );
  return rows[0] || null;
}

function serializeAuditRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    whatsappAccountId: row.whatsapp_account_id,
    contactNumber: row.contact_number,
    messageId: row.message_id,
    status: row.status,
    confidence: row.confidence != null ? Number(row.confidence) : null,
    createdAt: row.created_at,
  };
}
// ── Public entry point ────────────────────────────────────────────────────
/**
 * @param {object} params
 * @param {number|string} params.workspaceId
 * @param {number|string} params.whatsappAccountId
 * @param {string} params.contactNumber - the customer's WhatsApp number
 * @param {Array<{messageId?: string, direction: 'incoming'|'outgoing', text: string}>} [params.conversationMessages]
 *   - optional pre-fetched conversation (oldest first). When omitted, this
 *     service loads recent coexistence.chat_history for the given
 *     workspace/account/contact itself.
 * @param {boolean} [params.persist=true] - when false, skips writing to
 *   zoho_extraction_audit (useful for a pure "preview" call).
 * @param {string} [params.model] - optional Groq model override.
 * @param {Array<object>} [params.fieldDefinitions] - Phase 8F: active 8E
 *   business-field definitions (serialize()d shape from
 *   businessFieldDefinitionService) to additionally extract, dynamically,
 *   for THIS workspace/whatsapp account. Omitted/empty -> behaves exactly
 *   as before 8F (business_fields comes back as {}).
 * @returns {Promise<{ extraction: object, complete: boolean, audit: object|null, error: string|null }>}
 */
async function extractCustomerInformation(params = {}) {
  const { workspaceId, whatsappAccountId, contactNumber, conversationMessages, persist = true, model, fieldDefinitions } = params;

  if (!workspaceId) throw new Error('workspaceId is required');
  if (!whatsappAccountId) throw new Error('whatsappAccountId is required');
  const normalizedContact = normalizePhone(contactNumber);
  if (!normalizedContact) throw new Error('A valid contactNumber is required');

  // Isolation guarantee (spec §11) — never trust an arbitrary
  // workspaceId/whatsappAccountId pair from a caller.
  await zohoConnectionService.assertWhatsappAccountInWorkspace(workspaceId, whatsappAccountId);

  const defs = Array.isArray(fieldDefinitions) ? fieldDefinitions : [];

  let messages = conversationMessages;
  if (!Array.isArray(messages) || messages.length === 0) {
    messages = await loadConversationMessages({ workspaceId, whatsappAccountId, contactNumber: normalizedContact });
  }

  if (!messages || messages.length === 0) {
    const extraction = emptyExtraction(null, defs);
    const validation = computeValidation(extraction, { knownContactNumber: normalizedContact });
    extraction.missing_required_fields = validation.missing_required_fields;
    extraction.validation = validation;
    extraction.business_validation = computeBusinessValidation(extraction.business_fields);
    return {
      extraction,
      complete: false,
      status: validation.status,
      audit: null,
      error: 'no conversation messages available to extract from',
    };
  }

  const messageId = latestInboundMessageId(messages);

  // Best-effort idempotency (spec §13, extended by 8F §6) — skip re-calling
  // the AI entirely when we've already produced an audit row for this exact
  // conversation state. The cached extracted_data already has whatever
  // business_fields shape was computed on the call that created it; recompute
  // business_validation fresh against the CURRENT field definitions (an admin
  // may have added/changed fields since that row was written) rather than
  // trusting a stale validation block.
  if (persist && messageId) {
    const existing = await findExistingAudit({
      workspaceId,
      whatsappAccountId,
      contactNumber: normalizedContact,
      messageId,
    });
    if (existing) {
      const extraction = existing.extracted_data || emptyExtraction(null, defs);
      if (!extraction.business_fields) extraction.business_fields = emptyBusinessFields(defs);
      // Older audit rows (or rows written before Part 2) may not carry a
      // `validation` block — recompute it rather than trusting a stored
      // shape that might predate this decision layer.
      const validation = computeValidation(extraction, { knownContactNumber: normalizedContact });
      extraction.missing_required_fields = validation.missing_required_fields;
      extraction.validation = validation;
      extraction.business_validation = computeBusinessValidation(extraction.business_fields);
      return {
        extraction,
        complete: validation.status === 'COMPLETE',
        status: validation.status,
        audit: serializeAuditRow(existing),
        error: null,
      };
    }
  }

  const prompt = buildPrompt(renderConversation(messages), defs);
  const { text, error: aiError } = await groqService.askGroq(prompt, model ? { model } : undefined);

  let extraction = text ? safeParseExtraction(text, defs) : emptyExtraction(aiError || 'no AI response', defs);
  // Evidence integrity (spec §4) — strip/downgrade any field whose evidence
  // cites a message_id that isn't actually part of this conversation.
  extraction = enforceEvidenceIntegrity(extraction, messages);

  const validation = computeValidation(extraction, { knownContactNumber: normalizedContact });
  extraction.missing_required_fields = validation.missing_required_fields;
  extraction.validation = validation;
  extraction.business_validation = computeBusinessValidation(extraction.business_fields);

  let audit = null;
  if (persist) {
    const savedRow = await persistExtractionAudit({
      workspaceId,
      whatsappAccountId,
      contactNumber: normalizedContact,
      messageId,
      extraction,
    });
    audit = serializeAuditRow(savedRow);
  }

  return {
    extraction,
    complete: validation.status === 'COMPLETE',
    status: validation.status,
    audit,
    error: text ? null : (aiError || 'no AI response'),
  };
}
module.exports = {
  extractCustomerInformation,
  // Exported for focused unit testing / reuse — not part of the "public
  // API" surface other services should depend on.
  safeParseExtraction,
  buildPrompt,
  computeMissingFields,
  // Part 2 additions, exported for the same reason.
  computeValidation,
  enforceEvidenceIntegrity,
  // Phase 8F additions, exported for focused unit testing / reuse by
  // businessFieldExtractionService.js.
  sanitizeBusinessFields,
  computeBusinessValidation,
  buildBusinessFieldsPromptSection,
  normalizeBusinessFieldValue,
};