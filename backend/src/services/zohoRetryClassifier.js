// Phase 8H Part 1 — Zoho retry classification + exponential backoff.
//
// Pure logic only (no pool/DB, no fetch) — same reasoning as
// util/sequenceExitRules.js / util/sequenceDelay.js: kept side-effect-free
// so it's trivially unit-testable and so zohoReconciliationService.js can
// import it without pulling in Redis/BullMQ or DB requires.
//
// Reuses the SAME error shape zohoLeadService.js/zohoNoteService.js/
// zohoLeadService.resolveConnectionRow already throw
// (`err.status`, `err.zohoStatus`) rather than inventing a second
// error-classification vocabulary — see zohoLeadService.js's
// zohoApiError()/resolveConnectionRow() for where these fields come from.

// Zoho HTTP statuses that represent a TRANSIENT condition — worth retrying
// with backoff. 401/403 are deliberately excluded here: a 401 that survives
// zohoLeadService.withAccessToken's one refresh-and-retry already gets
// converted to connection status 'reauth_required' by that function, which
// this classifier treats as its own category below (see classifyFailure).
const RETRYABLE_ZOHO_STATUSES = new Set([429, 500, 502, 503, 504]);

// Zoho HTTP statuses that represent a PERMANENT rejection — retrying the
// exact same request will fail the exact same way.
const PERMANENT_ZOHO_STATUSES = new Set([400, 404, 422]);

/**
 * Classifies a thrown error (from zohoSyncService.syncConversationToZoho,
 * zohoLeadService, or zohoNoteService) into one of the three
 * zoho_sync_state.failure_type values, PLUS whether it should still be
 * retried given the row's current attempt_count/max_attempts.
 *
 * @param {Error} err - the caught error. May carry `.status` (an
 *   AKChat-assigned HTTP status, e.g. 404/409 from resolveConnectionRow)
 *   and/or `.zohoStatus` (Zoho's own HTTP status, from zohoApiError()).
 * @param {object} [state] - the zoho_sync_state row (or a plain object with
 *   attempt_count/max_attempts) used to decide if retries are exhausted.
 * @returns {{ failureType: 'retryable_failure'|'permanent_failure'|'reauth_required',
 *             retryable: boolean }}
 */
function classifyFailure(err, state = {}) {
  const attemptCount = Number(state.attempt_count ?? state.attemptCount ?? 0);
  const maxAttempts = Number(state.max_attempts ?? state.maxAttempts ?? 8);

  // ── Phase 8J FIX — Fix 1: forced-retryable internal bookkeeping signal ──
  // Some errors passed in here are not genuine Zoho API/network/validation
  // failures at all — they're synthetic markers zohoSyncService.js raises
  // for internal bookkeeping conditions that must ALWAYS stay open/
  // retryable (e.g. "a prior Note attempt for this Lead is still
  // unresolved and this retry produced no content to resubmit"). Such an
  // error has neither `.status` nor `.zohoStatus` — exactly the same shape
  // as a genuine caller-input validation error — so without an explicit
  // marker it was falling into the "no status fields -> permanent_failure"
  // branch below by coincidence of shape, not intent, pushing
  // next_attempt_at ~100 years out and permanently excluding the row from
  // reconciliation. Callers that need "always retryable" set
  // `err.zohoForceRetryable = true` explicitly rather than this classifier
  // trying to infer intent from shape. This does not change classification
  // for any real Zoho/API/validation error, none of which set this flag.
  if (err && err.zohoForceRetryable) {
    return exhaustionAwareRetry(attemptCount, maxAttempts, 'retryable_failure');
  }

  // ── reauth_required ─────────────────────────────────────────────────
  // Mirrors zoho_connections.status='reauth_required'/'error' and the 409
  // resolveConnectionRow() throws for those statuses (see
  // zohoLeadService.resolveConnectionRow), plus the case where
  // withAccessToken itself already called
  // zohoConnectionService.markReauthRequired after a second 401. None of
  // these can succeed on retry until the user redoes OAuth consent, so
  // this is never subject to attempt_count/backoff — it is excluded from
  // the scheduler's claim query entirely until the connection reconnects
  // (see zohoReconciliationService.resetForReauthRecovery).
  // Reauth-loop root-cause FIX (Task 2 gate): a 401/403 that the caller has
  // explicitly marked `transient` (see zohoLeadService.withAccessToken's
  // second-API-401-after-successful-refresh case) is NOT grant-invalidation
  // evidence — treat it as an ordinary retryable failure instead of forcing
  // this sync_state row into the non-retryable reauth_required bucket.
  if (err && (err.zohoStatus === 401 || err.zohoStatus === 403) && !err.transient) {
    return { failureType: 'reauth_required', retryable: false };
  }
  if (err && (err.zohoStatus === 401 || err.zohoStatus === 403) && err.transient) {
    return exhaustionAwareRetry(attemptCount, maxAttempts, 'retryable_failure');
  }
  if (err && err.status === 409 && /re-?auth/i.test(String(err.message || ''))) {
    return { failureType: 'reauth_required', retryable: false };
  }
  if (err && err.status === 409 && /disconnected/i.test(String(err.message || ''))) {
    return { failureType: 'reauth_required', retryable: false };
  }

  // ── permanent_failure ────────────────────────────────────────────────
  // A rejection the SAME request will hit again unchanged. Includes: Zoho
  // validation errors 8G's field-fallback couldn't resolve (400), a
  // linked Lead deleted on Zoho's side (404 — see zohoLeadService.updateLead
  // "Lead was deleted on Zoho's side out-of-band"), and a malformed-
  // response-shape 422-equivalent.
  if (err && PERMANENT_ZOHO_STATUSES.has(err.zohoStatus)) {
    return { failureType: 'permanent_failure', retryable: false };
  }
  // A caller-input validation error (e.g. requireIds throwing "A valid
  // contactNumber is required") has neither .status nor .zohoStatus and
  // can never succeed on retry either — treat as permanent.
  if (err && !err.status && !err.zohoStatus && err instanceof Error) {
    // Network errors are the one exception: zohoLeadService.callZohoLeadsApi
    // wraps them with zohoStatus = null explicitly (see "Network error
    // contacting Zoho CRM"), which the check above already excludes from
    // this branch by falling through to it — detect that shape here.
    if (err.zohoStatus === null) {
      return exhaustionAwareRetry(attemptCount, maxAttempts, 'retryable_failure');
    }
    return { failureType: 'permanent_failure', retryable: false };
  }

  // ── retryable_failure (default) ─────────────────────────────────────
  // 429/5xx, network failures (zohoStatus === null), and anything else not
  // explicitly classified above default to retryable — per spec, err on
  // the side of giving a transient-looking failure another bounded chance
  // rather than permanently giving up on it.
  return exhaustionAwareRetry(attemptCount, maxAttempts, 'retryable_failure');
}

