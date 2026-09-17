// Phase 8I — thin wrapper around the Groq API, used ONLY by
// customerExtractionService.js for customer-information extraction.
//
// Mirrors geminiService.js's contract exactly so the caller's error/fallback
// handling needs no changes: never throws — every failure mode (missing key,
// timeout, HTTP error, malformed/empty response) is caught and returned as
// { text: null, error: '<reason>' }.
//
// GROQ_API_KEY is read from process.env only — never hard-coded, never
// logged, never returned to any caller. This file adds no dependency on
// GEMINI_API_KEY and does not touch the existing Gemini reply path.
//
// Uses axios (already a dependency in this codebase) against Groq's
// OpenAI-compatible /chat/completions endpoint, so no new package is
// required.

const axios = require('axios');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
// A Groq-hosted model well suited to reliable structured JSON extraction.
const DEFAULT_MODEL = 'openai/gpt-oss-120b';
const DEFAULT_TIMEOUT_MS = 12000; // kept under automationEngine's 15s node budget

/**
 * Ask Groq a single prompt and return its text response.
 *
 * @param {string} prompt - fully-constructed prompt (customerExtractionService builds this)
 * @param {object} [opts]
 * @param {string} [opts.model] - defaults to DEFAULT_MODEL
 * @param {number} [opts.timeoutMs] - defaults to DEFAULT_TIMEOUT_MS
 * @returns {Promise<{ text: string|null, error: string|null }>}
 */
async function askGroq(prompt, opts = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || !String(apiKey).trim()) {
    return { text: null, error: 'GROQ_API_KEY is not configured' };
  }
  if (!prompt || !String(prompt).trim()) {
    return { text: null, error: 'empty prompt' };
  }

  const modelName = opts.model || DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  try {
    const response = await axios.post(
      GROQ_API_URL,
      {
        model: modelName,
        messages: [{ role: 'user', content: prompt }],
        // The extraction prompt already demands strict JSON; asking the API
        // to enforce a JSON object response is an additional safety net.
        response_format: { type: 'json_object' },
        temperature: 0,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: timeoutMs,
      }
    );

    const text = response?.data?.choices?.[0]?.message?.content;
    if (!text || !String(text).trim()) {
      return { text: null, error: 'Groq returned an empty response' };
    }
    return { text: String(text).trim(), error: null };
  } catch (err) {
    if (err.code === 'ECONNABORTED') {
      return { text: null, error: `Groq request timed out after ${timeoutMs}ms` };
    }
    const status = err?.response?.status;
    if (status === 429) {
      return { text: null, error: 'Groq rate limit/quota exceeded' };
    }
    const message = err?.response?.data?.error?.message || err.message || String(err);
    return { text: null, error: `Groq request failed: ${redactKey(message, apiKey)}` };
  }
}

// Defense-in-depth: strip the literal API key from any error string before
// it can reach logs/execution records, in case an error ever echoes request
// details back.
function redactKey(message, apiKey) {
  if (!message) return 'unknown error';
  if (apiKey && message.includes(apiKey)) {
    return message.split(apiKey).join('[REDACTED]');
  }
  return message;
}

module.exports = {
  askGroq,
};



