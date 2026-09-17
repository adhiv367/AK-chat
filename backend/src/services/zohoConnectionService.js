// Phase 8B Part 1 — Zoho connection lifecycle CRUD, scoped to
// coexistence.zoho_connections. This is the ownership boundary for the
// whole Zoho feature: every lookup here requires BOTH workspace_id AND
// whatsapp_account_id, and verifies the WhatsApp account actually belongs
// to that workspace before touching any connection row — mirrors the
// isolation model already enforced by instagramAccountService.js
// (workspace_id-scoped queries) and the DB-level
// uq_zoho_connections_workspace_account constraint in zohoSchema.js.
//
// No API routes call into this yet (Part 2+) — this file is the service
// layer only, per this part's scope.

const pool = require('../db');

const CONNECTION_STATUSES = ['disconnected', 'connected', 'error', 'reauth_required'];

// Confirms whatsappAccountId belongs to workspaceId before any connection
// row is created/read/modified. This is the single choke point that
// prevents "Workspace A -> Workspace B connection access" and
// "WhatsApp Account A -> WhatsApp Account B connection access" — every
// public function below calls this first.
async function assertWhatsappAccountInWorkspace(workspaceId, whatsappAccountId) {
  if (!workspaceId) throw new Error('workspaceId is required');
  if (!whatsappAccountId) throw new Error('whatsappAccountId is required');

  const { rows } = await pool.query(
    `SELECT id FROM coexistence.whatsapp_accounts WHERE id = $1 AND workspace_id = $2`,
    [whatsappAccountId, workspaceId]
  );
  if (rows.length === 0) {
    const err = new Error('WhatsApp account not found in this workspace');
    err.status = 404;
    throw err;
  }
}

// Safe serialization — the only shape this service ever returns to a
// caller that might expose it further up the stack (future routes).
// Tokens are NEVER included, not even masked, since Zoho tokens (unlike a
// long-lived pasted WhatsApp token) are not something an admin ever needs
// to visually verify — only whether the connection is healthy.
function serializeConnection(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    whatsappAccountId: row.whatsapp_account_id,
    zohoOrgId: row.zoho_org_id,
    zohoApiDomain: row.zoho_api_domain,
    zohoDataCenter: row.zoho_data_center,
    status: row.status,
    scopes: row.scopes,
    connectedAt: row.connected_at,
    connectedBy: row.connected_by,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    hasRefreshToken: Boolean(row.refresh_token_encrypted),
    tokenExpiresAt: row.token_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Lookup ────────────────────────────────────────────────────────────────
async function findConnection(workspaceId, whatsappAccountId) {
  await assertWhatsappAccountInWorkspace(workspaceId, whatsappAccountId);
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.zoho_connections
      WHERE workspace_id = $1 AND whatsapp_account_id = $2`,
    [workspaceId, whatsappAccountId]
  );
  return rows[0] || null;
}

async function getConnection(workspaceId, whatsappAccountId) {
  const row = await findConnection(workspaceId, whatsappAccountId);
  return serializeConnection(row);
}

// Internal-only accessor (e.g. for zohoTokenService callers that already
// have a connection id from a prior findConnection/getConnection call and
// need the raw row). Never exported for use outside the service layer.
async function getConnectionRowById(connectionId, workspaceId, whatsappAccountId) {
  await assertWhatsappAccountInWorkspace(workspaceId, whatsappAccountId);
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.zoho_connections
      WHERE id = $1 AND workspace_id = $2 AND whatsapp_account_id = $3`,
    [connectionId, workspaceId, whatsappAccountId]
  );
  return rows[0] || null;
}

// ── Create / update ──────────────────────────────────────────────────────
// Creates the connection row in 'disconnected' status if none exists yet —
// this is what a future OAuth /start route would call before redirecting
// to Zoho, so there is always a row to atomically update once the callback
// completes (avoids a race between "insert on callback" and a concurrent
// second connect attempt). Idempotent: calling it again for the same
// workspace+account just returns the existing row untouched.
async function ensureConnection(workspaceId, whatsappAccountId, { connectedBy } = {}) {
  await assertWhatsappAccountInWorkspace(workspaceId, whatsappAccountId);

  const existing = await findConnection(workspaceId, whatsappAccountId);
  if (existing) return serializeConnection(existing);

  const { rows } = await pool.query(
    `INSERT INTO coexistence.zoho_connections
       (workspace_id, whatsapp_account_id, status, connected_by)
     VALUES ($1, $2, 'disconnected', $3)
     ON CONFLICT ON CONSTRAINT uq_zoho_connections_workspace_account
       DO UPDATE SET updated_at = coexistence.zoho_connections.updated_at
     RETURNING *`,
    [workspaceId, whatsappAccountId, connectedBy || null]
  );
  return serializeConnection(rows[0]);
}

