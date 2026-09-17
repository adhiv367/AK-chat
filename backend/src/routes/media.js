const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const { downloadOne, MEDIA_DIR } = require('../services/mediaDownloader');
const { assertContactAccess } = require('../middleware/access');
const { getAccountByPhoneNumber } = require('./whatsappAccounts');

const router = Router();

function resolveSafe(absPath) {
  if (!absPath) return null;
  const resolved = path.resolve(absPath);
  if (!resolved.startsWith(path.resolve(MEDIA_DIR) + path.sep)) return null;
  return resolved;
}

// Phase 6 Gap #2: assertContactAccess (middleware/access.js) only checks the
// CALLING USER's role-based visibility (BDA assignment vs admin bypass) — it
// has no concept of workspace, and its admin bypass uses the GLOBAL
// akchat_users.role, not workspace membership. That means a global admin
// user could enumerate another workspace's message_id and stream its media.
// This mirrors the fix already applied in routes/messages.js
// (assertWaWorkspace, using getAccountByPhoneNumber): confirm the message's
// own wa_number actually belongs to the caller's OWN workspace
// (req.workspace, resolved server-side from the session) before any bytes
// are served, in addition to (not instead of) the existing per-contact
// access check. A cross-workspace message_id is treated exactly like a
// missing one (404) so its existence in another workspace is never revealed.
async function assertMediaWorkspace(req, res, waNumber) {
  const workspaceId = req.workspace?.id ?? null;
  if (!workspaceId) {
    res.status(404).json({ error: 'Message not found' });
    return false;
  }
  const acc = await getAccountByPhoneNumber(waNumber, workspaceId);
  if (!acc) {
    res.status(404).json({ error: 'Message not found' });
    return false;
  }
  return true;
}

// GET /api/media/:messageId — stream stored media bytes, auth required.
router.get('/media/:messageId', async (req, res) => {
  try {
    const { messageId } = req.params;
    const { rows } = await pool.query(
      `SELECT message_id, message_type, media_storage_path, media_mime_type,
              media_status, media_filename, message_body, wa_number, contact_number
         FROM coexistence.chat_history
        WHERE message_id = $1`,
      [messageId]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'Message not found' });
    // Workspace check first — a global admin must not be able to reach past
    // this by virtue of their global role (see assertMediaWorkspace above).
    if (!(await assertMediaWorkspace(req, res, row.wa_number))) return;
    // Per-conversation access: non-admins may only stream media from
    // conversations they're assigned to (admins bypass). Prevents downloading
    // any message's media by guessing a message_id (IDOR).
    if (!(await assertContactAccess(req, res, row.wa_number, row.contact_number))) return;
    if (row.media_status !== 'stored' || !row.media_storage_path) {
      return res.status(404).json({ error: 'Media not available', status: row.media_status });
    }
    const abs = resolveSafe(row.media_storage_path);
    if (!abs || !fs.existsSync(abs)) {
      return res.status(404).json({ error: 'File missing on disk' });
    }
    const mime = row.media_mime_type || 'application/octet-stream';
    const total = fs.statSync(abs).size;
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    // Advertise byte-range support so browsers can seek/scrub AND scan to the
    // end to compute Ogg/Opus duration (otherwise audio.duration === Infinity).
    res.setHeader('Accept-Ranges', 'bytes');
    if (req.query.download === '1' || row.message_type === 'document') {
      const fname = row.media_filename || row.message_body || `${messageId}`;
      res.setHeader('Content-Disposition',
        `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${fname.replace(/[^\w. -]/g, '_')}"`);
    }

    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] !== '' ? parseInt(m[1], 10) : 0;
      let end = m && m[2] !== '' ? parseInt(m[2], 10) : total - 1;
      if (!Number.isFinite(start)) start = 0;
      if (!Number.isFinite(end) || end >= total) end = total - 1;
      if (start > end || start >= total) {
        res.status(416).setHeader('Content-Range', `bytes */${total}`);
        return res.end();
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', end - start + 1);
      return fs.createReadStream(abs, { start, end }).pipe(res);
    }

    res.setHeader('Content-Length', total);
    fs.createReadStream(abs).pipe(res);
  } catch (err) {
    console.error('[media] GET error:', err.message);
    res.status(500).json({ error: 'Failed to read media' });
  }
});

// POST /api/media/:messageId/retry — re-attempt download
router.post('/media/:messageId/retry', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT wa_number, contact_number FROM coexistence.chat_history WHERE message_id = $1`,
      [req.params.messageId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Message not found' });
    if (!(await assertMediaWorkspace(req, res, rows[0].wa_number))) return;
    if (!(await assertContactAccess(req, res, rows[0].wa_number, rows[0].contact_number))) return;
    const result = await downloadOne(req.params.messageId);
    res.json(result);
  } catch (err) {
    console.error('[media] retry error:', err.message);
    res.status(500).json({ error: 'Retry failed' });
  }
});

module.exports = { router };





