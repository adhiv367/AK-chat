const { Router } = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const pool = require('../db');
const { resolveAccount, insertPendingRow, secondsSinceLastIncoming } = require('../services/messageSender');
const { enqueueSend } = require('../queue/sendQueue');
const { uploadMedia } = require('../integrations/metaSend');
// Phase 7.6 — Product Search / Product ID: workspace-scoped product lookup
// + the shared Meta product-interactive builder (see
// services/whatsappProductMessage.js). Used only by POST /messages/send-product
// below; the module internally reuses productService.js's own
// workspace-isolated lookups rather than bypassing them.
const whatsappProductMessage = require('../services/whatsappProductMessage');
const { markAccountHealth, classifyMetaError } = require('../services/accountHealth');
const storage = require('../util/pgStorage');
const { syncMediaToAccount } = require('./mediaLibrary');
const crypto = require('crypto');
const { userWaNumbers, assertWaAccess, assertContactAccess, requireRole, requirePermission } = require('../middleware/access');
const { getAccountByPhoneNumber } = require('./whatsappAccounts');

// Phase 3C: assertWaAccess/assertContactAccess (middleware/access.js) only
// check the CALLING USER's role-based visibility (BDA assignment vs admin
// bypass) — they have no concept of workspace and never did, since they
// predate workspaces entirely. That means an authenticated admin (or a BDA
// assigned to a same-numbered contact) could otherwise read/write another
// workspace's contacts by supplying that workspace's wa_number here. This
// closes that gap: confirm the client-supplied wa_number actually belongs
// to the caller's OWN workspace (req.workspace, resolved server-side from
// the session — never trust a workspace implied by a client-chosen number)
// before any of these routes touch coexistence.contacts through it.
async function assertWaWorkspace(req, res, waNumber) {
  const workspaceId = req.workspace?.id ?? null;
  if (!workspaceId) {
    res.status(403).json({ error: 'No workspace found for this account' });
    return false;
  }
  const acc = await getAccountByPhoneNumber(waNumber, workspaceId);
  if (!acc) {
    res.status(403).json({ error: 'This WhatsApp number does not belong to your workspace' });
    return false;
  }
  return true;
}
const { isAdmin } = require('../permissions');
const { canonicalizeMime, chatKindFor, CHAT_TYPES_MSG } = require('../util/metaMime');
const ExcelJS = require('exceljs');
const { Readable } = require('stream');
// Same phone normalizer the Google Sheet sync uses — one source of truth for
// "what does a valid stored contact_number look like" across every entry
// point (Excel import, Google Sheet sync, manual Add Contact).
const { normalizePhone } = require('../services/contactSyncService');
// Read-only public-sheet fetcher already used by the Admin Settings auto-sync
// — reused here for the one-time "Import from Sheet" pull on the Contacts
// page. KlutchChat never writes to the sheet via either path.
const { fetchSheetGrid } = require('../services/googleSheetService');

const pexecFile = promisify(execFile);
const MEDIA_DIR = process.env.MEDIA_DIR || '/app/media';

/**
 * A quote-reply's context message id is only valid to Meta if it's a real
 * Meta wamid. Optimistic rows still carry a local-/tmp- id (the message hasn't
 * been accepted by Meta yet) — quoting those would make Meta reject the send,
 * so we drop them and send without the quote rather than fail.
 */
function sanitizeContextId(id) {
  if (!id || typeof id !== 'string') return null;
  if (id.startsWith('local-') || id.startsWith('tmp-')) return null;
  return id;
}
const META_AUDIO_TYPES = new Set(['audio/aac', 'audio/mp4', 'audio/amr', 'audio/mpeg', 'audio/ogg']);

/**
 * Transcode browser audio (typically webm/opus) to Meta-accepted ogg/opus.
 * Returns { buffer, mime, ext }.
 */
async function transcodeAudioForMeta(srcBuffer, srcMime) {
  // Guard against an empty / truncated recording before shelling out to ffmpeg —
  // otherwise ffmpeg fails with a cryptic "End of file" / invalid-EBML error.
  if (!srcBuffer || srcBuffer.length === 0) {
    throw new Error('The recording was empty. Please record again before sending.');
  }
  // Strip any codecs parameter (e.g. "audio/webm;codecs=opus") before matching.
  const baseMime = String(srcMime || '').split(';')[0].trim().toLowerCase();
  if (META_AUDIO_TYPES.has(baseMime)) {
    return { buffer: srcBuffer, mime: baseMime, ext: baseMime === 'audio/mpeg' ? 'mp3' : baseMime.split('/')[1] };
  }
  // Write source to a temp file, transcode to ogg/opus
  const tmpIn = `/tmp/audio-in-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const tmpOut = `${tmpIn}.ogg`;
  fs.writeFileSync(tmpIn, srcBuffer);
  try {
    await pexecFile('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-i', tmpIn,
      '-vn', '-c:a', 'libopus', '-b:a', '64k',
      tmpOut,
    ], { timeout: 30_000 });
    const buf = fs.readFileSync(tmpOut);
    if (!buf || buf.length === 0) throw new Error('Transcoded audio was empty.');
    return { buffer: buf, mime: 'audio/ogg', ext: 'ogg' };
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

/**
 * Mirror an outbound media file to /app/media so the chat bubble can render
 * the thumbnail/playback via the existing /api/media/:messageId proxy.
 * Path layout matches inbound: <wa>/<yyyymm>/<msgid>.<ext>
 */
function persistOutboundMedia({ accountPhoneDigits, messageId, buffer, ext }) {
  const ym = `${new Date().getUTCFullYear()}${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
  const dir = path.join(MEDIA_DIR, accountPhoneDigits || 'unknown', ym);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filename = `${String(messageId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200)}.${ext || 'bin'}`;
  const absPath = path.join(dir, filename);
  fs.writeFileSync(absPath, buffer);
  return { absPath, size: buffer.length };
}

const router = Router();
const SERVICE_WINDOW_SECONDS = 24 * 3600;

// Multipart parser for chat media (up to 16MB — WhatsApp's per-message cap)
const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
});

// Multipart parser for the contacts-import sheet (.csv / .xlsx, up to 5MB).
const sheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Header alias matching for the import sheet — header names are normalised to
// [a-z0-9] (case/punctuation-insensitive) before lookup, so "Customer Name",
// "customer_name", "CUSTOMER NAME" etc. all resolve to the same alias.
// Restriction-free by design: any sheet with a recognisable name/phone/email
// column (regardless of source — CRM export, Shopify, manual spreadsheet)
// should import cleanly.
const IMPORT_NAME_ALIASES = new Set([
  'name', 'fullname', 'contactname', 'customername', 'clientname',
  'customer', 'client', 'fullcustomername', 'personname', 'contactperson',
]);
const IMPORT_PHONE_ALIASES = new Set([
  'phone', 'phonenumber', 'phoneno', 'phonenum', 'mobile', 'mobilenumber',
  'mobileno', 'mobilenum', 'whatsapp', 'whatsappnumber', 'whatsappno',
  'contactnumber', 'contactno', 'customerphone', 'customermobile',
  'customernumber', 'clientphone', 'clientmobile', 'number', 'msisdn',
  'cellnumber', 'cellphone', 'telephone', 'tel', 'primaryphone', 'primarymobile',
]);
const IMPORT_EMAIL_ALIASES = new Set([
  'email', 'emailaddress', 'mail', 'customeremail', 'clientemail', 'emailid',
]);
function pickImportColumn(row, aliases) {
  for (const key of Object.keys(row)) {
    const norm = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (aliases.has(norm)) return row[key];
  }
  return undefined;
}

// Read a .csv/.xlsx upload into an array of header-keyed row objects (like the
// old SheetJS sheet_to_json output), using exceljs — which, unlike xlsx@0.18.5,
// has no known prototype-pollution / ReDoS advisories. The first non-empty row
// is treated as the header.
function cellToString(v) {
  if (v == null) return '';
  if (typeof v === 'object') return String(v.text ?? v.result ?? v.hyperlink ?? '').trim();
  return String(v).trim();
}
async function parseSheetRows(file) {
  const wb = new ExcelJS.Workbook();
  const name = (file.originalname || '').toLowerCase();
  const isCsv = name.endsWith('.csv') || file.mimetype === 'text/csv';
  let ws;
  if (isCsv) {
    ws = await wb.csv.read(Readable.from(file.buffer));
  } else {
    await wb.xlsx.load(file.buffer);
    ws = wb.worksheets[0];
  }
  if (!ws) throw new Error('empty workbook');
  const rows = [];
  let headers = null;
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = row.values; // 1-indexed; vals[0] is undefined
    if (!headers) {
      headers = vals.map(cellToString);
      return;
    }
    const obj = {};
    for (let i = 1; i < headers.length; i++) {
      if (!headers[i]) continue;
      obj[headers[i]] = cellToString(vals[i]);
    }
    rows.push(obj);
  });
  return rows;
}

const DEFAULT_DATA_WINDOW = "INTERVAL '14 days'";

function timeRangeToInterval(range) {
  const map = {
    '1h': "INTERVAL '1 hour'",
    '6h': "INTERVAL '6 hours'",
    '24h': "INTERVAL '24 hours'",
    '7d': "INTERVAL '7 days'",
    '14d': "INTERVAL '14 days'",
    '30d': "INTERVAL '30 days'",
  };
  return map[range] || null;
}