// Records the Zoho-side org identity once known (post-OAuth — see
// zohoTokenService.exchangeAndStoreTokens for the token half of this same
// callback). Kept separate from token storage so the token service never
// needs to know about org-identity fields, and this service never needs to
// know about token fields — clean boundary per spec §7.
async function recordZohoOrgIdentity(workspaceId, whatsappAccountId, { zohoOrgId, zohoApiDomain, zohoDataCenter, connectedBy } = {}) {
  const row = await getConnectionRowByOwnership(workspaceId, whatsappAccountId);
  if (!row) throw new Error('Zoho connection not found');

  const { rows } = await pool.query(
    `UPDATE coexistence.zoho_connections
        SET zoho_org_id = COALESCE($3, zoho_org_id),
            zoho_api_domain = COALESCE($4, zoho_api_domain),
            zoho_data_center = COALESCE($5, zoho_data_center),
            connected_at = NOW(),
            connected_by = COALESCE($6, connected_by),
            updated_at = NOW()
      WHERE id = $1 AND workspace_id = $2
      RETURNING *`,
    [row.id, workspaceId, zohoOrgId || null, zohoApiDomain || null, zohoDataCenter || null, connectedBy || null]
  );
  return serializeConnection(rows[0]);
}

async function getConnectionRowByOwnership(workspaceId, whatsappAccountId) {
  await assertWhatsappAccountInWorkspace(workspaceId, whatsappAccountId);
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.zoho_connections
      WHERE workspace_id = $1 AND whatsapp_account_id = $2`,
    [workspaceId, whatsappAccountId]
  );
  return rows[0] || null;
}

// ── Status management ────────────────────────────────────────────────────
async function updateConnectionStatus(workspaceId, whatsappAccountId, status) {
  if (!CONNECTION_STATUSES.includes(status)) {
    throw new Error(`Invalid Zoho connection status: ${status}`);
  }
  const row = await getConnectionRowByOwnership(workspaceId, whatsappAccountId);
  if (!row) throw new Error('Zoho connection not found');

  const { rows } = await pool.query(
    `UPDATE coexistence.zoho_connections
        SET status = $3, updated_at = NOW()
      WHERE id = $1 AND workspace_id = $2
      RETURNING *`,
    [row.id, workspaceId, status]
  );
  return serializeConnection(rows[0]);
}

async function recordSuccess(workspaceId, whatsappAccountId) {
  const row = await getConnectionRowByOwnership(workspaceId, whatsappAccountId);
  if (!row) throw new Error('Zoho connection not found');
  const { rows } = await pool.query(
    `UPDATE coexistence.zoho_connections
        SET last_success_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND workspace_id = $2
      RETURNING *`,
    [row.id, workspaceId]
  );
  return serializeConnection(rows[0]);
}

async function recordError(workspaceId, whatsappAccountId, errorMessage) {
  const row = await getConnectionRowByOwnership(workspaceId, whatsappAccountId);
  if (!row) throw new Error('Zoho connection not found');
  const { rows } = await pool.query(
    `UPDATE coexistence.zoho_connections
        SET status = 'error', last_error = $3, last_error_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND workspace_id = $2
      RETURNING *`,
    [row.id, workspaceId, String(errorMessage || '').slice(0, 500)]
  );
  return serializeConnection(rows[0]);
}

// ── Disconnect ────────────────────────────────────────────────────────────
// Soft-disconnect only (spec §8 — safe statuses, no mention of deletion):
// clears tokens and org identity, flips status to 'disconnected'. The row
// itself is kept (not deleted) so history (last_error, connected_at, etc.)
// isn't lost and a reconnect can reuse the same row rather than fighting
// the UNIQUE(workspace_id, whatsapp_account_id) constraint.
// Marks a connection REAUTH_REQUIRED (Zoho refresh token permanently
// failed — revoked on Zoho's side, etc.). Kept separate from recordError
// (which stays 'error' for other kinds of failures) since the future
// frontend (8I) needs to tell "reconnect via OAuth" apart from "transient
// API error" at a glance.
async function markReauthRequired(workspaceId, whatsappAccountId, errorMessage) {
  const row = await getConnectionRowByOwnership(workspaceId, whatsappAccountId);
  if (!row) throw new Error('Zoho connection not found');
  const { rows } = await pool.query(
    `UPDATE coexistence.zoho_connections
        SET status = 'reauth_required', last_error = $3, last_error_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND workspace_id = $2
      RETURNING *`,
    [row.id, workspaceId, String(errorMessage || '').slice(0, 500)]
  );
  return serializeConnection(rows[0]);
}

async function disconnect(workspaceId, whatsappAccountId) {
  const row = await getConnectionRowByOwnership(workspaceId, whatsappAccountId);
  if (!row) return null;

  const { rows } = await pool.query(
    `UPDATE coexistence.zoho_connections
        SET status = 'disconnected',
            access_token_encrypted = NULL,
            refresh_token_encrypted = NULL,
            token_expires_at = NULL,
            zoho_org_id = NULL,
            zoho_api_domain = NULL,
            zoho_data_center = NULL,
            scopes = NULL,
            updated_at = NOW()
      WHERE id = $1 AND workspace_id = $2
      RETURNING *`,
    [row.id, workspaceId]
  );
  return serializeConnection(rows[0]);
}

module.exports = {
  CONNECTION_STATUSES,
  serializeConnection,
  assertWhatsappAccountInWorkspace,
  findConnection,
  getConnection,
  getConnectionRowById,
  getConnectionRowByOwnership,
  ensureConnection,
  recordZohoOrgIdentity,
  updateConnectionStatus,
  recordSuccess,
  recordError,
  markReauthRequired,
  disconnect,
};

