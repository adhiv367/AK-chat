const { Router } = require('express');
const pool = require('../db');
const { decrypt } = require('../util/crypto');
const { findProduct } =
require("../services/productAutomation");
const { getProduct } =
require("../services/shopifyService");
const {
 generateReply
} = require(
 "../services/aiReplyService"
);
const { safeEqual, verifyMetaSignature, verifyForwardSecret } = require('../util/webhookSignature');
const { evaluateTriggers, resumeAutomation } = require('../engine/automationEngine');
const { hasManualReplyTag } = require('../services/automationGuard');
const { markPending, MEDIA_TYPES } = require('../services/mediaDownloader');
const { enqueueMediaDownload } = require('../queue/mediaQueue');
const { resolveAccount, insertPendingRow } = require('../services/messageSender');
const { enqueueSend } = require('../queue/sendQueue');
const { prepareProductImage } = require('../services/imagePrep');
const { uploadMedia } = require('../integrations/metaSend');
const { syncConversationToZoho } = require('../services/zohoSyncService');
// Root-cause fix (inbound-message-invisible-in-Inbox bug): resolve the
// CANONICAL wa_number for a webhook delivery from the account record
// (looked up by the Meta-assigned, globally-unique phone_number_id),
// rather than trusting the raw metadata.display_phone_number Meta sends
// on that particular delivery. See the resolveCanonicalWaNumber() comment
// below for why these can diverge and why every Inbox/list/contacts query
// (routes/messages.js) silently drops a row whose wa_number doesn't match.
const { getAccountByPhoneNumber } = require('./whatsappAccounts');
const { recordFlowSubmission } = require('../services/flowSubmissionService');
const orderService = require('../services/orderService'); // Phase 7.7 — Cart
const { applyCtwaContactAttribution } = require('../services/ctwaAttributionService'); // Phase 11B
// Phase 12 Step 7 fix — contact.created was never emitted for a contact
// auto-created by an inbound WhatsApp message (only routes/contacts.js's
// manual "Add Contact" and routes/apiV1.js's public POST /v1/contacts
// called this). See the profile-name upsert below for the guarded
// emission that closes that gap. Does not touch coexistence.webhook_events
// (the legacy Meta inbound table this file otherwise owns) — this only
// adds a call into the separate Phase 12 webhook engine.
const webhookService = require('../services/webhookService');

const router = Router();

// Temporary test switch for Phase 4.1: allows disabling the external Grok AI
// Bridge so the native AK Chat Gemini ai_reply path can be tested in isolation.
// Absent or any value other than the literal string 'false' => Bridge stays enabled.
const AI_BRIDGE_ENABLED = process.env.AI_BRIDGE_ENABLED !== 'false';

/**
 * Parse a Meta WhatsApp Cloud API webhook payload and extract message records.
 * Handles: text, image, video, audio, document, location, sticker, contacts,
 *          interactive (button_reply / list_reply), reaction, and status updates.
 */
// Normalize WhatsApp phone numbers to digits-only — strips '+', spaces, dashes.
// Meta sometimes includes leading '+' in display_phone_number, sometimes not;
// without this, the same conversation lands under two different wa_numbers and
// shows as duplicate chat threads.
function normalizePhone(s) {
  if (!s) return s;
  return String(s).replace(/\D/g, '');
}

// Root cause of the "inbound message never appears in Inbox" bug:
// every Inbox-facing query (routes/messages.js GET /numbers, /contacts,
// /messages) filters chat_history by wa_number equal to the CANONICAL
// value stored on coexistence.whatsapp_accounts.display_phone_number
// (itself captured once, at connect-time, from the Graph API — see
// fetchPhoneMeta() in routes/whatsappAccounts.js). The webhook handler,
// however, used to stamp every inbound record's wa_number straight from
// THIS delivery's metadata.display_phone_number instead of that stored
// canonical value. Meta does not guarantee those two strings normalize to
// the same digits on every delivery for every account (WhatsApp Business
// App "coexistence" numbers in particular can report a differently
// formatted display number — e.g. missing/extra country-code digits —
// on personal-app-originated inbound webhooks than the Graph API returned
// at onboarding). When they differ, the row is stored correctly (nothing
// in the webhook path fails or throws) but every Inbox query's
// `wa_number = ...` / `wa_number = ANY(...)` filter excludes it, so it
// silently never renders — while automation/Zoho/order ingestion, which
// all resolve the account via phone_number_id (never via wa_number), are
// completely unaffected and keep working, exactly matching the reported
// symptom split.
//
// Fix: resolve the account ONCE per (phone_number_id) via
// getAccountByPhoneNumber(phoneNumberId) — the same Meta-assigned,
// globally-unique id every other resolution path in this codebase already
// treats as authoritative (never the customer's number) — and use ITS
// stored displayPhoneNumber for every record's wa_number. Falls back to
// the payload's own display_phone_number only if no account is found yet
// (e.g. a delivery that arrives before onboarding finishes), which
// preserves prior behavior for that edge case rather than dropping the
// message.
async function resolveCanonicalWaNumber(phoneNumberId, fallbackDisplayNumber, cache) {
  const fallback = normalizePhone(fallbackDisplayNumber);
  if (!phoneNumberId) return fallback;
  if (cache.has(phoneNumberId)) return cache.get(phoneNumberId);
  let resolved = fallback;
  try {
    const acct = await getAccountByPhoneNumber(phoneNumberId);
    if (acct && acct.displayPhoneNumber) {
      resolved = normalizePhone(acct.displayPhoneNumber);
    }
  } catch (err) {
    console.error('[webhook] canonical wa_number lookup failed for phone_number_id', phoneNumberId, ':', err.message);
  }
  cache.set(phoneNumberId, resolved);
  return resolved;
}

