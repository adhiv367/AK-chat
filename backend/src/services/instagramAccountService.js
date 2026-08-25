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

async function upsertAccount({ accountName, igBusinessId, pageId, username, pageName, accessToken, expiresAt, profilePicture }) {
  const existing = await pool.query(
    `SELECT webhook_verify_token FROM coexistence.instagram_accounts WHERE instagram_business_id = $1`,
    [igBusinessId]
  );
  const verifyToken = existing.rows[0]?.webhook_verify_token || crypto.randomBytes(16).toString('hex');

  const { rows } = await pool.query(
    `INSERT INTO coexistence.instagram_accounts
       (account_name, instagram_business_id, facebook_page_id, username, page_name,
        access_token_encrypted, expires_at, app_id, webhook_verify_token, profile_picture, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'connected')
     ON CONFLICT (instagram_business_id) DO UPDATE SET
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
    [accountName, igBusinessId, pageId, username, pageName, encrypt(accessToken), expiresAt,
     process.env.META_IG_APP_ID, verifyToken, profilePicture]
  );
  return rows[0];
}

async function listAccounts() {
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.instagram_accounts ORDER BY id DESC`
  );
  return rows.map(r => publicShape(r));
}

async function getAccountRow(id) {
  const { rows } = await pool.query(`SELECT * FROM coexistence.instagram_accounts WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function getDecryptedToken(id) {
  const row = await getAccountRow(id);
  if (!row) throw new Error('Instagram account not found');
  return decrypt(row.access_token_encrypted);
}

async function getAccountByBusinessId(igBusinessId) {
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.instagram_accounts WHERE instagram_business_id = $1`,
    [igBusinessId]
  );
  return rows[0] || null;
}

async function disconnectAccount(id) {
  await pool.query(`UPDATE coexistence.instagram_accounts SET status = 'disconnected', updated_at = NOW() WHERE id = $1`, [id]);
}

async function deleteAccount(id) {
  // Conversation history intentionally kept (spec: don't delete unless asked) —
  // we only null the FK so old rows stay but are unassigned.
  await pool.query(`UPDATE coexistence.instagram_contacts SET instagram_account_id = NULL WHERE instagram_account_id = $1`, [id]);
  await pool.query(`DELETE FROM coexistence.instagram_accounts WHERE id = $1`, [id]);
}

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


