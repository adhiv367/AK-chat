// Phase 8B Part 2 — Zoho CRM OAuth + connection-management ROUTES ONLY.
//
// No Lead creation, no Notes, no AI extraction, no field mapping, no
// automatic sync, no retry engine, no frontend here — see zohoSchema.js
// header for the full phase plan. This file wires the Part 1 services
// (zohoOAuthService / zohoTokenService / zohoConnectionService) into HTTP
// routes; it does not duplicate any of their logic.
//
// Mixed public/private router, same shape as
// routes/instagram/instagramOAuth.js: Zoho redirects the user's raw browser
// back to /callback with no AKChat session cookie attached (cross-site
// top-level redirect), so /callback can never trust req.user/req.workspace
// and this whole router is mounted PUBLICLY in index.js (before the global
// authMiddleware). /connect, /status, /disconnect, and /test instead apply
// authMiddleware + attachWorkspace inline, exactly like instagramOAuth.js's
// /start does — never trusting a workspace/whatsapp-account id supplied by
// the client without that middleware resolving req.user/req.workspace from
// the session first.

const express = require('express');
const router = express.Router();

const { authMiddleware } = require('../../auth');
const { attachWorkspace } = require('../../middleware/workspaceContext');

const zohoOAuthService = require('../../services/zohoOAuthService');
const zohoTokenService = require('../../services/zohoTokenService');
const zohoConnectionService = require('../../services/zohoConnectionService');
const zohoLeadService = require('../../services/zohoLeadService'); // Phase 8C Part 1
const zohoNoteService = require('../../services/zohoNoteService'); // Phase 8C Part 2
const zohoSyncService = require('../../services/zohoSyncService'); // Phase 8G
const zohoReconciliationService = require('../../services/zohoReconciliationService'); // Phase 8H Part 1

// ── Helpers ──────────────────────────────────────────────────────────────

// Maps Zoho's callback `accounts-server` query param (the accounts-server
// origin Zoho actually redirected back from) to our internal dc key, so the
// token exchange hits the SAME datacenter the user authorized against,
// rather than assuming DEFAULT_DATACENTER. Falls back to undefined (lets
// zohoOAuthService apply its own default) when absent/unrecognized.
function dcFromAccountsServer(accountsServer) {
  if (!accountsServer || typeof accountsServer !== 'string') return undefined;
  const entry = Object.entries(zohoOAuthService.ZOHO_DATACENTERS)
    .find(([, cfg]) => cfg.accountsBaseUrl.toLowerCase() === accountsServer.toLowerCase());
  return entry ? entry[0] : undefined;
}

// Datacenter-persistence FIX — companion to dcFromAccountsServer above.
// Zoho's `accounts-server` query param is sometimes absent/unrecognized on
// the callback redirect, but the TOKEN EXCHANGE response's own `api_domain`
// (e.g. "https://www.zohoapis.in") is an equally reliable, always-present
// signal of which datacenter the connection actually lives on. Used as a
// fallback so a connection's zoho_data_center is never guessed as the
// 'com' default when it is actually 'in' (or 'eu', etc.) — see callback
// handler below for why this matters (a wrong DC here makes every future
// refresh/API call target the wrong Zoho region and fail as if the token
// were invalid).
function dcFromApiDomain(apiDomain) {
  if (!apiDomain || typeof apiDomain !== 'string') return undefined;
  const entry = Object.entries(zohoOAuthService.ZOHO_DATACENTERS)
    .find(([, cfg]) => cfg.apiBaseUrl.toLowerCase() === apiDomain.toLowerCase());
  return entry ? entry[0] : undefined;
}

