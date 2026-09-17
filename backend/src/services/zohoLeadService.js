// Phase 8C Part 1 — Zoho CRM Lead create/update on ALREADY STRUCTURED input.
//
// No AI extraction, no automatic sync-from-message, no business-specific
// fields, no retry queue here — see zohoSchema.js header for the full phase
// plan. This service is the CRM-operations layer only: it receives
// structured/validated data (workspaceId, whatsappAccountId, contactNumber,
// name, place, phone, email, interestSummary) and turns it into a Zoho CRM
// Lead, reusing every existing Zoho building block:
//
//   - zohoConnectionService  -> resolve + own the workspace/account's
//                                Zoho connection (isolation boundary)
//   - zohoTokenService       -> ensureValidAccessToken() for a live,
//                                never-expired access token
//   - zohoOAuthService       -> ZOHO_DATACENTERS apiBaseUrl fallback when a
//                                connection has no zoho_api_domain yet
//   - contactSyncService     -> normalizePhone() — the SAME phone
//                                normalization convention already used by
//                                contacts.js/contactSyncService.js, so
//                                +919999999999 and 919999999999 never
//                                become two different AKChat identities
//   - coexistence.zoho_lead_links (Phase 8A) -> the idempotency table.
//     Its existing UNIQUE(workspace_id, whatsapp_account_id, contact_number)
//     constraint (zohoSchema.js) is exactly the identity this phase's spec
//     calls for — no schema change was needed for Part 1.
//
// ── Identity / idempotency design (spec §6, §9) ─────────────────────────
// workspace_id + whatsapp_account_id + normalized contact_number is the one
// AKChat-side identity that maps to at most one zoho_lead_id. Concurrent
// create requests are resolved with a single atomic
// `INSERT ... ON CONFLICT ON CONSTRAINT uq_zoho_lead_links_identity DO
// NOTHING RETURNING *` — the DB constraint itself is the lock, not a
// SELECT-then-INSERT race (spec §9B). Whichever request's INSERT actually
// lands owns the Zoho API call; the loser(s) see zero rows back and fall
// through to "read the winner's row" below.
//
// ── Unavoidable external-consistency limitation (spec §12) ──────────────
// This is a two-system write (AKChat DB + Zoho CRM) with no distributed
// transaction between them:
//   1) If the Zoho Lead create call succeeds but the immediately-following
//      zoho_lead_links UPDATE (writing zoho_lead_id + status='synced')
//      fails/crashes, the link row is left claimed-but-unsynced (zoho_lead_id
//      still NULL, status='pending'). A caller that retries will see that
//      pending row (not a fresh INSERT — the unique constraint already owns
//      the identity) and, per Part 1 scope, that retry is rejected with a
//      clear "already in progress" error rather than silently creating a
//      second Zoho Lead. Reconciling a truly stuck pending row (e.g. after a
//      crash) is a retry-queue concern explicitly deferred to a later phase
//      (spec §12 "Do not implement a full retry engine yet").
//   2) If a zoho_lead_links row says synced with a zoho_lead_id, but that
//      Lead was deleted on Zoho's side out-of-band, this phase cannot detect
//      that until the next update attempt receives Zoho's 404 for that Lead
//      ID (handled explicitly below — see UPDATE flow "Lead not found").
//      Part 1 surfaces that 404 as a clear error; it does not auto-recreate
//      the Lead, since silently creating a replacement Lead the operator
//      didn't ask for is a bigger risk than a clear, actionable error.

const pool = require('../db');
const zohoConnectionService = require('./zohoConnectionService');
const zohoTokenService = require('./zohoTokenService');
const { ZOHO_DATACENTERS, DEFAULT_DATACENTER } = require('./zohoOAuthService');
const { normalizePhone } = require('./contactSyncService');