// GET /api/numbers
router.get('/numbers', async (req, res) => {
  try {
    // Phase 3D: chat_history has no workspace_id of its own — a wa_number's
    // workspace is derived the same way dashboard.js already does it (see
    // getConnectedWaNumbers there): via the whatsapp_accounts row that owns
    // that display number. A workspace with no connected accounts sees no
    // numbers at all, never another workspace's, regardless of role.
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.json([]);
    const { rows: acctRows } = await pool.query(
      `SELECT display_phone_number FROM coexistence.whatsapp_accounts WHERE workspace_id = $1`,
      [workspaceId]
    );
    const workspaceWaNumbers = acctRows.map(r => (r.display_phone_number || '').replace(/\D/g, '')).filter(Boolean);
    if (workspaceWaNumbers.length === 0) return res.json([]);

    // BDA visibility: a wa_number is visible only if the user has at least
    // one contact assigned to them on that number. Admin sees everything
    // (still bounded to this workspace's numbers above).
    let extraFilter = '';
    const params = [workspaceWaNumbers];
    if (!isAdmin(req.user)) {
      params.push(req.user.id);
      extraFilter = `AND wa_number IN (
        SELECT DISTINCT wa_number FROM coexistence.contacts WHERE assigned_user_id = $${params.length}
      )`;
    }
    const { rows } = await pool.query(`
      SELECT
        wa_number,
        MAX(timestamp) AS last_message_time,
        COUNT(*) AS message_count
      FROM coexistence.chat_history
      WHERE wa_number = ANY($1::text[])
        AND timestamp >= NOW() - ${DEFAULT_DATA_WINDOW} ${extraFilter}
        -- Only surface numbers that are still connected WhatsApp accounts, so
        -- data from a previously-connected number (after the account is edited
        -- to a new number or removed) stops showing. The rows stay in the DB —
        -- this just hides orphaned numbers from the picker. Digits-only match
        -- tolerates '+'/spaces in stored display_phone_number.
        -- AND regexp_replace(wa_number, '[^0-9]', '', 'g') IN (
        -- SELECT regexp_replace(display_phone_number, '[^0-9]', '', 'g')
        -- FROM coexistence.whatsapp_accounts
        -- WHERE display_phone_number IS NOT NULL
        --)
      GROUP BY wa_number
      ORDER BY last_message_time DESC
    `, params);

    // Unread chats per wa_number = conversations with >=1 incoming message newer
    // than last_read_at. Respects the same BDA visibility scoping as above.
    const unreadParams = [workspaceWaNumbers];
    let unreadJoin = '';
    let unreadAssign = '';
    if (!isAdmin(req.user)) {
      unreadParams.push(req.user.id);
      unreadJoin = `JOIN coexistence.contacts c
        ON c.wa_number = ch.wa_number AND c.contact_number = ch.contact_number`;
      unreadAssign = `AND c.assigned_user_id = $${unreadParams.length}`;
    }
    const unreadRes = await pool.query(`
      SELECT ch.wa_number, COUNT(DISTINCT ch.contact_number) AS unread_chats
      FROM coexistence.chat_history ch
      LEFT JOIN coexistence.conversation_reads cr
        ON cr.wa_number = ch.wa_number AND cr.contact_number = ch.contact_number
      ${unreadJoin}
      WHERE ch.wa_number = ANY($1::text[])
        AND ch.direction = 'incoming'
        AND ch.timestamp >= NOW() - ${DEFAULT_DATA_WINDOW}
        AND ch.timestamp > COALESCE(cr.last_read_at, 'epoch'::timestamptz)
        ${unreadAssign}
      GROUP BY ch.wa_number
    `, unreadParams);
    const unreadMap = {};
    for (const r of unreadRes.rows) unreadMap[r.wa_number] = Number(r.unread_chats) || 0;

    // Enrich with display name + team-member data. Two bulk queries for the
    // whole set instead of two per row (was an N+1: 2*N round-trips).
    const waNumbers = rows.map(r => r.wa_number);
    const nameMap = {};
    const teamMap = {};
    if (waNumbers.length > 0) {
      const normWa = waNumbers.map(w => String(w).replace(/\D/g, ''));
      const [nameRes, teamRes] = await Promise.all([
        // The "self" contact (contact_number == wa_number) carries the number's
        // display name.
        pool.query(
          `SELECT wa_number, COALESCE(name, profile_name) AS name
             FROM coexistence.contacts
            WHERE contact_number = wa_number AND wa_number = ANY($1::text[])`,
          [waNumbers]
        ),
        // Match team members by digits-only phone number (covers '+'/exact/raw).
        pool.query(
          `SELECT name, profile_picture_url,
                  regexp_replace(phone_number, '[^0-9]', '', 'g') AS norm
             FROM coexistence.team_members
            WHERE regexp_replace(phone_number, '[^0-9]', '', 'g') = ANY($1::text[])`,
          [normWa]
        ),
      ]);
      for (const r of nameRes.rows) nameMap[r.wa_number] = r.name;
      // Keep the first match per normalized number (preserves prior LIMIT 1 behaviour).
      for (const r of teamRes.rows) if (!(r.norm in teamMap)) teamMap[r.norm] = r;
    }
    const enriched = rows.map((row) => {
      const teamMember = teamMap[String(row.wa_number).replace(/\D/g, '')];
      return {
        ...row,
        display_name: teamMember?.name || nameMap[row.wa_number] || null,
        profile_picture_url: teamMember?.profile_picture_url || null,
        unread_chats: unreadMap[row.wa_number] || 0,
      };
    });

    res.json(enriched);
  } catch (err) {
    console.error('[messages] /numbers error:', err.message);
    res.status(500).json({ error: 'Failed to fetch numbers' });
  }
});

