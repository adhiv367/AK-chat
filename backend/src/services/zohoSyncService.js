// Phase 8G — FLEXIBLE ZOHO CRM PER WHATSAPP NUMBER + LEAD/NOTE SYNC.
//
// Thin orchestration layer only — every actual capability it uses already
// exists from 8A–8F and is reused as-is, never redesigned:
//
//   - zohoConnectionService / zohoLeadService.resolveConnectionRow
//       -> per-WhatsApp-number connection resolution + isolation
//          (workspace_id + whatsapp_account_id, never falls back to
//          another account's connection).
//   - businessFieldExtractionService.extractBusinessFields (8F)
//       -> runs 8D conversation extraction using ONLY this workspace/
//          account's ACTIVE 8E field definitions.
//   - zohoFieldMappingService (8G, new)
//       -> maps extracted business fields to Zoho targets using each
//          definition's zoho_target; anything unmapped is preserved, not
//          dropped.
//   - zohoLeadService.createLead/updateLead (8C, extended in 8G to accept
//     extraFields + drop-unsupported-field fallback)
//       -> idempotent per (workspace, whatsapp_account, contact_number)
//          Lead create-or-update, reusing zoho_lead_links.
//   - zohoNoteService.createNote (8C Part 2)
//       -> idempotent Note attached to the linked Lead.
//
// ── One number, one connection, one Lead (spec §3) ──────────────────────
// Every call here is scoped to exactly one (workspaceId, whatsappAccountId,
// contactNumber) triple, resolved entirely server-side by the caller (the
// route layer) from the authenticated session — never accepted as opaque
// client input beyond the WhatsApp account id itself, which
// zohoConnectionService.assertWhatsappAccountInWorkspace (called
// transitively by every service used below) verifies belongs to the
// caller's own workspace. Nothing in this file can select another
// account's connection, field definitions, or Lead — it never queries
// zoho_connections/zoho_lead_links itself; it only calls into services
// that already enforce that scoping internally.
//
// ── Minimum requirement (spec §2) ────────────────────────────────────────
// A Lead is only created/updated once 8D/8F's own standard-field
// completeness check (name + contact number + a valid place) reports
// COMPLETE. contactNumber is always "confirmed" here (it identifies the
// conversation itself), so this reduces in practice to "name and place are
// both present" — this file does not reimplement that decision, it reads
// it from customerExtractionService.computeValidation via
// businessFieldExtractionService's `standard.status`.
//
// ── Dynamic fields are never lost (spec §6) ──────────────────────────────
// A business field lands on the Zoho Lead ONLY when its 8E definition
// currently has a zoho_target configured AND Zoho accepts it. Everything
// else — no zoho_target configured, or a configured target Zoho itself
// rejects as unsupported on this org/plan (handled by
// zohoLeadService.withFieldFallback) — is folded into the sync Note
// instead of being silently discarded.
//
// ── Partial success (spec §5) ─────────────────────────────────────────────
// If the Lead create/update succeeds but the follow-up Note fails, this
// returns `{ synced: true, partial: true, lead, note: null, noteError }` —
// the Lead id is never lost, and the caller can retry just the Note later
// (POST /integrations/zoho/leads/:leadId/notes, unchanged from 8C).

const zohoLeadService = require('./zohoLeadService');
const zohoNoteService = require('./zohoNoteService');
const businessFieldExtractionService = require('./businessFieldExtractionService');
const { mapBusinessFieldsToZoho } = require('./zohoFieldMappingService');
const { normalizePhone } = require('./contactSyncService');
// Phase 8H Part 1 — additive only. This file still never re-implements
// Lead/Note creation itself; it now ALSO records the outcome of every
// attempt onto coexistence.zoho_sync_state so
// zohoReconciliationService/zohoReconciliationScheduler can find and retry
// exactly the conversations that still need work (bounded retry +
// exponential backoff, crash recovery, Lead-success/Note-failure
// recovery). See zohoSyncStateSchema.js's header for the full design and
// zohoReconciliationService.js's header for why this direct-pool write
// (rather than requiring zohoReconciliationService back) avoids a circular
// dependency — that service itself calls INTO this file to perform
// retries.
const pool = require('../db');
const zohoRetryClassifier = require('./zohoRetryClassifier');
const safeLog = require('./zohoSafeLogger');