// ── Name handling (spec §4) ──────────────────────────────────────────────
// Zoho CRM Leads require Last_Name. Never invent a surname. "Ravi Kumar" ->
// First_Name=Ravi, Last_Name=Kumar (last whitespace-separated token is the
// surname, everything before it is the first name). A single token (e.g.
// "Kumar") safely becomes Last_Name alone, with no First_Name guessed.
function splitName(rawName) {
  const name = (rawName || '').trim().replace(/\s+/g, ' ');
  if (!name) return { firstName: null, lastName: null };

  const parts = name.split(' ');
  if (parts.length === 1) {
    return { firstName: null, lastName: parts[0] };
  }
  return {
    firstName: parts.slice(0, -1).join(' '),
    lastName: parts[parts.length - 1],
  };
}

// ── Structured-input -> standard Zoho Lead field mapping (spec §4) ──────
// Only standard fields for Part 1 — no custom/business fields (spec §13).
function buildLeadFields({ name, place, phone, email, interestSummary, contactNumber, extraFields }) {
  const { firstName, lastName } = splitName(name);

  const fields = {
    // Phase 8G — dynamic business fields (already mapped to Zoho api names
    // via zohoFieldMappingService) go in FIRST so the standard fields below
    // always win on any key collision — a misconfigured zoho_target must
    // never be able to overwrite the customer's actual name/phone/etc.
    ...(extraFields || {}),
    // Zoho requires SOME Last_Name. If no usable name was supplied at all,
    // fall back to the WhatsApp number itself rather than inventing a fake
    // customer name (spec §4 "Do not invent fake customer names").
    Last_Name: lastName || contactNumber,
  };
  if (firstName) fields.First_Name = firstName;
  if (place) fields.City = place;
  if (email) fields.Email = email;
  if (interestSummary) fields.Description = interestSummary;

  // Phone/Mobile: both point at the same normalized WhatsApp-derived
  // number unless a distinct `phone` value was explicitly supplied.
  const phoneValue = phone || contactNumber;
  if (phoneValue) {
    fields.Phone = phoneValue;
    fields.Mobile = phoneValue;
  }

  return fields;
}

// Only include fields the caller actually supplied on an UPDATE (spec §8
// "Do not overwrite valid existing customer information with null/empty
// values. Only update fields that are actually supplied.").
function buildUpdateFields({ name, place, phone, email, interestSummary, extraFields }) {
  // Phase 8G — same precedence rule as buildLeadFields: dynamic fields
  // first, standard fields (only the ones actually supplied) applied on
  // top so they always win on a key collision.
  const fields = { ...(extraFields || {}) };

  if (name !== undefined && name !== null && String(name).trim() !== '') {
    const { firstName, lastName } = splitName(name);
    if (lastName) fields.Last_Name = lastName;
    if (firstName) fields.First_Name = firstName;
  }
  if (place !== undefined && place !== null && String(place).trim() !== '') {
    fields.City = place;
  }
  if (email !== undefined && email !== null && String(email).trim() !== '') {
    fields.Email = email;
  }
  if (interestSummary !== undefined && interestSummary !== null && String(interestSummary).trim() !== '') {
    fields.Description = interestSummary;
  }
  if (phone !== undefined && phone !== null && String(phone).trim() !== '') {
    fields.Phone = phone;
    fields.Mobile = phone;
  }

  return fields;
}

// ── Zoho CRM Leads HTTP calls ────────────────────────────────────────────
// Same request shape as routes/zoho.js's fetchZohoOrg (Authorization:
// Zoho-oauthtoken <token>). apiDomain preferred (the exact host Zoho issued
// at OAuth/refresh time); falls back to the datacenter's static apiBaseUrl
// only when a connection has no zoho_api_domain recorded yet.
function resolveApiBase(connectionRow) {
  if (connectionRow.zoho_api_domain) return connectionRow.zoho_api_domain;
  const dc = ZOHO_DATACENTERS[connectionRow.zoho_data_center] ? connectionRow.zoho_data_center : DEFAULT_DATACENTER;
  return ZOHO_DATACENTERS[dc].apiBaseUrl;
}

// Wraps a Zoho CRM API error into a sanitized (never-raw-payload) Error with
// a `zohoStatus` (spec §10) so callers can react (e.g. reauth on 401).
function zohoApiError(status, code) {
  const err = new Error(`Zoho CRM API request failed (${status}${code ? `: ${code}` : ''})`);
  err.zohoStatus = status;
  return err;
}

