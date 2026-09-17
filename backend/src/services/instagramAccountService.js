const crypto = require('crypto');
const pool = require('../db');
const { encrypt, decrypt, maskSecret } = require('../util/crypto');

function publicShape(row, { reveal = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    accountName: row.account_name,
    instagramBusinessId: row.instagram_business_id,
    facebookPageId: row.facebook_page_id,
    username: row.username,
    pageName: row.page_name,
    accessTokenMasked: maskSecret(decrypt(row.access_token_encrypted)),
    accessToken: reveal ? decrypt(row.access_token_encrypted) : undefined,
    expiresAt: row.expires_at,
    profilePicture: row.profile_picture,
    status: row.status,
    connectedAt: row.connected_at,
    lastSync: row.last_sync,
  };
}

// workspaceId is REQUIRED — every account connection must be attributed to
// the workspace that initiated the OAuth flow (see routes/instagram/
// instagramOAuth.js, where workspaceId is carried through the signed OAuth
// `state` param, never trusted from the request body/query).
//
// instagram_business_id is unique system-wide (same convention as WhatsApp's
// phone_number_id), so if the IG business account is already connected to a
// *different* workspace, this must not silently reassign it — that would be
// a cross-workspace takeover. Only the owning workspace may refresh it, or a
// previously-unclaimed (legacy, workspace_id IS NULL) row may be claimed.
async function upsertAccount({ accountName, igBusinessId, pageId, username, pageName, accessToken, expiresAt, profilePicture, workspaceId }) {
  if (!workspaceId) throw new Error('workspaceId is required to connect an Instagram account');

  const existing = await pool.query(
    `SELECT id, webhook_verify_token, workspace_id FROM coexistence.instagram_accounts WHERE instagram_business_id = $1`,
    [igBusinessId]
  );
  const existingRow = existing.rows[0];
  if (existingRow && existingRow.workspace_id != null && String(existingRow.workspace_id) !== String(workspaceId)) {
    const err = new Error('This Instagram account is already connected to another workspace');
    err.status = 409;
    throw err;
  }
  const verifyToken = existingRow?.webhook_verify_token || crypto.randomBytes(16).toString('hex');

  const { rows } = await pool.query(
    `INSERT INTO coexistence.instagram_accounts
       (workspace_id, account_name, instagram_business_id, facebook_page_id, username, page_name,
        access_token_encrypted, expires_at, app_id, webhook_verify_token, profile_picture, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'connected')
     ON CONFLICT (instagram_business_id) DO UPDATE SET
       workspace_id = EXCLUDED.workspace_id,
       account_name = EXCLUDED.account_name,
       facebook_page_id = EXCLUDED.facebook_page_id,
       username = EXCLUDED.username,
       page_name = EXCLUDED.page_name,
       access_token_encrypted = EXCLUDED.access_token_encrypted,
       expires_at = EXCLUDED.expires_at,
       profile_picture = EXCLUDED.profile_picture,
       status = 'connected',
       updated_at = NOW()
     RETURNING *`,
    [workspaceId, accountName, igBusinessId, pageId, username, pageName, encrypt(accessToken), expiresAt,
     process.env.META_IG_APP_ID, verifyToken, profilePicture]
  );
  return rows[0];
}

// List accounts for the current workspace only — a workspace must never see
// another workspace's connected Instagram accounts.
async function listAccounts(workspaceId) {
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.instagram_accounts WHERE workspace_id = $1 ORDER BY id DESC`,
    [workspaceId]
  );
  return rows.map(r => publicShape(r));
}

// getAccountRow(id, workspaceId): when workspaceId is provided, the lookup
// is scoped to it (used by every customer-facing route — never trust an
// account id alone). When omitted, this is an internal/system lookup (e.g.
// the token-refresh cron, which intentionally operates across every
// workspace using each account's own stored ownership).
async function getAccountRow(id, workspaceId = null) {
  const { rows } = await pool.query(
    workspaceId
      ? `SELECT * FROM coexistence.instagram_accounts WHERE id = $1 AND workspace_id = $2`
      : `SELECT * FROM coexistence.instagram_accounts WHERE id = $1`,
    workspaceId ? [id, workspaceId] : [id]
  );
  return rows[0] || null;
}

async function getDecryptedToken(id, workspaceId = null) {
  const row = await getAccountRow(id, workspaceId);
  if (!row) throw new Error('Instagram account not found');
  return decrypt(row.access_token_encrypted);
}

// Used only by the inbound Meta webhook (server-to-server, no requesting
// workspace to scope by) to resolve which account a payload belongs to.
async function getAccountByBusinessId(igBusinessId) {
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.instagram_accounts WHERE instagram_business_id = $1`,
    [igBusinessId]
  );
  return rows[0] || null;
}

async function disconnectAccount(id, workspaceId) {
  const { rowCount } = await pool.query(
    `UPDATE coexistence.instagram_accounts SET status = 'disconnected', updated_at = NOW() WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId]
  );
  return rowCount > 0;
}

async function deleteAccount(id, workspaceId) {
  const acc = await getAccountRow(id, workspaceId);
  if (!acc) return false;
  // Conversation history intentionally kept (spec: don't delete unless asked) —
  // we only null the FK so old rows stay but are unassigned. workspace_id on
  // those child rows is left as-is (they still belong to this workspace;
  // only the account link is cleared).
  await pool.query(`UPDATE coexistence.instagram_contacts SET instagram_account_id = NULL WHERE instagram_account_id = $1`, [id]);
  await pool.query(`DELETE FROM coexistence.instagram_accounts WHERE id = $1 AND workspace_id = $2`, [id, workspaceId]);
  return true;
}

// Background job (token-refresh cron) — no requesting workspace; operates on
// the account by its own stored id, same as before.
async function touchLastSync(id) {
  await pool.query(`UPDATE coexistence.instagram_accounts SET last_sync = NOW() WHERE id = $1`, [id]);
}

async function setStatus(id, status) {
  await pool.query(`UPDATE coexistence.instagram_accounts SET status = $1, updated_at = NOW() WHERE id = $2`, [status, id]);
}

module.exports = {
  publicShape, upsertAccount, listAccounts, getAccountRow, getDecryptedToken,
  getAccountByBusinessId, disconnectAccount, deleteAccount, touchLastSync, setStatus,
};
