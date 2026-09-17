const pool = require('../db');

async function ensureInstagramTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.instagram_accounts (
      id BIGSERIAL PRIMARY KEY,
      page_id TEXT,
      business_account_id TEXT,
      access_token TEXT,
      webhook_url TEXT,
      verify_token TEXT,
      app_secret TEXT,
      status TEXT DEFAULT 'inactive',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.instagram_contacts (
      id BIGSERIAL PRIMARY KEY,
      ig_user_id TEXT NOT NULL,
      username TEXT,
      display_name TEXT,
      profile_picture TEXT,
      last_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.instagram_conversations (
      id BIGSERIAL PRIMARY KEY,
      contact_id BIGINT REFERENCES coexistence.instagram_contacts(id),
      status TEXT DEFAULT 'open',
      assignee_id BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.instagram_messages (
      id BIGSERIAL PRIMARY KEY,
      conversation_id BIGINT REFERENCES coexistence.instagram_conversations(id),
      direction TEXT NOT NULL,
      content TEXT,
      media_url TEXT,
      status TEXT DEFAULT 'sent',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.instagram_templates (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      shortcut TEXT,
      message TEXT,
      category TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.instagram_campaigns (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'draft',
      scheduled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.instagram_campaign_messages (
      id BIGSERIAL PRIMARY KEY,
      campaign_id BIGINT REFERENCES coexistence.instagram_campaigns(id),
      contact_id BIGINT REFERENCES coexistence.instagram_contacts(id),
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Matches the real WhatsApp `chatbots` table design: the entire node graph
  // (nodes + edges) is stored as one JSON blob in `config`, not split across
  // separate tables. This mirrors coexistence.chatbots exactly.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.instagram_workflows (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'draft',
      trigger_type TEXT DEFAULT 'keyword',
      config JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.instagram_workflow_executions (
      id BIGSERIAL PRIMARY KEY,
      workflow_id BIGINT REFERENCES coexistence.instagram_workflows(id),
      status TEXT DEFAULT 'running',
      trigger_source TEXT,
      contact_ref TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      error_message TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.instagram_workflow_execution_steps (
      id BIGSERIAL PRIMARY KEY,
      execution_id BIGINT REFERENCES coexistence.instagram_workflow_executions(id),
      node_id TEXT,
      node_type TEXT,
      status TEXT DEFAULT 'success',
      result TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      duration_ms INT DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.instagram_tags (
      id BIGSERIAL PRIMARY KEY,
      contact_id BIGINT REFERENCES coexistence.instagram_contacts(id),
      tag TEXT NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.instagram_notes (
      id BIGSERIAL PRIMARY KEY,
      contact_id BIGINT REFERENCES coexistence.instagram_contacts(id),
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.instagram_settings (
      id BIGSERIAL PRIMARY KEY,
      page_id TEXT,
      business_account_id TEXT,
      access_token TEXT,
      webhook_url TEXT,
      verify_token TEXT,
      app_secret TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.instagram_ai_logs (
      id BIGSERIAL PRIMARY KEY,
      conversation_id BIGINT REFERENCES coexistence.instagram_conversations(id),
      prompt TEXT,
      response TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.instagram_analytics (
      id BIGSERIAL PRIMARY KEY,
      metric TEXT NOT NULL,
      value NUMERIC DEFAULT 0,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Multi-account support
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.instagram_accounts (
      id BIGSERIAL PRIMARY KEY,
      account_name TEXT NOT NULL,
      instagram_business_id TEXT UNIQUE NOT NULL,
      facebook_page_id TEXT NOT NULL,
      username TEXT,
      page_name TEXT,
      access_token_encrypted TEXT NOT NULL,
      refresh_token_encrypted TEXT,
      expires_at TIMESTAMPTZ,
      app_id TEXT,
      app_secret_encrypted TEXT,
      webhook_verify_token TEXT NOT NULL,
      profile_picture TEXT,
      status TEXT DEFAULT 'connected',
      connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_sync TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);



  // The CREATE TABLE above is a no-op if instagram_accounts already exists
  // (it was originally created with the older single-account schema further
  // up this file). Patch the existing table with any multi-account columns
  // it's missing, e.g. webhook_verify_token.
  await pool.query(`
    ALTER TABLE coexistence.instagram_accounts
      ADD COLUMN IF NOT EXISTS account_name TEXT,
      ADD COLUMN IF NOT EXISTS instagram_business_id TEXT,
      ADD COLUMN IF NOT EXISTS facebook_page_id TEXT,
      ADD COLUMN IF NOT EXISTS username TEXT,
      ADD COLUMN IF NOT EXISTS page_name TEXT,
      ADD COLUMN IF NOT EXISTS access_token_encrypted TEXT,
      ADD COLUMN IF NOT EXISTS refresh_token_encrypted TEXT,
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS app_id TEXT,
      ADD COLUMN IF NOT EXISTS app_secret_encrypted TEXT,
      ADD COLUMN IF NOT EXISTS webhook_verify_token TEXT,
      ADD COLUMN IF NOT EXISTS profile_picture TEXT,
      ADD COLUMN IF NOT EXISTS connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS last_sync TIMESTAMPTZ
  `);

  // instagram_business_id needs a UNIQUE constraint for the ON CONFLICT
  // (instagram_business_id) upsert in instagramAccountService.js to work.
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'instagram_accounts_instagram_business_id_key'
      ) THEN
        ALTER TABLE coexistence.instagram_accounts
          ADD CONSTRAINT instagram_accounts_instagram_business_id_key UNIQUE (instagram_business_id);
      END IF;
    END $$;
  `);
  // Scope every existing table to an account (nullable so old dummy rows don't break)
  const scopedTables = [
    'instagram_contacts', 'instagram_conversations', 'instagram_campaigns',
    'instagram_workflows', 'instagram_templates',
  ];
  for (const t of scopedTables) {
    await pool.query(`
      ALTER TABLE coexistence.${t}
      ADD COLUMN IF NOT EXISTS instagram_account_id BIGINT REFERENCES coexistence.instagram_accounts(id)
    `);
  }

  console.log('[Instagram] Multi-account tables ensured.');
  console.log('[Instagram] Tables ensured.');
}

module.exports = { ensureInstagramTables };