function requireIds(workspaceId, whatsappAccountId, contactNumber) {
  if (!workspaceId) throw new Error('workspaceId is required');
  if (!whatsappAccountId) throw new Error('whatsappAccountId is required');
  const normalized = normalizePhone(contactNumber);
  if (!normalized) throw new Error('A valid contactNumber is required');
  return normalized;
}

// ── Phase 8H Part 1 — sync-state bookkeeping helpers ─────────────────────
// All three helpers are best-effort: a failure to WRITE the bookkeeping
// row must never mask or replace the real sync result/error the caller
// (route layer) is waiting on, so every call site below awaits these but
// never lets a bookkeeping error propagate past a caught-and-logged
// no-op. The actual Lead/Note sync result already returned/thrown by this
// file is unaffected either way.

// Reads the row's current attempt_count (0 if no row yet) so
// zohoRetryClassifier.classifyFailure can decide retryable vs.
// exhausted-into-permanent correctly, then upserts the terminal/interim
// outcome. Kept as a single small helper rather than a bare pool.query at
// each call site so the identity/UPSERT shape is defined exactly once.
async function upsertSyncState(workspaceId, whatsappAccountId, contactNumber, fields) {
  const { rows: existingRows } = await pool.query(
    `SELECT attempt_count, max_attempts FROM coexistence.zoho_sync_state
      WHERE workspace_id = $1 AND whatsapp_account_id = $2 AND contact_number = $3`,
    [workspaceId, whatsappAccountId, contactNumber]
  );
  const existing = existingRows[0] || { attempt_count: 0, max_attempts: 8 };
  return { existing };
}

async function recordSyncSuccess(workspaceId, whatsappAccountId, contactNumber, { zohoConnectionId, zohoLeadId }) {
  try {
    await pool.query(
      `INSERT INTO coexistence.zoho_sync_state
         (workspace_id, whatsapp_account_id, zoho_connection_id, zoho_lead_id, contact_number,
          sync_status, failure_type, last_error, attempt_count, next_attempt_at,
          locked_until, locked_by, last_attempt_at, last_success_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, 'completed', NULL, NULL, 1, NOW(), NULL, NULL, NOW(), NOW(), NOW())
       ON CONFLICT ON CONSTRAINT uq_zoho_sync_state_identity DO UPDATE
         SET zoho_connection_id = $3,
             zoho_lead_id = $4,
             sync_status = 'completed',
             failure_type = NULL,
             last_error = NULL,
             attempt_count = coexistence.zoho_sync_state.attempt_count + 1,
             next_attempt_at = NOW(),
             locked_until = NULL,
             locked_by = NULL,
             last_attempt_at = NOW(),
             last_success_at = NOW(),
             completed_at = NOW()`,
      [workspaceId, whatsappAccountId, zohoConnectionId || null, zohoLeadId || null, contactNumber]
    );
    safeLog.info('sync success', { workspaceId, whatsappAccountId, contactNumber, zohoLeadId: zohoLeadId || null });
  } catch (err) {
    safeLog.error('failed to record sync success (non-fatal)', err, { workspaceId, whatsappAccountId });
  }
}