async function callZohoLeadsApi(connectionRow, accessToken, { method, path, body }) {
  const base = resolveApiBase(connectionRow);
  let resp;
  try {
    resp = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // Network failure — never leak the underlying error's internals.
    const wrapped = new Error('Network error contacting Zoho CRM');
    wrapped.zohoStatus = null;
    throw wrapped;
  }

  let data = null;
  try {
    data = await resp.json();
  } catch {
    // Malformed/non-JSON response body.
    if (!resp.ok) throw zohoApiError(resp.status);
    const err = new Error('Zoho CRM returned a malformed response');
    err.zohoStatus = resp.status;
    throw err;
  }

  if (resp.status === 401) throw zohoApiError(401, 'unauthorized');
  if (resp.status === 403) throw zohoApiError(403, 'permission_denied');
  if (resp.status === 404) throw zohoApiError(404, 'not_found');
  if (resp.status === 429) throw zohoApiError(429, 'rate_limited');
  if (!resp.ok) {
    // Zoho v2 Leads API reports validation errors (missing/invalid field,
    // etc.) inside a 2xx-or-non-2xx `data[]` array — surface only the short
    // `code`, never the raw payload (spec §10 "sanitize errors").
    const firstEntry = Array.isArray(data?.data) ? data.data[0] : null;
    throw zohoApiError(resp.status, firstEntry?.code || data?.code);
  }

  // Zoho v2 wraps both create/update responses as { data: [ { ... } ] } —
  // a per-record status lives INSIDE that entry even on an overall-2xx
  // response, so it must be checked explicitly.
  const entry = Array.isArray(data?.data) ? data.data[0] : null;
  if (!entry) {
    const err = new Error('Zoho CRM returned an unexpected response shape');
    err.zohoStatus = resp.status;
    throw err;
  }
  if (entry.status === 'error') {
    if (entry.code === 'INVALID_TOKEN') throw zohoApiError(401, entry.code);
    if (entry.code === 'RECORD_NOT_FOUND') throw zohoApiError(404, entry.code);
    // Phase 8G — per-field validation errors (unsupported/invalid custom
    // field, or a mandatory field this account's Zoho plan doesn't expose)
    // carry the offending field's api_name in `details`, which the 8G
    // fallback-on-INVALID_DATA retry (see submitLeadWithFieldFallback)
    // needs in order to drop just that field rather than failing the
    // whole Lead. Never surfaced to the client as-is — always re-wrapped
    // by sanitizeZohoErrorMessage at the route layer.
    const err = zohoApiError(400, entry.code);
    err.zohoDetails = entry.details || null;
    throw err;
  }

  return entry; // { code: 'SUCCESS', details: { id, ... }, status: 'success' }
}

async function createZohoLead(connectionRow, accessToken, fields) {
  const entry = await callZohoLeadsApi(connectionRow, accessToken, {
    method: 'POST',
    path: '/crm/v2/Leads',
    body: { data: [fields] },
  });
  return entry.details?.id;
}

async function updateZohoLead(connectionRow, accessToken, zohoLeadId, fields) {
  await callZohoLeadsApi(connectionRow, accessToken, {
    method: 'PUT',
    path: `/crm/v2/Leads/${encodeURIComponent(zohoLeadId)}`,
    body: { data: [{ id: zohoLeadId, ...fields }] },
  });
}

