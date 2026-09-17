// Phase 5A — self-service password recovery storage.
//
// Dedicated table (rather than columns bolted onto akchat_users), so a
// user can only ever have well-defined, queryable reset attempts, and so
// this feature can't collide with the unrelated invite_token/invite_expires_at
// columns Phase 4D already added to workspace_members (invitations are
// workspace-membership activation; password reset is account-level auth
// and intentionally has nothing to do with workspace membership).
//
// Tokens are never stored in plaintext: only a SHA-256 hash of the token
// is persisted, exactly the same "store a hash, mail the raw value once"
// pattern as the bcrypt-hashed placeholder password used for invitations.
// A leaked database backup therefore does not hand out working reset links.

const pool = require('../db');

async function ensurePasswordResetTable() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS coexistence.password_reset_tokens (
        id           BIGSERIAL PRIMARY KEY,
        user_id      BIGINT NOT NULL REFERENCES coexistence.akchat_users(id) ON DELETE CASCADE,
        token_hash   TEXT NOT NULL UNIQUE,
        expires_at   TIMESTAMPTZ NOT NULL,
        used_at      TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id
        ON coexistence.password_reset_tokens (user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires_at
        ON coexistence.password_reset_tokens (expires_at)
    `);
  } finally {
    client.release();
  }
}

module.exports = { ensurePasswordResetTable };