// Phase 8H Part 2 — extraction ran but standard fields aren't COMPLETE yet
// (missing name/place). This is customer-data incompleteness, NEVER a Zoho
// API failure: failure_type stays NULL and sync_status is the dedicated
// 'incomplete' value (see zohoSyncStateSchema.js's header/list), which is
// intentionally absent from the scheduler's claim-query status list, so a
// still-incomplete conversation is never polled/retried in the background.
// Progress instead comes from the very next inbound WhatsApp message
// re-invoking syncConversationToZoho for this same conversation, which
// naturally re-runs extraction; once standard.status flips to COMPLETE that
// same call proceeds straight into Lead creation/update below, no separate
// "resume" path needed. Existing zoho_lead_id/zoho_connection_id on the row
// are left untouched (not part of this UPDATE's SET list) so this can never
// erase a Lead link a prior attempt already recorded.
async function recordIncompleteExtraction(workspaceId, whatsappAccountId, contactNumber, { zohoConnectionId, missingRequiredFields = [], uncertainFields = [] } = {}) {
  try {
    const summary = `Incomplete extraction — missing: ${(missingRequiredFields || []).join(', ') || 'none'}` +
      ((uncertainFields || []).length ? `; uncertain: ${uncertainFields.join(', ')}` : '');
    await pool.query(
      `INSERT INTO coexistence.zoho_sync_state
         (workspace_id, whatsapp_account_id, zoho_connection_id, contact_number,
          sync_status, failure_type, last_error, attempt_count, next_attempt_at,
          locked_until, locked_by, last_attempt_at)
       VALUES ($1, $2, $3, $4, 'incomplete', NULL, $5, 0, NOW(), NULL, NULL, NOW())
       ON CONFLICT ON CONSTRAINT uq_zoho_sync_state_identity DO UPDATE
         SET zoho_connection_id = $3,
             sync_status = 'incomplete',
             failure_type = NULL,
             last_error = $5,
             attempt_count = 0,
             next_attempt_at = NOW(),
             locked_until = NULL,
             locked_by = NULL,
             last_attempt_at = NOW()`,
      [workspaceId, whatsappAccountId, zohoConnectionId || null, contactNumber, summary.slice(0, 500)]
    );
  } catch (writeErr) {
    safeLog.error('failed to record incomplete-extraction state (non-fatal)', writeErr, { workspaceId, whatsappAccountId });
  }
}

