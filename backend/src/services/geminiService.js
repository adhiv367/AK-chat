// Thin wrapper around the Gemini API. Never throws — every failure mode
// (missing key, timeout, quota/rate-limit, malformed/empty response, SDK
// error) is caught and returned as { text: null, error: '<reason>' } so
// callers (aiReplyService) can implement fallback behavior without needing
// try/catch of their own.
//
// GEMINI_API_KEY is read from process.env only (populated via dotenv in
// index.js, same as every other credential in this app) — never hard-coded,
// never logged, never returned to any caller.

const DEFAULT_MODEL = 'gemini-1.5-flash';
const DEFAULT_TIMEOUT_MS = 12000; // kept under automationEngine's 15s node budget

// Lazily require the SDK and construct the client only when actually asked
// to make a call — this file must not throw at require-time just because
// the SDK happens to be missing/broken in some environment, since that
// would take down the whole automation engine module graph.
function getClient(apiKey) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  return new GoogleGenerativeAI(apiKey);
}

/**
 * Ask Gemini a single prompt and return its text response.
 *
 * @param {string} prompt - fully-constructed prompt (aiReplyService builds this)
 * @param {object} [opts]
 * @param {string} [opts.model] - defaults to DEFAULT_MODEL
 * @param {number} [opts.timeoutMs] - defaults to DEFAULT_TIMEOUT_MS
 * @returns {Promise<{ text: string|null, error: string|null }>}
 */
async function askGemini(prompt, opts = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !String(apiKey).trim()) {
    return { text: null, error: 'GEMINI_API_KEY is not configured' };
  }
  if (!prompt || !String(prompt).trim()) {
    return { text: null, error: 'empty prompt' };
  }

  const modelName = opts.model || DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  let client;
  let model;
  try {
    client = getClient(apiKey);
    model = client.getGenerativeModel({ model: modelName });
  } catch (err) {
    // Never surface the raw error message if it could conceivably echo the
    // key back (SDK init errors sometimes include the request URL/config) —
    // strip anything that looks like the key itself, defense in depth.
    return { text: null, error: `Gemini client init failed: ${redactKey(err.message, apiKey)}` };
  }

  // The SDK's own request timeout support varies by version, so we don't
  // rely on it — a plain Promise.race against a local timer is simpler and
  // version-proof, and guarantees we never hang past timeoutMs regardless
  // of what the SDK does internally.
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('__gemini_timeout__')), timeoutMs);
  });

  try {
    const result = await Promise.race([
      model.generateContent(prompt),
      timeoutPromise,
    ]);
    clearTimeout(timer);

    const text = result?.response?.text ? result.response.text() : null;
    if (!text || !String(text).trim()) {
      return { text: null, error: 'Gemini returned an empty response' };
    }
    return { text: String(text).trim(), error: null };
  } catch (err) {
    clearTimeout(timer);
    if (err && err.message === '__gemini_timeout__') {
      return { text: null, error: `Gemini request timed out after ${timeoutMs}ms` };
    }
    // Quota/rate-limit errors from the SDK typically surface as HTTP 429 —
    // status may be on err.status or nested under err.response depending on
    // SDK version, so check loosely rather than assuming one shape.
    const status = err?.status || err?.response?.status;
    if (status === 429) {
      return { text: null, error: 'Gemini rate limit/quota exceeded' };
    }
    return { text: null, error: `Gemini request failed: ${redactKey(err.message || String(err), apiKey)}` };
  }
}

// Defense-in-depth: strip the literal API key from any error string before
// it can reach logs/execution records, in case an SDK error ever echoes
// request details back.
function redactKey(message, apiKey) {
  if (!message) return 'unknown error';
  if (apiKey && message.includes(apiKey)) {
    return message.split(apiKey).join('[REDACTED]');
  }
  return message;
}

module.exports = {
  askGemini,
};