// GET /api/contacts?waNumber=xxx&timeRange=24h
router.get('/contacts', async (req, res) => {
  try {
    const { waNumber, timeRange = '24h' } = req.query;
    if (!waNumber) return res.status(400).json({ error: 'waNumber required' });
    if (!(await assertWaAccess(req, res, waNumber))) return;
    if (!(await assertWaWorkspace(req, res, waNumber))) return;

    const interval = timeRangeToInterval(timeRange);
    let timeFilter = `AND timestamp >= NOW() - ${DEFAULT_DATA_WINDOW}`;
    if (interval) timeFilter = `AND timestamp >= NOW() - ${interval}`;

    // BDA visibility: only contacts whose assigned_user_id matches the user.
    // Admin sees everyone. Switch from LEFT to INNER JOIN for non-admins.
    const params = [waNumber];
    let joinKind = 'LEFT JOIN';
    let assignFilter = '';
    if (!isAdmin(req.user)) {
      joinKind = 'INNER JOIN';
      params.push(req.user.id);
      assignFilter = `AND c.assigned_user_id = $${params.length}`;
    }
    const { rows } = await pool.query(`
      SELECT
        ch.contact_number,
        MAX(ch.timestamp) AS last_message_time,
        COUNT(*) AS message_count,
        COUNT(*) FILTER (
          WHERE ch.direction = 'incoming'
            AND ch.timestamp > COALESCE(cr.last_read_at, 'epoch'::timestamptz)
        ) AS unread_count,
        (SELECT CASE
                  WHEN NULLIF(ch2.message_body, '') IS NOT NULL THEN ch2.message_body
                  WHEN ch2.message_type IN ('audio','voice') THEN '🎵 Audio'
                  WHEN ch2.message_type = 'image'   THEN '📷 Photo'
                  WHEN ch2.message_type = 'video'   THEN '🎥 Video'
                  WHEN ch2.message_type = 'document' THEN '📄 Document'
                  WHEN ch2.message_type = 'location' THEN '📍 Location'
                  WHEN ch2.message_type = 'contacts' THEN '👤 Contact'
                  WHEN ch2.message_type = 'sticker'  THEN 'Sticker'
                  WHEN ch2.message_type = 'template' THEN 'Template message'
                  WHEN ch2.message_type = 'interactive' THEN 'Interactive message'
                  WHEN ch2.message_type IN ('unsupported','unknown') THEN 'Unsupported message'
                  ELSE NULL
                END
         FROM coexistence.chat_history ch2
         WHERE ch2.wa_number = $1 AND ch2.contact_number = ch.contact_number
           AND ch2.message_type NOT IN ('reaction','status')
         ORDER BY ch2.timestamp DESC LIMIT 1) AS last_message,
        COALESCE(c.name, c.profile_name) AS name,
        c.tags,
        c.assigned_user_id,
        u.display_name AS assigned_user_name,
        u.role        AS assigned_user_role
      FROM coexistence.chat_history ch
      ${joinKind} coexistence.contacts c
        ON c.wa_number = ch.wa_number AND c.contact_number = ch.contact_number
      LEFT JOIN coexistence.akchat_users u ON u.id = c.assigned_user_id
      LEFT JOIN coexistence.conversation_reads cr
        ON cr.wa_number = ch.wa_number AND cr.contact_number = ch.contact_number
      WHERE ch.wa_number = $1 ${timeFilter} ${assignFilter}
      GROUP BY ch.contact_number, c.name, c.profile_name, c.tags, c.assigned_user_id, u.display_name, u.role, cr.last_read_at
      ORDER BY last_message_time DESC
    `, params);

    res.json(rows.map(r => ({ ...r, tags: r.tags || [], unread_count: Number(r.unread_count) || 0 })));
  } catch (err) {
    console.error('[messages] /contacts error:', err.message);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

// POST /api/contacts/save
// Also the backend for manual "Add Contact": accepts any phone formatting
// (spaces, dashes, +91, bare 10-digit) via normalizePhone, and an optional
// email that gets merged into custom_fields alongside any existing fields.
router.post('/contacts/save', requireRole('AGENT'), async (req, res) => {
  try {
    const { waNumber, contactNumber, name, tags, customFields, assignedUserId, email } = req.body;
    if (!waNumber || !contactNumber) {
      return res.status(400).json({ error: 'waNumber and contactNumber required' });
    }
    // Re-normalizing here is a no-op for existing callers (they already pass
    // a clean contact_number pulled from the DB) and is what lets the new
    // Add Contact form accept any format the user types.
    const normalizedContactNumber = normalizePhone(contactNumber) || String(contactNumber).replace(/\D/g, '');
    if (!normalizedContactNumber) {
      return res.status(400).json({ error: 'Enter a valid phone number' });
    }
    if (name != null && String(name).length > 255) {
      return res.status(400).json({ error: 'Name too long (max 255 characters)' });
    }
    if (tags != null && (!Array.isArray(tags) || tags.length > 50)) {
      return res.status(400).json({ error: 'tags must be an array of at most 50 items' });
    }
    if (customFields != null && JSON.stringify(customFields).length > 10000) {
      return res.status(400).json({ error: 'customFields payload too large' });
    }
    const admin = isAdmin(req.user);

    // Sales users may only edit a contact already assigned to them.
    if (!admin && !(await assertContactAccess(req, res, waNumber, normalizedContactNumber))) return;
    if (!(await assertWaWorkspace(req, res, waNumber))) return;

    // name is optional: a blank name means "don't touch the name" (used by the
    // chat-header quick-actions that only change tags/assignment). When blank we
    // store NULL and preserve any existing name via COALESCE on conflict, so a
    // tag/assign change can never overwrite the contact's name or promote a
    // WhatsApp profile_name into the CRM name column.
    const cleanName = (name && name.trim()) ? name.trim() : null;

    // custom_fields is an object keyed by field id ({fieldId: value}); when
    // omitted ($5 = NULL) existing values are preserved (new rows fall back to
    // an empty object) so a save can't accidentally wipe them. A bare `email`
    // (used by the manual Add Contact form) is merged in the same way rather
    // than replacing the whole object.
    let cf = null;
    if (customFields !== undefined && customFields !== null) {
      cf = JSON.stringify(customFields);
    } else if (email !== undefined && email !== null && String(email).trim()) {
      cf = JSON.stringify({ email: String(email).trim() });
    }

    // assigned_user_id (who owns this chat):
    //   - sales user  → forced to themselves (can't reassign)
    //   - admin + assignedUserId given (incl. null) → set / clear it
    //   - admin + omitted → preserve existing (or NULL on a brand-new row)
    let setAssign = false;
    let assignVal = null;
    if (!admin) {
      setAssign = true;
      assignVal = req.user.id;
    } else if (assignedUserId !== undefined) {
      setAssign = true;
      assignVal = (assignedUserId === null || assignedUserId === '') ? null : parseInt(assignedUserId, 10);
    }

    await pool.query(`
      INSERT INTO coexistence.contacts
        (wa_number, contact_number, name, tags, custom_fields, assigned_user_id, updated_at)
      VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, '{}'::jsonb), $6, NOW())
      ON CONFLICT (wa_number, contact_number)
      DO UPDATE SET
        name = COALESCE(EXCLUDED.name, coexistence.contacts.name),
        tags = EXCLUDED.tags,
        -- '||' merges keys instead of replacing the whole object, so a bare
        -- {email} patch from Add Contact can't wipe custom fields set
        -- elsewhere (e.g. by the Google Sheet sync or a field editor save).
        custom_fields = CASE WHEN $5::jsonb IS NULL THEN coexistence.contacts.custom_fields
                              ELSE coexistence.contacts.custom_fields || $5::jsonb END,
        assigned_user_id = CASE WHEN $7::boolean THEN $6 ELSE coexistence.contacts.assigned_user_id END,
        updated_at = NOW()
    `, [waNumber, normalizedContactNumber, cleanName, JSON.stringify(tags || []), cf, assignVal, setAssign]);

    res.json({ ok: true });
  } catch (err) {
    console.error('[messages] /contacts/save error:', err.message);
    res.status(500).json({ error: 'Failed to save contact' });
  }
});

// GET /api/contacts/import/template — download a sample .xlsx (Name, Phone Number).
// Generated on the fly; the auth cookie rides along on a plain anchor download.
router.get('/contacts/import/template', async (req, res) => {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Contacts');
    ws.columns = [
      { header: 'Name', key: 'name', width: 24 },
      { header: 'Phone Number', key: 'phone', width: 20 },
    ];
    ws.addRow({ name: 'John Doe', phone: '919876543210' });
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="contacts-import-template.xlsx"');
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error('[messages] /contacts/import/template error:', err.message);
    res.status(500).json({ error: 'Failed to build template' });
  }
});

// Shared by POST /contacts/import (file upload) and POST /contacts/import-sheet
// (Google Sheet URL, one-time pull) — one place defines "how a row becomes a
// contact" so both entry points stay identical in behavior (same header
// aliases, same phone normalization, same dedupe/ownership rules).
async function importContactRows(rows, { waNumber, admin, userId }) {
  let imported = 0, updated = 0;
  const skipped = [];
  const seen = new Set();

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2; // +1 header, +1 for 1-based display
    const rawName = pickImportColumn(rows[i], IMPORT_NAME_ALIASES);
    const rawPhone = pickImportColumn(rows[i], IMPORT_PHONE_ALIASES);
    const rawEmail = pickImportColumn(rows[i], IMPORT_EMAIL_ALIASES);
    const name = (rawName === undefined || rawName === null) ? '' : String(rawName).trim();
    const email = (rawEmail === undefined || rawEmail === null) ? '' : String(rawEmail).trim();
    // normalizePhone accepts any formatting (spaces, dashes, +, leading 0s)
    // and a bare 10-digit Indian mobile number, and always returns the
    // number WITH country code — same shape every other contact is stored in.
    const phone = normalizePhone(rawPhone);

    if (!phone) { skipped.push({ row: rowNum, reason: `Invalid or missing phone "${String(rawPhone ?? '').trim() || '(blank)'}"` }); continue; }
    if (!name) { skipped.push({ row: rowNum, reason: 'Missing name' }); continue; }
    if (seen.has(phone)) { skipped.push({ row: rowNum, reason: 'Duplicate phone in sheet' }); continue; }
    seen.add(phone);

    // custom_fields.email merge: keep any existing custom fields on update,
    // only ever add/overwrite the email key — never wipes other data an
    // earlier import or the Google Sheet sync already stored on this contact.
    const emailPatch = JSON.stringify(email ? { email } : {});

    let result;
    if (admin) {
      result = await pool.query(`
        INSERT INTO coexistence.contacts (wa_number, contact_number, name, tags, custom_fields, updated_at)
        VALUES ($1, $2, $3, '[]'::jsonb, $4::jsonb, NOW())
        ON CONFLICT (wa_number, contact_number)
        DO UPDATE SET name = COALESCE(EXCLUDED.name, coexistence.contacts.name),
                      custom_fields = coexistence.contacts.custom_fields || $4::jsonb,
                      updated_at = NOW()
        RETURNING (xmax = 0) AS inserted
      `, [waNumber, phone, name, emailPatch]);
    } else {
      // New rows assign to the importing user; existing rows keep their current
      // owner (COALESCE) so an import can't silently steal another user's contact.
      result = await pool.query(`
        INSERT INTO coexistence.contacts (wa_number, contact_number, name, tags, custom_fields, assigned_user_id, updated_at)
        VALUES ($1, $2, $3, '[]'::jsonb, $4::jsonb, $5, NOW())
        ON CONFLICT (wa_number, contact_number)
        DO UPDATE SET name = COALESCE(EXCLUDED.name, coexistence.contacts.name),
                      custom_fields = coexistence.contacts.custom_fields || $4::jsonb,
                      assigned_user_id = COALESCE(coexistence.contacts.assigned_user_id, EXCLUDED.assigned_user_id),
                      updated_at = NOW()
        RETURNING (xmax = 0) AS inserted
      `, [waNumber, phone, name, emailPatch, userId]);
    }
    if (result.rows[0]?.inserted) imported++; else updated++;
  }

  return { imported, updated, skipped };
}

// Converts a raw grid (array of arrays, row 0 = header) — the shape
// googleSheetService.fetchSheetGrid returns — into the same header-keyed row
// objects parseSheetRows produces for file uploads, so importContactRows can
// process either source identically.
function gridToRowObjects(grid) {
  if (!Array.isArray(grid) || grid.length === 0) return [];
  const headers = grid[0];
  return grid.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, i) => { if (h) obj[h] = row[i] ?? ''; });
    return obj;
  });
}

// ── Phase 4I — Import preview/validate ───────────────────────────────────
// Adds a Preview -> Validate step in front of the existing direct-import
// endpoint below, without changing that endpoint's behavior (nothing here
// touches importContactRows' insert/update logic — it's called unchanged by
// /contacts/import/confirm once the customer confirms what they saw).
//
// No new database table: a parsed-and-validated file is small (<=5000 rows,
// same MAX_ROWS as direct import) and only needs to survive the few minutes
// between "upload" and "click confirm", so it's held in-memory keyed by a
// random importId. If the process restarts in that window the id simply
// stops resolving and confirm returns 410 asking the customer to re-upload
// — no partial/half-imported data is ever possible, since nothing is
// written to coexistence.contacts until confirm runs importContactRows.
const IMPORT_PREVIEW_TTL_MS = 15 * 60 * 1000; // 15 minutes
const importPreviewSessions = new Map(); // importId -> { rows, waNumber, workspaceId, userId, admin, expiresAt }

function cleanupExpiredImportSessions() {
  const now = Date.now();
  for (const [id, s] of importPreviewSessions) {
    if (s.expiresAt < now) importPreviewSessions.delete(id);
  }
}

// Classifies parsed rows the same way importContactRows will treat them,
// but performs no writes. "duplicate" = a contact already exists for this
// wa_number+contact_number in THIS workspace (import will update it, same
// as direct import always has); "valid" = will insert a new contact;
// "invalid" = missing/unusable phone, missing name, or a repeat phone
// within the file itself.
async function classifyImportRows(rows, waNumber) {
  const phones = [];
  const parsed = rows.map((row, i) => {
    const rowNum = i + 2;
    const rawName = pickImportColumn(row, IMPORT_NAME_ALIASES);
    const rawPhone = pickImportColumn(row, IMPORT_PHONE_ALIASES);
    const rawEmail = pickImportColumn(row, IMPORT_EMAIL_ALIASES);
    const name = (rawName === undefined || rawName === null) ? '' : String(rawName).trim();
    const email = (rawEmail === undefined || rawEmail === null) ? '' : String(rawEmail).trim();
    const phone = normalizePhone(rawPhone);
    if (phone) phones.push(phone);
    return { rowNum, name, email, phone, rawPhone: String(rawPhone ?? '').trim() };
  });

  const { rows: existingRows } = phones.length
    ? await pool.query(
        `SELECT contact_number FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = ANY($2::text[])`,
        [waNumber, phones]
      )
    : { rows: [] };
  const existingPhones = new Set(existingRows.map((r) => r.contact_number));

  const seen = new Set();
  const classified = parsed.map((r) => {
    if (!r.phone) return { ...r, status: 'invalid', reason: `Invalid or missing phone "${r.rawPhone || '(blank)'}"` };
    if (!r.name) return { ...r, status: 'invalid', reason: 'Missing name' };
    if (seen.has(r.phone)) return { ...r, status: 'invalid', reason: 'Duplicate phone in sheet' };
    seen.add(r.phone);
    if (existingPhones.has(r.phone)) return { ...r, status: 'duplicate', reason: 'Already exists — will be updated' };
    return { ...r, status: 'valid', reason: null };
  });

  return classified;
}

