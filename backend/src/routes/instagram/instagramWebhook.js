const express = require('express');
const pool = require('../../db');
const { safeEqual, verifyMetaSignature } = require('../../util/webhookSignature');
const accountService = require('../../services/instagramAccountService');
const { evaluateInstagramTriggers } = require('../../engine/instagram/instagramWorkflowEngine');
const router = express.Router();

// ── Duplicate-webhook protection ─────────────────────────────────────────
// Meta redelivers a webhook event if the endpoint doesn't 200 fast enough
// (or on any transient error), keyed by the message's own `mid`. There is
// no existing dedup mechanism anywhere in the Instagram module and
// instagram_messages has no unique message-id column to key an ON CONFLICT
// off (adding one is a schema change — see note below), so this is the
// smallest safe protection possible without touching the schema: an
// in-memory TTL cache of recently-seen mids. This covers Meta's actual
// retry behavior (short-window redelivery) but is NOT durable across a
// process restart/redeploy. A durable fix — a `mid TEXT UNIQUE` column on
// instagram_messages with `ON CONFLICT (mid) DO NOTHING` — is a genuine
// schema change and is called out separately for approval rather than
// applied here.
const SEEN_MID_TTL_MS = 10 * 60 * 1000; // 10 minutes
const seenMids = new Map(); // mid -> expiry timestamp

function isDuplicateMid(mid) {
  if (!mid) return false;
  const now = Date.now();
  // Opportunistic cleanup so this map can't grow unbounded.
  if (seenMids.size > 5000) {
    for (const [k, exp] of seenMids) if (exp < now) seenMids.delete(k);
  }
  const expiry = seenMids.get(mid);
  if (expiry && expiry > now) return true;
  seenMids.set(mid, now + SEEN_MID_TTL_MS);
  return false;
}

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

  // Meta redelivery protection (see isDuplicateMid above). message.is_echo
  // marks messages the business account itself sent (e.g. via the app or
  // Instagram's own inbox UI) — these are not customer messages and must
  // never trigger a workflow.
  if (message.is_echo) return;
  if (isDuplicateMid(message.mid)) {
    console.log('[ig-webhook] duplicate mid, skipping:', message.mid);
    return;
  }

  const contact = await upsertContact(account.id, account.workspace_id, senderId);
  const isNewConversation = await conversationExists(account.id, contact.id) === false;
  const conversation = await upsertConversation(account.id, account.workspace_id, contact.id);

  const text = message.text || '[non-text message]';

  await pool.query(
    `INSERT INTO coexistence.instagram_messages (conversation_id, direction, content, status)
     VALUES ($1, 'inbound', $2, 'received')`,
    [conversation.id, text]
  );
  await pool.query(
    `UPDATE coexistence.instagram_contacts SET last_message = $1, updated_at = NOW() WHERE id = $2`,
    [text, contact.id]
  );
  await pool.query(
    `UPDATE coexistence.instagram_conversations SET updated_at = NOW() WHERE id = $1`,
    [conversation.id]
  );

  // ── Live workflow trigger ────────────────────────────────────────────
  // workspace_id always comes from the owning account row resolved above
  // (account.workspace_id), never from the inbound Meta payload — this is
  // what enforces "Workspace A's Instagram account can never fire
  // Workspace B's workflow" per the Phase 4.4 requirement. A failure here
  // must not crash the webhook — evaluateInstagramTriggers already
  // catches internally, but this call is additionally wrapped so a bug in
  // future workflow node types can never take the webhook down.
  try {
    await evaluateInstagramTriggers({
      workspaceId: account.workspace_id,
      incomingMessage: message.text || '',
      account,
      igUserId: senderId,
      conversationId: conversation.id,
      contactId: contact.id,
      contactName: contact.display_name || contact.username || '',
      isNewConversation,
    });
  } catch (err) {
    console.error('[ig-webhook] workflow trigger error:', err.message);
  }
}

async function conversationExists(accountId, contactId) {
  const { rows } = await pool.query(
    `SELECT id FROM coexistence.instagram_conversations WHERE contact_id = $1 AND instagram_account_id = $2`,
    [contactId, accountId]
  );
  return rows.length > 0;
}

// workspaceId is the owning account's stored workspace_id — never derived
// from anything in the inbound Meta payload — so new inbound contacts/
// conversations land in the correct workspace's inbox immediately, instead
// of sitting as orphans (workspace_id NULL) until the next boot's backfill.
async function upsertContact(accountId, workspaceId, igUserId) {
  const existing = await pool.query(
    `SELECT * FROM coexistence.instagram_contacts WHERE ig_user_id = $1 AND instagram_account_id = $2`,
    [igUserId, accountId]
  );
  if (existing.rows[0]) return existing.rows[0];
  const { rows } = await pool.query(
    `INSERT INTO coexistence.instagram_contacts (ig_user_id, username, display_name, instagram_account_id, workspace_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [igUserId, igUserId, igUserId, accountId, workspaceId]
  );
  return rows[0];
}

async function upsertConversation(accountId, workspaceId, contactId) {
  const existing = await pool.query(
    `SELECT * FROM coexistence.instagram_conversations WHERE contact_id = $1 AND instagram_account_id = $2`,
    [contactId, accountId]
  );
  if (existing.rows[0]) return existing.rows[0];
  const { rows } = await pool.query(
    `INSERT INTO coexistence.instagram_conversations (contact_id, status, instagram_account_id, workspace_id)
     VALUES ($1, 'open', $2, $3) RETURNING *`,
    [contactId, accountId, workspaceId]
  );
  return rows[0];
}
module.exports = { router };