// ── Phase 8G — unsupported/invalid custom field fallback ────────────────
// A workspace's 8E field definitions can declare a zoho_target that later
// turns out not to exist on that particular Zoho org/plan (spec §6 "Never
// assume custom fields exist in Zoho... unsupported/unavailable Zoho
// custom fields must not fail the whole Lead"). This wraps a single
// create/update attempt: on a per-field INVALID_DATA rejection naming the
// offending api_name, that field is dropped and the SAME call is retried
// without it — up to `fields.length` times, so at most one field is ever
// dropped per attempt and a run can never loop forever. A rejection that
// does NOT name a specific field (e.g. a genuinely invalid value on a
// standard/mandatory field) is not something this fallback can safely work
// around and is re-thrown as-is (spec: Lead validation failures must still
// surface clearly, only *unsupported fields* get this treatment).
//
// `attempt(currentFields)` performs one create-or-update call and must
// throw the same zohoApiError shape callZohoLeadsApi produces (with
// `.zohoDetails.api_name` when applicable).
async function withFieldFallback(fields, attempt) {
  let currentFields = { ...fields };
  const droppedFields = [];
  const maxAttempts = Math.max(1, Object.keys(currentFields).length + 1);

  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      const result = await attempt(currentFields);
      return { result, droppedFields };
    } catch (err) {
      const offendingField = err.zohoStatus === 400 && err.zohoDetails && err.zohoDetails.api_name;
      if (!offendingField || !(offendingField in currentFields)) {
        throw err;
      }
      droppedFields.push({ apiName: offendingField, value: currentFields[offendingField] });
      const { [offendingField]: _removed, ...rest } = currentFields;
      currentFields = rest;
    }
  }
  // Exhausted every field without a clean success — surface the last
  // rejection rather than silently giving up.
  return attempt(currentFields).then((result) => ({ result, droppedFields }));
}

async function getZohoLead(connectionRow, accessToken, zohoLeadId) {
  return callZohoLeadsApi(connectionRow, accessToken, {
    method: 'GET',
    path: `/crm/v2/Leads/${encodeURIComponent(zohoLeadId)}`,
  });
}

// ── Access-token resolution with one retry-after-refresh ────────────────
// zohoTokenService.ensureValidAccessToken already refreshes a
// stale/near-expiry token before returning; this additionally retries ONCE
// if Zoho itself rejects the (supposedly valid) token with 401 — covers a
// token revoked/invalidated on Zoho's side between our expiry check and the
// actual call. A second 401 is treated as permanent (reauth_required).
async function withAccessToken(workspaceId, whatsappAccountId, connectionRow, fn) {
  let accessToken = await zohoTokenService.ensureValidAccessToken(connectionRow.id);
  try {
    return await fn(accessToken);
  } catch (err) {
    if (err.zohoStatus === 401) {
      try {
        accessToken = await zohoTokenService.refreshConnectionToken(connectionRow.id);
      } catch (refreshErr) {
        throw refreshErr; // already marked reauth_required by the token service
      }
      // Domain-staleness FIX (root cause of "Connected -> Needs
      // reauthentication" flips reported against a live DB row whose
      // status was actually 'connected'): refreshConnectionToken() just
      // persisted whatever zoho_api_domain Zoho returned with the new
      // access token, which can legitimately differ from the value this
      // connectionRow was loaded with earlier in the request (e.g. it was
      // NULL/stale/wrong-datacenter beforehand). Every call below this
      // point closes over the SAME connectionRow object passed in by our
      // caller (createLead/updateLead) — without refreshing it here, the
      // retry sends a perfectly valid new token to the WRONG Zoho host,
      // draws a second 401 that has nothing to do with the grant itself,
      // and the catch below then wrongly marks the connection permanently
      // reauth_required. Mutating the row in place (rather than returning
      // a new one) means callZohoLeadsApi's resolveApiBase(connectionRow)
      // picks up the corrected domain automatically on the retry.
      //
      // The same fresh read also gives us a baseline for the
      // concurrent-refresh-race FIX below: freshRow.access_token_encrypted
      // is exactly the ciphertext our OWN refreshConnectionToken() call
      // just wrote — if a sibling request (another webhook, or the
      // reconciliation scheduler) refreshes this same connection again
      // before our retry below runs, that ciphertext will have moved on
      // again by the time we check it, which is how we tell "we lost a
      // race" apart from "the grant is genuinely dead".
      let tokenAfterOurRefresh = null;
      try {
        const freshRow = await zohoConnectionService.getConnectionRowByOwnership(workspaceId, whatsappAccountId);
        if (freshRow && freshRow.zoho_api_domain) {
          connectionRow.zoho_api_domain = freshRow.zoho_api_domain;
        }
        tokenAfterOurRefresh = freshRow ? freshRow.access_token_encrypted : null;
      } catch (lookupErr) {
        // Best-effort only — if this fails we simply retry with whatever
        // domain we already had, same as before this fix.
      }
      try {
        return await fn(accessToken);
      } catch (retryErr) {
        if (retryErr.zohoStatus === 401) {
          // Reauth-loop root-cause FIX (Task 2 gate): a second 401 right
          // after a successful token refresh is NOT, by itself, evidence
          // the OAuth grant is invalid — refreshConnectionToken() already
          // succeeded moments ago, which is the strongest signal Zoho has
          // that the stored refresh token/grant is fine. A second API-level
          // 401 here can come from: a concurrent refresh elsewhere rotating
          // the access token again (existing race check below), Zoho-side
          // access-token propagation lag across their edge/cache layer
          // immediately after issuance, or a transient per-request auth
          // hiccup — none of which mean "customer must reconnect". The
          // centralized rule (see zohoOAuthService.classifyRefreshFailure)
          // is: only an explicit invalid_grant/invalid_code from the OAuth
          // *refresh* endpoint itself proves the grant is dead. This path
          // never saw such evidence — the refresh call succeeded — so it
          // must never call markReauthRequired. Log for diagnostics only,
          // and let the retry classifier's normal retryable-failure path
          // (429/5xx-style backoff, not reauth) handle the retry.
          let raceDetected = false;
          try {
            const latest = await zohoConnectionService.getConnectionRowByOwnership(workspaceId, whatsappAccountId);
            if (latest && tokenAfterOurRefresh && latest.access_token_encrypted !== tokenAfterOurRefresh) {
              raceDetected = true;
            }
          } catch (checkErr) {
            // Best-effort only — absence of proof of a race is not proof
            // of a dead grant either; we still never reauth here.
          }
          // eslint-disable-next-line no-console
          console.log('[zoho-auth] reauth decision: skip (second API 401 post-refresh is not grant evidence)', {
            workspaceId,
            whatsappAccountId,
            connectionId: connectionRow.id,
            raceDetected,
          });
          retryErr.transient = true; // never demand reconnect for this condition
        }
        throw retryErr;
      }

    }
    throw err;
  }
}