// POST /api/contacts/import/preview — upload, parse, and validate a
// .csv/.xlsx WITHOUT writing anything. Returns row-level classification
// (valid/duplicate/invalid) plus a summary, and an importId to confirm with.
router.post('/contacts/import/preview', requireRole('AGENT'), requirePermission('contacts'), sheetUpload.single('file'), async (req, res) => {
  try {
    const waNumber = String(req.body.waNumber || '').replace(/\D/g, '');
    if (!waNumber) return res.status(400).json({ error: 'waNumber required' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const admin = isAdmin(req.user);
    if (!admin && !(await assertWaAccess(req, res, waNumber))) return;
    if (!(await assertWaWorkspace(req, res, waNumber))) return;

    let rows;
    try {
      rows = await parseSheetRows(req.file);
    } catch {
      return res.status(400).json({ error: 'Could not read the file. Upload a valid .csv or .xlsx sheet.' });
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'The sheet has no data rows.' });
    }
    const MAX_ROWS = 5000;
    if (rows.length > MAX_ROWS) {
      return res.status(400).json({ error: `Too many rows (${rows.length}). The limit is ${MAX_ROWS} per import.` });
    }

    const classified = await classifyImportRows(rows, waNumber);
    const valid = classified.filter((r) => r.status === 'valid').length;
    const duplicate = classified.filter((r) => r.status === 'duplicate').length;
    const invalid = classified.filter((r) => r.status === 'invalid').length;

    cleanupExpiredImportSessions();
    const importId = crypto.randomUUID();
    importPreviewSessions.set(importId, {
      // Only rows that will actually be written are kept for confirm — no
      // point carrying invalid rows through to the insert/update step.
      // Stored under canonical "Name"/"Phone"/"Email" headers so
      // importContactRows' own pickImportColumn/normalizePhone re-run on
      // confirm exactly as they would for a direct import — one code path,
      // not a re-derived copy of its insert logic.
      rows: classified.filter((r) => r.status !== 'invalid').map((r) => ({ Name: r.name, Phone: r.phone, Email: r.email })),
      waNumber,
      workspaceId: req.workspace.id,
      userId: req.user.id,
      admin,
      expiresAt: Date.now() + IMPORT_PREVIEW_TTL_MS,
    });

    res.json({
      ok: true,
      importId,
      total: rows.length,
      valid,
      duplicate,
      invalid,
      rows: classified.slice(0, 200).map((r) => ({
        row: r.rowNum, name: r.name || null, phone: r.phone || r.rawPhone || null,
        email: r.email || null, status: r.status, reason: r.reason,
      })),
      truncated: classified.length > 200,
    });
  } catch (err) {
    console.error('[messages] /contacts/import/preview error:', err.message);
    res.status(500).json({ error: 'Failed to preview import' });
  }
});

// POST /api/contacts/import/confirm — commits a previously-previewed
// import. Re-checks permission/role/workspace-ownership independently of
// whatever the preview session recorded (never trust stored state for
// authorization), then hands the same rows to importContactRows() that
// /contacts/import uses directly — identical insert/update/dedupe behavior.
router.post('/contacts/import/confirm', requireRole('AGENT'), requirePermission('contacts'), async (req, res) => {
  try {
    const { importId } = req.body || {};
    if (!importId) return res.status(400).json({ error: 'importId required' });

    cleanupExpiredImportSessions();
    const session = importPreviewSessions.get(importId);
    if (!session) {
      return res.status(410).json({ error: 'This preview has expired. Please re-upload the file.' });
    }

    const waNumber = String(req.body.waNumber || session.waNumber || '').replace(/\D/g, '');
    if (waNumber !== session.waNumber) {
      return res.status(400).json({ error: 'waNumber does not match the previewed file.' });
    }

    // workspace_id is always re-derived from the authenticated session
    // (req.workspace), never trusted from the stored preview — a workspace
    // switch between preview and confirm must not let this write elsewhere.
    const admin = isAdmin(req.user);
    if (!admin && !(await assertWaAccess(req, res, waNumber))) return;
    if (!(await assertWaWorkspace(req, res, waNumber))) return;
    if (req.workspace.id !== session.workspaceId) {
      return res.status(403).json({ error: 'Workspace changed since preview — please re-upload the file.' });
    }

    const { imported, updated, skipped } = await importContactRows(session.rows, { waNumber, admin, userId: req.user.id });
    importPreviewSessions.delete(importId);

    res.json({ ok: true, imported, updated, skipped, total: session.rows.length });
  } catch (err) {
    console.error('[messages] /contacts/import/confirm error:', err.message);
    res.status(500).json({ error: 'Failed to import contacts' });
  }
});

// POST /api/contacts/import — bulk-import contacts (Name + Phone) from a .csv/.xlsx
// sheet onto a WhatsApp number. Parsed server-side with exceljs; row-by-row upsert
// keyed on UNIQUE(wa_number, contact_number). Returns counts + skipped rows.
router.post('/contacts/import', requireRole('AGENT'), sheetUpload.single('file'), async (req, res) => {
  try {
    const waNumber = String(req.body.waNumber || '').replace(/\D/g, '');
    if (!waNumber) return res.status(400).json({ error: 'waNumber required' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const admin = isAdmin(req.user);
    // Non-admins may only import onto a WhatsApp number they have access to.
    if (!admin && !(await assertWaAccess(req, res, waNumber))) return;
    if (!(await assertWaWorkspace(req, res, waNumber))) return;

    let rows;
    try {
      // exceljs returns cell values as text/number; cellToString normalises them
      // so phone numbers don't arrive as floats / scientific notation.
      rows = await parseSheetRows(req.file);
    } catch {
      return res.status(400).json({ error: 'Could not read the file. Upload a valid .csv or .xlsx sheet.' });
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'The sheet has no data rows.' });
    }
    const MAX_ROWS = 5000;
    if (rows.length > MAX_ROWS) {
      return res.status(400).json({ error: `Too many rows (${rows.length}). The limit is ${MAX_ROWS} per import.` });
    }

    const { imported, updated, skipped } = await importContactRows(rows, { waNumber, admin, userId: req.user.id });
    res.json({ ok: true, imported, updated, skipped, total: rows.length });
  } catch (err) {
    console.error('[messages] /contacts/import error:', err.message);
    res.status(500).json({ error: 'Failed to import contacts' });
  }
});

// POST /api/contacts/import-sheet — one-time pull from a public Google Sheet
// URL, right from the Contacts page (distinct from the persistent auto-sync
// configured in Admin Settings: no URL is saved here, nothing is scheduled,
// this just imports whatever is in the sheet right now). Reuses the exact
// same header-detection/phone-normalization/dedupe logic as the file import
// via importContactRows, and the same read-only sheet fetcher the background
// sync uses — KlutchChat still never writes to the sheet.
router.post('/contacts/import-sheet', requireRole('AGENT'), async (req, res) => {
  try {
    const waNumber = String(req.body.waNumber || '').replace(/\D/g, '');
    const sheetUrl = String(req.body.sheetUrl || '').trim();
    if (!waNumber) return res.status(400).json({ error: 'waNumber required' });
    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });

    const admin = isAdmin(req.user);
    if (!admin && !(await assertWaAccess(req, res, waNumber))) return;
    if (!(await assertWaWorkspace(req, res, waNumber))) return;

    let grid;
    try {
      grid = await fetchSheetGrid(sheetUrl);
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Could not read that Google Sheet.' });
    }

    const rows = gridToRowObjects(grid);
    if (rows.length === 0) {
      return res.status(400).json({ error: 'The sheet has no data rows.' });
    }
    const MAX_ROWS = 5000;
    if (rows.length > MAX_ROWS) {
      return res.status(400).json({ error: `Too many rows (${rows.length}). The limit is ${MAX_ROWS} per import.` });
    }

    const { imported, updated, skipped } = await importContactRows(rows, { waNumber, admin, userId: req.user.id });
    res.json({ ok: true, imported, updated, skipped, total: rows.length });
  } catch (err) {
    console.error('[messages] /contacts/import-sheet error:', err.message);
    res.status(500).json({ error: 'Failed to import from Google Sheet' });
  }
});