// Lightweight Zoho CRM API call used both to identify the connected org
// right after OAuth (callback) and to prove a stored connection still works
// (test-connection). Never logs/returns the token; never touches Leads.
async function fetchZohoOrg(apiDomain, accessToken) {
  const base = apiDomain || 'https://www.zohoapis.com';
  const resp = await fetch(`${base}/crm/v2/org`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });

  let body = {};
  try { body = await resp.json(); } catch { /* non-JSON error body */ }

  if (resp.status === 401) {
    const err = new Error('Zoho API rejected the access token (401)');
    err.zohoStatus = 401;
    throw err;
  }
  if (resp.status === 429) {
    const err = new Error('Zoho API rate limit exceeded');
    err.zohoStatus = 429;
    throw err;
  }
  if (!resp.ok) {
    const err = new Error(`Zoho API request failed (${resp.status})`);
    err.zohoStatus = resp.status;
    throw err;
  }

  // Zoho's /crm/v2/org returns { org: [ {...} ] }. A user's OAuth grant is
  // always scoped to exactly one CRM org per Zoho's own data model, but
  // treat the array defensively and deterministically take the first entry
  // rather than guessing which of several to prefer — no organization-
  // selection UI exists yet (future phase, per spec).
  const org = Array.isArray(body.org) ? body.org[0] : null;
  return org || null;
}