// Shared by both explicit-retryable branches above: once attempt_count has
// reached max_attempts, a failure that would otherwise be retried is
// reclassified as permanent_failure instead — bounded retry (spec), never
// an infinite loop.
function exhaustionAwareRetry(attemptCount, maxAttempts, failureTypeIfRetrying) {
  if (attemptCount + 1 >= maxAttempts) {
    return { failureType: 'permanent_failure', retryable: false };
  }
  return { failureType: failureTypeIfRetrying, retryable: true };
}

// ── Exponential backoff ───────────────────────────────────────────────────
// Base 30s, doubling per attempt, capped at 1 hour, plus up to 20% jitter
// so many simultaneously-failing rows don't all wake up in the same
// instant and thundering-herd the Zoho API / this process's claim query.
const BASE_BACKOFF_MS = parseInt(process.env.ZOHO_RETRY_BASE_MS || '30000', 10);
const MAX_BACKOFF_MS = parseInt(process.env.ZOHO_RETRY_MAX_MS || String(60 * 60 * 1000), 10);

/**
 * @param {number} attemptCount - the attempt_count value AFTER incrementing
 *   for the attempt that just failed (i.e. how many attempts have now been
 *   made, including this one).
 * @returns {number} milliseconds to wait before next_attempt_at.
 */
function computeBackoffMs(attemptCount) {
  const exponent = Math.max(0, attemptCount - 1);
  const raw = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * (2 ** exponent));
  const jitter = raw * 0.2 * Math.random();
  return Math.round(raw + jitter);
}

// ── Bug fix (Note-sync verification pass) ─────────────────────────────────
// zohoSyncService.js's recordNotePending/recordSyncFailure have always
// called `computeNextAttemptDelayMs(failureType, attemptCount)` (see their
// header comments describing "permanent_failure -> effectively never (100
// years out)" vs. "retryable_failure/reauth_required -> bounded exponential
// backoff") but this composition function was never actually defined here —
// only the plain attemptCount-only computeBackoffMs was. That left every
// call site throwing "computeNextAttemptDelayMs is not a function", which
// upsertSyncState's/recordNotePending's/recordSyncFailure's own
// try/catch silently swallowed as "best-effort, non-fatal" — so
// zoho_sync_state was never actually being written to 'note_pending' or a
// backed-off 'pending' at all. This wrapper is purely additive: it does not
// change classifyFailure's classification rules or computeBackoffMs's
// exponential/jitter formula, it only wires the already-documented
// permanent-vs-retryable distinction those two functions describe but
// never composed.
const PERMANENT_DELAY_MS = 1000 * 60 * 60 * 24 * 365 * 100; // ~100 years
function computeNextAttemptDelayMs(failureType, attemptCount) {
  if (failureType === 'permanent_failure') {
    return PERMANENT_DELAY_MS;
  }
  return computeBackoffMs(attemptCount);
}
module.exports = {
  classifyFailure,
  computeBackoffMs,
  computeNextAttemptDelayMs,
  RETRYABLE_ZOHO_STATUSES,
  PERMANENT_ZOHO_STATUSES,
}