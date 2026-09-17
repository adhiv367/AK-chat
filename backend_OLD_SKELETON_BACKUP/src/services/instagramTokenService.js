const pool = require('../db');
const { getAccountRow, setStatus } = require('./instagramAccountService');
const { decrypt, encrypt } = require('../util/crypto');
const { getLongLivedToken } = require('./instagramOAuthService');

async function refreshIfNeeded(accountId) {
  const acc = await getAccountRow(accountId);
  if (!acc || !acc.expires_at) return;
  const msLeft = new Date(acc.expires_at) - Date.now();
  if (msLeft > 3 * 24 * 60 * 60 * 1000) return; // >3 days left, skip

  try {
    const token = decrypt(acc.access_token_encrypted);
    const refreshed = await getLongLivedToken({ access_token: token });
    const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000);
    await pool.query(
      `UPDATE coexistence.instagram_accounts SET access_token_encrypted=$1, expires_at=$2, status='connected', updated_at=NOW() WHERE id=$3`,
      [encrypt(refreshed.access_token), newExpiry, accountId]
    );
  } catch (e) {
    console.error('[instagramToken] refresh failed for account', accountId, e.message);
    await setStatus(accountId, 'token_expired');
  }
}

async function refreshAllAccounts() {
  const { rows } = await pool.query(`SELECT id FROM coexistence.instagram_accounts WHERE status != 'disconnected'`);
  for (const r of rows) await refreshIfNeeded(r.id);
}

module.exports = { refreshIfNeeded, refreshAllAccounts };