async function parseMetaPayload(body, waNumberCache) {
  const records = [];

  if (!body || body.object !== 'whatsapp_business_account') {
    return records;
  }

  const entries = body.entry || [];
  for (const entry of entries) {
    const changes = entry.changes || [];
    for (const change of changes) {
      const value = change.value || {};
      if (value.messaging_product !== 'whatsapp') continue;

      const metadata = value.metadata || {};
      const phoneNumberId = metadata.phone_number_id || '';
      const displayPhoneNumber = metadata.display_phone_number || '';
      // Canonical wa_number for every record produced from this change —
      // see resolveCanonicalWaNumber() above.
      const canonicalWaNumber = await resolveCanonicalWaNumber(phoneNumberId, displayPhoneNumber, waNumberCache);

      // Contact profile info (name mapping)
      const contactProfiles = {};
      (value.contacts || []).forEach(c => {
        const waId = c.wa_id || '';
        const name = c.profile?.name || '';
        if (waId && name) contactProfiles[waId] = name;
      });

      // Parse a single message (shared logic for incoming and outgoing)
      function parseMessage(msg, direction, waNum, contactNum) {
        const record = {
          message_id: msg.id || '',
          phone_number_id: phoneNumberId,
          // waNum is always the caller-supplied canonicalWaNumber (see call
          // sites below) — normalizePhone() is idempotent so this is a no-op
          // safety net, not a second source of truth.
          wa_number: normalizePhone(waNum),
          contact_number: normalizePhone(contactNum || ''),
          to_number: normalizePhone(msg.to || ''),
          direction,
          message_type: msg.type || 'unknown',
          message_body: null,
          raw_payload: JSON.stringify(body),
          media_url: null,
          media_mime_type: null,
          status: direction === 'incoming' ? 'received' : 'sent',
          timestamp: msg.timestamp
            ? new Date(parseInt(msg.timestamp, 10) * 1000).toISOString()
            : new Date().toISOString(),
          contact_name: contactProfiles[contactNum] || null,
          // Quote-reply: when the customer replies to a specific message, Meta
          // sends the quoted message's wamid here. Stored so we can render the
          // quoted bubble above their reply.
          context_message_id: msg.context?.id || null,
          // Phase 11A — CTWA referral (null when absent/unparseable; never
          // throws, never affects any other field on this record).
          ctwa_referral: parseCtwaReferral(msg),
        };

        const type = msg.type;
        if (type === 'text' && msg.text) {
          record.message_body = msg.text.body || '';
        } else if (type === 'image' && msg.image) {
          record.message_body = msg.image.caption || '';
          record.media_mime_type = msg.image.mime_type || null;
          record.media_url = msg.image.id || null;
        } else if (type === 'video' && msg.video) {
          record.message_body = msg.video.caption || '';
          record.media_mime_type = msg.video.mime_type || null;
          record.media_url = msg.video.id || null;
        } else if (type === 'audio' && msg.audio) {
          record.message_body = 'Audio message';
          record.media_mime_type = msg.audio.mime_type || null;
          record.media_url = msg.audio.id || null;
        } else if (type === 'voice' && msg.voice) {
          record.message_body = 'Voice message';
          record.media_mime_type = msg.voice.mime_type || null;
          record.media_url = msg.voice.id || null;
        } else if (type === 'document' && msg.document) {
          record.message_body = msg.document.filename || '';
          record.media_mime_type = msg.document.mime_type || null;
          record.media_url = msg.document.id || null;
          record.media_filename = msg.document.filename || null;
        } else if (type === 'location' && msg.location) {
          const lat = msg.location.latitude || '';
          const lng = msg.location.longitude || '';
          record.message_body = `Location: ${lat}, ${lng}`;
        } else if (type === 'sticker' && msg.sticker) {
          record.message_body = 'Sticker';
          record.media_mime_type = msg.sticker.mime_type || null;
          record.media_url = msg.sticker.id || null;
        } else if (type === 'contacts' && msg.contacts) {
          const names = msg.contacts.map(c => c.name?.formatted_name || c.name?.first_name || 'Contact').join(', ');
          record.message_body = `Shared contact(s): ${names}`;
        } else if (type === 'interactive' && msg.interactive) {
          const btnReply  = msg.interactive.button_reply  || null;
          const listReply = msg.interactive.list_reply    || null;
          // Phase 6.5 — WhatsApp Flow submission. Kept as its own
          // message_type ('flow_response'), NOT 'interactive', so it does
          // not fall into the existing button_reply/list_reply AI-reply
          // path below (which keys off msgType === 'interactive') — purely
          // additive; button_reply/list_reply behavior is untouched.
          const nfmReply  = msg.interactive.nfm_reply     || null;
          if (btnReply) {
            // Encode as "ID::<id>::<title>" so ai_bridge.py can extract btn_id
            const btnId    = btnReply.id    || '';
            const btnTitle = btnReply.title || '';
            record.message_body = `ID::${btnId}::${btnTitle}`;
            record.message_type = 'interactive';
          } else if (listReply) {
            const listId    = listReply.id    || '';
            const listTitle = listReply.title || '';
            record.message_body = `ID::${listId}::${listTitle}`;
            record.message_type = 'interactive';
          } else if (nfmReply) {
            record.message_body = nfmReply.body || 'Flow response received';
            record.message_type = 'flow_response';
            // Raw block only — resolved/persisted downstream by
            // flowSubmissionService.recordFlowSubmission(), never trusted
            // as-is for workspace/flow identity.
            record.nfm_reply = nfmReply;
          } else {
            record.message_body = 'Interactive response';
            record.message_type = 'interactive';
          }
        } else if (type === 'reaction' && msg.reaction) {
          record.message_body = `Reaction: ${msg.reaction.emoji || ''}`;
          record.message_type = 'reaction';
          // Capture the target message + emoji so the insert loop can attach it
          // to that message instead of creating a standalone bubble. Empty emoji
          // = the customer removed their reaction.
          record.reaction = {
            targetMessageId: msg.reaction.message_id || null,
            emoji: msg.reaction.emoji || '',
            from: msg.from || null,
          };
        } else if (type === 'order' && msg.order) {
          const itemCount = Array.isArray(msg.order.product_items) ? msg.order.product_items.length : 0;
          record.message_body = itemCount > 0 ? `Order received (${itemCount} item${itemCount === 1 ? '' : 's'})` : 'Order received';
          // Phase 7.7 — Cart: raw block only, resolved/persisted downstream
          // by orderService.createOrderFromWhatsappMessage(), never trusted
          // as-is for workspace identity — mirrors the nfm_reply pattern
          // just above.
          record.order = msg.order;
        } else if (type === 'system' && msg.system) {
          record.message_body = msg.system.body || 'System message';
        } else if (type === 'unknown' && msg.errors) {
          record.message_body = `Error: ${msg.errors[0]?.message || 'Unknown error'}`;
          record.status = 'error';
        }

        return record;
      }

      // Incoming messages
      const messages = value.messages || [];
      for (const msg of messages) {
        records.push(parseMessage(msg, 'incoming', canonicalWaNumber, msg.from));
      }

      // Outgoing message echoes (messages sent from the WhatsApp Business app)
      const messageEchoes = value.message_echoes || [];
      for (const msg of messageEchoes) {
        // For echoes: from = business number, to = customer
        records.push(parseMessage(msg, 'outgoing', canonicalWaNumber, msg.to));
      }

      // Status updates (delivered, read, sent)
      const statuses = value.statuses || [];
      for (const status of statuses) {
        records.push({
          message_id: status.id || '',
          phone_number_id: phoneNumberId,
          wa_number: canonicalWaNumber,
          contact_number: normalizePhone(status.recipient_id || ''),
          to_number: normalizePhone(status.recipient_id || ''),
          direction: 'outgoing',
          message_type: 'status',
          message_body: `Status: ${status.status || ''}`,
          raw_payload: JSON.stringify(body),
          media_url: null,
          media_mime_type: null,
          status: status.status || 'unknown',
          timestamp: status.timestamp
            ? new Date(parseInt(status.timestamp, 10) * 1000).toISOString()
            : new Date().toISOString(),
          contact_name: contactProfiles[status.recipient_id] || null,
          // Include full status payload for trigger evaluation
          conversation: status.conversation || null,
          pricing: status.pricing || null,
          errors: status.errors || null,
        });
      }
    }
  }

  return records;
}

