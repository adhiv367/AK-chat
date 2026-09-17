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
 */
async function resolveAccount({ accountId, fromPhoneNumber }) {
  try {
    let acc = null;
    if (accountId) acc = await getAccountWithToken(accountId);
    else if (fromPhoneNumber) acc = await getAccountByPhoneNumber(fromPhoneNumber);
    // Single-account product: if matching by id/phone found nothing (e.g. the
    // display number isn't resolved from Meta yet), fall back to the lone account.
    if (!acc) acc = await getSingleAccount();
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
 */
async function markSent(localId, wamid) {
  await pool.query(
    `UPDATE coexistence.chat_history
        SET message_id = $1, status = 'sent', error_message = NULL
      WHERE message_id = $2`,
    [wamid, localId]
  );
}

/**
 * Build a compact, human-readable error string that still carries Meta's
 * structured error fields (code, error_subcode, message, error_data,
 * fbtrace_id) so the UI/DB show the EXACT reason a send failed instead of
 * just a generic "FAILED" status. Accepts either a plain string (back-compat)
 * or an Error thrown by metaSend.js (which attaches `err.metaError`).
 */
function formatSendError(errorOrMessage) {
  if (errorOrMessage && typeof errorOrMessage === 'object' && errorOrMessage.metaError) {
    const me = errorOrMessage.metaError;
    return JSON.stringify({
      message: me.message || errorOrMessage.message,
      code: me.code ?? null,
      error_subcode: me.error_subcode ?? null,
      error_data: me.error_data ?? null,
      fbtrace_id: me.fbtrace_id ?? null,
    });
  }
  if (errorOrMessage instanceof Error) return errorOrMessage.message;
  return String(errorOrMessage || 'send failed');
}

/**
 * Mark a row as failed (Meta rejected, network error, etc).
 * `errorOrMessage` can be a plain string OR the Error thrown by metaSend.js
 * (preferred — carries the full Meta error object for accurate diagnosis).
 */
async function markFailed(localId, errorOrMessage) {
  const stored = formatSendError(errorOrMessage);
  await pool.query(
    `UPDATE coexistence.chat_history
        SET status = 'failed', error_message = $1
      WHERE message_id = $2`,
    [stored.slice(0, 500), localId]
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

module.exports = {
  resolveAccount,
  insertPendingRow,
  markSent,
  markFailed,
  formatSendError,
  secondsSinceLastIncoming,
  localMessageId,
};



