function safeErrorResponse(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

// Resolves + validates workspaceId/whatsappAccountId for the four
// authenticated routes below. Never trusts a client-supplied workspaceId —
// only req.workspace (attachWorkspace) and an explicitly-passed
// whatsappAccountId that assertWhatsappAccountInWorkspace then verifies.
async function resolveOwnedAccount(req) {
  const workspaceId = req.workspace?.id;
  if (!workspaceId) {
    const err = new Error('No workspace found for this account. Please contact support.');
    err.status = 409;
    throw err;
  }
  const whatsappAccountId = req.query.whatsappAccountId || req.body?.whatsappAccountId;
  if (!whatsappAccountId) {
    const err = new Error('whatsappAccountId is required');
    err.status = 400;
    throw err;
  }
  await zohoConnectionService.assertWhatsappAccountInWorkspace(workspaceId, whatsappAccountId);
  return { workspaceId, whatsappAccountId };
}

// ── 1. CONNECT ───────────────────────────────────────────────────────────
// GET /integrations/zoho/connect?whatsappAccountId=&dc=
// Starts the OAuth flow for a specific WhatsApp account within the caller's
// workspace. Ownership of whatsappAccountId is verified server-side before
// anything is signed into state — never trusted from the browser alone.
router.get('/integrations/zoho/connect', authMiddleware, attachWorkspace, async (req, res) => {
  try {
    const { workspaceId, whatsappAccountId } = await resolveOwnedAccount(req);

    // Idempotent: creates the 'disconnected' row on first connect attempt,
    // returns the existing row on any later attempt (see
    // zohoConnectionService.ensureConnection) — guarantees there is always
    // a row for the callback to atomically update into.
    await zohoConnectionService.ensureConnection(workspaceId, whatsappAccountId, {
      connectedBy: req.user?.id ?? null,
    });

    const state = zohoOAuthService.generateState({ workspaceId, whatsappAccountId });
    const dc = typeof req.query.dc === 'string' ? req.query.dc : undefined;
    const url = zohoOAuthService.getAuthUrl(state, dc ? { dc } : undefined);

    return res.redirect(url);
  } catch (err) {
    console.error('[zoho/connect]', err.message);
    return safeErrorResponse(res, err.status || 500, err.message);
  }
});

// ── 2. OAUTH CALLBACK ────────────────────────────────────────────────────
// GET /integrations/zoho/callback
// PUBLIC — Zoho redirects the raw browser here with no AKChat session.
// Every value used to decide anything is derived from the signed `state`
// (minted by /connect) or freshly re-verified against the DB — never from
// an unauthenticated req.workspace/req.user, which do not exist on this
// request.
router.get('/integrations/zoho/callback', async (req, res) => {
  const { code, state, error: zohoError } = req.query;

  // Zoho appends ?error=access_denied&state=... when the user declines
  // consent on the Zoho screen — never a hard 500, just a safe rejection.
  if (zohoError) {
    return safeErrorResponse(res, 400, `Zoho authorization was denied (${zohoError})`);
  }
  if (!code) {
    return safeErrorResponse(res, 400, 'Missing authorization code');
  }

  let workspaceId, whatsappAccountId;
  try {
    ({ workspaceId, whatsappAccountId } = zohoOAuthService.validateState(state));
  } catch (err) {
    // Covers: missing/malformed state, expired state (jwt exp), tampered
    // signature (jwt.verify failure), and wrong purpose — validateState
    // throws a distinct message for each, all safe to surface as-is (no
    // secrets embedded in these messages).
    return safeErrorResponse(res, 400, err.message);
  }

  try {
    // Re-verify ownership fresh against the DB rather than trusting the
    // state payload alone was still valid by the time the user finished on
    // Zoho's consent screen (account/workspace could have been removed,
    // reassigned, etc. in the interim) — this is the "workspace/account
    // mismatch" rejection the spec calls out explicitly.
    await zohoConnectionService.assertWhatsappAccountInWorkspace(workspaceId, whatsappAccountId);

    const connection = await zohoConnectionService.ensureConnection(workspaceId, whatsappAccountId);

    const dc = dcFromAccountsServer(req.query['accounts-server']);
    let apiDomain;
    try {
      const result = await zohoTokenService.exchangeAndStoreTokens(connection.id, code, { dc });
      apiDomain = result.apiDomain;
    } catch (err) {
      await zohoConnectionService.recordError(workspaceId, whatsappAccountId, err.message);
      return safeErrorResponse(res, 400, 'Zoho authorization-code exchange failed');
    }

    // Reauth-loop FIX — persist the data center + api domain IMMEDIATELY,
    // independent of the best-effort org-identity lookup below. Both values
    // are already fully known from the successful token-exchange response
    // above (api_domain) plus the callback's own accounts-server param — no
    // extra network call required. Previously this was only ever written
    // as a side-effect of the org lookup succeeding, so a flaky/failed org
    // lookup (a SEPARATE network call) left zoho_data_center/zoho_api_domain
    // NULL on an otherwise-successfully-connected row. Every later
    // refresh/API call then fell back to the 'com' default datacenter,
    // which is wrong for e.g. an India-region connection — causing every
    // subsequent call (including token refresh) to fail as if the token
    // were invalid, and the UI to keep demanding reconnection.
    const resolvedDc = dc || dcFromApiDomain(apiDomain);
    try {
      await zohoConnectionService.recordZohoOrgIdentity(workspaceId, whatsappAccountId, {
        zohoApiDomain: apiDomain || null,
        zohoDataCenter: resolvedDc || null,
      });
    } catch (err) {
      console.error('[zoho/callback] failed to persist api domain/data center (non-fatal):', err.message);
    }

    // Org identification (spec §5) — best-effort and fully independent of
    // the datacenter/domain persistence above. Token storage already
    // succeeded, so the connection is genuinely 'connected' regardless of
    // whether this lookup succeeds. Reauth-loop FIX: a failed org lookup
    // (rate limit, transient network issue, momentary Zoho hiccup) must
    // NEVER flip the connection's status away from 'connected' — doing so
    // was the single biggest cause of "Needs reauthentication" appearing
    // right after a customer had just successfully connected.
    try {
      const accessToken = await zohoTokenService.getDecryptedAccessToken(connection.id);
      const org = await fetchZohoOrg(apiDomain, accessToken);
      if (org?.id) {
        await zohoConnectionService.recordZohoOrgIdentity(workspaceId, whatsappAccountId, {
          zohoOrgId: org.id,
        });
      }
    } catch (err) {
      console.error('[zoho/callback] org lookup failed (non-fatal, connection remains connected):', err.message);
    }

    const safeConnection = await zohoConnectionService.getConnection(workspaceId, whatsappAccountId);

    // Phase 8H Part 1 — reauth handling: a fresh, successful OAuth
    // completion means this connection is 'connected' again, so any
    // conversation whose sync was previously blocked with
    // failure_type='reauth_required' is now worth retrying. Best-effort —
    // never lets a bookkeeping failure undo the successful reconnection
    // response above.
    zohoReconciliationService.resetForReauthRecovery(workspaceId, whatsappAccountId).catch((err) => {
      console.error('[zoho/callback] reauth-recovery reset failed (non-fatal):', err.message);
    });

    return res.json({ success: true, connected: true, connection: safeConnection });
  } catch (err) {
    console.error('[zoho/callback]', err.message);
    return safeErrorResponse(res, err.status || 500, 'Zoho connection could not be completed');
  }
});

// ── 3. STATUS ────────────────────────────────────────────────────────────
// GET /integrations/zoho/status?whatsappAccountId=
//
// Stale-response FIX (this phase): this is a GET endpoint whose answer
// changes the moment OAuth completes or a refresh succeeds/fails, and
// Express's default res.json() emits a strong ETag — so without an explicit
// Cache-Control header, a browser (or any intermediary) is allowed to serve
// back a PREVIOUSLY cached body (e.g. one captured mid-reconnect while the
// connection still showed reauth_required) on a later identical GET for the
// same URL, exactly matching "leave the page and reopen it shows stale
// status" even though the DB and this handler's own logic are correct at
// request time. `no-store` forbids any cache (browser or proxy) from ever
// reusing or re-validating a previous response for this URL — every open of
// the WhatsApp Accounts page/card is guaranteed to hit this handler fresh.
router.get('/integrations/zoho/status', authMiddleware, attachWorkspace, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { workspaceId, whatsappAccountId } = await resolveOwnedAccount(req);
    const connection = await zohoConnectionService.getConnection(workspaceId, whatsappAccountId);

    if (!connection) {
      return res.json({ connected: false, status: 'disconnected' });
    }

    return res.json({
      connected: connection.status === 'connected',
      status: connection.status,
      zoho_org_id: connection.zohoOrgId,
      data_center: connection.zohoDataCenter,
      connected_at: connection.connectedAt,
      last_success_at: connection.lastSuccessAt,
      // Reauth-loop FIX: 'error' means "actively connected but a call
      // recently failed" (e.g. a transient/rate-limited /test failure) —
      // it is NOT the same thing as "Zoho rejected the refresh token /
      // authorization was revoked / a required scope is missing", which is
      // exactly what 'reauth_required' means (see zohoSchema.js). Only the
      // latter should ever tell the customer to reconnect.
      needs_reauth: connection.status === 'reauth_required',
    });
  } catch (err) {
    console.error('[zoho/status]', err.message);
    return safeErrorResponse(res, err.status || 500, err.message);
  }
});

