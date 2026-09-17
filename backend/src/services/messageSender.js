// Central outbound orchestration. ALL message-sending paths funnel through here:
//   - Chat reply input  (routes/messages.js → POST /messages/send)
//   - Broadcast launch  (routes/broadcasts.js → /:id/send)
//   - Automation engine (engine/automationEngine.executeMessageNode)
//   - Template test     (routes/templates.js → /:id/test-send)
//
// Flow:
//   1. Insert optimistic chat_history row (status='sending', local message_id)
//   2. Enqueue BullMQ job (sendQueue.enqueueSend)
//   3. Worker calls Meta, then updates the row in place:
//        success → message_id = real wamid, status = 'sent'
//        failure → status = 'failed', error_message populated

const crypto = require('crypto');
const pool = require('../db');
const { getAccountByPhoneNumber, getAccountWithToken, getSingleAccount } = require('../routes/whatsappAccounts');

function localMessageId() {
  // Distinct from Meta's wamid format so we can tell them apart in logs
  return `local-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * Resolve credentials for a sender. Accepts either an explicit accountId or a
 * fromPhoneNumber. Returns { account, error } — never throws.
 *
 * @param {object} params
 * @param {number|string} [params.accountId]
 * @param {string} [params.fromPhoneNumber]
 * @param {number|string|null} [params.workspaceId] - when provided (any
 *   authenticated, workspace-scoped caller), resolution is restricted to
 *   that workspace's accounts, and the fallback-to-default account (below)
 *   only considers that workspace too. Never omit this from customer-facing
 *   routes — omitting it is only correct for callers that don't have a
 *   request/workspace context (e.g. the public Meta webhook, which already
 *   knows the exact phone_number_id and needs no further scoping).
 */
async function resolveAccount({ accountId, fromPhoneNumber, workspaceId = null }) {
  try {
    let acc = null;
    if (accountId) acc = await getAccountWithToken(accountId, workspaceId);
    else if (fromPhoneNumber) acc = await getAccountByPhoneNumber(fromPhoneNumber, workspaceId);
    // Fallback: if matching by id/phone found nothing (e.g. the display
    // number isn't resolved from Meta yet), fall back to the workspace's
    // default account (or, with no workspace context, the system-wide
    // default — legacy behaviour for background jobs, see getSingleAccount).
    if (!acc) acc = await getSingleAccount(workspaceId);
    if (!acc) return { error: `No WhatsApp Business account registered for ${fromPhoneNumber || `id=${accountId}`}` };
    if (!acc.isActive) return { error: `WhatsApp Business account "${acc.displayName}" is inactive` };
    if (!acc.accessToken) return { error: 'Access token missing (re-enter in Settings)' };
    return { account: acc };
  } catch (err) {
    return { error: err.message || 'Account lookup failed' };
  }
}

/**
 * Insert an optimistic chat_history row that the UI shows as "sending…".
 * Returns the local message_id used so caller can correlate later updates.
 */
async function insertPendingRow({ account, toNumber, messageType, messageBody, mediaUrl = null, mediaMime = null, templateMeta = null, contextMessageId = null }) {
  const messageId = localMessageId();
  await pool.query(
    `INSERT INTO coexistence.chat_history
       (message_id, phone_number_id, wa_number, contact_number, to_number,
        direction, message_type, message_body, raw_payload,
        media_url, media_mime_type, status, timestamp, template_meta, context_message_id)
     VALUES ($1,$2,$3,$4,$5,'outgoing',$6,$7,$8,$9,$10,'sending',NOW(),$11,$12)`,
    [
      messageId,
      account.phoneNumberId,
      account.displayPhoneNumber.replace(/\D/g, ''),
      String(toNumber).replace(/\D/g, ''),
      String(toNumber).replace(/\D/g, ''),
      messageType,
      messageBody || null,
      JSON.stringify({ origin: 'outbound', queued_at: new Date().toISOString() }),
      mediaUrl,
      mediaMime,
      templateMeta ? JSON.stringify(templateMeta) : null,
      contextMessageId || null,
    ]
  );
  return messageId;
}

/**
 * Mark a previously-inserted row as accepted by Meta, swapping in the real wamid.
 *
 * Phase 8A: accepts an optional `workspaceId` parameter for forward
 * compatibility with callers that resolve it here rather than separately.
 * This function deliberately does NOT perform any usage metering itself
 * (single responsibility: message status only) — the actual increment is
 * performed by the caller (queue/sendQueue.js's single call site), using
 * its own already-resolved `account.workspaceId` and this function's
 * return value. Existing callers that omit the third argument are
 * completely unaffected.
 *
 * Returns `true` if a row was actually updated, `false` otherwise (e.g. a
 * second call with an already-swapped localId matches zero rows, since
 * `message_id` no longer equals `localId` after the first successful
 * update — this is the natural idempotency guarantee a caller can rely on
 * to avoid double-counting a retried/duplicate call). Existing callers that
 * don't inspect the return value behave exactly as before.
 */
async function markSent(localId, wamid, workspaceId = null) {
  const { rowCount } = await pool.query(
    `UPDATE coexistence.chat_history
        SET message_id = $1, status = 'sent', error_message = NULL
      WHERE message_id = $2`,
    [wamid, localId]
  );
  return rowCount > 0;
}
/**
 * Coerce whatever markFailed()/broadcast-log writers receive (a plain string,
 * an Error, or an Error carrying Meta's structured `metaError` — see
 * integrations/metaSend.js's postJson) into a safe, storable string.
 *
 * NEVER assumes the input is a string — sendQueue.js's worker 'failed'
 * handler passes the actual Error object so structured Meta details
 * (code / error_subcode / message / error_data / fbtrace_id) aren't lost,
 * and calling .slice() directly on that Error (rather than on a string
 * derived from it) is exactly what used to throw and swallow the failure.
 */
function toErrorMessage(errorMessage) {
  if (errorMessage == null) return 'send failed';
  if (typeof errorMessage === 'string') return errorMessage || 'send failed';

  if (errorMessage instanceof Error || typeof errorMessage === 'object') {
    const meta = errorMessage.metaError || errorMessage.error || null;
    if (meta) {
      const parts = [];
      if (meta.message) parts.push(meta.message);
      if (meta.code != null) parts.push(`code=${meta.code}`);
      if (meta.error_subcode != null) parts.push(`subcode=${meta.error_subcode}`);
      const details = meta.error_data?.details;
      if (details) parts.push(`details=${details}`);
      if (meta.fbtrace_id) parts.push(`fbtrace_id=${meta.fbtrace_id}`);
      if (parts.length) return parts.join(' | ');
    }
    return errorMessage.message || String(errorMessage) || 'send failed';
  }
  return String(errorMessage) || 'send failed';
}
/**
 * Mark a row as failed (Meta rejected, network error, etc).
 * Accepts either a plain string or an Error object (see toErrorMessage above).
 */
async function markFailed(localId, errorMessage) {
  const msg = toErrorMessage(errorMessage);
  await pool.query(
    `UPDATE coexistence.chat_history
        SET status = 'failed', error_message = $1
      WHERE message_id = $2`,
    [msg.slice(0, 500), localId]
  );
}
/**
 * Return seconds-since the last incoming message from `contactNumber` to
 * `accountPhoneNumberId`. Returns null if no inbound message exists.
 * Meta's "customer service window" is 24h = 86400s.
 */
async function secondsSinceLastIncoming({ accountPhoneNumberId, contactNumber }) {
  const norm = String(contactNumber).replace(/\D/g, '');
  const { rows } = await pool.query(
    `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(timestamp))) AS seconds
       FROM coexistence.chat_history
      WHERE phone_number_id = $1
        AND contact_number = $2
        AND direction = 'incoming'`,
    [accountPhoneNumberId, norm]
  );
  const s = rows[0]?.seconds;
  return s != null ? Math.floor(s) : null;
}
/**
 * Format a send-failure error (Meta API error object, network Error, etc)
 * into a short, storable string for broadcast_logs.error_message. Used by
 * queue/sendQueue.js's worker 'failed' handler when the origin is a
 * broadcast log row. Kept separate from markFailed's own string coercion
 * since callers here already have the raw Error/Meta-error object.
 */
function formatSendError(err) {
  return toErrorMessage(err);
}
module.exports = {
  resolveAccount,
  insertPendingRow,
  markSent,
  markFailed,
  secondsSinceLastIncoming,
  localMessageId,
  formatSendError,
  toErrorMessage,
};



