// Phase 8H Part 1 — Zoho SAFE LOGGING. Zero secrets/tokens in any log line
// this module writes.
//
// Every existing Zoho file already follows a "never log the raw
// token/payload" discipline ad hoc (see zohoLeadService.js's zohoApiError()
// — "never leak the underlying error's internals" — and
// zohoConnectionService.js's serializeConnection() — "Tokens are NEVER
// included, not even masked"). 8H's reconciliation service/scheduler run
// unattended in the background and log considerably more (every claim,
// every attempt, every backoff), so this module centralizes that
// discipline into one place instead of re-deriving it at each call site,
// and adds an actual redaction pass as a second line of defense in case a
// caller accidentally hands it something sensitive.
//
// What this module guarantees:
//   - access_token_encrypted / refresh_token_encrypted / access_token /
//     refresh_token / Authorization headers are NEVER printed, even if
//     present on an object passed to it — redactValue() strips known
//     sensitive keys recursively before anything is serialized.
//   - Log lines are short, structured, and safe to ship to any log
//     aggregator — no raw Zoho response bodies, no raw error stack traces
//     with request internals, no full connection rows.
//   - Every line is prefixed with the same [zoho-sync] tag so 8H logs are
//     greppable/filterable independent of the rest of the app's logs.

// Keys that must NEVER appear in a log line, anywhere in a nested object.
// Matched case-insensitively against the key name itself, not the value —
// deliberately broad (better to over-redact than to leak once).
const SENSITIVE_KEY_PATTERN = /token|secret|authorization|password|refresh|client_secret|access_token|api_key|apikey/i;

const REDACTED = '[REDACTED]';

function redactValue(value, depth = 0) {
  if (depth > 5) return '[TRUNCATED]'; // guard against pathological/circular input
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        out[key] = REDACTED;
      } else {
        out[key] = redactValue(val, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === 'string') {
    // Defense-in-depth: a raw bearer/oauth token string passed positionally
    // (not under a named key) still gets caught if it matches Zoho's own
    // token shape prefixes, without needing a key name to trigger on.
    if (/^1000\.[a-f0-9]{32,}/i.test(value) || /^Zoho-oauthtoken\s/i.test(value)) {
      return REDACTED;
    }
    return value;
  }
  return value;
}

function safeStringify(context) {
  if (context === undefined) return '';
  try {
    return JSON.stringify(redactValue(context));
  } catch {
    return '[unserializable context]';
  }
}

function info(message, context) {
  const ctx = safeStringify(context);
  console.log(`[zoho-sync] ${message}${ctx ? ` ${ctx}` : ''}`);
}

function warn(message, context) {
  const ctx = safeStringify(context);
  console.warn(`[zoho-sync] ${message}${ctx ? ` ${ctx}` : ''}`);
}

// Errors: only ever pass err.message (already sanitized by
// zohoLeadService's zohoApiError / sanitizeZohoErrorMessage upstream where
// applicable) — never err.stack, never a raw Zoho response body, never the
// full Error object (which could carry .zohoDetails with field-level
// payload data).
function error(message, err, context) {
  const errMessage = err instanceof Error ? err.message : String(err || 'unknown error');
  const ctx = safeStringify(context);
  console.error(`[zoho-sync] ${message}: ${redactValue(errMessage)}${ctx ? ` ${ctx}` : ''}`);
}

module.exports = {
  info,
  warn,
  error,
  redactValue,
  safeStringify,
};