// ── Connection resolution (spec §11 — organization isolation) ───────────
// Always resolves through zohoConnectionService, which itself asserts the
// WhatsApp account belongs to the workspace before returning anything —
// there is no path here that can cross workspace/account boundaries.
async function resolveConnectionRow(workspaceId, whatsappAccountId) {
  const connection = await zohoConnectionService.findConnection(workspaceId, whatsappAccountId);
  if (!connection) {
    const err = new Error('No Zoho CRM connection found for this WhatsApp account');
    err.status = 404;
    throw err;
  }
  if (connection.status === 'disconnected') {
    const err = new Error('Zoho CRM connection is disconnected for this WhatsApp account');
    err.status = 409;
    throw err;
  }
  if (connection.status === 'error' || connection.status === 'reauth_required') {
    const err = new Error('Zoho CRM connection requires re-authentication');
    err.status = 409;
    throw err;
  }
  return connection;
}

function requireIds(workspaceId, whatsappAccountId, contactNumber) {
  if (!workspaceId) throw new Error('workspaceId is required');
  if (!whatsappAccountId) throw new Error('whatsappAccountId is required');
  const normalized = normalizePhone(contactNumber);
  if (!normalized) throw new Error('A valid contactNumber is required');
  return normalized;
}

// Safe result shape — never includes tokens or raw Zoho payloads.
function serializeLeadLink(row, { created, droppedFields } = {}) {
  return {
    zohoLeadId: row.zoho_lead_id,
    status: row.status,
    contactNumber: row.contact_number,
    workspaceId: row.workspace_id,
    whatsappAccountId: row.whatsapp_account_id,
    lastSyncedAt: row.last_synced_at,
    created: Boolean(created),
    // Phase 8G — fields the caller asked to sync (via extraFields) that
    // Zoho rejected as unsupported/invalid on THIS org/plan and which were
    // therefore dropped from the Lead payload rather than failing the
    // whole request. Empty unless withFieldFallback actually had to drop
    // something. Callers (zohoSyncService) fold these into the Note.
    droppedFields: Array.isArray(droppedFields) ? droppedFields : [],
  };
}

