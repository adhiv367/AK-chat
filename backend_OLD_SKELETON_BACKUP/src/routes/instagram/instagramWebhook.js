const express = require('express');
const pool = require('../../db');
const { safeEqual, verifyMetaSignature } = require('../../util/webhookSignature');
const accountService = require('../../services/instagramAccountService');
const router = express.Router();

// GET /api/webhook/instagram — Meta verification, checked per-account (like WhatsApp)
router.get('/webhook/instagram', async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  let accepted = false;
  if (mode === 'subscribe' && token) {
    const { rows } = await pool.query(`SELECT webhook_verify_token FROM coexistence.instagram_accounts`);
    for (const r of rows) {
      if (safeEqual(r.webhook_verify_token, token)) { accepted = true; break; }
    }
  }
  if (accepted) return res.status(200).type('text/plain').send(String(challenge ?? ''));
  res.sendStatus(403);
});

// POST /api/webhook/instagram — inbound DMs/comments/etc
router.post('/webhook/instagram', async (req, res) => {
  try {
    const sig = verifyMetaSignature(req);
    if (sig === false) return res.status(403).json({ error: 'Invalid webhook signature' });
    if (sig === null) console.warn('[ig-webhook] META_IG_APP_SECRET not set — unverified inbound payload');

    const body = req.body;
    if (body.object !== 'instagram') return res.status(200).json({ ok: true });

    for (const entry of body.entry || []) {
      const igBusinessId = entry.id; // the Page's linked IG business account id
      const account = await accountService.getAccountByBusinessId(igBusinessId);
      if (!account) { console.warn('[ig-webhook] no account for', igBusinessId); continue; }

      for (const messaging of entry.messaging || []) {
        await handleMessaging(account, messaging);
      }
      await accountService.touchLastSync(account.id);
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[ig-webhook] error:', err.message);
    res.status(200).json({ ok: false, error: 'Processing error' });
  }
});

async function handleMessaging(account, messaging) {
  const senderId = messaging.sender?.id;
  const message = messaging.message;
  if (!senderId || !message) return; // ignore reads/deliveries for now

  const contact = await upsertContact(account.id, senderId);
  const conversation = await upsertConversation(account.id, contact.id);

  await pool.query(
    `INSERT INTO coexistence.instagram_messages (conversation_id, direction, content, status)
     VALUES ($1, 'inbound', $2, 'received')`,
    [conversation.id, message.text || '[non-text message]']
  );
  await pool.query(
    `UPDATE coexistence.instagram_contacts SET last_message = $1, updated_at = NOW() WHERE id = $2`,
    [message.text || '[non-text message]', contact.id]
  );
  await pool.query(
    `UPDATE coexistence.instagram_conversations SET updated_at = NOW() WHERE id = $1`,
    [conversation.id]
  );
}

async function upsertContact(accountId, igUserId) {
  const existing = await pool.query(
    `SELECT * FROM coexistence.instagram_contacts WHERE ig_user_id = $1 AND instagram_account_id = $2`,
    [igUserId, accountId]
  );
  if (existing.rows[0]) return existing.rows[0];
  const { rows } = await pool.query(
    `INSERT INTO coexistence.instagram_contacts (ig_user_id, username, display_name, instagram_account_id)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [igUserId, igUserId, igUserId, accountId]
  );
  return rows[0];
}

async function upsertConversation(accountId, contactId) {
  const existing = await pool.query(
    `SELECT * FROM coexistence.instagram_conversations WHERE contact_id = $1 AND instagram_account_id = $2`,
    [contactId, accountId]
  );
  if (existing.rows[0]) return existing.rows[0];
  const { rows } = await pool.query(
    `INSERT INTO coexistence.instagram_conversations (contact_id, status, instagram_account_id)
     VALUES ($1, 'open', $2) RETURNING *`,
    [contactId, accountId]
  );
  return rows[0];
}

module.exports = { router };