// ── 4. DISCONNECT ────────────────────────────────────────────────────────
// POST /integrations/zoho/disconnect { whatsappAccountId }
router.post('/integrations/zoho/disconnect', authMiddleware, attachWorkspace, async (req, res) => {
  try {
    const { workspaceId, whatsappAccountId } = await resolveOwnedAccount(req);
    const connection = await zohoConnectionService.disconnect(workspaceId, whatsappAccountId);
    return res.json({ success: true, connection });
  } catch (err) {
    console.error('[zoho/disconnect]', err.message);
    return safeErrorResponse(res, err.status || 500, err.message);
  }
});

// ── 5. TEST CONNECTION ───────────────────────────────────────────────────
// POST /integrations/zoho/test { whatsappAccountId }
router.post('/integrations/zoho/test', authMiddleware, attachWorkspace, async (req, res) => {
  try {
    const { workspaceId, whatsappAccountId } = await resolveOwnedAccount(req);

    const row = await zohoConnectionService.findConnection(workspaceId, whatsappAccountId);
    if (!row || row.status === 'disconnected') {
      return safeErrorResponse(res, 404, 'No Zoho connection exists for this WhatsApp account');
    }

    let accessToken;
    try {
      accessToken = await zohoTokenService.ensureValidAccessToken(row.id);
    } catch (err) {
      // ensureValidAccessToken already marks reauth_required internally on
      // an actual refresh failure (zohoTokenService.markReauthRequired) —
      // this branch also covers "already reauth_required/error" connections
      // that short-circuit before attempting a refresh at all.
      return safeErrorResponse(res, 409, 'Zoho connection requires re-authentication');
    }

    try {
      await fetchZohoOrg(row.zoho_api_domain, accessToken);
    } catch (err) {
      if (err.zohoStatus === 401) {
        // Access token was valid a moment ago per our own expiry bookkeeping
        // but Zoho rejected it anyway (e.g. revoked mid-session) — one
        // explicit refresh-and-retry, matching zohoTokenService's own
        // reauth_required marking on failure.
        try {
          const refreshed = await zohoTokenService.refreshConnectionToken(row.id);
          await fetchZohoOrg(row.zoho_api_domain, refreshed);
        } catch (refreshErr) {
          return safeErrorResponse(res, 409, 'Zoho connection requires re-authentication');
        }
      } else if (err.zohoStatus === 429) {
        // Transient — never flips the connection's health status away from
        // 'connected' (unlike recordError below), just surfaces the
        // rate-limit to the caller so they can retry.
        return safeErrorResponse(res, 429, 'Zoho API rate limit exceeded — please try again shortly');
      } else {
        await zohoConnectionService.recordError(workspaceId, whatsappAccountId, err.message);
        return safeErrorResponse(res, 502, 'Could not reach Zoho CRM');
      }
    }

    await zohoConnectionService.recordSuccess(workspaceId, whatsappAccountId);
    return res.json({ success: true, status: 'connected' });
  } catch (err) {
    console.error('[zoho/test]', err.message);
    return safeErrorResponse(res, err.status || 500, err.message);
  }
});

