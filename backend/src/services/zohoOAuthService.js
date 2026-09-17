// Phase 8B Part 1 — Zoho CRM OAuth 2.0 (authorization-code flow) + signed
// state handling. No routes, no lead sync, no AI extraction here — see
// zohoSchema.js header for the full phase plan.
//
// State pattern mirrors routes/instagram/instagramOAuth.js's signed-JWT
// `state` (purpose/wsId/nonce, jwt.verify enforces expiry+tamper detection)
// but extends it with waId (whatsapp_account_id), since a Zoho connection is
// scoped to a specific WhatsApp account within a workspace (see zohoSchema.js
// header: "A Zoho connection belongs to a specific AKChat WhatsApp account"),
// not just to the workspace as a whole like Instagram's connection is.
//
// Never put access_token / refresh_token / client_secret inside state — it
// only ever carries workspace_id, whatsapp_account_id, a nonce, and an
// expiry (via the JWT's own `exp` claim).

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// Same fallback convention as routes/instagram/instagramOAuth.js — dev never
// hard-crashes over a missing JWT_SECRET, but production should always set
// one explicitly (enforced elsewhere for the encryption key; JWT_SECRET
// itself is validated at process boot by whatever already checks it today).
const JWT_SECRET = process.env.JWT_SECRET || 'AKchat-dev-secret-change-me';

// Single purpose tag for this flow's state tokens, distinct from
// 'ig_oauth_state' (instagramOAuth.js) so a state minted for one OAuth flow
// can never be replayed against the other's callback.
const STATE_PURPOSE = 'zoho_oauth_state';
const STATE_TTL = '10m';

// ── Zoho multi-datacenter endpoint configuration ────────────────────────
// Mirrors the *set* of datacenters zohoSchema.js's ZOHO_DATA_CENTERS check
// constraint allows, but only 'com' / 'eu' / 'in' are wired with concrete
// accounts-server hosts here (per this part's scope — "support at minimum
// com, eu, in"). Adding a new datacenter later is a one-line addition to
// this map, no code changes required elsewhere.
const ZOHO_DATACENTERS = {
  com: { accountsBaseUrl: 'https://accounts.zoho.com', apiBaseUrl: 'https://www.zohoapis.com' },
  eu: { accountsBaseUrl: 'https://accounts.zoho.eu', apiBaseUrl: 'https://www.zohoapis.eu' },
  in: { accountsBaseUrl: 'https://accounts.zoho.in', apiBaseUrl: 'https://www.zohoapis.in' },
};
const DEFAULT_DATACENTER = 'com';

function resolveDatacenter(dc) {
  return ZOHO_DATACENTERS[dc] ? dc : DEFAULT_DATACENTER;
}

function getDatacenterConfig(dc) {
  return ZOHO_DATACENTERS[resolveDatacenter(dc)];
}

// ── State generation / validation ───────────────────────────────────────
// workspaceId + whatsappAccountId are the caller's already-authorized
// values (resolved the same way instagramOAuth.js's /start does: from
// req.workspace after authMiddleware + attachWorkspace, never from
// client-supplied query/body) — this function only signs them, it does not
// itself authorize anything.
function generateState({ workspaceId, whatsappAccountId }) {
  if (!workspaceId) throw new Error('workspaceId is required to generate Zoho OAuth state');
  if (!whatsappAccountId) throw new Error('whatsappAccountId is required to generate Zoho OAuth state');

  return jwt.sign(
    {
      purpose: STATE_PURPOSE,
      wsId: workspaceId,
      waId: whatsappAccountId,
      nonce: crypto.randomBytes(8).toString('hex'),
    },
    JWT_SECRET,
    { expiresIn: STATE_TTL }
  );
}

// Returns { workspaceId, whatsappAccountId } on success, throws on any
// missing/expired/tampered/wrong-purpose/malformed state. jwt.verify itself
// rejects expired tokens (exp claim) and tampered signatures; the explicit
// checks below cover malformed payload shape and wrong purpose, which
// jwt.verify would otherwise accept as a validly-signed-but-wrong token.
function validateState(state) {
  if (!state || typeof state !== 'string') {
    throw new Error('Missing or malformed OAuth state');
  }

  let decoded;
  try {
    decoded = jwt.verify(state, JWT_SECRET);
  } catch (err) {
    throw new Error('Invalid or expired OAuth state');
  }

  if (!decoded || typeof decoded !== 'object') {
    throw new Error('Malformed OAuth state payload');
  }
  if (decoded.purpose !== STATE_PURPOSE) {
    throw new Error('OAuth state has the wrong purpose');
  }
  if (!decoded.wsId || !decoded.waId) {
    throw new Error('OAuth state is missing required fields');
  }

  return { workspaceId: decoded.wsId, whatsappAccountId: decoded.waId };
}

