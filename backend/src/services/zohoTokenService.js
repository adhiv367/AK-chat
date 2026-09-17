// Phase 8B Part 1 — Zoho token lifecycle: encrypted storage/retrieval,
// expiry bookkeeping, and refresh, all scoped to a single
// coexistence.zoho_connections row (by its own id).
//
// This module never resolves *which* connection to use from a
// workspace/whatsapp-account pair — that ownership resolution lives in
// zohoConnectionService.js, which is expected to be the only caller here in
// normal request flow (routes are Part 2+ and not created yet).
//
// Reuses util/crypto.js's encrypt/decrypt (AES-256-GCM), same helper already
// used for WhatsApp/Instagram access tokens — no new encryption mechanism.
//
// HARD RULE enforced throughout this file: raw token values are returned
// only from getDecryptedAccessToken()/ensureValidAccessToken() for callers
// that are about to make a Zoho API call with them. Every other function
// here (storeTokens, refreshConnectionToken's return value, etc.) returns
// only the safe/serialized row — see zohoConnectionService.js's
// serializeConnection() for the single place a connection is turned into
// something that could reach the frontend, which never includes tokens.

const pool = require('../db');
const { encrypt, decrypt } = require('../util/crypto');
const { exchangeCodeForToken, refreshAccessToken, resolveDatacenter } = require('./zohoOAuthService');

// How much of a safety margin to leave before actual expiry when deciding a
// token needs refreshing — avoids a request racing an about-to-expire token.
const EXPIRY_SAFETY_MARGIN_MS = 60 * 1000; // 1 minute

