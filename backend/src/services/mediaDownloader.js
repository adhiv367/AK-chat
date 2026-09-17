// Inbound WhatsApp media pipeline: Meta media id -> local disk, plus the
// shared "write bytes under MEDIA_DIR" helper also used by outbound mirrors.
//
// Flow (mirrors the two-step Meta Cloud API media protocol used by
// integrations/metaMedia.js):
//   1. webhook.js inserts the chat_history row for an incoming media message
//      (media_url = the Meta media id, NOT a URL — see webhook.js
//      parseMessage) and calls markPending() so the UI can show a
//      "Downloading…" state instead of a broken tile.
//   2. webhook.js enqueues a durable job via queue/mediaQueue.js, whose
//      worker (and inline fallback, and routes/media.js's manual retry
//      endpoint) call downloadOne(messageId).
//   3. downloadOne resolves the owning WhatsApp account from the row's own
//      phone_number_id — this runs from a background job/queue worker, never
//      from a request, so (matching messageSender.resolveAccount's
//      no-workspace fallback and sendQueue.js's background-job convention)
//      it is intentionally NOT scoped by req.workspace. phone_number_id is
//      Meta-assigned and globally unique, so this can never cross workspaces.
//   4. Fetches the short-lived download URL (getMediaInfo) then the bytes
//      (downloadMediaBinary), writes them to disk via persistOutboundBuffer,
//      and updates the row so routes/media.js can stream it back.
//
// persistOutboundBuffer is also used directly by OUTBOUND flows
// (engine/automationEngine.js library-media sends) that need to mirror an
// already-sent file locally, using the exact same <wa>/<yyyymm>/<msgid>.<ext>
// layout as routes/messages.js's local persistOutboundMedia().

const fs = require('fs');
const path = require('path');
const pool = require('../db');
const { getAccountByPhoneNumber } = require('../routes/whatsappAccounts');
const { getMediaInfo, downloadMediaBinary } = require('../integrations/metaMedia');
const { canonicalizeMime } = require('../util/metaMime');

const MEDIA_DIR = process.env.MEDIA_DIR || '/app/media';

// Message types that carry a Meta media id in chat_history.media_url and so
// need a download pass. Matches the set of types webhook.js's parseMessage()
// populates media_url/media_mime_type for.
const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'voice', 'document', 'sticker']);

// mime -> file extension for naming the stored file. Reverse of
// util/metaMime.js's EXT_MIME table, plus webp (sticker) which that table
// doesn't need to cover in the other direction.
const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/3gp': '3gp',
  'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/aac': 'aac', 'audio/amr': 'amr', 'audio/mp4': 'm4a',
  'application/pdf': 'pdf', 'text/plain': 'txt',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};
function extForMime(mime) {
  return MIME_EXT[String(mime || '').toLowerCase()] || 'bin';
}

/**
 * Mark a just-inserted media message row as awaiting download. Called by
 * webhook.js immediately after insert, before the download queue runs.
 */
async function markPending(messageId) {
  await pool.query(
    `UPDATE coexistence.chat_history SET media_status = 'pending' WHERE message_id = $1`,
    [messageId]
  );
}

/**
 * Write bytes to MEDIA_DIR under <wa>/<yyyymm>/<msgid>.<ext> — the same
 * layout used throughout the app for outbound media (see
 * routes/messages.js's local persistOutboundMedia()). Returns the absolute
 * path and byte size so the caller can persist them on the chat_history row.
 */
function persistOutboundBuffer({ accountPhoneDigits, messageId, buffer, ext }) {
  const ym = `${new Date().getUTCFullYear()}${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
  const dir = path.join(MEDIA_DIR, accountPhoneDigits || 'unknown', ym);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filename = `${String(messageId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200)}.${ext || 'bin'}`;
  const absPath = path.join(dir, filename);
  fs.writeFileSync(absPath, buffer);
  return { absPath, size: buffer.length };
}

/**
 * Permanent Meta errors (expired media link, revoked/invalid token, media no
 * longer available) are persisted as a terminal 'failed' state so the UI
 * doesn't show "Downloading…" forever. Anything else is left as 'pending' so
 * BullMQ's retry/backoff (queue/mediaQueue.js throws whenever ok=false) can
 * try again.
 */
async function handleDownloadError(messageId, err) {
  const status = err?.status;
  const permanent = status === 401 || status === 403 || status === 404 || status === 410;
  const message = (err?.message || 'Media download failed').slice(0, 500);
  if (permanent) {
    await pool.query(
      `UPDATE coexistence.chat_history SET media_status = 'failed' WHERE message_id = $1`,
      [messageId]
    );
  }
  return { ok: false, error: message, status: permanent ? 'failed' : 'pending' };
}

/**
 * Download one inbound media message from Meta and store it locally.
 * Returns { ok: true, status: 'stored', path, size } on success, or
 * { ok: false, error, status } when it can't proceed (see
 * handleDownloadError for the permanent-vs-retryable distinction). Never
 * throws itself — queue/mediaQueue.js's worker is the layer that turns
 * ok=false into a thrown error so BullMQ retries.
 */
async function downloadOne(messageId) {
  const { rows } = await pool.query(
    `SELECT message_id, phone_number_id, wa_number, media_url, media_mime_type, media_filename, message_type
       FROM coexistence.chat_history WHERE message_id = $1`,
    [messageId]
  );
  const row = rows[0];
  if (!row) return { ok: false, error: 'Message not found' };

  // webhook.js stores Meta's media id (not a URL) in media_url.
  const mediaId = row.media_url;
  if (!mediaId) return { ok: false, error: 'No media id on this message' };

  // Background job — resolve strictly from the row's own phone_number_id,
  // never from a request/workspace (see file header).
  const account = await getAccountByPhoneNumber(row.phone_number_id);
  if (!account || !account.accessToken) {
    const error = "No WhatsApp account/access token for this media's phone number";
    await pool.query(
      `UPDATE coexistence.chat_history SET media_status = 'failed' WHERE message_id = $1`,
      [messageId]
    );
    return { ok: false, error, status: 'failed' };
  }

  let info;
  try {
    info = await getMediaInfo(mediaId, account.accessToken);
  } catch (err) {
    return handleDownloadError(messageId, err);
  }

  let bin;
  try {
    bin = await downloadMediaBinary(info.url, account.accessToken);
  } catch (err) {
    return handleDownloadError(messageId, err);
  }

  const mime = canonicalizeMime(info.mime_type || bin.contentType, row.media_filename);
  const ext = extForMime(mime);
  const accountPhoneDigits = String(row.wa_number || '').replace(/\D/g, '');
  const { absPath, size } = persistOutboundBuffer({
    accountPhoneDigits, messageId, buffer: bin.buffer, ext,
  });

  await pool.query(
    `UPDATE coexistence.chat_history
        SET media_storage_path = $1, media_status = 'stored',
            media_mime_type = COALESCE(media_mime_type, $2),
            media_size_bytes = $3, media_downloaded_at = NOW()
      WHERE message_id = $4`,
    [absPath, mime, size, messageId]
  );

  return { ok: true, status: 'stored', path: absPath, size };
}
module.exports = {
  markPending,
  MEDIA_TYPES,
  downloadOne,
  MEDIA_DIR,
  persistOutboundBuffer,
};