// Phase 11A — CTWA (Click-to-WhatsApp Ad) referral capture.
// Meta attaches a `referral` object to the first inbound message of a
// conversation that originated from a WhatsApp CTWA ad click. Shape (all
// fields optional/partial in practice):
//   {
//     source_url, source_type, source_id, headline, body, media_type,
//     image_url, video_url, thumbnail_url, ctwa_clid
//   }
// This is read-only, best-effort extraction: never throws, never assumes
// any field is present, and never touches message parsing for messages
// that lack a referral entirely (the vast majority). Returns null when
// there is nothing usable, so callers can treat "no referral" uniformly
// whether the field was absent or malformed.
function parseCtwaReferral(msg) {
  const ref = msg && msg.referral;
  if (!ref || typeof ref !== 'object') return null;

  const ctwa_clid = typeof ref.ctwa_clid === 'string' ? ref.ctwa_clid : null;
  const referral_source_url = typeof ref.source_url === 'string' ? ref.source_url : null;
  const referral_source_type = typeof ref.source_type === 'string' ? ref.source_type : null;
  const referral_source_id = typeof ref.source_id === 'string' ? ref.source_id : null;
  const referral_headline = typeof ref.headline === 'string' ? ref.headline : null;
  const referral_media_type = typeof ref.media_type === 'string' ? ref.media_type : null;

  // Partial referral objects are common (Meta doesn't guarantee every
  // field); only treat it as "no referral" if literally everything is
  // missing, otherwise store whatever fields ARE present.
  if (
    ctwa_clid === null && referral_source_url === null && referral_source_type === null &&
    referral_source_id === null && referral_headline === null && referral_media_type === null
  ) {
    return null;
  }

  return {
    ctwa_clid,
    referral_source_url,
    referral_source_type,
    referral_source_id,
    referral_headline,
    referral_media_type,
  };
}

// Redacts a phone number / wa_id down to its last 4 digits for logging.
function maskId(id) {
  const s = String(id || '');
  if (s.length <= 4) return s ? '***' : '';
  return `***${s.slice(-4)}`;
}

// Builds a small, non-sensitive summary of an inbound Meta WhatsApp webhook
// payload for logging — counts and types only, never message bodies, names,
// media, or full contact identifiers.
function summarizeWhatsappWebhook(body) {
  try {
    const entries = Array.isArray(body?.entry) ? body.entry : [];
    let messages = 0, statuses = 0;
    const numbers = new Set();
    for (const entry of entries) {
      for (const change of entry?.changes || []) {
        const value = change?.value || {};
        for (const m of value.messages || []) {
          messages += 1;
          if (m?.from) numbers.add(maskId(m.from));
        }
        for (const s of value.statuses || []) {
          statuses += 1;
          if (s?.recipient_id) numbers.add(maskId(s.recipient_id));
        }
      }
    }
    return { entries: entries.length, messages, statuses, numbers: Array.from(numbers) };
  } catch {
    return { summary: 'unavailable' };
  }
}

/**
 * POST /api/webhook/whatsapp
 * Receives raw Meta WhatsApp webhook payloads forwarded by n8n.
 * No auth required — called by internal n8n instance.
 */