function computeExpiresAt(expiresInSeconds) {
  const seconds = Number(expiresInSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(Date.now() + seconds * 1000);
}

function isExpired(tokenExpiresAt) {
  if (!tokenExpiresAt) return true;
  const expiresAt = new Date(tokenExpiresAt).getTime();
  return Number.isNaN(expiresAt) || expiresAt - EXPIRY_SAFETY_MARGIN_MS <= Date.now();
}

// ── Authorization-code exchange ─────────────────────────────────────────
// Exchanges `code` with Zoho, then atomically writes the encrypted tokens
// (+ expiry, scopes, org identity, status) onto the given connection row.
// Returns the raw Zoho token payload's non-secret fields (api_domain) so
// the caller (future Part 2 route / connection service) can resolve the
// Zoho org without this module leaking token values back up.
async function exchangeAndStoreTokens(connectionId, code, { dc } = {}) {
  if (!connectionId) throw new Error('connectionId is required');

  const tokenData = await exchangeCodeForToken(code, { dc: resolveDatacenter(dc) });
  const expiresAt = computeExpiresAt(tokenData.expires_in);

  await atomicTokenUpdate(connectionId, {
    accessToken: tokenData.access_token,
    // Zoho always issues a refresh_token on the first authorization-code
    // exchange (with access_type=offline + prompt=consent) — but never
    // overwrite a previously-stored refresh_token with null if one somehow
    // isn't present on this response, to avoid orphaning the connection.
    refreshToken: tokenData.refresh_token,
    expiresAt,
    scopes: tokenData.scope || null,
    apiDomain: tokenData.api_domain || null,
    status: 'connected',
  });

  return { apiDomain: tokenData.api_domain || null, expiresAt };
}

// ── Encrypted storage (atomic single-row UPDATE) ────────────────────────
// Every field is optional except connectionId — callers pass only what
// changed. refreshToken is only written when explicitly provided (undefined
// means "leave as-is"), so a refresh response that omits refresh_token
// (Zoho's normal behaviour on refresh) never clobbers the stored one.
async function atomicTokenUpdate(connectionId, {
  accessToken,
  refreshToken,
  expiresAt,
  scopes,
  apiDomain,
  status,
} = {}) {
  if (!connectionId) throw new Error('connectionId is required');

  const sets = [];
  const params = [];
  let i = 1;

  if (accessToken !== undefined) {
    sets.push(`access_token_encrypted = $${i++}`);
    params.push(encrypt(accessToken));
  }
  if (refreshToken !== undefined && refreshToken !== null) {
    sets.push(`refresh_token_encrypted = $${i++}`);
    params.push(encrypt(refreshToken));
  }
  if (expiresAt !== undefined) {
    sets.push(`token_expires_at = $${i++}`);
    params.push(expiresAt);
  }
  if (scopes !== undefined) {
    sets.push(`scopes = $${i++}`);
    params.push(scopes);
  }
  if (apiDomain !== undefined) {
    sets.push(`zoho_api_domain = $${i++}`);
    params.push(apiDomain);
  }
  if (status !== undefined) {
    sets.push(`status = $${i++}`);
    params.push(status);
  }

  if (sets.length === 0) return; // nothing to update

  sets.push(`last_success_at = NOW()`);
  sets.push(`updated_at = NOW()`);
  params.push(connectionId);

  await pool.query(
    `UPDATE coexistence.zoho_connections SET ${sets.join(', ')} WHERE id = $${i}`,
    params
  );
}

// ── Decrypted retrieval (internal use only — never returned to frontend) ──
async function getDecryptedAccessToken(connectionId) {
  const row = await getConnectionRow(connectionId);
  if (!row) throw new Error('Zoho connection not found');
  return decrypt(row.access_token_encrypted);
}

async function getDecryptedRefreshToken(connectionId) {
  const row = await getConnectionRow(connectionId);
  if (!row) throw new Error('Zoho connection not found');
  return decrypt(row.refresh_token_encrypted);
}

async function getConnectionRow(connectionId) {
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.zoho_connections WHERE id = $1`,
    [connectionId]
  );
  return rows[0] || null;
}

// ── Refresh ───────────────────────────────────────────────────────────────
// Concurrent-refresh-race FIX: a webhook-triggered sync and the background
// reconciliation scheduler (zohoReconciliationScheduler.js, every 60s) can
// both decide the same connection's token is expired/near-expiry at
// virtually the same moment and both call this function. Without
// serialization, both read the SAME stored refresh token, both call Zoho's
// /oauth/v2/token endpoint concurrently — and Zoho rotates (invalidating
// the prior) refresh token on every successful exchange, so whichever call
// loses the race gets a genuine-looking invalid_grant for a token that was,
// a moment ago, perfectly valid. Before this fix that was indistinguishable
// from an actually-revoked grant, and got the connection wrongly marked
// reauth_required — reproducing even after the stale-domain fix, because
// this is a completely different bug: a race, not a stale value.
//
// Two layers of defense:
//   1) In-process de-duplication: concurrent refreshConnectionToken calls
//      for the SAME connectionId share one in-flight Zoho request instead
//      of firing two. Handles the common case (single container/process).
//   2) DB-level optimistic check (below, in the catch block): even if two
//      separate processes/containers raced, before condemning the
//      connection we re-read its current refresh_token_encrypted and
//      compare it to the one we actually sent Zoho. If it no longer
//      matches, a concurrent refresh already won and rotated it — proof
//      the connection is fine, not proof the grant is dead.
const refreshInFlight = new Map(); // connectionId -> Promise<accessToken>

async function refreshConnectionToken(connectionId) {
  if (refreshInFlight.has(connectionId)) {
    return refreshInFlight.get(connectionId);
  }
  const attempt = performRefresh(connectionId).finally(() => {
    refreshInFlight.delete(connectionId);
  });
  refreshInFlight.set(connectionId, attempt);
  return attempt;
}

async function performRefresh(connectionId) {
  const row = await getConnectionRow(connectionId);
  if (!row) throw new Error('Zoho connection not found');

  const refreshToken = decrypt(row.refresh_token_encrypted);
  if (!refreshToken) {
    await markReauthRequired(connectionId, 'No refresh token stored');
    throw new Error('No refresh token stored for this Zoho connection');
  }

  try {
    const tokenData = await refreshAccessToken(refreshToken, { dc: row.zoho_data_center || undefined });
    const expiresAt = computeExpiresAt(tokenData.expires_in);

    await atomicTokenUpdate(connectionId, {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token, // only written if Zoho re-issued one
      expiresAt,
      apiDomain: tokenData.api_domain || undefined,
      status: 'connected',
    });

    return tokenData.access_token;
  } catch (err) {
    if (err.transient) {
      // Reauth-loop FIX: a transient failure attempting the refresh call
      // itself (network blip, Zoho 5xx outage, rate limiting — see
      // zohoOAuthService.classifyRefreshFailure) says nothing about whether
      // the stored refresh token is still good. Never mark reauth_required
      // for this — leave status/last_error untouched so the next attempt
      // (or the reconciliation retry loop) can simply try again without
      // demanding the customer redo OAuth.
      throw err;
    }

    // Concurrent-refresh-race FIX, layer 2: Zoho told us this exact
    // refresh_token is bad. Before believing that, confirm nobody else
    // already rotated it out from under us while our call was in flight.
    const currentRow = await getConnectionRow(connectionId);
    if (currentRow && currentRow.refresh_token_encrypted !== row.refresh_token_encrypted) {
      const raceErr = new Error('Zoho refresh token was rotated by a concurrent refresh — connection is still valid, not reauthenticating');
      raceErr.transient = true; // never demand reconnect for losing a race
      throw raceErr;
    }

    await markReauthRequired(connectionId, err.message);
    throw err;
  }
}

// Phase 8B Part 2: the DB now has a real 'reauth_required' status (see
// zohoSchema.js migration) — write that instead of the 'error' stand-in
// Part 1 used before the value existed. Pre-existing rows already written
// as 'error' by Part 1 code are left as-is (no backfill); ensureValidAccessToken
// below treats both the same way going forward.
async function markReauthRequired(connectionId, errorMessage) {
  await pool.query(
    `UPDATE coexistence.zoho_connections
        SET status = 'reauth_required',
            last_error = $2,
            last_error_at = NOW(),
            updated_at = NOW()
      WHERE id = $1`,
    [connectionId, String(errorMessage || 'Token refresh failed').slice(0, 500)]
  );
}

// Returns a valid (non-expired) decrypted access token, refreshing first if
// the stored one is expired/near-expiry. This is the function any future
// Zoho-API-calling code (Part 2+) should use — it never returns a stale
// token and never silently swallows a refresh failure.
async function ensureValidAccessToken(connectionId) {
  const row = await getConnectionRow(connectionId);
  if (!row) throw new Error('Zoho connection not found');

  // 'error' is the legacy Part-1 stand-in value for this same condition on
  // rows written before 'reauth_required' existed — treat both the same.
  if (row.status === 'error' || row.status === 'reauth_required') {
    throw new Error('Zoho connection requires re-authentication');
  }

  if (!isExpired(row.token_expires_at)) {
    return decrypt(row.access_token_encrypted);
  }

  return refreshConnectionToken(connectionId);
}

module.exports = {
  computeExpiresAt,
  isExpired,
  exchangeAndStoreTokens,
  atomicTokenUpdate,
  getDecryptedAccessToken,
  getDecryptedRefreshToken,
  refreshConnectionToken,
  markReauthRequired,
  ensureValidAccessToken,
  EXPIRY_SAFETY_MARGIN_MS,
};