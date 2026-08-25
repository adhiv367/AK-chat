// Email Marketing module — schema for subscribers, templates, and campaigns.
// Mirrors the ensure*Tables() pattern used by db/retargetSchema.js:
// idempotent CREATE TABLE IF NOT EXISTS, called once on server startup.

const pool = require('../db');

async function ensureEmailTables() {
  // ── Subscribers — imported from Google Sheets, WhatsApp/Instagram capture,
  // or manual add. email is unique so re-imports upsert instead of duplicate.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.email_subscribers (
      id BIGSERIAL PRIMARY KEY,
      name TEXT,
      email TEXT NOT NULL,
      source TEXT DEFAULT 'manual',
      tags JSONB NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (email)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_email_subscribers_status ON coexistence.email_subscribers (status)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_email_subscribers_created_at ON coexistence.email_subscribers (created_at DESC)
  `);

  // ── Templates — reusable email content (New Arrival, Offer, Welcome, etc.)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.email_templates (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      subject TEXT NOT NULL,
      html_body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── Campaigns — one row per send, tracks what/who/when/status
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.email_campaigns (
      id BIGSERIAL PRIMARY KEY,
      template_id BIGINT REFERENCES coexistence.email_templates(id) ON DELETE SET NULL,
      subject TEXT NOT NULL,
      recipient_count INTEGER NOT NULL DEFAULT 0,
      sent_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_email_campaigns_created_at ON coexistence.email_campaigns (created_at DESC)
  `);

  // -- Sheet sources -- named, saved Google Sheet imports (e.g. "Retargeting",
  // "Marketing List"). Subscribers are tagged with which source they came
  // from, so deleting a source cascades to only that source's subscribers.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.email_sheet_sources (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      sheet_url TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE coexistence.email_subscribers
      ADD COLUMN IF NOT EXISTS source_id BIGINT REFERENCES coexistence.email_sheet_sources(id) ON DELETE CASCADE
  `);

  // -- Inbox — two-way email. One row per message, inbound (customer reply)
  // or outbound (your reply sent from AK Chat). Grouped into a conversation
  // by contact_email, so no separate "thread" table is needed for MVP.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.email_inbox_messages (
      id BIGSERIAL PRIMARY KEY,
      subscriber_id BIGINT REFERENCES coexistence.email_subscribers(id) ON DELETE SET NULL,
      contact_email TEXT NOT NULL,
      contact_name TEXT,
      direction TEXT NOT NULL DEFAULT 'inbound',
      subject TEXT,
      body_text TEXT,
      body_html TEXT,
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_email_inbox_contact_email ON coexistence.email_inbox_messages (contact_email)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_email_inbox_created_at ON coexistence.email_inbox_messages (created_at DESC)
  `);
   // ── Senders — multiple "from" addresses selectable per campaign
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.email_senders (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (email)
    )
  `);

  console.log('[Email] Tables ensured.');
}

module.exports = { ensureEmailTables };