// ── CREATE (or return-existing) flow (spec §7) ──────────────────────────
async function createLead(input) {
  const { workspaceId, whatsappAccountId, contactNumber } = input;
  const normalizedNumber = requireIds(workspaceId, whatsappAccountId, contactNumber);

  const connectionRow = await resolveConnectionRow(workspaceId, whatsappAccountId);

  // Atomic claim: the UNIQUE(workspace_id, whatsapp_account_id,
  // contact_number) constraint is the concurrency guard (spec §9B), not a
  // SELECT-then-INSERT race.
  const { rows: claimedRows } = await pool.query(
    `INSERT INTO coexistence.zoho_lead_links
       (workspace_id, whatsapp_account_id, zoho_connection_id, contact_number, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT ON CONSTRAINT uq_zoho_lead_links_identity DO NOTHING
     RETURNING *`,
    [workspaceId, whatsappAccountId, connectionRow.id, normalizedNumber]
  );

  if (claimedRows.length === 0) {
    // Another request already owns this identity — never create a second
    // Zoho Lead (spec §6, §9A).
    const { rows: existingRows } = await pool.query(
      `SELECT * FROM coexistence.zoho_lead_links
        WHERE workspace_id = $1 AND whatsapp_account_id = $2 AND contact_number = $3`,
      [workspaceId, whatsappAccountId, normalizedNumber]
    );
    const existing = existingRows[0];
    if (existing.zoho_lead_id) {
      return serializeLeadLink(existing, { created: false });
    }
    // A create is already in flight (or previously crashed mid-flight) for
    // this identity — see file header's external-consistency note. Part 1
    // does not attempt to resolve this automatically.
    const err = new Error('A Zoho Lead creation for this contact is already in progress or previously failed before linking. Retry later or use the update flow once a zoho_lead_id exists.');
    err.status = 409;
    throw err;
  }

  const claimed = claimedRows[0];
  const fields = buildLeadFields({ ...input, contactNumber: normalizedNumber });

  let zohoLeadId;
  let droppedFields = [];
  try {
    ({ result: zohoLeadId, droppedFields } = await withAccessToken(workspaceId, whatsappAccountId, connectionRow, (accessToken) =>
      withFieldFallback(fields, (currentFields) => createZohoLead(connectionRow, accessToken, currentFields))
    ));
  } catch (err) {
    await pool.query(
      `UPDATE coexistence.zoho_lead_links
          SET status = 'failed', last_error = $2, updated_at = NOW()
        WHERE id = $1`,
      [claimed.id, String(err.message || 'Zoho Lead creation failed').slice(0, 500)]
    );
    throw err;
  }

  if (!zohoLeadId) {
    await pool.query(
      `UPDATE coexistence.zoho_lead_links
          SET status = 'failed', last_error = $2, updated_at = NOW()
        WHERE id = $1`,
      [claimed.id, 'Zoho did not return a Lead id']
    );
    const err = new Error('Zoho CRM did not return a Lead id');
    throw err;
  }

  const { rows: finalRows } = await pool.query(
    `UPDATE coexistence.zoho_lead_links
        SET zoho_lead_id = $2, status = 'synced', last_synced_at = NOW(), last_error = NULL, updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [claimed.id, zohoLeadId]
  );

  await zohoConnectionService.recordSuccess(workspaceId, whatsappAccountId);

  return serializeLeadLink(finalRows[0], { created: true, droppedFields });
}

// ── UPDATE flow (spec §8) ────────────────────────────────────────────────
async function updateLead(input) {
  const { workspaceId, whatsappAccountId, contactNumber } = input;
  const normalizedNumber = requireIds(workspaceId, whatsappAccountId, contactNumber);

  const connectionRow = await resolveConnectionRow(workspaceId, whatsappAccountId);

  const { rows: linkRows } = await pool.query(
    `SELECT * FROM coexistence.zoho_lead_links
      WHERE workspace_id = $1 AND whatsapp_account_id = $2 AND contact_number = $3`,
    [workspaceId, whatsappAccountId, normalizedNumber]
  );
  const link = linkRows[0];
  if (!link || !link.zoho_lead_id) {
    const err = new Error('No existing Zoho Lead link found for this contact — create one first');
    err.status = 404;
    throw err;
  }

  const fields = buildUpdateFields(input);
  if (Object.keys(fields).length === 0) {
    // Nothing supplied to update — return current state unchanged rather
    // than making a no-op Zoho call.
    return serializeLeadLink(link, { created: false });
  }

  let droppedFields = [];
  try {
    ({ droppedFields } = await withAccessToken(workspaceId, whatsappAccountId, connectionRow, (accessToken) =>
      withFieldFallback(fields, (currentFields) => updateZohoLead(connectionRow, accessToken, link.zoho_lead_id, currentFields))
    ));
  } catch (err) {
    if (err.zohoStatus === 404) {
      // Lead was deleted on Zoho's side out-of-band (spec §12). Surface
      // clearly; do not silently recreate.
      await pool.query(
        `UPDATE coexistence.zoho_lead_links
            SET status = 'failed', last_error = $2, updated_at = NOW()
          WHERE id = $1`,
        [link.id, 'Linked Zoho Lead no longer exists (404)']
      );
      const notFoundErr = new Error('The linked Zoho Lead no longer exists on Zoho\u2019s side');
      notFoundErr.status = 409;
      throw notFoundErr;
    }
    await pool.query(
      `UPDATE coexistence.zoho_lead_links
          SET status = 'failed', last_error = $2, updated_at = NOW()
        WHERE id = $1`,
      [link.id, String(err.message || 'Zoho Lead update failed').slice(0, 500)]
    );
    throw err;
  }

  const { rows: finalRows } = await pool.query(
    `UPDATE coexistence.zoho_lead_links
        SET status = 'synced', last_synced_at = NOW(), last_error = NULL, updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [link.id]
  );

  await zohoConnectionService.recordSuccess(workspaceId, whatsappAccountId);

  return serializeLeadLink(finalRows[0], { created: false, droppedFields });
}