// Phase 8I FIX — PART 3: before short-circuiting to "nothing worth
// attaching, full success" (see syncConversationToZoho's
// `if (!hasNoteWorthyContent)` branch below), check whether THIS Lead
// already has an unresolved Note obligation — a prior attempt's
// zoho_lead_notes row still 'pending' or 'failed'. Without this check, a
// retry whose re-run extraction happens to produce no note-worthy fields
// at all (LLM output naturally varies run-to-run, and
// previously-"unmapped" fields can legitimately empty out once the Lead
// already carries them) silently marks the WHOLE sync 'completed' — which
// permanently removes the row from zohoReconciliationService's claim query
// (`sync_status IN ('pending','lead_synced','note_pending')`), orphaning the
// failed Note forever even though no Note was ever actually created in
// Zoho. See zohoNoteService.js's zoho_lead_notes ledger for the source of
// truth this checks against; this function is read-only.
async function hasUnresolvedNoteObligation(workspaceId, whatsappAccountId, zohoLeadId) {
  if (!zohoLeadId) return false;
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM coexistence.zoho_lead_notes
        WHERE workspace_id = $1 AND whatsapp_account_id = $2 AND zoho_lead_id = $3
          AND status IN ('pending', 'failed')
        LIMIT 1`,
      [workspaceId, whatsappAccountId, zohoLeadId]
    );
    return rows.length > 0;
  } catch (err) {
    // Best-effort check only — if it fails, fall back to the OLD (safe
    // side: still-empty-content) behavior rather than blocking the whole
    // sync on a bookkeeping-query error.
    safeLog.error('failed to check unresolved Note obligation (non-fatal)', err, { workspaceId, whatsappAccountId });
    return false;
  }
}

// Lead succeeded, Note failed — the "Lead-success/Note-failure recovery"
// case (spec). Recorded as 'note_pending' (never 'pending') so a future
// retry NEVER re-attempts Lead creation — zohoSyncService.
// syncConversationToZoho's own getLinkedLead check on retry already
// guarantees this independently, but the sync_status itself documents the
// row's actual state for anything inspecting it (e.g. a future admin UI).
async function recordNotePending(workspaceId, whatsappAccountId, contactNumber, { zohoConnectionId, zohoLeadId, err }) {
  try {
    const { existing } = await upsertSyncState(workspaceId, whatsappAccountId, contactNumber);
    const { failureType, retryable } = zohoRetryClassifier.classifyFailure(err, existing);
    const nextAttemptCount = Number(existing.attempt_count || 0) + 1;
    // See zohoRetryClassifier.computeNextAttemptDelayMs's header: only
    // permanent_failure gets pushed effectively "never"; retryable_failure
    // AND reauth_required both get a real, bounded exponential backoff.
    const backoffMs = zohoRetryClassifier.computeNextAttemptDelayMs(failureType, nextAttemptCount);

    await pool.query(
      `INSERT INTO coexistence.zoho_sync_state
         (workspace_id, whatsapp_account_id, zoho_connection_id, zoho_lead_id, contact_number,
          sync_status, failure_type, last_error, attempt_count, next_attempt_at,
          locked_until, locked_by, last_attempt_at)
       VALUES ($1, $2, $3, $4, $5, 'note_pending', $6, $7, 1, NOW() + ($8 || ' milliseconds')::interval,
               NULL, NULL, NOW())
       ON CONFLICT ON CONSTRAINT uq_zoho_sync_state_identity DO UPDATE
         SET zoho_connection_id = $3,
             zoho_lead_id = $4,
             sync_status = 'note_pending',
             failure_type = $6,
             last_error = $7,
             attempt_count = coexistence.zoho_sync_state.attempt_count + 1,
             next_attempt_at = NOW() + ($8 || ' milliseconds')::interval,
             locked_until = NULL,
             locked_by = NULL,
             last_attempt_at = NOW()`,
      [
        workspaceId, whatsappAccountId, zohoConnectionId || null, zohoLeadId || null, contactNumber,
        failureType, String((err && err.message) || 'Zoho Note sync failed').slice(0, 500),
        String(backoffMs),
      ]
    );
    safeLog.warn('note pending / partial success', { workspaceId, whatsappAccountId, contactNumber, zohoLeadId: zohoLeadId || null, failureType, retryable });
  } catch (writeErr) {
    safeLog.error('failed to record note-pending state (non-fatal)', writeErr, { workspaceId, whatsappAccountId });
  }
}

// Whole-pipeline failure (connection resolution / extraction / Lead
// create-or-update itself threw) — no Lead id exists yet for this attempt.
async function recordSyncFailure(workspaceId, whatsappAccountId, contactNumber, err) {
  try {
    const { existing } = await upsertSyncState(workspaceId, whatsappAccountId, contactNumber);
    const { failureType, retryable } = zohoRetryClassifier.classifyFailure(err, existing);
    const nextAttemptCount = Number(existing.attempt_count || 0) + 1;
    // Row stays sync_status='pending' regardless of failureType (so a
    // future manual resync/enqueueSync call always finds a sane row to
    // update), but next_attempt_at is what actually gates automatic
    // reclaiming by the scheduler's claim query
    // (`next_attempt_at <= NOW()`):
    //   - retryable_failure  -> NOW() + bounded exponential backoff.
    //   - reauth_required    -> ALSO NOW() + bounded exponential backoff
    //     (same formula) — a real, calculable future time; it functions as
    //     a cheap periodic self-check until either resetForReauthRecovery()
    //     (called once the connection reconnects) explicitly sets
    //     next_attempt_at back to NOW(), or attempts exhaust.
    //   - permanent_failure  -> effectively "never" (100 years out) — spec
    //     "excluded from the scheduler's claim query" once exhausted/
    //     unfixable-by-retry. A future explicit enqueueSync() (e.g. a user
    //     hitting "retry now") is the only thing that un-blocks it.
    // See zohoRetryClassifier.computeNextAttemptDelayMs for the single
    // source of truth on this.
    const nextStatus = 'pending';
    const delayMs = zohoRetryClassifier.computeNextAttemptDelayMs(failureType, nextAttemptCount);

    await pool.query(
      `INSERT INTO coexistence.zoho_sync_state
         (workspace_id, whatsapp_account_id, contact_number,
          sync_status, failure_type, last_error, attempt_count, next_attempt_at,
          locked_until, locked_by, last_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6, 1, NOW() + ($7 || ' milliseconds')::interval, NULL, NULL, NOW())
       ON CONFLICT ON CONSTRAINT uq_zoho_sync_state_identity DO UPDATE
         SET sync_status = $4,
             failure_type = $5,
             last_error = $6,
             attempt_count = coexistence.zoho_sync_state.attempt_count + 1,
             next_attempt_at = NOW() + ($7 || ' milliseconds')::interval,
             locked_until = NULL,
             locked_by = NULL,
             last_attempt_at = NOW()`,
      [
        workspaceId, whatsappAccountId, contactNumber,
        nextStatus, failureType,
        String((err && err.message) || 'Zoho sync failed').slice(0, 500),
        String(delayMs),
      ]
    );
    safeLog.warn(`sync failure (${failureType})`, { workspaceId, whatsappAccountId, contactNumber, retryable });
  } catch (writeErr) {
    safeLog.error('failed to record sync failure (non-fatal)', writeErr, { workspaceId, whatsappAccountId });
  }
}

/**
 * Syncs one conversation (one WhatsApp number + one contact) to that
 * number's OWN Zoho CRM connection. Never touches any other WhatsApp
 * account's connection, field definitions, or Leads.
 *
 * @param {object} params
 * @param {number|string} params.workspaceId - server-resolved only.
 * @param {number|string} params.whatsappAccountId
 * @param {string} params.contactNumber
 * @param {Array<object>} [params.conversationMessages] - optional
 *   pre-fetched conversation; forwarded to 8D/8F as-is.
 * @param {boolean} [params.persist=true] - whether 8D should persist an
 *   extraction-audit row (forwarded as-is).
 * @param {string} [params.model] - optional Gemini model override.
 * @returns {Promise<object>} see file header for the possible shapes.
 */
async function syncConversationToZoho(params = {}) {
  const { workspaceId, whatsappAccountId, contactNumber, conversationMessages, persist = true, model } = params;
  const normalizedContact = requireIds(workspaceId, whatsappAccountId, contactNumber);

  // Phase 8H Part 1 — wraps the whole pipeline so a failure at ANY step
  // (connection resolution, extraction, Lead create/update) is recorded
  // onto coexistence.zoho_sync_state before being rethrown unchanged —
  // the external return/throw contract of this function is otherwise
  // untouched (see recordSyncFailure above; it never masks the real error).
  let connectionRow;
  try {
    // §3 — resolve THIS number's own connection first (never a fallback to
    // another account's). Throws a clear, already-categorized error
    // (404 no connection / 409 disconnected / 409 reauth_required) before any
    // AI extraction is attempted, so a mis-set-up number never burns an
    // extraction call it can't use.
    connectionRow = await zohoLeadService.resolveConnectionRow(workspaceId, whatsappAccountId);
  } catch (err) {
    await recordSyncFailure(workspaceId, whatsappAccountId, normalizedContact, err);
    throw err;
  }

  // §3/§6 — 8F extraction, scoped to this exact workspace/account/contact
  // and using ONLY that account's active 8E field definitions.
  let extractionResult;
  try {
    extractionResult = await businessFieldExtractionService.extractBusinessFields({
      workspaceId,
      whatsappAccountId,
      contactNumber: normalizedContact,
      conversationMessages,
      persist,
      model,
    });
  } catch (err) {
    await recordSyncFailure(workspaceId, whatsappAccountId, normalizedContact, err);
    throw err;
  }

  const { extraction, standard, business, fieldDefinitions } = extractionResult;

  // §2 — never create/update a Lead on an incomplete extraction. Returned
  // (not thrown) — an incomplete conversation is an expected, non-error
  // outcome the caller needs to display, not a failure.
  if (standard.status !== 'COMPLETE') {
    // Safe logging only — workspaceId/whatsappAccountId/contactNumber
    // identify WHICH conversation, standard.status/missing/uncertain
    // fields explain WHY, and nothing else (no message content, no
    // extracted values, no tokens) ever goes into this line.
    safeLog.info('incomplete extraction — Zoho sync deferred', {
      workspaceId,
      whatsappAccountId,
      contactNumber: normalizedContact,
      standardStatus: standard.status,
      missingRequiredFields: standard.missing_required_fields,
      uncertainFields: standard.uncertain_fields,
    });
    await recordIncompleteExtraction(workspaceId, whatsappAccountId, normalizedContact, {
      zohoConnectionId: connectionRow.id,
      missingRequiredFields: standard.missing_required_fields,
      uncertainFields: standard.uncertain_fields,
    });
    return {
      synced: false,
      reason: 'incomplete_extraction',
      standard,
      business,
      extraction,
      lead: null,
      note: null,
      partial: false,
      noteError: null,
      unmappedFields: [],
      droppedZohoFields: [],
    };
  }

  const { mappedFields, unmappedFields } = mapBusinessFieldsToZoho(business.extracted_fields, fieldDefinitions);

  const leadInput = {
    workspaceId,
    whatsappAccountId,
    contactNumber: normalizedContact,
    name: extraction.name?.value || null,
    place: extraction.place?.value || null,
    email: extraction.email?.value || null,
    interestSummary: extraction.interest_summary || null,
    extraFields: mappedFields,
  };

  // §4 — idempotent create-or-update: read AKChat's own ledger first,
  // never guess/assume a Lead already exists.
  const existingLink = await zohoLeadService.getLinkedLead(workspaceId, whatsappAccountId, normalizedContact);
  let lead;
  try {
    lead = existingLink && existingLink.zohoLeadId
      ? await zohoLeadService.updateLead(leadInput)
      : await zohoLeadService.createLead(leadInput);
  } catch (err) {
    await recordSyncFailure(workspaceId, whatsappAccountId, normalizedContact, err);
    throw err;
  }
  // §6 — anything that never made it onto the Zoho Lead (no zoho_target
  // configured, or Zoho rejected it as unsupported) is preserved here
  // rather than lost.
  const droppedZohoFields = (lead.droppedFields || []).map(({ apiName, value }) => ({
    fieldKey: apiName,
    fieldLabel: apiName,
    value,
  }));
  // ── ZOHO PHASE 8 — FINAL FIX: CONSOLIDATE NOTES ─────────────────────────
  // Instead of assembling one free-text blob and handing it to createNote
  // (which created a brand-new Zoho Note every time the text differed —
  // exactly the "one Note per message" bug this fix removes), this now
  // hands STRUCTURED confirmed fields to zohoNoteService.upsertConversationNote,
  // which maintains exactly ONE consolidated Note per Zoho Lead: it merges
  // newly-confirmed info into whatever the Note already has (never
  // duplicating a line that's already there) and only calls Zoho again
  // when the merged, rendered content actually changed.
  //
  // Only ALREADY-CONFIRMED structured fields ever reach the Note — never
  // raw message text, greetings, or AI replies (spec §4): name/place/email/
  // phone/interest_summary come from 8D/8F's own confirmed extraction, and
  // dynamicNoteFields are exactly the business fields 8F/8G already decided
  // were confirmed-but-unmapped (unmappedFields) or Zoho-rejected
  // (droppedZohoFields) — nothing new is inferred or included here.
  const dynamicNoteFields = [...unmappedFields, ...droppedZohoFields];

  const hasNoteWorthyContent = Boolean(
    (extraction.name?.value && String(extraction.name.value).trim()) ||
    (extraction.place?.value && String(extraction.place.value).trim()) ||
    (extraction.email?.value && String(extraction.email.value).trim()) ||
    (extraction.phone?.value && String(extraction.phone.value).trim()) ||
    (extraction.interest_summary && String(extraction.interest_summary).trim()) ||
    dynamicNoteFields.some((f) => f && f.value !== null && f.value !== undefined && String(f.value).trim())
  );

  const baseResult = {
    synced: true,
    reason: null,
    standard,
    business,
    extraction,
    lead,
    unmappedFields,
    droppedZohoFields,
  };

  if (!hasNoteWorthyContent) {
    // Phase 8I FIX — PART 3: empty content this run is NOT automatically
    // "nothing worth attaching" — it might just be this retry's extraction
    // coming back thinner than the attempt that actually needed a Note. If
    // a prior attempt already claimed a zoho_lead_notes row for this Lead
    // and it never made it to 'synced' (still 'pending'/'failed'), that
    // obligation is still open: declaring full success here would mark
    // sync_status='completed' and permanently remove the row from the
    // reconciliation scheduler's claim query, orphaning the failed Note
    // with nothing in Zoho and nothing left retrying it.
    const unresolvedNote = await hasUnresolvedNoteObligation(workspaceId, whatsappAccountId, lead.zohoLeadId);
    if (unresolvedNote) {
      const err = new Error(
        'A previous Note attempt for this Lead is still unresolved (pending/failed) and this retry\'s extraction produced no note content to (re)submit — keeping the sync open for another attempt rather than declaring it complete.'
      );
      // Phase 8J FIX — Fix 1: this is an internal "keep retrying" signal,
      // not a genuine Zoho/API/validation error — it must never be
      // classified as permanent_failure (see zohoRetryClassifier's matching
      // comment on this exact flag).
      err.zohoForceRetryable = true;
      await recordNotePending(workspaceId, whatsappAccountId, normalizedContact, {
        zohoConnectionId: connectionRow.id,
        zohoLeadId: lead.zohoLeadId,
        err,
      });
      return {
        ...baseResult,
        note: null,
        partial: true,
        noteError: err.message,
      };
    }

    // Nothing worth attaching as a Note this time, and no prior Note
    // attempt is left unresolved for this Lead — Lead sync alone is a
    // full (non-partial) success.
    await recordSyncSuccess(workspaceId, whatsappAccountId, normalizedContact, {
      zohoConnectionId: connectionRow.id,
      zohoLeadId: lead.zohoLeadId,
    });
    return { ...baseResult, note: null, partial: false, noteError: null };
  }
  try {
    // upsertConversationNote maintains exactly ONE consolidated Note per
    // Zoho Lead — it internally merges these newly-confirmed fields into
    // whatever the Note already has and only calls Zoho when the merged,
    // rendered content actually changed (spec §2, §5, §7).
    const note = await zohoNoteService.upsertConversationNote({
      workspaceId,
      whatsappAccountId,
      contactNumber: normalizedContact,
      title: 'AKChat conversation sync',
      name: extraction.name?.value || null,
      location: extraction.place?.value || null,
      email: extraction.email?.value || null,
      phone: extraction.phone?.value || null,
      interest: extraction.interest_summary || null,
      dynamicFields: dynamicNoteFields,
    });
    await recordSyncSuccess(workspaceId, whatsappAccountId, normalizedContact, {
      zohoConnectionId: connectionRow.id,
      zohoLeadId: lead.zohoLeadId,
    });
    return { ...baseResult, note, partial: false, noteError: null };
  } catch (err) {
    // §5 — Lead succeeded, Note failed: clear partial success. The Lead id
    // is never lost (already durably linked via zoho_lead_links above) and
    // the SAME consolidated Note (found again via the fixed idempotency
    // key on the next sync/retry) is retried rather than a new one being
    // created. Phase 8H Part 1 — this state is now durably
    // recorded on coexistence.zoho_sync_state (status='note_pending') so
    // zohoReconciliationScheduler picks it up automatically; the caller
    // still gets the exact same partial-success response shape as before.
    await recordNotePending(workspaceId, whatsappAccountId, normalizedContact, {
      zohoConnectionId: connectionRow.id,
      zohoLeadId: lead.zohoLeadId,
      err,
    });
    return {
      ...baseResult,
      note: null,
      partial: true,
      noteError: err.message || 'Zoho Note sync failed',
    };
  }
}
module.exports = {
  syncConversationToZoho,
  // Phase 8H Part 1 — exported for zohoReconciliationService/tests, not
  // part of the public "run a sync" surface.
  recordSyncSuccess,
  recordNotePending,
  recordSyncFailure,
  recordIncompleteExtraction,
  // Phase 8I FIX Part 3 — exported for focused tests only.
  hasUnresolvedNoteObligation,
};