// DELETE /api/contact?waNumber=xxx&contactNumber=xxx — remove the saved contact
// record (name/profile_name/tags/custom_fields/assignment). Chat history lives in
// a separate table and is left intact; a future inbound message will recreate a
// bare row from the WhatsApp profile name.
router.delete('/contact', requireRole('AGENT'), async (req, res) => {
  try {
    const waNumber = req.query.waNumber || req.body?.waNumber;
    const contactNumber = req.query.contactNumber || req.body?.contactNumber;
    if (!waNumber || !contactNumber) {
      return res.status(400).json({ error: 'waNumber and contactNumber required' });
    }
    // BDAs can only delete a contact they have access to; admins can delete any.
    if (!(await assertContactAccess(req, res, waNumber, contactNumber))) return;
    if (!(await assertWaWorkspace(req, res, waNumber))) return;
    const { rowCount } = await pool.query(
      `DELETE FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $2`,
      [waNumber, contactNumber]
    );
    res.json({ ok: true, deleted: rowCount });
  } catch (err) {
    console.error('[messages] DELETE /contact error:', err.message);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

// GET /api/saved-contacts?waNumber=xxx
router.get('/saved-contacts', async (req, res) => {
  try {
    const { waNumber } = req.query;
    if (!waNumber) return res.status(400).json({ error: 'waNumber required' });
    if (!(await assertWaAccess(req, res, waNumber))) return;
    if (!(await assertWaWorkspace(req, res, waNumber))) return;

    const params = [waNumber];
    let assignFilter = '';
    if (!isAdmin(req.user)) {
      params.push(req.user.id);
      assignFilter = `AND assigned_user_id = $${params.length}`;
    }
    const { rows } = await pool.query(`
      SELECT c.contact_number, COALESCE(c.name, c.profile_name, c.contact_number) AS name, c.tags, c.custom_fields, c.created_at, c.updated_at,
             c.assigned_user_id, u.display_name AS assigned_user_name, u.role AS assigned_user_role
      FROM coexistence.contacts c
      LEFT JOIN coexistence.akchat_users u ON u.id = c.assigned_user_id
      WHERE c.wa_number = $1 ${assignFilter.replace(/assigned_user_id/g, 'c.assigned_user_id')}
      ORDER BY COALESCE(c.name, c.profile_name, c.contact_number) ASC
    `, params);

    res.json(rows.map(r => ({ ...r, tags: r.tags || [] })));
  } catch (err) {
    console.error('[messages] /saved-contacts error:', err.message);
    res.status(500).json({ error: 'Failed to fetch saved contacts' });
  }
});

// GET /api/contact?waNumber=xxx&contactNumber=xxx
router.get('/contact', async (req, res) => {
  try {
    const { waNumber, contactNumber } = req.query;
    if (!waNumber || !contactNumber) {
      return res.status(400).json({ error: 'waNumber and contactNumber required' });
    }
    if (!(await assertContactAccess(req, res, waNumber, contactNumber))) return;
    if (!(await assertWaWorkspace(req, res, waNumber))) return;

    const { rows } = await pool.query(`
      SELECT c.contact_number, COALESCE(c.name, c.profile_name) AS name, c.tags, c.custom_fields, c.created_at, c.updated_at,
             c.assigned_user_id,
             u.display_name AS assigned_user_name,
             u.role AS assigned_user_role
      FROM coexistence.contacts c
      LEFT JOIN coexistence.akchat_users u ON u.id = c.assigned_user_id
      WHERE c.wa_number = $1 AND c.contact_number = $2
      LIMIT 1
    `, [waNumber, contactNumber]);

    if (rows.length === 0) {
      return res.json({ contact_number: contactNumber, name: null, tags: [] });
    }

    res.json({ ...rows[0], tags: rows[0].tags || [] });
  } catch (err) {
    console.error('[messages] /contact error:', err.message);
    res.status(500).json({ error: 'Failed to fetch contact' });
  }
});

// POST /api/messages/mark-read — stamp a conversation as read (agent opened it).
// Clears the unread badge for this (wa_number, contact_number).
router.post('/messages/mark-read', async (req, res) => {
  try {
    const { waNumber, contactNumber } = req.body;
    if (!waNumber || !contactNumber) {
      return res.status(400).json({ error: 'waNumber and contactNumber required' });
    }
    if (!(await assertContactAccess(req, res, waNumber, contactNumber))) return;
    if (!(await assertWaWorkspace(req, res, waNumber))) return;

    const workspaceId = req.workspace?.id ?? null;
    await pool.query(`
      INSERT INTO coexistence.conversation_reads (workspace_id, wa_number, contact_number, last_read_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (workspace_id, wa_number, contact_number)
      DO UPDATE SET last_read_at = NOW()
    `, [workspaceId, waNumber, contactNumber]);

    res.json({ ok: true });
  } catch (err) {
    console.error('[messages] /messages/mark-read error:', err.message);
    res.status(500).json({ error: 'Failed to mark read' });
  }
});

// GET /api/messages?waNumber=xxx&contactNumber=xxx&page=1&limit=50
router.get('/messages', async (req, res) => {
  try {
    const {
      waNumber, contactNumber,
      page = '1', limit = '50',
      search = '', direction = 'all',
    } = req.query;

    if (!waNumber || !contactNumber) {
      return res.status(400).json({ error: 'waNumber and contactNumber required' });
    }
    if (!(await assertContactAccess(req, res, waNumber, contactNumber))) return;
    if (!(await assertWaWorkspace(req, res, waNumber))) return;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const offset = (pageNum - 1) * limitNum;

    const params = [waNumber, contactNumber];
    let paramIdx = 3;
    const conditions = [
      'wa_number = $1',
      'contact_number = $2',
      `timestamp >= NOW() - ${DEFAULT_DATA_WINDOW}`,
      // Defensive: never render status-receipt rows as chat bubbles (legacy
      // phantom "Status: delivered" rows; the webhook no longer creates these).
      `message_type <> 'status'`,
    ];

    const trimmedSearch = (typeof search === 'string' ? search : '').trim().slice(0, 200);
    if (trimmedSearch) {
      conditions.push(`COALESCE(message_body, '') ILIKE $${paramIdx}`);
      params.push(`%${trimmedSearch}%`);
      paramIdx++;
    }

    if (direction === 'incoming') {
      conditions.push(`direction = $${paramIdx}`);
      params.push('incoming');
      paramIdx++;
    } else if (direction === 'outgoing') {
      conditions.push(`direction = $${paramIdx}`);
      params.push('outgoing');
      paramIdx++;
    }

    const whereClause = conditions.join(' AND ');

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM coexistence.chat_history WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    const { rows } = await pool.query(
      `SELECT * FROM coexistence.chat_history
       WHERE ${whereClause}
       ORDER BY timestamp DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limitNum, offset]
    );

    // Attach reactions (emoji badges) to each message by its wamid.
    const ids = rows.map(r => r.message_id).filter(Boolean);
    const reactionsByMsg = {};
    if (ids.length > 0) {
      const { rows: rx } = await pool.query(
        `SELECT target_message_id, direction, emoji
           FROM coexistence.message_reactions
          WHERE target_message_id = ANY($1)`,
        [ids]
      );
      for (const r of rx) {
        (reactionsByMsg[r.target_message_id] ||= []).push({ emoji: r.emoji, direction: r.direction });
      }
    }

    // Phase 6.5 — WhatsApp Flow submission display. chat_history never
    // stored the submitted answers (only message_body = 'Sent'); they live
    // in coexistence.flow_submissions, keyed by the same message_id. Read
    // ONLY (no write, no schema change) and attach a sanitized
    // flow_response_data object to the matching flow_response row so the
    // frontend can render it. flow_token / internal ids are stripped here
    // so they can never reach the client. Every other message type/row is
    // untouched.
    const flowMsgIds = rows
      .filter(r => r.message_type === 'flow_response' && r.message_id)
      .map(r => r.message_id);
    const flowDataByMsg = {};
    if (flowMsgIds.length > 0) {
      try {
        const { rows: fs } = await pool.query(
          `SELECT message_id, response_json
             FROM coexistence.flow_submissions
            WHERE message_id = ANY($1)`,
          [flowMsgIds]
        );
        for (const f of fs) {
          const data = (f.response_json && typeof f.response_json === 'object')
            ? { ...f.response_json }
            : {};
          delete data.flow_token;
          flowDataByMsg[f.message_id] = data;
        }
      } catch (flowErr) {
        // Never let a lookup problem here break normal message loading.
        console.error('[messages] flow_submissions lookup error:', flowErr.message);
      }
    }

    res.json({
      messages: rows
        // Strip raw_payload (the full Meta webhook JSON) — it's internal-only,
        // never read by the client, and can carry extra PII / metadata.
        .map(({ raw_payload, ...m }) => ({
          ...m,
          reactions: reactionsByMsg[m.message_id] || [],
          ...(m.message_type === 'flow_response'
            ? { flow_response_data: flowDataByMsg[m.message_id] || null }
            : {}),
        }))
        .reverse(), // oldest first for chat display
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    console.error('[messages] /messages error:', err.message);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// GET /api/contact-names?waNumber=xxx
router.get('/contact-names', async (req, res) => {
  try {
    const { waNumber } = req.query;
    if (!waNumber) return res.status(400).json({ error: 'waNumber required' });
    if (!(await assertWaAccess(req, res, waNumber))) return;
    if (!(await assertWaWorkspace(req, res, waNumber))) return;

    const params = [waNumber];
    let assignFilter = '';
    if (!isAdmin(req.user)) {
      params.push(req.user.id);
      assignFilter = `AND assigned_user_id = $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT contact_number, COALESCE(name, profile_name) AS name FROM coexistence.contacts WHERE wa_number = $1 ${assignFilter}`,
      params
    );

    const nameMap = {};
    rows.forEach(r => { nameMap[r.contact_number] = r.name; });
    res.json(nameMap);
  } catch (err) {
    console.error('[messages] /contact-names error:', err.message);
    res.status(500).json({ error: 'Failed to fetch contact names' });
  }
});

/**
 * GET /messages/window-status?waNumber=&contactNumber=
 * Returns { canSendFreeForm: boolean, lastIncomingSecondsAgo: number|null, windowSeconds: 86400 }
 * The frontend uses this to grey out the chat input when outside the 24h
 * customer service window.
 */
router.get('/messages/window-status', async (req, res) => {
  try {
    const { waNumber, contactNumber } = req.query;
    if (!waNumber || !contactNumber) return res.status(400).json({ error: 'waNumber and contactNumber required' });
    if (!(await assertWaWorkspace(req, res, waNumber))) return;
    const { account, error } = await resolveAccount({ fromPhoneNumber: waNumber, workspaceId: req.workspace?.id });
    if (error) return res.json({ canSendFreeForm: false, reason: error, windowSeconds: SERVICE_WINDOW_SECONDS });
    const secs = await secondsSinceLastIncoming({ accountPhoneNumberId: account.phoneNumberId, contactNumber });
    res.json({
      canSendFreeForm: secs != null && secs <= SERVICE_WINDOW_SECONDS,
      lastIncomingSecondsAgo: secs,
      windowSeconds: SERVICE_WINDOW_SECONDS,
      accountId: account.id,
      accountName: account.displayName,
    });
  } catch (err) {
    console.error('[messages] window-status error:', err.message);
    res.status(500).json({ error: 'Failed to compute window status' });
  }
});

/**
 * POST /messages/react
 * Body: { fromNumber, toNumber, messageId, emoji }
 * Sends an emoji reaction to a message (empty emoji removes it). Requires the
 * 24-hour customer service window to be open. Records our reaction locally.
 */
router.post('/messages/react', requireRole('AGENT'), async (req, res) => {
  try {
    const { fromNumber, toNumber, messageId, emoji } = req.body || {};
    if (!fromNumber || !toNumber || !messageId) {
      return res.status(400).json({ error: 'fromNumber, toNumber and messageId required' });
    }
    if (!(await assertContactAccess(req, res, fromNumber, toNumber))) return;
    if (!(await assertWaWorkspace(req, res, fromNumber))) return;

    const { account, error } = await resolveAccount({ fromPhoneNumber: fromNumber, workspaceId: req.workspace?.id });
    if (error) return res.status(409).json({ error });

    const secs = await secondsSinceLastIncoming({ accountPhoneNumberId: account.phoneNumberId, contactNumber: toNumber });
    if (secs == null || secs > SERVICE_WINDOW_SECONDS) {
      return res.status(409).json({ error: 'Outside 24-hour customer service window.', code: 'OUTSIDE_WINDOW' });
    }

    const cleanEmoji = typeof emoji === 'string' ? emoji : '';
    const wa = String(fromNumber).replace(/\D/g, '');
    const contact = String(toNumber).replace(/\D/g, '');

    // Record our reaction (outgoing). Empty emoji removes it.
    if (cleanEmoji) {
      await pool.query(
        `INSERT INTO coexistence.message_reactions
           (wa_number, contact_number, target_message_id, direction, emoji, updated_at)
         VALUES ($1,$2,$3,'outgoing',$4,NOW())
         ON CONFLICT (target_message_id, direction)
         DO UPDATE SET emoji = EXCLUDED.emoji, updated_at = NOW()`,
        [wa, contact, messageId, cleanEmoji]
      );
    } else {
      await pool.query(
        `DELETE FROM coexistence.message_reactions
           WHERE target_message_id = $1 AND direction = 'outgoing'
             AND wa_number = $2 AND contact_number = $3`,
        [messageId, wa, contact]
      );
    }

    await enqueueSend({
      kind: 'reaction',
      accountId: account.id,
      to: contact,
      payload: { messageId, emoji: cleanEmoji },
    });

    res.json({ ok: true, messageId, emoji: cleanEmoji, direction: 'outgoing' });
  } catch (err) {
    console.error('[messages] /react error:', err.message);
    res.status(500).json({ error: 'Failed to send reaction' });
  }
});

/**
 * POST /messages/star
 * Body: { waNumber, contactNumber, messageId, starred }
 * Toggles the local "starred" flag on a message (CRM-only bookmark).
 */
router.post('/messages/star', requireRole('AGENT'), async (req, res) => {
  try {
    const { waNumber, contactNumber, messageId, starred } = req.body || {};
    if (!waNumber || !contactNumber || !messageId) {
      return res.status(400).json({ error: 'waNumber, contactNumber and messageId required' });
    }
    if (!(await assertContactAccess(req, res, waNumber, contactNumber))) return;
    if (!(await assertWaWorkspace(req, res, waNumber))) return;
    // Scope to the validated (wa_number, contact_number) so a pair the user owns
    // can't be used to star a message_id from another conversation (IDOR).
    const waDigits = String(waNumber).replace(/\D/g, '');
    const contactDigits = String(contactNumber).replace(/\D/g, '');
    const { rowCount } = await pool.query(
      `UPDATE coexistence.chat_history SET starred = $1
         WHERE message_id = $2 AND wa_number = $3 AND contact_number = $4`,
      [!!starred, messageId, waDigits, contactDigits]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Message not found' });
    res.json({ ok: true, messageId, starred: !!starred });
  } catch (err) {
    console.error('[messages] /star error:', err.message);
    res.status(500).json({ error: 'Failed to update star' });
  }
});

/**
 * POST /messages/send
 * Body: { fromNumber, toNumber, text }
 * Inserts an optimistic chat_history row (status='sending') and enqueues a
 * BullMQ job. Returns the row immediately so the UI can render the bubble.
 */
router.post('/messages/send', requireRole('AGENT'), async (req, res) => {
  try {
    const { fromNumber, toNumber, text, contextMessageId } = req.body || {};
    if (!fromNumber || !toNumber || !text || !String(text).trim()) {
      return res.status(400).json({ error: 'fromNumber, toNumber, text required' });
    }
    if (String(text).length > 4096) {
      return res.status(400).json({ error: 'Message too long (max 4096 characters)' });
    }
    // Ownership: the (wa_number, contact_number) pair must belong to the
    // requester (admins bypass). This ties fromNumber to the user and gates
    // toNumber — a non-admin can't send from a WABA or to a contact they don't own.
    if (!(await assertContactAccess(req, res, fromNumber, toNumber))) return;
    if (!(await assertWaWorkspace(req, res, fromNumber))) return;

    const { account, error } = await resolveAccount({ fromPhoneNumber: fromNumber, workspaceId: req.workspace?.id });
    if (error) return res.status(400).json({ error });

    // Enforce Meta's 24h customer service window for free-form text
    const secs = await secondsSinceLastIncoming({ accountPhoneNumberId: account.phoneNumberId, contactNumber: toNumber });
    if (secs == null || secs > SERVICE_WINDOW_SECONDS) {
      return res.status(409).json({
        error: 'Outside 24-hour customer service window. Send an approved template instead.',
        code: 'OUTSIDE_WINDOW',
      });
    }

    const ctxId = sanitizeContextId(contextMessageId);
    const localId = await insertPendingRow({
      account, toNumber, messageType: 'text', messageBody: String(text).trim(),
      contextMessageId: ctxId,
    });

    const trimmedText = String(text).trim();
    await enqueueSend({
      kind: 'text',
      accountId: account.id,
      to: String(toNumber).replace(/\D/g, ''),
      localMessageId: localId,
      // Enable WhatsApp link preview when the message contains a URL
      payload: { body: trimmedText, previewUrl: /https?:\/\/\S+/i.test(trimmedText), contextMessageId: ctxId },
    });

    // Record that an agent replied right now for this conversation.
    // webhook.js compares this timestamp against each incoming customer message
    // timestamp. If this is newer than the customer message: AI skips that
    // message. Once the customer sends a NEW message (newer than this
    // timestamp), AI fires normally again. No permanent lock — per-message only.
    try {
      const waDigits = String(fromNumber).replace(/\D/g, '');
      const contactDigits = String(toNumber).replace(/\D/g, '');
      const agentUserId = req.user?.id || null;
      await pool.query(
        `INSERT INTO coexistence.contacts
           (wa_number, contact_number, last_agent_reply_at, last_agent_reply_by, tags, custom_fields, updated_at)
         VALUES ($1, $2, NOW(), $3, '[]'::jsonb, '{}'::jsonb, NOW())
         ON CONFLICT (wa_number, contact_number)
         DO UPDATE SET
           last_agent_reply_at = NOW(),
           last_agent_reply_by = $3,
           updated_at = NOW()`,
        [waDigits, contactDigits, agentUserId]
      );
      console.log(`[agent-reply] Recorded agent reply at ${new Date().toISOString()} for contact ${contactDigits}`);
    } catch (agentErr) {
      // Non-fatal -- message was already sent, just log the error
      console.error('[agent-reply] Failed to record last_agent_reply_at:', agentErr.message);
    }

    res.status(202).json({ ok: true, messageId: localId, status: 'sending' });
  } catch (err) {
    console.error('[messages] send error:', err.message);
    res.status(500).json({ error: 'Failed to enqueue send' });
  }
});

/**
 * POST /messages/send-media (multipart)
 * Fields: fromNumber, toNumber, caption?, file (binary)
 * Uploads the binary to Meta to get a media_id, then enqueues a send job.
 * Subject to the 24h customer service window same as text.
 */
router.post('/messages/send-media', requireRole('AGENT'), mediaUpload.single('file'), async (req, res) => {
  try {
    const { fromNumber, toNumber, caption = '', contextMessageId } = req.body || {};
    if (!fromNumber || !toNumber) return res.status(400).json({ error: 'fromNumber and toNumber required' });
    if (!req.file) return res.status(400).json({ error: 'file required' });
    if (!(await assertContactAccess(req, res, fromNumber, toNumber))) return;
    if (!(await assertWaWorkspace(req, res, fromNumber))) return;

    const { account, error } = await resolveAccount({ fromPhoneNumber: fromNumber, workspaceId: req.workspace?.id });
    if (error) return res.status(400).json({ error });

    const secs = await secondsSinceLastIncoming({ accountPhoneNumberId: account.phoneNumberId, contactNumber: toNumber });
    if (secs == null || secs > SERVICE_WINDOW_SECONDS) {
      return res.status(409).json({ error: 'Outside 24-hour customer service window.', code: 'OUTSIDE_WINDOW' });
    }

    const mime = canonicalizeMime(req.file.mimetype, req.file.originalname);
    const kind = chatKindFor(mime);
    if (!kind) return res.status(400).json({ error: `Unsupported file type "${req.file.mimetype || 'unknown'}". ${CHAT_TYPES_MSG}` });

    // Step 1: upload binary to Meta to get media_id
    let mediaId;
    try {
      const uploaded = await uploadMedia({
        accessToken: account.accessToken,
        phoneNumberId: account.phoneNumberId,
        buffer: req.file.buffer,
        mimeType: mime,
        filename: req.file.originalname,
      });
      mediaId = uploaded?.id;
      if (!mediaId) throw new Error('Meta upload returned no id');
      await markAccountHealth(account.id, 'healthy');
    } catch (err) {
      const cls = classifyMetaError(err);
      await markAccountHealth(account.id, cls, err.message);
      return res.status(err.status === 401 ? 401 : 400).json({ error: err.message, metaCode: err.metaError?.code });
    }

    // Step 2: insert optimistic row + mirror file locally so the bubble
    // renders the actual thumbnail / playback via /api/media/:messageId
    const ctxId = sanitizeContextId(contextMessageId);
    const localId = await insertPendingRow({
      account, toNumber, messageType: kind,
      messageBody: caption || req.file.originalname,
      mediaMime: mime,
      contextMessageId: ctxId,
    });
    const ext = req.file.originalname.split('.').pop()?.toLowerCase() || mime.split('/')[1] || 'bin';
    const accountDigits = (account.displayPhoneNumber || '').replace(/\D/g, '');
    const { absPath, size } = persistOutboundMedia({
      accountPhoneDigits: accountDigits, messageId: localId,
      buffer: req.file.buffer, ext,
    });
    await pool.query(
      `UPDATE coexistence.chat_history
          SET media_storage_path = $1, media_status = 'stored',
              media_size_bytes = $2, media_filename = $3,
              media_downloaded_at = NOW()
        WHERE message_id = $4`,
      [absPath, size, req.file.originalname, localId]
    );

    // Step 3: enqueue send to Meta
    await enqueueSend({
      kind: 'media',
      accountId: account.id,
      to: String(toNumber).replace(/\D/g, ''),
      localMessageId: localId,
      payload: {
        type: kind, mediaId, caption: caption || undefined,
        filename: kind === 'document' ? req.file.originalname : undefined,
        contextMessageId: ctxId,
      },
    });

    res.status(202).json({ ok: true, messageId: localId, status: 'sending', mediaId });
  } catch (err) {
    console.error('[messages] send-media error:', err.message);
    res.status(500).json({ error: 'Failed to send media' });
  }
});

/**
 * POST /messages/send-product
 * Body: { fromNumber, toNumber, productId, caption?, contextMessageId? }
 *
 * Phase 7.6 — sends a WhatsApp single-product message for a product already
 * in the caller's own workspace catalog (coexistence.products). `productId`
 * here is that product's INTERNAL id (the row the agent selected in
 * ProductPicker.jsx) — not to be confused with the product's external
 * Product ID/SKU/retailer_id column, which productService.findProductByExternalId
 * handles for other entry points.
 *
 * Isolation, mirrored from every other route in this file:
 *   - fromNumber/toNumber ownership: assertContactAccess (unchanged).
 *   - fromNumber belongs to the caller's OWN workspace: assertWaWorkspace
 *     (unchanged) — this is also what makes req.workspace.id trustworthy
 *     below.
 *   - The product looked up by productId must belong to that SAME
 *     workspace — enforced by productService.getProduct, which 404s
 *     rather than leaking cross-workspace existence.
 *   - The Meta catalog id is NEVER accepted from the client. It is
 *     resolved server-side from coexistence.meta_catalog_connections via
 *     whatsappProductMessage.resolveCatalogForAccount(workspaceId,
 *     account.id) — scoped to both the workspace and the specific
 *     WhatsApp account doing the sending.
 *
 * Reuses the exact same send path as every other interactive message in
 * this codebase: insertPendingRow() -> enqueueSend({ kind: 'interactive' })
 * -> queue/sendQueue.js's existing 'interactive' branch -> integrations/
 * metaSend.js's sendInteractive(). Neither of those two files is touched.
 */
router.post('/messages/send-product', requireRole('AGENT'), async (req, res) => {
  try {
    const { fromNumber, toNumber, productId, caption = '', contextMessageId } = req.body || {};
    if (!fromNumber || !toNumber) return res.status(400).json({ error: 'fromNumber and toNumber required' });
    if (!productId) return res.status(400).json({ error: 'productId required' });
    if (!(await assertContactAccess(req, res, fromNumber, toNumber))) return;
    if (!(await assertWaWorkspace(req, res, fromNumber))) return;

    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const { account, error } = await resolveAccount({ fromPhoneNumber: fromNumber, workspaceId });
    if (error) return res.status(400).json({ error });

    const secs = await secondsSinceLastIncoming({ accountPhoneNumberId: account.phoneNumberId, contactNumber: toNumber });
    if (secs == null || secs > SERVICE_WINDOW_SECONDS) {
      return res.status(409).json({ error: 'Outside 24-hour customer service window.', code: 'OUTSIDE_WINDOW' });
    }

    // Product lookup — workspace-scoped. A productId belonging to another
    // workspace surfaces as 404 here, exactly like every other product
    // lookup in this codebase (productService.js's isolation model).
    let product;
    try {
      product = await whatsappProductMessage.resolveProductForMessage(workspaceId, { id: productId });
    } catch (err) {
      if (err instanceof whatsappProductMessage.NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof whatsappProductMessage.ValidationError) return res.status(400).json({ error: err.message });
      throw err;
    }

    // Catalog id — resolved server-side only, scoped to this workspace +
    // this specific WhatsApp account. Never trust a catalogId from req.body.
    let catalogId;
    try {
      catalogId = await whatsappProductMessage.resolveCatalogForAccount(workspaceId, account.id);
    } catch (err) {
      if (err instanceof whatsappProductMessage.ValidationError) return res.status(400).json({ error: err.message });
      throw err;
    }

    const retailerId = whatsappProductMessage.resolveRetailerId(product);
    const trimmedCaption = String(caption || '').trim();
    const interactive = whatsappProductMessage.buildProductInteractive({
      catalogId,
      productRetailerId: retailerId,
      bodyText: trimmedCaption,
    });

    const ctxId = sanitizeContextId(contextMessageId);
    // Phase 7.9 — stash just enough of the product (name/image/price) on
    // the outgoing chat_history row's existing template_meta JSONB column
    // so MessageBubble.jsx can render a rich product card for this
    // message without a second lookup. Purely additive: template_meta is
    // already a generic per-row metadata column (see messageSender.js),
    // already threaded through GET /messages' `SELECT *`, and defaults to
    // null for every other message type/caller, so nothing existing is
    // affected by populating it here.
    const localId = await insertPendingRow({
      account, toNumber, messageType: 'interactive',
      messageBody: trimmedCaption || product.name,
      contextMessageId: ctxId,
      templateMeta: {
        kind: 'product',
        product: {
          id: product.id,
          name: product.name,
          imageUrl: product.image_url || null,
          price: product.price != null ? product.price : null,
          currency: product.currency || null,
          retailerId,
        },
      },
    });

    // NOTE: metaSend.js's sendInteractive() has no contextMessageId param
    // (interactive/product messages aren't quote-repliable via the Cloud
    // API the way text/media are) — ctxId above is only stored on the
    // local chat_history row above for the UI's own quote-reply rendering,
    // same as every other interactive send in this codebase.
    await enqueueSend({
      kind: 'interactive',
      accountId: account.id,
      to: String(toNumber).replace(/\D/g, ''),
      localMessageId: localId,
      payload: { interactive },
    });

    res.status(202).json({
      ok: true, messageId: localId, status: 'sending',
      product: { id: product.id, name: product.name, retailerId },
    });
  } catch (err) {
    console.error('[messages] send-product error:', err.message);
    res.status(500).json({ error: 'Failed to send product' });
  }
});

/**
 * POST /messages/send-catalog
 * Body: { fromNumber, toNumber, body, thumbnailProductId?, contextMessageId? }
 *
 * Phase 7.9 — sends a WhatsApp "catalog message" (interactive.type ===
 * 'catalog_message'), showing the customer the full catalog connected to
 * the sending WhatsApp account rather than a single product. Deliberately
 * the exact same proven shape as POST /messages/send-product above:
 *
 *   - fromNumber/toNumber ownership: assertContactAccess (unchanged).
 *   - fromNumber belongs to the caller's OWN workspace: assertWaWorkspace
 *     (unchanged).
 *   - `thumbnailProductId`, when supplied, is the product's INTERNAL id
 *     (picked from ProductPicker.jsx in its catalog mode) — resolved and
 *     workspace-scoped via whatsappProductMessage.resolveProductForMessage,
 *     exactly like send-product resolves productId. It is OPTIONAL: Meta's
 *     catalog_message only needs body text; a thumbnail product is a
 *     cosmetic nicety, not a requirement.
 *   - A connected Meta catalog is still required before sending (same
 *     resolveCatalogForAccount check send-product uses) — this route does
 *     not put that catalog id in the payload itself (buildCatalogInteractive
 *     never has; see services/whatsappProductMessage.js), it only uses the
 *     check to fail fast with a clear error instead of a silent Meta-side
 *     rejection when no catalog is connected for this account.
 *
 * Reuses the exact same send path as send-product: insertPendingRow() ->
 * enqueueSend({ kind: 'interactive' }) -> queue/sendQueue.js's existing
 * 'interactive' branch -> integrations/metaSend.js's sendInteractive().
 * Neither of those two files is touched.
 */
router.post('/messages/send-catalog', requireRole('AGENT'), async (req, res) => {
  try {
    const { fromNumber, toNumber, body = '', thumbnailProductId, contextMessageId } = req.body || {};
    if (!fromNumber || !toNumber) return res.status(400).json({ error: 'fromNumber and toNumber required' });
    const trimmedBody = String(body || '').trim();
    if (!trimmedBody) return res.status(400).json({ error: 'body is required' });
    if (!(await assertContactAccess(req, res, fromNumber, toNumber))) return;
    if (!(await assertWaWorkspace(req, res, fromNumber))) return;

    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const { account, error } = await resolveAccount({ fromPhoneNumber: fromNumber, workspaceId });
    if (error) return res.status(400).json({ error });

    const secs = await secondsSinceLastIncoming({ accountPhoneNumberId: account.phoneNumberId, contactNumber: toNumber });
    if (secs == null || secs > SERVICE_WINDOW_SECONDS) {
      return res.status(409).json({ error: 'Outside 24-hour customer service window.', code: 'OUTSIDE_WINDOW' });
    }

    // A connected catalog is required to send any catalog-backed message —
    // same fail-fast check send-product uses. Its return value isn't put
    // in the payload (see function doc above); this is validation only.
    try {
      await whatsappProductMessage.resolveCatalogForAccount(workspaceId, account.id);
    } catch (err) {
      if (err instanceof whatsappProductMessage.ValidationError) return res.status(400).json({ error: err.message });
      throw err;
    }

    // Optional thumbnail product — workspace-scoped lookup, same isolation
    // model as send-product's productId resolution. A thumbnailProductId
    // belonging to another workspace surfaces as 404, never leaked.
    let thumbnailProduct = null;
    let thumbnailRetailerId;
    if (thumbnailProductId) {
      try {
        thumbnailProduct = await whatsappProductMessage.resolveProductForMessage(workspaceId, { id: thumbnailProductId });
        thumbnailRetailerId = whatsappProductMessage.resolveRetailerId(thumbnailProduct);
      } catch (err) {
        if (err instanceof whatsappProductMessage.NotFoundError) return res.status(404).json({ error: err.message });
        if (err instanceof whatsappProductMessage.ValidationError) return res.status(400).json({ error: err.message });
        throw err;
      }
    }

    const interactive = whatsappProductMessage.buildCatalogInteractive({
      catalogId: thumbnailRetailerId, // see buildCatalogInteractive's own doc: this param is the thumbnail's retailer id, not the Meta catalog id
      bodyText: trimmedBody,
    });

    const ctxId = sanitizeContextId(contextMessageId);
    const localId = await insertPendingRow({
      account, toNumber, messageType: 'interactive',
      messageBody: trimmedBody,
      contextMessageId: ctxId,
      templateMeta: {
        kind: 'catalog',
        body: trimmedBody,
        thumbnail: thumbnailProduct ? {
          id: thumbnailProduct.id,
          name: thumbnailProduct.name,
          imageUrl: thumbnailProduct.image_url || null,
        } : null,
      },
    });

    await enqueueSend({
      kind: 'interactive',
      accountId: account.id,
      to: String(toNumber).replace(/\D/g, ''),
      localMessageId: localId,
      payload: { interactive },
    });

    res.status(202).json({
      ok: true, messageId: localId, status: 'sending',
      thumbnail: thumbnailProduct ? { id: thumbnailProduct.id, name: thumbnailProduct.name, retailerId: thumbnailRetailerId } : null,
    });
  } catch (err) {
    console.error('[messages] send-catalog error:', err.message);
    res.status(500).json({ error: 'Failed to send catalog' });
  }
});

/**
 * POST /messages/send-audio (multipart)
 * Fields: fromNumber, toNumber, file (browser-recorded audio blob)
 * Transcodes the browser's webm/opus output to ogg/opus (Meta-accepted),
 * uploads to Meta, mirrors locally, and enqueues send.
 */
router.post('/messages/send-audio', requireRole('AGENT'), mediaUpload.single('file'), async (req, res) => {
  try {
    const { fromNumber, toNumber, contextMessageId } = req.body || {};
    if (!fromNumber || !toNumber) return res.status(400).json({ error: 'fromNumber and toNumber required' });
    if (!req.file) return res.status(400).json({ error: 'audio file required' });
    if (!req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({ error: 'The recording was empty. Please record again before sending.' });
    }
    if (!(await assertContactAccess(req, res, fromNumber, toNumber))) return;
    if (!(await assertWaWorkspace(req, res, fromNumber))) return;

    const { account, error } = await resolveAccount({ fromPhoneNumber: fromNumber, workspaceId: req.workspace?.id });
    if (error) return res.status(400).json({ error });

    const secs = await secondsSinceLastIncoming({ accountPhoneNumberId: account.phoneNumberId, contactNumber: toNumber });
    if (secs == null || secs > SERVICE_WINDOW_SECONDS) {
      return res.status(409).json({ error: 'Outside 24-hour customer service window.', code: 'OUTSIDE_WINDOW' });
    }

    // Transcode to Meta-accepted format if needed
    let audioBuffer, audioMime, audioExt;
    try {
      const transcoded = await transcodeAudioForMeta(req.file.buffer, req.file.mimetype);
      audioBuffer = transcoded.buffer;
      audioMime = transcoded.mime;
      audioExt = transcoded.ext;
    } catch (err) {
      return res.status(400).json({ error: 'Audio processing failed. Please try a different recording.' });
    }

    // Upload to Meta
    let mediaId;
    try {
      const uploaded = await uploadMedia({
        accessToken: account.accessToken, phoneNumberId: account.phoneNumberId,
        buffer: audioBuffer, mimeType: audioMime, filename: `voice.${audioExt}`,
      });
      mediaId = uploaded?.id;
      if (!mediaId) throw new Error('Meta upload returned no id');
      await markAccountHealth(account.id, 'healthy');
    } catch (err) {
      const cls = classifyMetaError(err);
      await markAccountHealth(account.id, cls, err.message);
      return res.status(err.status === 401 ? 401 : 400).json({ error: err.message, metaCode: err.metaError?.code });
    }

    // Insert optimistic row + mirror locally
    const ctxId = sanitizeContextId(contextMessageId);
    const localId = await insertPendingRow({
      account, toNumber, messageType: 'audio',
      messageBody: 'Voice message', mediaMime: audioMime,
      contextMessageId: ctxId,
    });
    const accountDigits = (account.displayPhoneNumber || '').replace(/\D/g, '');
    const { absPath, size } = persistOutboundMedia({
      accountPhoneDigits: accountDigits, messageId: localId,
      buffer: audioBuffer, ext: audioExt,
    });
    await pool.query(
      `UPDATE coexistence.chat_history
          SET media_storage_path = $1, media_status = 'stored',
              media_size_bytes = $2, media_downloaded_at = NOW()
        WHERE message_id = $3`,
      [absPath, size, localId]
    );

    await enqueueSend({
      kind: 'media',
      accountId: account.id,
      to: String(toNumber).replace(/\D/g, ''),
      localMessageId: localId,
      payload: { type: 'audio', mediaId, contextMessageId: ctxId },
    });

    res.status(202).json({ ok: true, messageId: localId, status: 'sending', mediaId });
  } catch (err) {
    console.error('[messages] send-audio error:', err.message);
    res.status(500).json({ error: 'Failed to send audio' });
  }
});

/**
 * POST /messages/send-library-media
 * Body: { fromNumber, toNumber, mediaLibraryId, caption? }
 *
 * Sends an existing Media Library item to a contact. Resolves the WABA from
 * `fromNumber`, finds (or refreshes) the per-WABA Meta media_id for that
 * library item, mirrors the file from storage into /app/media so the chat
 * bubble renders, and enqueues the send.
 *
 * Auto-resyncs if no sync row exists for this WABA, or if the existing
 * meta_media_id is expired/failed — the caller never has to worry about
 * Meta's 28-day TTL.
 */
router.post('/messages/send-library-media', requireRole('AGENT'), async (req, res) => {
  try {
    const { fromNumber, toNumber, mediaLibraryId, caption = '', contextMessageId } = req.body || {};
    if (!fromNumber || !toNumber || !mediaLibraryId) {
      return res.status(400).json({ error: 'fromNumber, toNumber, mediaLibraryId required' });
    }
    if (!(await assertContactAccess(req, res, fromNumber, toNumber))) return;
    if (!(await assertWaWorkspace(req, res, fromNumber))) return;

    const { account, error } = await resolveAccount({ fromPhoneNumber: fromNumber, workspaceId: req.workspace?.id });
    if (error) return res.status(400).json({ error });

    const secs = await secondsSinceLastIncoming({
      accountPhoneNumberId: account.phoneNumberId, contactNumber: toNumber,
    });
    if (secs == null || secs > SERVICE_WINDOW_SECONDS) {
      return res.status(409).json({ error: 'Outside 24-hour customer service window.', code: 'OUTSIDE_WINDOW' });
    }

    // Phase 7.12B fix: scope the media_library lookup to the caller's own
    // workspace (req.workspace.id, resolved server-side by attachWorkspace —
    // never client input). Previously this queried by id alone, so any
    // authenticated agent could supply another workspace's mediaLibraryId
    // and have it resolved/synced/sent through their own WABA.
    const { rows: mRows } = await pool.query(
      `SELECT * FROM coexistence.media_library
        WHERE id = $1 AND deleted_at IS NULL AND workspace_id = $2`,
      [mediaLibraryId, req.workspace?.id ?? null]
    );
    if (!mRows.length) return res.status(404).json({ error: 'Media not found in library' });
    const media = mRows[0];

    // Resolve per-WABA meta_media_id; auto-(re)sync if missing/expired/failed
    const { rows: sRows } = await pool.query(
      `SELECT * FROM coexistence.media_meta_sync WHERE media_id = $1 AND account_id = $2`,
      [media.id, account.id]
    );
    let sync = sRows[0];
    const needsSync = !sync
      || sync.status !== 'synced'
      || !sync.meta_media_id
      || (sync.expires_at && new Date(sync.expires_at) <= new Date());
    if (needsSync) {
      try {
        sync = await syncMediaToAccount(media.id, account.id, req.workspace?.id ?? null);
        // syncMediaToAccount returns a `rowToSync`-shaped object — adapt keys
        sync = {
          meta_media_id: sync.metaMediaId,
          expires_at: sync.expiresAt,
          status: sync.status,
        };
      } catch (err) {
        return res.status(502).json({ error: 'Auto-sync to Meta failed' });
      }
    }

    const mediaMimeCanon = canonicalizeMime(media.mime_type, media.original_name);
    const kind = chatKindFor(mediaMimeCanon);
    if (!kind) return res.status(400).json({ error: `Unsupported library media type for chat send. ${CHAT_TYPES_MSG}` });

    // Fetch bytes from storage so we can mirror locally for bubble rendering
    let buf;
    try {
      buf = await storage.getObjectBuffer(media.storage_key);
    } catch (err) {
      return res.status(502).json({ error: 'Failed to read media from storage' });
    }

    const ctxId = sanitizeContextId(contextMessageId);
    const localId = await insertPendingRow({
      account, toNumber, messageType: kind,
      messageBody: caption || media.original_name,
      mediaMime: mediaMimeCanon,
      contextMessageId: ctxId,
    });
    const ext = media.original_name.split('.').pop()?.toLowerCase() || mediaMimeCanon.split('/')[1] || 'bin';
    const accountDigits = (account.displayPhoneNumber || '').replace(/\D/g, '');
    const { absPath, size } = persistOutboundMedia({
      accountPhoneDigits: accountDigits, messageId: localId, buffer: buf, ext,
    });
    await pool.query(
      `UPDATE coexistence.chat_history
          SET media_storage_path = $1, media_status = 'stored',
              media_size_bytes = $2, media_filename = $3,
              media_downloaded_at = NOW()
        WHERE message_id = $4`,
      [absPath, size, media.original_name, localId]
    );

    await enqueueSend({
      kind: 'media',
      accountId: account.id,
      to: String(toNumber).replace(/\D/g, ''),
      localMessageId: localId,
      payload: {
        type: kind,
        mediaId: sync.meta_media_id,
        caption: caption || undefined,
        filename: kind === 'document' ? media.original_name : undefined,
        contextMessageId: ctxId,
      },
    });

    res.status(202).json({
      ok: true, messageId: localId, status: 'sending',
      mediaId: sync.meta_media_id, mediaLibraryId: Number(media.id),
    });
  } catch (err) {
    console.error('[messages] send-library-media error:', err.message);
    res.status(500).json({ error: 'Failed to send library media' });
  }
});

/**
 * GET /messages/ai-status?waNumber=xxx&contactNumber=xxx
 * Returns the last_agent_reply_at timestamp for a conversation.
 * Frontend can use this to show "Agent handled" indicator.
 */
router.get('/messages/ai-status', async (req, res) => {
  try {
    const { waNumber, contactNumber } = req.query;
    if (!waNumber || !contactNumber) {
      return res.status(400).json({ error: 'waNumber and contactNumber required' });
    }
    if (!(await assertContactAccess(req, res, waNumber, contactNumber))) return;
    if (!(await assertWaWorkspace(req, res, waNumber))) return;

    const { rows } = await pool.query(
      `SELECT last_agent_reply_at, last_agent_reply_by
         FROM coexistence.contacts
        WHERE wa_number = $1 AND contact_number = $2
        LIMIT 1`,
      [String(waNumber).replace(/\D/g, ''), String(contactNumber).replace(/\D/g, '')]
    );

    if (rows.length === 0) {
      return res.json({ lastAgentReplyAt: null, lastAgentReplyBy: null });
    }

    res.json({
      lastAgentReplyAt: rows[0].last_agent_reply_at || null,
      lastAgentReplyBy: rows[0].last_agent_reply_by || null,
    });
  } catch (err) {
    console.error('[messages] /ai-status error:', err.message);
    res.status(500).json({ error: 'Failed to fetch AI status' });
  }
});
module.exports = { router };