// ── Authorization URL ────────────────────────────────────────────────────
// scope kept broad-but-minimal for Part 1 (foundation only — no Lead/Notes
// module calls exist yet). Later parts can extend this list without
// touching the state/token machinery here.
//
// Phase 8K FIX — Notes scope gap. Part 2 (zohoNoteService.js) added Note
// creation via POST /crm/v2/Leads/{id}/Notes, but this scope list was never
// updated to match: it only ever granted ZohoCRM.modules.leads.ALL (+ org/
// users read), so Zoho was correctly rejecting every Note create call with
// a flat 401 regardless of token validity/freshness — the token simply
// never had permission for the Notes module. Per Zoho's CRM API docs,
// creating a Note requires ZohoCRM.modules.notes.CREATE (or the much
// broader ZohoCRM.modules.ALL, which we deliberately do NOT use — least-
// privilege: this workspace's Zoho integration only ever needs to CREATE
// Notes, never read/update/delete them, so .CREATE is the correct minimal
// grant, not .ALL). Existing Lead/org/users scopes are unchanged/additive
// only. NOTE: this only affects the scope requested on a FRESH OAuth
// consent — any already-connected connection's stored token was issued
// under the old scope list and needs one re-authorize/reconnect pass
// before Notes will actually work for it; this change does not retroactively
// grant the new scope to existing tokens.
const DEFAULT_SCOPES = [
  'ZohoCRM.modules.leads.ALL',
  'ZohoCRM.modules.notes.CREATE',
  'ZohoCRM.org.READ',
  'ZohoCRM.users.READ',
];

function getAuthUrl(state, { dc = DEFAULT_DATACENTER, scopes = DEFAULT_SCOPES } = {}) {
  if (!process.env.ZOHO_CLIENT_ID) throw new Error('ZOHO_CLIENT_ID is not configured');
  if (!process.env.ZOHO_REDIRECT_URI) throw new Error('ZOHO_REDIRECT_URI is not configured');

  const { accountsBaseUrl } = getDatacenterConfig(dc);
  const params = new URLSearchParams({
    scope: scopes.join(','),
    client_id: process.env.ZOHO_CLIENT_ID,
    response_type: 'code',
    access_type: 'offline', // required for Zoho to also issue a refresh_token
    redirect_uri: process.env.ZOHO_REDIRECT_URI,
    prompt: 'consent', // ensures a refresh_token is (re-)issued even on repeat connects
    state,
  });

  return `${accountsBaseUrl}/oauth/v2/auth?${params.toString()}`;
}