// ── Retrieve existing linked Lead (spec §2) ──────────────────────────────
async function getLinkedLead(workspaceId, whatsappAccountId, contactNumber) {
  const normalizedNumber = requireIds(workspaceId, whatsappAccountId, contactNumber);
  await zohoConnectionService.assertWhatsappAccountInWorkspace(workspaceId, whatsappAccountId);

  const { rows } = await pool.query(
    `SELECT * FROM coexistence.zoho_lead_links
      WHERE workspace_id = $1 AND whatsapp_account_id = $2 AND contact_number = $3`,
    [workspaceId, whatsappAccountId, normalizedNumber]
  );
  if (!rows[0]) return null;
  return serializeLeadLink(rows[0], { created: false });
}

module.exports = {
  createLead,
  updateLead,
  getLinkedLead,
  // Exported for tests / potential reuse — not part of the public "CRM
  // operation" surface, but pure and useful to test in isolation.
  splitName,
  buildLeadFields,
  buildUpdateFields,
  // Exported for reuse by zohoNoteService.js (Phase 8C Part 2) — Notes are
  // just another Zoho CRM sub-resource under the same connection/token
  // lifecycle, so the Note service reuses this connection-resolution +
  // token-retry + generic-HTTP-call machinery instead of duplicating it
  // (spec §2, §13 "reuse existing architecture").
  resolveConnectionRow,
  withAccessToken,
  callZohoLeadsApi,
  // Phase 8G — exported for zohoSyncService/tests.
  withFieldFallback,
};