// ── Phase 8C Part 2 — structured Lead + Note routes ─────────────────────
//
// Only standard Zoho Lead fields (spec §9) and already-structured input —
// no AI, no inference, no business-specific/custom fields (those are
// explicitly out of scope, see 8E). Every route below resolves
// workspace/whatsapp-account ownership exactly like /connect, /status,
// /disconnect, /test above (authMiddleware + attachWorkspace +
// resolveOwnedAccount — never trusting a client-supplied workspaceId), and
// additionally never trusts a client-supplied Zoho Lead id: the :leadId
// path param is always cross-checked against AKChat's own
// zoho_lead_links ledger (via zohoLeadService.getLinkedLead) before it is
// used for anything.

// Maps a service-layer error (zohoApiError from zohoLeadService/
// zohoNoteService, or a plain thrown Error with .status) to a sanitized,
// never-leaks-raw-Zoho-payload message (spec §10, §11).
function sanitizeZohoErrorMessage(err) {
  if (err.status) return err.message;
  if (err.zohoStatus === 401 || err.zohoStatus === 403) return 'Zoho CRM connection requires re-authentication';
  if (err.zohoStatus === 404) return 'The requested Zoho CRM record was not found';
  if (err.zohoStatus === 429) return 'Zoho CRM rate limit exceeded — please try again shortly';
  if (err.zohoStatus === 400) return 'Zoho CRM rejected the request — please check the submitted details';
  if (err.zohoStatus) return 'Zoho CRM request failed';
  return 'Unexpected error while processing the Zoho CRM request';
}

function statusForZohoError(err) {
  if (err.status) return err.status;
  if (err.zohoStatus === 401 || err.zohoStatus === 403) return 409; // needs reauth
  if (err.zohoStatus === 404) return 404;
  if (err.zohoStatus === 429) return 429;
  if (err.zohoStatus === 400) return 400;
  return 502; // network failure / malformed response / unknown Zoho failure
}

function safeZohoErrorResponse(res, err) {
  return safeErrorResponse(res, statusForZohoError(err), sanitizeZohoErrorMessage(err));
}

function validateContactNumber(body) {
  const { contactNumber } = body || {};
  if (!contactNumber || typeof contactNumber !== 'string' || !contactNumber.trim()) {
    return 'contactNumber is required';
  }
  return null;
}