// ── Token exchange ────────────────────────────────────────────────────────
// dc is the datacenter the callback was redirected back to (Zoho's
// `accounts-server` query param on the callback identifies this — callers
// resolve it before calling here; see zohoTokenService.js). Falls back to
// DEFAULT_DATACENTER only if the caller genuinely has no better signal yet.
async function exchangeCodeForToken(code, { dc = DEFAULT_DATACENTER } = {}) {
  if (!code) throw new Error('Missing authorization code');
  requireClientCredentials();

  const { accountsBaseUrl } = getDatacenterConfig(dc);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    redirect_uri: process.env.ZOHO_REDIRECT_URI,
    code,
  });

  const resp = await fetch(`${accountsBaseUrl}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await resp.json();

  // Zoho returns HTTP 200 with an {error: '...'} body on failure rather than
  // a non-2xx status for some error cases, so check both.
  if (!resp.ok || data.error) {
    throw new Error(sanitizeZohoError(data) || 'Zoho authorization-code exchange failed');
  }
  if (!data.access_token) {
    throw new Error('Zoho token exchange response missing access_token');
  }

  return data; // { access_token, refresh_token, expires_in, token_type, api_domain, ... }
}

// ── Refresh-failure classification (reauth-loop FIX) ─────────────────────
// A failure calling Zoho's refresh endpoint is NOT automatically proof that
// the stored refresh token itself is invalid/revoked. Before this fix,
// zohoTokenService.refreshConnectionToken treated EVERY failure here
// (network blips, Zoho 5xx outages, rate limiting) identically to a
// genuinely revoked refresh token — marking the connection
// 'reauth_required' and forcing the customer through OAuth again for
// something that had nothing to do with their authorization. Only a
// structured Zoho error response (e.g. `invalid_code`/`invalid_grant`,
// returned for a revoked/expired/consumed refresh token) or a 4xx client
// error genuinely means "this refresh token no longer works" — a 5xx/429 or
// a raw network failure means "try again shortly", never "reconnect".
// Reauth-loop root-cause FIX (runtime-traced): this function used to treat
// ANY Zoho error body (`data.error` truthy, on any non-5xx/429 status) as
// proof the refresh grant itself was invalid. But Zoho's refresh endpoint
// returns a structured `{error: "..."}` body for a range of conditions that
// have nothing to do with the stored refresh token being dead — e.g.
// `access_denied` (transient consent/portal-side hiccup),
// `invalid_client`/config propagation delay right after a client
// secret/redirect change, or other non-4xx-coded error strings Zoho emits
// with a 200/400 status outside the 429/5xx range. Only a small, explicit
// set of error codes actually MEANS "the stored refresh token/grant no
// longer works" per Zoho's OAuth docs: `invalid_code` (code/refresh-token
// value itself rejected) and `invalid_grant` (expired/revoked/already-
// consumed grant). Everything else with an `error` field is classified
// transient — worth retrying, never grounds to force the customer through
// OAuth again.
const GRANT_INVALID_ERROR_CODES = new Set(['invalid_grant', 'invalid_code']);

function classifyRefreshFailure(resp, data) {
  const status = resp?.status;
  if (status === 429 || (typeof status === 'number' && status >= 500)) {
    return { transient: true };
  }
  if (data && typeof data.error === 'string' && GRANT_INVALID_ERROR_CODES.has(data.error)) {
    // Zoho explicitly told us the stored refresh grant itself is dead.
    return { transient: false };
  }
  if (data && data.error) {
    // Some other structured Zoho error (e.g. access_denied, invalid_client,
    // rate-limit-as-200-body) — says nothing definitive about the grant.
    // Be conservative: retry, don't force a reconnect.
    return { transient: true };
  }
  // Anything else unexpected (malformed body, missing fields) — be
  // conservative and do NOT force a reconnect on an ambiguous failure.
  return { transient: true };
}

async function refreshAccessToken(refreshToken, { dc = DEFAULT_DATACENTER } = {}) {
  if (!refreshToken) throw new Error('Missing refresh token');
  requireClientCredentials();

  const { accountsBaseUrl } = getDatacenterConfig(dc);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    refresh_token: refreshToken,
  });

  let resp;
  try {
    resp = await fetch(`${accountsBaseUrl}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (networkErr) {
    // A network-level failure reaching Zoho says nothing about whether the
    // stored refresh token is still valid — never treat this as grounds to
    // force a reconnect.
    const wrapped = new Error('Network error contacting Zoho during token refresh');
    wrapped.transient = true;
    throw wrapped;
  }

  let data;
  try {
    data = await resp.json();
  } catch {
    const err = new Error('Zoho refresh response was not valid JSON');
    err.transient = true;
    throw err;
  }

  if (!resp.ok || data.error) {
    const { transient } = classifyRefreshFailure(resp, data);
    const err = new Error(sanitizeZohoError(data) || 'Zoho refresh-token exchange failed');
    err.transient = transient;
    throw err;
  }
  if (!data.access_token) {
    const err = new Error('Zoho refresh response missing access_token');
    err.transient = true; // unexpected shape — not a confirmed invalid grant
    throw err;
  }

  // Zoho does not always re-issue a refresh_token on refresh — callers must
  // keep the existing one when absent (handled in zohoTokenService.js).
  return data; // { access_token, expires_in, token_type, api_domain, ... }
}

function requireClientCredentials() {
  if (!process.env.ZOHO_CLIENT_ID) throw new Error('ZOHO_CLIENT_ID is not configured');
  if (!process.env.ZOHO_CLIENT_SECRET) throw new Error('ZOHO_CLIENT_SECRET is not configured');
  if (!process.env.ZOHO_REDIRECT_URI) throw new Error('ZOHO_REDIRECT_URI is not configured');
}

// Never let a raw Zoho error payload (which could theoretically echo back
// request params) propagate into logs/responses unexamined — surface only
// the short error code Zoho provides.
function sanitizeZohoError(data) {
  if (!data) return null;
  return typeof data.error === 'string' ? data.error : null;
}

module.exports = {
  STATE_PURPOSE,
  ZOHO_DATACENTERS,
  DEFAULT_DATACENTER,
  resolveDatacenter,
  getDatacenterConfig,
  generateState,
  validateState,
  getAuthUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  classifyRefreshFailure, // exported for focused unit tests only
};