router.post('/webhook/whatsapp', async (req, res) => {
  try {
    // ── Local dev mirror auth (demo bridge) ───────────────────────────
    // A forwarded copy of an ALREADY-Meta-verified payload (see the
    // fire-and-forget forward further below) arrives re-serialized by
    // fetch(), so it will never carry a byte-identical X-Hub-Signature-256
    // HMAC over its own body — that is expected, not a spoofing attempt.
    // It is authenticated instead by a separate shared secret configured
    // on both the forwarding and receiving instance
    // (LOCAL_WEBHOOK_FORWARD_SECRET), compared in constant time. This path
    // is only reachable when the RECEIVING instance has that secret
    // configured; otherwise every request falls straight through to the
    // normal Meta signature verification below, completely unchanged.
    const isForwardedCopy = verifyForwardSecret(req, process.env.LOCAL_WEBHOOK_FORWARD_SECRET);

    // Authenticity: this endpoint is necessarily unauthenticated (public), so
    // the control is Meta's HMAC signature. When META_APP_SECRET is configured
    // we REJECT anything unsigned/invalid.
    // Phase 7.11 (F-4): previously, an unconfigured META_APP_SECRET caused this
    // endpoint to log a warning and PROCESS the payload anyway (fail-open) —
    // never process an unverifiable webhook as if it were trusted. This now
    // matches billing.js's POST /billing/webhook fail-closed pattern for its
    // own null (unconfigured) case: reject rather than proceed.
    //
    // Security fix (Phase 9E): the raw payload used to be logged in full
    // BEFORE signature verification — an unauthenticated caller could push
    // arbitrary contact/message content straight into server logs. We now
    // verify first, and even then only log a small redacted summary, never
    // the raw body.
    if (!isForwardedCopy) {
      const sig = verifyMetaSignature(req);
      if (sig === false) {
        return res.status(403).json({ error: 'Invalid webhook signature' });
      }
      if (sig === null) {
        console.error('[webhook] META_APP_SECRET not configured — rejecting inbound webhook (cannot verify authenticity).');
        return res.status(501).json({ error: 'Webhook signature verification is not configured' });
      }
    }
    console.log('[webhook] whatsapp payload received:', summarizeWhatsappWebhook(req.body), isForwardedCopy ? '(forwarded copy — storage-only, no AI/automation)' : '');

    const payload = req.body;
    if (!payload) {
      return res.status(400).json({ error: 'Empty payload' });
    }

    // ── Local dev mirror forward (demo bridge) ──────────────────────────
    // Fire-and-forget copy of this verified inbound payload to a local dev
    // backend (e.g. via an ngrok tunnel), purely so a local Inbox can
    // display live messages without ever being in Meta's real delivery
    // path. Never awaited by the main flow below: any failure (tunnel
    // offline, DNS, timeout) is caught right here and only logged — it can
    // never delay or fail this response, the DB write, or the AI reply.
    // Never re-forwards a request that is itself a forwarded copy, so two
    // mirrored instances can never loop. No-op unless an operator has
    // explicitly set LOCAL_WEBHOOK_FORWARD_URL on THIS instance.
    if (!isForwardedCopy && process.env.LOCAL_WEBHOOK_FORWARD_URL) {
      const forwardUrl = process.env.LOCAL_WEBHOOK_FORWARD_URL;
      const forwardHeaders = { 'Content-Type': 'application/json' };
      if (process.env.LOCAL_WEBHOOK_FORWARD_SECRET) {
        forwardHeaders['X-Akchat-Forward-Secret'] = process.env.LOCAL_WEBHOOK_FORWARD_SECRET;
      }
      const forwardController = new AbortController();
      const forwardTimeout = setTimeout(() => forwardController.abort(), 5000);
      fetch(forwardUrl, {
        method: 'POST',
        headers: forwardHeaders,
        body: JSON.stringify(payload),
        signal: forwardController.signal,
      })
        .catch((err) => console.error('[webhook] local mirror forward failed (non-blocking):', err.message))
        .finally(() => clearTimeout(forwardTimeout));
    }

    // Support both array of payloads (n8n batch) and single payload
    const payloads = Array.isArray(payload) ? payload : [payload];
    const allRecords = [];
    // Shared across every payload/change in this delivery so a batch touching
    // the same phone_number_id multiple times only looks the account up once.
    const waNumberCache = new Map();
    for (const p of payloads) {
      const records = await parseMetaPayload(p, waNumberCache);
      allRecords.push(...records);
    }

    if (allRecords.length === 0) {
      // Acknowledge non-message webhooks (e.g. verification, errors)
      return res.status(200).json({ ok: true, stored: 0 });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const r of allRecords) {
        // Status receipts (sent/delivered/read/failed) update the ORIGINAL
        // message's status — they must never create a chat row. Inserting them
        // produced phantom "Status: delivered" bubbles. If no matching message
        // exists (e.g. an app-sent message we don't track), this is a no-op.
        if (r.message_type === 'status') {
          // Phase 6 Part 3B — ordering guard. Meta may re-deliver webhook
          // events out of order (its own retries, or n8n forwarding jitter).
          // Without a guard, a duplicate/late 'delivered' event arriving
          // after 'read' was already recorded would regress the row back to
          // 'delivered' — a real downgrade the UI (and the broadcast rollup
          // in routes/broadcasts.js, which joins on this same status) must
          // never show. Rank 'failed' alongside 'sent': it can supersede the
          // optimistic 'sent' row (the normal case — Meta accepted the send,
          // then delivery ultimately failed), but a message already marked
          // delivered/read cannot regress to failed either. Ties (rank equal,
          // e.g. duplicate delivery of the same status) are allowed through
          // as a harmless no-op write — this is what keeps the update
          // idempotent rather than needing a separate duplicate-detection
          // table. Statuses outside this known set (e.g. 'sending', the
          // initial inbound value) rank lowest and are always superseded.
          await client.query(
            `UPDATE coexistence.chat_history
                SET status = $1
              WHERE message_id = $2
                AND (
                  CASE status
                    WHEN 'read' THEN 3
                    WHEN 'delivered' THEN 2
                    WHEN 'sent' THEN 1
                    WHEN 'failed' THEN 1
                    ELSE 0
                  END
                  <=
                  CASE $1
                    WHEN 'read' THEN 3
                    WHEN 'delivered' THEN 2
                    WHEN 'sent' THEN 1
                    WHEN 'failed' THEN 1
                    ELSE 0
                  END
                )`,
            [r.status, r.message_id]
          );

          // Failure receipts must also propagate to broadcast_logs — chat_history
          // alone drives the Delivery UI's sent/delivered/read rollup (via the
          // wa_message_id -> chat_history.message_id join in getBroadcastWithLogs),
          // but the failed/success counts there are read straight off
          // broadcast_logs.status, which this status branch never touched. A
          // send that Meta later fails post-acceptance (e.g. a billing-eligibility
          // error) therefore stayed 'sent' forever with no error_message. Reuse
          // the same wa_message_id correlation key the rollup query already
          // uses — no new correlation mechanism. Only 'failed' is written here;
          // sent/delivered/read continue to be derived from chat_history as
          // before, so that behavior is untouched.
          if (r.status === 'failed' && r.message_id) {
            const firstError = Array.isArray(r.errors) && r.errors.length ? r.errors[0] : null;
            const detail = firstError
              ? `${firstError.title || firstError.message || 'Message failed'}${firstError.code ? ` (code ${firstError.code})` : ''}`
              : 'Message failed';
            await client.query(
              `UPDATE coexistence.broadcast_logs
                  SET status = 'failed', error_message = $1
                WHERE wa_message_id = $2`,
              [detail.slice(0, 500), r.message_id]
            );
          }
          continue;
        }

        // Reactions are NOT chat bubbles — attach the emoji to the message it
        // reacts to (message_reactions). An empty emoji removes the reaction.
        if (r.message_type === 'reaction') {
          const tgt = r.reaction?.targetMessageId;
          if (tgt) {
            if (r.reaction.emoji) {
              await client.query(
                `INSERT INTO coexistence.message_reactions
                   (wa_number, contact_number, target_message_id, direction, emoji, reactor, updated_at)
                 VALUES ($1,$2,$3,$4,$5,$6,NOW())
                 ON CONFLICT (target_message_id, direction)
                 DO UPDATE SET emoji = EXCLUDED.emoji, reactor = EXCLUDED.reactor, updated_at = NOW()`,
                [r.wa_number, r.contact_number, tgt, r.direction, r.reaction.emoji, r.reaction.from || null]
              );
            } else {
              await client.query(
                `DELETE FROM coexistence.message_reactions WHERE target_message_id = $1 AND direction = $2`,
                [tgt, r.direction]
              );
            }
          }
          continue;
        }

        // Upsert chat_history (ignore duplicates on message_id)
        //
        // Phase 11A — CTWA referral columns are additive and first-touch:
        // on a duplicate/retried webhook delivery for the same message_id,
        // an already-stored referral value must never be clobbered (Meta
        // only sends `referral` on the first inbound message of a CTWA
        // conversation, but retries of that same webhook are still
        // possible). COALESCE(existing, incoming) keeps whichever value
        // was written first and only fills a column in if it was NULL —
        // it never overwrites a previously captured value. status and
        // raw_payload keep their existing (non-referral) overwrite
        // behavior, unchanged.
        await client.query(
          `INSERT INTO coexistence.chat_history
            (message_id, phone_number_id, wa_number, contact_number, to_number,
             direction, message_type, message_body, raw_payload, media_url,
             media_mime_type, media_filename, status, timestamp, context_message_id,
             ctwa_clid, referral_source_url, referral_source_type,
             referral_source_id, referral_headline, referral_media_type)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
           ON CONFLICT (message_id) DO UPDATE SET
             status = EXCLUDED.status,
             raw_payload = EXCLUDED.raw_payload,
             ctwa_clid = COALESCE(coexistence.chat_history.ctwa_clid, EXCLUDED.ctwa_clid),
             referral_source_url = COALESCE(coexistence.chat_history.referral_source_url, EXCLUDED.referral_source_url),
             referral_source_type = COALESCE(coexistence.chat_history.referral_source_type, EXCLUDED.referral_source_type),
             referral_source_id = COALESCE(coexistence.chat_history.referral_source_id, EXCLUDED.referral_source_id),
             referral_headline = COALESCE(coexistence.chat_history.referral_headline, EXCLUDED.referral_headline),
             referral_media_type = COALESCE(coexistence.chat_history.referral_media_type, EXCLUDED.referral_media_type)`,
          [
            r.message_id, r.phone_number_id, r.wa_number, r.contact_number, r.to_number,
            r.direction, r.message_type, r.message_body, r.raw_payload, r.media_url,
            r.media_mime_type, r.media_filename || null, r.status, r.timestamp,
            r.context_message_id || null,
            r.ctwa_referral?.ctwa_clid || null,
            r.ctwa_referral?.referral_source_url || null,
            r.ctwa_referral?.referral_source_type || null,
            r.ctwa_referral?.referral_source_id || null,
            r.ctwa_referral?.referral_headline || null,
            r.ctwa_referral?.referral_media_type || null,
          ]
        );

        // Upsert the WhatsApp profile/push name into profile_name (NOT name).
        // `name` is reserved for a name we explicitly captured (AI ask-name flow
        // or manual save) so inbound messages don't clobber it — that clobbering
        // is what made the automation "is the contact known?" condition always
        // true. Display falls back to COALESCE(name, profile_name).
        if (r.contact_number && r.wa_number && r.contact_name) {
          // Phase 7.10A — FIX 2: a brand-new contact created here previously
          // got workspace_id = NULL, since this insert path never set it.
          // The workspace is already resolvable from the WhatsApp account
          // that received the message (r.phone_number_id), same lookup
          // resolveAccount()/getAccountByPhoneNumber() do elsewhere in this
          // file — done here as a direct scoped query so it runs inside the
          // same transaction as the insert. Only used for a NEW contact
          // (via COALESCE below); an existing contact's workspace_id is
          // never overwritten by a later message.
          const { rows: acctRows } = await client.query(
            `SELECT workspace_id FROM coexistence.whatsapp_accounts WHERE phone_number_id = $1 LIMIT 1`,
            [r.phone_number_id]
          );
          const contactWorkspaceId = acctRows[0]?.workspace_id ?? null;
          // Phase 12 Step 7 fix — (xmax = 0) is the standard Postgres way to
          // tell an INSERT from an ON CONFLICT DO UPDATE within one
          // RETURNING: true only when this statement itself created the row
          // (xmax is unset on a fresh insert), false when it updated an
          // existing one. Needed so contact.created fires once, on genuine
          // creation, not on every subsequent inbound message from an
          // already-known contact.
          const { rows: upsertRows } = await client.query(
            `INSERT INTO coexistence.contacts (workspace_id, wa_number, contact_number, profile_name)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (wa_number, contact_number) DO UPDATE SET
               profile_name = EXCLUDED.profile_name,
               workspace_id = COALESCE(coexistence.contacts.workspace_id, EXCLUDED.workspace_id),
               updated_at = NOW()
             RETURNING id, created_at, (xmax = 0) AS inserted`,
            [contactWorkspaceId, r.wa_number, r.contact_number, r.contact_name]
          );

          // Fire-and-forget, same contract as routes/contacts.js's own
          // contact.created emission: unawaited + .catch()-logged so a
          // webhook/queue/DB hiccup here can never affect this inbound
          // webhook's own transaction or response. Only fires for a truly
          // new row, and only when a workspace was actually resolved (never
          // fires with a null/cross-tenant workspaceId — same isolation
          // contract emitEvent() itself enforces by skipping a falsy
          // workspaceId).
          const newContact = upsertRows[0];
          if (newContact?.inserted && contactWorkspaceId) {
            webhookService.emitEvent(contactWorkspaceId, webhookService.EVENT_TYPES.CONTACT_CREATED, {
              contact_id: newContact.id,
              name: r.contact_name,
              contact_number: r.contact_number,
              wa_number: r.wa_number,
              created_at: newContact.created_at,
            }).catch((err) => console.error('[webhookService] emit contact.created failed:', err.message));
          }
        }

        // ── Phase 11B — CTWA contact attribution ─────────────────────
        // Additive only: runs after the profile-name upsert above (so an
        // existing contact created by it is found here, never duplicated)
        // and inside the SAME transaction as the chat_history insert for
        // this record — see ctwaAttributionService.js for the full design
        // (first-touch only, namespaced custom_fields.ctwa, workspace/
        // WA-number scoped identically to the profile-name upsert). Never
        // throws — a failure here must never abort message storage for
        // the rest of this batch.
        try {
          await applyCtwaContactAttribution(client, r);
        } catch (ctwaErr) {
          console.error('[webhook] CTWA contact attribution error:', ctwaErr.message);
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // ── Local dev mirror guard (demo bridge) ────────────────────────────
    // A forwarded copy is stored above (chat_history/contacts/reactions/
    // statuses — unchanged, unconditional) so the local Inbox reflects it,
    // but everything below this point — Zoho sync, cart/order ingestion,
    // paused-automation resume, fresh trigger evaluation, and the AI reply
    // — is real, side-effecting, message-sending behavior that Render
    // already ran once for this same message. Skipping it here is what
    // keeps Render the only instance that ever replies, and prevents a
    // second local automation run against the same inbound event.
    if (!isForwardedCopy) {
    // Evaluate automation triggers
    // 1. For incoming messages (keyword, anyMessage, newContact triggers)
    //    First: if this conversation has paused executions awaiting a reply,
    //    resume them and SKIP fresh trigger evaluation for that record
    //    (the customer is mid-conversation — see plan: "Resume only — skip
    //    new trigger").
    const incomingRecords = allRecords.filter(r => r.direction === 'incoming' && r.message_type !== 'status' && r.message_type !== 'reaction');
    if (incomingRecords.length > 0) {
      for (const record of incomingRecords) {
        try {
          // ── WhatsApp Flow submission storage (Phase 6.5) ─────
          // Additive only: every other record type (text, image, button
          // taps, etc.) is untouched and falls straight through to Zoho
          // sync / automation below exactly as before. recordFlowSubmission
          // never throws — a malformed/unresolvable Flow reply is logged
          // and skipped, it never aborts webhook processing.
          if (record.message_type === 'flow_response' && record.nfm_reply) {
            try {
              await recordFlowSubmission({
                nfmReply: record.nfm_reply,
                messageId: record.message_id,
                phoneNumberId: record.phone_number_id,
                contactNumber: record.contact_number,
                timestamp: record.timestamp,
                // Phase 6.6 — pass the SAME wa_number already computed for
                // this record's own chat_history row (live Meta
                // metadata.display_phone_number, normalized) so the
                // downstream contact-mapping lookup keys off the exact
                // value every other contact-creating path in this codebase
                // uses for this delivery. Does not change what's written
                // to chat_history/flow_submissions — purely an in-memory
                // value already computed above, threaded through to fix
                // contact-resolution consistency (see flowSubmissionService.js).
                waNumber: record.wa_number,
              });
            } catch (flowSubErr) {
              console.error('[webhook] Flow submission storage error:', flowSubErr.message);
            }
          }
          // ────────────────────────────────────────────────────

          // ── Automatic Zoho CRM sync ─────────────────────────
          // Every eligible incoming WhatsApp message triggers the existing
          // syncConversationToZoho() orchestration (extraction → Lead
          // eligibility → Zoho field mapping → per-number connection →
          // Lead create/update → Note → sync-state bookkeeping), scoped to
          // THIS message's own resolved WhatsApp account context only —
          // never a different/fallback account. Fired in the background
          // (not awaited) so a slow Zoho/Gemini call never delays the
          // WhatsApp response, and any error here is caught and logged —
          // it must never affect the normal WhatsApp AI reply above.
          //
          // Placed BEFORE the paused-automation check/continue below so it
          // fires exactly once per incoming record regardless of whether
          // this record resumes a paused automation or takes the fresh
          // trigger path — previously it lived after the `continue`, so
          // any inbound message with an active paused automation resumed
          // the automation and skipped Zoho sync entirely (Phase 8 bug).
          try {
            const { account: zohoAccount, error: zohoAcctErr } =
              await resolveAccount({ fromPhoneNumber: record.phone_number_id });
            if (zohoAcctErr || !zohoAccount || !zohoAccount.workspaceId) {
              console.error('[Zoho] Sync skipped -- account resolve error:', zohoAcctErr || 'account has no workspaceId');
            } else {
              syncConversationToZoho({
                workspaceId: zohoAccount.workspaceId,
                whatsappAccountId: zohoAccount.id,
                contactNumber: record.contact_number,
              }).catch((syncErr) => {
                console.error('[Zoho] Background sync error:', syncErr.message);
              });
            }
          } catch (zohoTriggerErr) {
            console.error('[Zoho] Sync trigger error:', zohoTriggerErr.message);
          }
          // ────────────────────────────────────────────────────

          // ── WhatsApp-native Cart/Order ingestion (Phase 7.7) ──
          // A customer tapping "Send Cart" on a WhatsApp catalog arrives
          // here as message_type === 'order' with the raw Meta payload on
          // record.order (see parseMessage's `type === 'order'` branch
          // above). Resolved into coexistence.orders/order_items scoped to
          // THIS message's own resolved WhatsApp account/workspace only —
          // never a different/fallback account, same isolation model as
          // the Zoho sync block above. Never throws — a malformed/
          // unresolvable order is logged and skipped, it never aborts
          // webhook processing for the rest of the batch.
          if (record.message_type === 'order' && record.order) {
            try {
              const { account: orderAccount, error: orderAcctErr } =
                await resolveAccount({ fromPhoneNumber: record.phone_number_id });
              if (orderAcctErr || !orderAccount || !orderAccount.workspaceId) {
                console.error('[webhook] Order ingestion skipped -- account resolve error:', orderAcctErr || 'account has no workspaceId');
              } else {
                const createdOrder = await orderService.createOrderFromWhatsappMessage(orderAccount.workspaceId, {
                  whatsappAccountId: orderAccount.id,
                  contactNumber: record.contact_number,
                  waOrder: record.order,
                  // Phase 7.10A — FIX 3: dedupe key for a redelivered Meta
                  // webhook of the same inbound 'order' message.
                  waMessageId: record.message_id || null,
                });

                // Phase 7.9 — link this inbound 'order' chat_history row to
                // the order just created, via the same generic template_meta
                // JSONB column messageSender.js already uses for outbound
                // template rendering data. Read-only for MessageBubble.jsx
                // (order line items/total/link) — never affects order
                // creation itself, and any failure here is logged and
                // swallowed, exactly like the rest of this ingestion block,
                // so a chat-link problem can never fail the order or the
                // wider webhook batch.
                try {
                  await pool.query(
                    `UPDATE coexistence.chat_history SET template_meta = $1 WHERE message_id = $2`,
                    [
                      JSON.stringify({
                        kind: 'order',
                        orderId: createdOrder.id,
                        orderNumber: createdOrder.order_number,
                        total: createdOrder.total_amount,
                        currency: createdOrder.currency,
                        items: (createdOrder.items || []).map(it => ({
                          name: it.product_name,
                          quantity: it.quantity,
                          unitPrice: it.unit_price,
                          totalPrice: it.total_price,
                        })),
                      }),
                      record.message_id,
                    ]
                  );
                } catch (linkErr) {
                  console.error('[webhook] Order chat-link update failed:', linkErr.message);
                }
              }
            } catch (orderErr) {
              console.error('[webhook] Order ingestion error:', orderErr.message);
            }
          }
          // ────────────────────────────────────────────────────

          const { rows: pausedRows } = await pool.query(
            `SELECT id FROM coexistence.automation_executions
              WHERE wa_number=$1 AND contact_number=$2
                AND status='paused' AND expires_at>NOW()
              ORDER BY paused_at`,
            [record.wa_number, record.contact_number]
          );
          if (pausedRows.length > 0) {
            for (const p of pausedRows) {
              try {
                await resumeAutomation(pool, p.id, record);
              } catch (resumeErr) {
                console.error(`[webhook] Resume error for execution ${p.id}:`, resumeErr.message);
              }
            }
            continue; // do not also fire fresh triggers
          }

const product =
findProduct(record.message_body || "");
if (product) {

  console.log(
    "PRODUCT FOUND:",
    product.id
  );

  const productData =
  await getProduct(product.id);

  console.log(
    "PRODUCT DATA:",
    productData
  );

}
          // ── Invi Creation AI Reply ──────────────────────────
          // CONTROL RULES (both must pass for AI to fire):
          // RULE 1: "Manual Reply" tag — if contact has this tag, skip AI.
          // RULE 2: Agent-reply timestamp — if agent replied after this message, skip.
          // MESSAGE TYPES: text, interactive (button tap), image (customer photo)
          // AI RESPONSE TYPES:
          //   { type:"text",        reply:"..." }
          //   { type:"interactive", reply:"...", buttons:[{id,title},...] }
          //   { type:"product",     reply:"...", image:"<url>" }
          try {
            const msgType = record.message_type;
            const isHandled = msgType === 'text' || msgType === 'interactive' || msgType === 'image';

            if (isHandled) {
              // ── RULE 1: Manual Reply tag check ───────────────────────────
              const { rows: contactRows } = await pool.query(
                `SELECT tags, last_agent_reply_at FROM coexistence.contacts
                  WHERE wa_number = $1 AND contact_number = $2
                  LIMIT 1`,
                [record.wa_number, record.contact_number]
              );
              const contactTags = contactRows.length > 0 ? (contactRows[0].tags || []) : [];

              if (hasManualReplyTag(contactTags)) {
                console.log(`[AI] Skipped -- "Manual Reply" tag set for ${record.contact_number}`);
              } else {
                // ── RULE 2: Agent-already-replied check ────────────────────
                const lastAgentReplyAt = contactRows.length > 0 ? contactRows[0].last_agent_reply_at : null;
                const customerMsgTime = new Date(record.timestamp).getTime();
                const agentReplyTime  = lastAgentReplyAt ? new Date(lastAgentReplyAt).getTime() : 0;
                const agentAlreadyReplied = agentReplyTime >= customerMsgTime;

                if (agentAlreadyReplied) {
                  console.log(`[AI] Skipped -- agent replied after ${record.contact_number}'s message`);
                } else {
                  // ── Build payload for ai_bridge ────────────────────────
                  const aiPayload = {};
                  aiPayload.customer_id = record.contact_number || '';
                  if (msgType === 'image') {
                    aiPayload.message = record.message_body || '';
                    aiPayload.image   = record.media_url   || null;
                  } else if (msgType === 'interactive') {
                    // message_body is 'ID::<id>::<title>' (see parseMessage above)
                    aiPayload.message      = record.message_body || '';
                    aiPayload.button_click = true;
                  } else {
                    aiPayload.message = record.message_body || '';
                  }

                  if (AI_BRIDGE_ENABLED && (aiPayload.message || aiPayload.image)) {
                    const aiResponse = await fetch('https://akchat-whatsapp-bot.onrender.com/ai', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(aiPayload)
                    });
                    const aiData    = await aiResponse.json();
                    const aiReply   = aiData.reply   || '';
                    const aiImage   = aiData.image   || null;
                    const aiType    = aiData.type    || 'text';
                    const aiButtons = Array.isArray(aiData.buttons) ? aiData.buttons : [];

                    if (aiReply) {
                      const { account, error } = await resolveAccount({ fromPhoneNumber: record.phone_number_id });
                      if (error) {
                        console.error('[AI] Account resolve error:', error);
                      } else {
                        const toNum = String(record.contact_number).replace(/\D/g, '');

                        if (aiType === 'interactive' && aiButtons.length > 0) {
                          // ─ WhatsApp interactive reply-button message ─
                          // Build the Cloud API "interactive" payload here so
                          // enqueueSend / messageSender receives the exact shape
                          // WhatsApp expects.
                          const waButtons = aiButtons.slice(0, 3).map(b => ({
                            type: 'reply',
                            reply: {
                              id:    String(b.id    || '').slice(0, 256),
                              title: String(b.title || '').slice(0, 20),
                            },
                          }));
                          const interactivePayload = {
                            messaging_product: 'whatsapp',
                            recipient_type:    'individual',
                            to:                toNum,
                            type:              'interactive',
                            interactive: {
                              type: 'button',
                              body: { text: aiReply },
                              action: { buttons: waButtons },
                            },
                          };
                          const localId = await insertPendingRow({ account, toNumber: toNum, messageType: 'interactive', messageBody: aiReply });
                          await enqueueSend({ kind: 'interactive', localMessageId: localId, accountId: account.id, to: toNum, payload: interactivePayload });
                          console.log('[AI] Sent interactive to', toNum, 'with', waButtons.length, 'buttons');
                        } else if (aiType === 'product' && aiImage) {
                          // ─ Product: image first, then text ─
                          // Meta rejects any image (link OR uploaded media) over 5MB
                          // (error 131053), and product photos are frequently larger
                          // than that. Every AI product image is prepared (validated,
                          // and resized/recompressed if needed) and uploaded to Meta's
                          // /media endpoint first, then sent by media_id — never by
                          // the raw original link — so an oversized source image can
                          // never reach Meta directly.
                          let imageSendFailed = false;
                          try {
                            const prep = await prepareProductImage(aiImage);
                            console.log(
                              '[AI] Product image preparation:',
                              `source=${prep.sourceSize} bytes`,
                              `final=${prep.finalSize} bytes`,
                              `mime=${prep.mime}`,
                              `compressed=${prep.compressed}`
                            );
                            const uploaded = await uploadMedia({
                              accessToken: account.accessToken,
                              phoneNumberId: account.phoneNumberId,
                              buffer: prep.buffer,
                              mimeType: prep.mime,
                              filename: 'product.' + (prep.mime === 'image/png' ? 'png' : 'jpg'),
                            });
                            if (!uploaded || !uploaded.id) {
                              throw new Error('Meta /media upload returned no media id');
                            }
                            const imgId = await insertPendingRow({ account, toNumber: toNum, messageType: 'image', messageBody: null, mediaUrl: aiImage });
                            await enqueueSend({ kind: 'media', localMessageId: imgId, accountId: account.id, to: toNum, payload: { type: 'image', mediaId: uploaded.id, caption: '' } });
                            console.log('[AI] Sent product image successfully to', toNum);
                          } catch (imgErr) {
                            imageSendFailed = true;
                            // Log loudly — never silently skip the product image.
                            console.error('[AI] Product image preparation/send FAILED for', toNum, ':', imgErr.message);
                          }
                          const localId = await insertPendingRow({ account, toNumber: toNum, messageType: 'text', messageBody: aiReply });
                          await enqueueSend({ kind: 'text', localMessageId: localId, accountId: account.id, to: toNum, payload: { body: aiReply } });
                          console.log('[AI] Sent product to', toNum, imageSendFailed ? '(image failed, text sent)' : '');
                        } else {
                          // ─ Plain text ─
                          const localId = await insertPendingRow({ account, toNumber: toNum, messageType: 'text', messageBody: aiReply });
                          await enqueueSend({ kind: 'text', localMessageId: localId, accountId: account.id, to: toNum, payload: { body: aiReply } });
                          console.log('[AI] Replied to', toNum, ':', aiReply);
                        }
                      }
                    }
                  }
                }
              }
            }
          } catch (aiErr) {
            console.error('[AI] Reply error:', aiErr.message);
          }
          // ────────────────────────────────────────────────────

          await evaluateTriggers(record);
        } catch (triggerErr) {
          console.error('[webhook] Trigger evaluation error:', triggerErr.message);
        }
      }
    }

    // 2. For status updates (messageRead, messageDelivered, messageSent triggers)
    const statusRecords = allRecords.filter(r => r.message_type === 'status');
    if (statusRecords.length > 0) {
      for (const record of statusRecords) {
        try {
          await evaluateTriggers(record);
        } catch (triggerErr) {
          console.error('[webhook] Status trigger evaluation error:', triggerErr.message);
        }
      }
    }
    } // end if (!isForwardedCopy) — local dev mirror guard

    // Enqueue durable media downloads via BullMQ (concurrency-capped + retried)
    for (const r of allRecords) {
      if (MEDIA_TYPES.has(r.message_type) && r.media_url && r.message_id) {
        await markPending(r.message_id);
        enqueueMediaDownload(r.message_id).catch(() => {});
      }
    }

    console.log(`[webhook] Stored ${allRecords.length} record(s)`);
    res.status(200).json({ ok: true, stored: allRecords.length });
  } catch (err) {
    console.error('[webhook] Error:', err.message);
    // Always return 200 to n8n so it doesn't retry infinitely. Use a static
    // message — err.message can carry internal Postgres/schema details.
    res.status(200).json({ ok: false, error: 'Processing error' });
  }
});
/**
 * GET /api/webhook/whatsapp
 * Meta webhook verification endpoint (for direct Meta → AKchat webhooks).
 * Not needed for n8n forwarding, but included for completeness.
 */
router.get('/webhook/whatsapp', async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  let accepted = false;
  if (mode === 'subscribe' && token) {
    // 1) The per-account Webhook Verify Token set in the connection form.
    try {
      const { rows } = await pool.query(
        `SELECT verify_token_encrypted FROM coexistence.whatsapp_accounts
          WHERE verify_token_encrypted IS NOT NULL`
      );
      for (const r of rows) {
        if (safeEqual(decrypt(r.verify_token_encrypted), token)) { accepted = true; break; }
      }
    } catch (err) {
      console.error('[webhook] verify-token lookup error:', err.message);
    }
    // 2) Backward-compatible env fallback.
    if (!accepted && process.env.META_WEBHOOK_VERIFY_TOKEN && safeEqual(process.env.META_WEBHOOK_VERIFY_TOKEN, token)) {
      accepted = true;
    }
  }
  if (accepted) {
    console.log('[webhook] Meta verification accepted');
    // Echo the challenge as plain text (Meta sends a numeric token). Sending it
    // as text/plain — not the res.send default of text/html — prevents the
    // reflected value from being interpreted as HTML (reflected-XSS).
    return res.status(200).type('text/plain').send(String(challenge ?? ''));
  }
  res.status(403).json({ error: 'Verification failed' });
});
module.exports = { router };