// ── 6. CREATE LEAD (+ optional Note) ─────────────────────────────────────
// POST /integrations/zoho/leads
// { whatsappAccountId, contactNumber, name, phone, email, place,
//   interestSummary, note?: { title?, content } }
//
// Accepts already-structured/validated data only — no AI extraction, no
// inferred location/interest (spec §6). Passes straight through to
// zohoLeadService rather than duplicating its field-mapping logic.
router.post('/integrations/zoho/leads', authMiddleware, attachWorkspace, async (req, res) => {
  let workspaceId, whatsappAccountId;
  try {
    ({ workspaceId, whatsappAccountId } = await resolveOwnedAccount(req));
  } catch (err) {
    console.error('[zoho/leads:create]', err.message);
    return safeErrorResponse(res, err.status || 500, err.message);
  }

  const { contactNumber, name, phone, email, place, interestSummary, note } = req.body || {};

  const contactError = validateContactNumber(req.body);
  if (contactError) return safeErrorResponse(res, 400, contactError);

  if (note !== undefined && note !== null) {
    if (typeof note !== 'object' || Array.isArray(note) || !note.content || typeof note.content !== 'string' || !note.content.trim()) {
      return safeErrorResponse(res, 400, 'note.content is required when note is supplied');
    }
  }

  let lead;
  try {
    lead = await zohoLeadService.createLead({ workspaceId, whatsappAccountId, contactNumber, name, phone, email, place, interestSummary });
  } catch (err) {
    console.error('[zoho/leads:create]', err.message);
    return safeZohoErrorResponse(res, err);
  }

  if (!note) {
    return res.status(201).json({ success: true, lead });
  }

  // ── Lead + Note flow (spec §4) ──────────────────────────────────────
  // The Lead is already durably created/linked at this point. If Note
  // creation fails, do NOT delete/undo the Lead, and do NOT fail the whole
  // request as an error — return a safe partial-success shape. contactNumber
  // is preserved in the response so a caller can retry just the Note via
  // POST /leads/:leadId/notes without ever risking a second Lead.
  try {
    const noteResult = await zohoNoteService.createNote({
      workspaceId,
      whatsappAccountId,
      contactNumber,
      title: note.title,
      content: note.content,
    });
    return res.status(201).json({ success: true, lead, note: noteResult });
  } catch (err) {
    console.error('[zoho/leads:create:note]', err.message);
    return res.status(207).json({
      success: true,
      partial: true,
      lead,
      note: null,
      noteError: sanitizeZohoErrorMessage(err),
    });
  }
});

// ── 7. UPDATE LEAD ────────────────────────────────────────────────────────
// PUT /integrations/zoho/leads/:leadId
// { whatsappAccountId, contactNumber, name, phone, email, place, interestSummary }
//
// Only fields explicitly supplied are changed (zohoLeadService.buildUpdateFields
// already enforces this — never overwrites existing Zoho values with
// null/empty). :leadId is cross-checked against the workspace+account+
// contact-scoped zoho_lead_links row before any Zoho call is made — a Lead
// belonging to another workspace/account can never be updated (spec §7, §10).
router.put('/integrations/zoho/leads/:leadId', authMiddleware, attachWorkspace, async (req, res) => {
  let workspaceId, whatsappAccountId;
  try {
    ({ workspaceId, whatsappAccountId } = await resolveOwnedAccount(req));
  } catch (err) {
    console.error('[zoho/leads:update]', err.message);
    return safeErrorResponse(res, err.status || 500, err.message);
  }

  const contactError = validateContactNumber(req.body);
  if (contactError) return safeErrorResponse(res, 400, contactError);

  const { contactNumber, name, phone, email, place, interestSummary } = req.body || {};
  const { leadId } = req.params;

  try {
    const existingLink = await zohoLeadService.getLinkedLead(workspaceId, whatsappAccountId, contactNumber);
    if (!existingLink || !existingLink.zohoLeadId) {
      return safeErrorResponse(res, 404, 'No existing Zoho Lead link found for this contact — create one first');
    }
    if (String(existingLink.zohoLeadId) !== String(leadId)) {
      // Never trust a caller-supplied Lead id — it must match the locally
      // linked Lead for this exact workspace/account/contact (spec §7, §10).
      return safeErrorResponse(res, 404, 'Lead not linked to this contact in this workspace/account');
    }

    const result = await zohoLeadService.updateLead({ workspaceId, whatsappAccountId, contactNumber, name, phone, email, place, interestSummary });
    return res.json({ success: true, lead: result });
  } catch (err) {
    console.error('[zoho/leads:update]', err.message);
    return safeZohoErrorResponse(res, err);
  }
});

