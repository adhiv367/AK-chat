// Phase 2B — Meta WhatsApp Embedded Signup: Graph API calls.
//
// This is the CONNECTION layer only. It never touches the existing
// send/receive/webhook pipeline (metaSend.js, webhook.js, sendQueue) —
// its only job is: given the `code` + WABA/phone IDs the Embedded Signup
// JS SDK hands back to the frontend, exchange the code server-side for a
// token and confirm what that token can actually see on Meta's side
// before we ever write it to our database.
//
// Reference: Meta's official WhatsApp Embedded Signup flow (Graph API +
// Facebook Login for Business JS SDK, config_id-based). This module makes
// the raw Graph API calls; backend/src/routes/whatsappEmbeddedSignup.js
// orchestrates them and enforces workspace/auth.

const GRAPH_VERSION = process.env.META_API_VERSION || 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

class EmbeddedSignupError extends Error {
  constructor(message, { cause = 'unknown' } = {}) {
    super(message);
    this.name = 'EmbeddedSignupError';
    this.cause = cause; // machine-readable reason, safe to expose to the client
  }
}

function assertConfigured() {
  const { META_APP_ID, META_APP_SECRET, META_WHATSAPP_CONFIG_ID } = process.env;
  if (!META_APP_ID || !META_APP_SECRET || !META_WHATSAPP_CONFIG_ID) {
    throw new EmbeddedSignupError(
      'WhatsApp Embedded Signup is not configured on this server.',
      { cause: 'not_configured' }
    );
  }
}

async function graphGet(path, accessToken) {
  const url = `${GRAPH_BASE}${path}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const text = await resp.text();
  let body = {};
  try { body = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!resp.ok) {
    // Never let a raw Graph API error (which can echo back token fragments
    // in some edge cases) or the token itself reach logs/response.
    const msg = body?.error?.message || 'Meta API request failed';
    throw new EmbeddedSignupError(msg, { cause: 'graph_api_error' });
  }
  return body;
}

/**
 * Exchange the short-lived `code` the Embedded Signup JS SDK callback
 * returns for an access token. Per Meta's Embedded Signup flow (JS SDK,
 * not a redirect-based OAuth flow), no redirect_uri is sent.
 * App Secret never leaves this function — never logged, never returned.
 */
async function exchangeCodeForToken(code) {
  assertConfigured();
  const { META_APP_ID, META_APP_SECRET } = process.env;
  const url = `${GRAPH_BASE}/oauth/access_token`
    + `?client_id=${encodeURIComponent(META_APP_ID)}`
    + `&client_secret=${encodeURIComponent(META_APP_SECRET)}`
    + `&code=${encodeURIComponent(code)}`;
  const resp = await fetch(url);
  const text = await resp.text();
  let body = {};
  try { body = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!resp.ok || !body.access_token) {
    console.error('[embeddedSignup] token exchange failed:', body?.error?.message || text);
    throw new EmbeddedSignupError(
      'Could not complete authorization with Meta. Please try connecting again.',
      { cause: 'token_exchange_failed' }
    );
  }
  return body.access_token; // never logged
}

/**
 * Confirm the WABA is real and the token can see it, and pull its display
 * name + owning Meta Business ID (for our `business_id` column).
 */
async function fetchWabaInfo(wabaId, accessToken) {
  const body = await graphGet(
    `/${encodeURIComponent(wabaId)}?fields=id,name,owner_business_info`,
    accessToken
  );
  return {
    id: body.id,
    name: body.name || null,
    businessId: body.owner_business_info?.id || null,
  };
}

/**
 * List the phone numbers under a WABA, per the access token. Used to
 * cross-check a frontend-supplied phone_number_id actually belongs to the
 * WABA the same token/session claims — we never trust the frontend pairing
 * on its own (see AK_CHAT_PHASE2B brief, section 14).
 */
async function listWabaPhoneNumbers(wabaId, accessToken) {
  const body = await graphGet(
    `/${encodeURIComponent(wabaId)}/phone_numbers?fields=id,display_phone_number,verified_name`,
    accessToken
  );
  return Array.isArray(body.data) ? body.data : [];
}

/**
 * Validate that phoneNumberId genuinely belongs to wabaId under this token,
 * and return its display fields. Throws EmbeddedSignupError if not.
 */
async function verifyAndFetchPhoneNumber(wabaId, phoneNumberId, accessToken) {
  const numbers = await listWabaPhoneNumbers(wabaId, accessToken);
  const match = numbers.find(n => String(n.id) === String(phoneNumberId));
  if (!match) {
    throw new EmbeddedSignupError(
      'That phone number was not found on the authorized WhatsApp Business Account.',
      { cause: 'phone_not_in_waba' }
    );
  }
  return {
    id: match.id,
    displayPhoneNumber: match.display_phone_number || '',
    verifiedName: match.verified_name || '',
  };
}

module.exports = {
  EmbeddedSignupError,
  assertConfigured,
  exchangeCodeForToken,
  fetchWabaInfo,
  listWabaPhoneNumbers,
  verifyAndFetchPhoneNumber,
  GRAPH_VERSION,
};