// ── 8. ADD NOTE TO LEAD ───────────────────────────────────────────────────
// POST /integrations/zoho/leads/:leadId/notes
// { whatsappAccountId, contactNumber, title?, content }
//
// The linked Zoho Lead is resolved through AKChat's lead-link ledger, not
// trusted from :leadId directly — the same cross-check as the UPDATE route
// above (spec §8, §10).
router.post('/integrations/zoho/leads/:leadId/notes', authMiddleware, attachWorkspace, async (req, res) => {
  let workspaceId, whatsappAccountId;
  try {
    ({ workspaceId, whatsappAccountId } = await resolveOwnedAccount(req));
  } catch (err) {
    console.error('[zoho/leads:notes]', err.message);
    return safeErrorResponse(res, err.status || 500, err.message);
  }

  const contactError = validateContactNumber(req.body);
  if (contactError) return safeErrorResponse(res, 400, contactError);

  const { contactNumber, title, content } = req.body || {};
  if (!content || typeof content !== 'string' || !content.trim()) {
    return safeErrorResponse(res, 400, 'content is required');
  }

  const { leadId } = req.params;

  try {
    const existingLink = await zohoLeadService.getLinkedLead(workspaceId, whatsappAccountId, contactNumber);
    if (!existingLink || !existingLink.zohoLeadId) {
      return safeErrorResponse(res, 404, 'No existing Zoho Lead link found for this contact — create one first');
    }
    if (String(existingLink.zohoLeadId) !== String(leadId)) {
      return safeErrorResponse(res, 404, 'Lead not linked to this contact in this workspace/account');
    }

    const note = await zohoNoteService.createNote({ workspaceId, whatsappAccountId, contactNumber, title, content });
    return res.status(201).json({ success: true, note });
  } catch (err) {
    console.error('[zoho/leads:notes]', err.message);
    return safeZohoErrorResponse(res, err);
  }
});

// ── Phase 8G — conversation → Zoho sync routes ───────────────────────────
//
// Every route below resolves ownership exactly like the routes above
// (authMiddleware + attachWorkspace + resolveOwnedAccount — never a
// client-supplied workspaceId). All Zoho/extraction failures are mapped
// through the SAME sanitizeZohoErrorMessage/statusForZohoError helpers
// used by the Lead/Note routes, so error responses stay consistent and
// never leak raw Zoho payloads or secrets.

// ── 9. SYNC CONVERSATION TO ZOHO ──────────────────────────────────────────
// POST /integrations/zoho/sync
// { whatsappAccountId, contactNumber, persist? }
//
// Runs 8F extraction (using this WhatsApp account's own active 8E field
// definitions) and, once the standard fields are complete, creates/updates
// this account's own Zoho Lead + Note. Never falls back to another
// account's connection or field definitions (spec §3).
router.post('/integrations/zoho/sync', authMiddleware, attachWorkspace, async (req, res) => {
  let workspaceId, whatsappAccountId;
  try {
    ({ workspaceId, whatsappAccountId } = await resolveOwnedAccount(req));
  } catch (err) {
    console.error('[zoho/sync]', err.message);
    return safeErrorResponse(res, err.status || 500, err.message);
  }

  const contactError = validateContactNumber(req.body);
  if (contactError) return safeErrorResponse(res, 400, contactError);

  const { contactNumber, persist } = req.body || {};

  try {
    const result = await zohoSyncService.syncConversationToZoho({
      workspaceId,
      whatsappAccountId,
      contactNumber,
      persist: persist === undefined ? undefined : Boolean(persist),
    });

    if (!result.synced) {
      // §2 — incomplete extraction is a safe, informative non-error
      // outcome, not a failure — the caller (e.g. 8I) can show what's
      // still missing.
      return res.status(200).json({ success: true, ...result });
    }

    return res.status(result.partial ? 207 : 200).json({ success: true, ...result });
  } catch (err) {
    console.error('[zoho/sync]', err.message);
    return safeZohoErrorResponse(res, err);
  }
});

// ── 10. SYNC / CONNECTION-AWARE STATUS ────────────────────────────────────
// GET /integrations/zoho/sync-status?whatsappAccountId=&contactNumber=
//
// Connection-aware read of "where does this contact currently stand" —
// combines this account's own connection health with any existing
// zoho_lead_links row for the contact. Never triggers a new sync.
router.get('/integrations/zoho/sync-status', authMiddleware, attachWorkspace, async (req, res) => {
  // Same stale-response FIX as GET /status above — never let a browser/proxy
  // reuse a previously-cached connection-status snapshot for this URL.
  res.set('Cache-Control', 'no-store');
  try {
    const { workspaceId, whatsappAccountId } = await resolveOwnedAccount(req);
    const { contactNumber } = req.query;
    if (!contactNumber || typeof contactNumber !== 'string' || !contactNumber.trim()) {
      return safeErrorResponse(res, 400, 'contactNumber is required');
    }

    const connection = await zohoConnectionService.getConnection(workspaceId, whatsappAccountId);
    const lead = connection ? await zohoLeadService.getLinkedLead(workspaceId, whatsappAccountId, contactNumber) : null;

    return res.json({
      success: true,
      connection: connection
        ? {
            status: connection.status,
            // Reauth-loop FIX — see /status above: only 'reauth_required'
            // ever means "the customer must reconnect via OAuth".
            needsReauth: connection.status === 'reauth_required',
          }
        : { status: 'disconnected', needsReauth: false },
      lead,
    });
  } catch (err) {
    console.error('[zoho/sync-status]', err.message);
    return safeErrorResponse(res, err.status || 500, err.message);
  }
});

// ── 11. RECONCILIATION STATE (Phase 8H Part 1) ───────────────────────────
// GET /integrations/zoho/reconciliation-state?whatsappAccountId=&contactNumber=
//
// Read-only view of the durable retry-queue row (coexistence.zoho_sync_state)
// for one conversation — distinct from /sync-status (which reflects
// zoho_lead_links/connection health only): this shows the RETRY bookkeeping
// itself (attempt_count, failure_type, next_attempt_at) so a future admin/
// support surface can see why a conversation hasn't synced yet without
// querying the DB directly. Never triggers a sync or a retry.
router.get('/integrations/zoho/reconciliation-state', authMiddleware, attachWorkspace, async (req, res) => {
  try {
    const { workspaceId, whatsappAccountId } = await resolveOwnedAccount(req);
    const { contactNumber } = req.query;
    if (!contactNumber || typeof contactNumber !== 'string' || !contactNumber.trim()) {
      return safeErrorResponse(res, 400, 'contactNumber is required');
    }

    const state = await zohoReconciliationService.getSyncState(workspaceId, whatsappAccountId, contactNumber);
    return res.json({
      success: true,
      state: state
        ? {
            syncStatus: state.sync_status,
            failureType: state.failure_type,
            attemptCount: state.attempt_count,
            maxAttempts: state.max_attempts,
            nextAttemptAt: state.next_attempt_at,
            lastAttemptAt: state.last_attempt_at,
            lastSuccessAt: state.last_success_at,
            completedAt: state.completed_at,
            // last_error is included here (unlike token/secret fields —
            // see zohoSafeLogger.js) because it is an already-sanitized
            // message the SAME code paths already surface to the caller of
            // /sync itself (noteError / thrown err.message) — never a raw
            // token or Zoho payload.
            lastError: state.last_error,
          }
        : null,
    });
  } catch (err) {
    console.error('[zoho/reconciliation-state]', err.message);
    return safeErrorResponse(res, err.status || 500, err.message);
  }
});

module.exports = { router };

