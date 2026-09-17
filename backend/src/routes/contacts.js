// Contacts CRUD + manual add + Excel/CSV import.
// Reuses normalizePhone/resolveSyncWaNumber from contactSyncService.js so
// phone format and dedupe logic match Google Sheet sync exactly — one
// source of truth for "what counts as a duplicate contact".

const { Router } = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { Readable } = require('stream');
const pool = require('../db');
const { requireRole } = require('../middleware/access');
const { normalizePhone, resolveSyncWaNumber } = require('../services/contactSyncService');
const { fetchExitUrlsForPhones, resolveContactExitUrl } = require('../services/retargetUrlResolver');
const { getAccountByPhoneNumber } = require('./whatsappAccounts');
const { checkLimit, limitExceededResponse, countContacts, LIMIT_TYPES } = require('../services/entitlementService');

// Attaches `retarget_exit_url` to every Retarget-flagged contact in `rows`,
// resolved via the shared retargetUrlResolver priority (retarget_customers
// .exit_url -> custom_fields.retargetURL -> Invi homepage). One batch query
// for the whole page instead of one per contact. Non-Retarget contacts are
// left untouched (no field added) — the homepage fallback only applies to
// Retarget contacts.
//
// Phase 3C-4: workspaceId is passed through to fetchExitUrlsForPhones so the
// retarget_customers lookup never reads another workspace's exit URLs —
// see retargetUrlResolver.js. Falls back to each contact's own mirrored
// custom_fields.retargetURL when workspaceId is unavailable.
async function attachRetargetExitUrls(rows, workspaceId) {
  const retargetRows = rows.filter((c) => c.custom_fields?.isRetarget);
  if (retargetRows.length === 0) return rows;

  const exitUrlsByPhone = await fetchExitUrlsForPhones(retargetRows.map((c) => c.contact_number), workspaceId);
  for (const c of retargetRows) {
    c.retarget_exit_url = resolveContactExitUrl(c, exitUrlsByPhone);
  }
  return rows;
}

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── GET /contacts?number=91xxxxxxxxxx&search=&tagIds=1,2 ────────────────────
router.get('/contacts', async (req, res) => {
  try {
    // Phase 3C: workspace_id is always taken from req.workspace (resolved
    // server-side from the session — see middleware/workspaceContext.js),
    // never trusted from the query string. A caller with no workspace sees
    // an empty list rather than falling through to another workspace's data.
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.json([]);

    const waNumber = req.query.number ? String(req.query.number).replace(/\D/g, '') : await resolveSyncWaNumber(workspaceId);
    const search = (req.query.search || '').trim();

    const params = [waNumber, workspaceId];
    let where = `c.wa_number = $1 AND c.workspace_id = $2`;
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (c.name ILIKE $${params.length} OR c.contact_number ILIKE $${params.length})`;
    }

    const { rows } = await pool.query(
      `SELECT c.*, u.display_name AS assigned_user_name
         FROM coexistence.contacts c
         LEFT JOIN coexistence.users u ON u.id = c.assigned_user_id
        WHERE ${where}
        ORDER BY c.updated_at DESC`,
      params
    );
    await attachRetargetExitUrls(rows, req.workspace?.id ?? null);
    res.json(rows);
  } catch (err) {
    console.error('[contacts] GET list error:', err.message);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

// ── GET /contacts/:id ────────────────────────────────────────────────────
router.get('/contacts/:id', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(404).json({ error: 'Contact not found' });

    const { rows } = await pool.query(
      `SELECT c.*, u.display_name AS assigned_user_name
         FROM coexistence.contacts c
         LEFT JOIN coexistence.users u ON u.id = c.assigned_user_id
        WHERE c.id = $1 AND c.workspace_id = $2`,
      [req.params.id, workspaceId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Contact not found' });
    await attachRetargetExitUrls(rows, req.workspace?.id ?? null);
    res.json(rows[0]);
  } catch (err) {
    console.error('[contacts] GET one error:', err.message);
    res.status(500).json({ error: 'Failed to fetch contact' });
  }
});

// ── POST /contacts — manual "Add Contact" ───────────────────────────────
// Rejects duplicates (per spec: manual entry must NOT silently update).
// Phase 7.11 fix (F-1): write-gate matching retarget.js's CRUD pattern —
// VIEWER must not be able to create/modify/delete/import contacts via a
// direct API call just because the button is hidden.
router.post('/contacts', requireRole('AGENT'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const { name, phone, email, city, notes, waNumber: bodyWaNumber } = req.body || {};

    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    const normPhone = normalizePhone(phone);
    if (!normPhone) return res.status(400).json({ error: 'Enter a valid phone number' });

    // Phase 3C: a client-supplied waNumber is only honoured if it actually
    // belongs to the caller's own workspace — otherwise resolve the
    // workspace's own connected account. Never trust a workspace implied by
    // a client-chosen number.
    let waNumber;
    if (bodyWaNumber) {
      const candidate = String(bodyWaNumber).replace(/\D/g, '');
      const acc = await getAccountByPhoneNumber(candidate, workspaceId);
      if (!acc) return res.status(403).json({ error: 'This WhatsApp number does not belong to your workspace' });
      waNumber = candidate;
    } else {
      waNumber = await resolveSyncWaNumber(workspaceId);
    }

    const { rows: existing } = await pool.query(
      `SELECT id FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $2 AND workspace_id = $3`,
      [waNumber, normPhone, workspaceId]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Contact already exists.' });
    }

    const customFields = {
      email: email?.trim() || null,
      city: city?.trim() || null,
      notes: notes?.trim() || null,
      source: 'manual',
    };

    const { rows } = await pool.query(
      `INSERT INTO coexistence.contacts (wa_number, contact_number, name, tags, custom_fields, workspace_id, updated_at)
       VALUES ($1, $2, $3, '[]'::jsonb, $4::jsonb, $5, NOW())
       RETURNING *`,
      [waNumber, normPhone, name.trim(), JSON.stringify(customFields), workspaceId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Contact already exists.' });
    console.error('[contacts] POST error:', err.message);
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

// ── PUT /contacts/:id — edit (name, tags, custom_fields, assignment) ───────
router.put('/contacts/:id', requireRole('AGENT'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(404).json({ error: 'Contact not found' });

    const { name, tags, customFields, assignedUserId } = req.body || {};
    const sets = ['updated_at = NOW()'];
    const params = [];
    let i = 1;
    const push = (col, val) => { sets.push(`${col} = $${i++}`); params.push(val); };

    if (name !== undefined) push('name', name.trim());
    if (tags !== undefined) push('tags', JSON.stringify(tags));
    if (customFields !== undefined) push('custom_fields', JSON.stringify(customFields));
    if (assignedUserId !== undefined) push('assigned_user_id', assignedUserId || null);

    params.push(req.params.id, workspaceId);
    // Phase 3C: scoped by id AND workspace_id so a request can never edit
    // another workspace's contact, even by guessing/enumerating ids.
    const { rows } = await pool.query(
      `UPDATE coexistence.contacts SET ${sets.join(', ')} WHERE id = $${i} AND workspace_id = $${i + 1} RETURNING *`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Contact not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[contacts] PUT error:', err.message);
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

// ── DELETE /contacts/:id ─────────────────────────────────────────────────
router.delete('/contacts/:id', requireRole('AGENT'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(404).json({ error: 'Contact not found' });

    const { rowCount } = await pool.query(
      `DELETE FROM coexistence.contacts WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, workspaceId]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Contact not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[contacts] DELETE error:', err.message);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

// ── Excel/CSV import ─────────────────────────────────────────────────────
// Auto-detects Name / Phone / Email columns from ANY header set. Every other
// column (Order ID, Address, Product, etc.) is ignored automatically.
const IMPORT_HEADER_MAP = {
  'customer name': 'name', name: 'name', 'full name': 'name',
  'mobile number': 'phone', phone: 'phone', mobile: 'phone', 'phone number': 'phone', 'contact number': 'phone',
  email: 'email', 'email address': 'email',
};

function buildImportHeaderIndex(headerRow) {
  const index = {};
  headerRow.forEach((h, i) => {
    const key = String(h || '').trim().toLowerCase();
    const mapped = IMPORT_HEADER_MAP[key];
    if (mapped && index[mapped] === undefined) index[mapped] = i;
  });
  return index;
}

async function parseWorkbookRows(buffer, filename) {
  const workbook = new ExcelJS.Workbook();
  if (filename.toLowerCase().endsWith('.csv')) {
    await workbook.csv.read(Readable.from(buffer));
  } else {
    await workbook.xlsx.load(buffer);
  }
  const ws = workbook.worksheets[0];
  if (!ws) return [];
  const grid = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values.slice(1).map((cell) => {
      if (cell == null) return '';
      if (cell instanceof Date) return cell.toISOString().slice(0, 10);
      if (typeof cell === 'object' && 'text' in cell) return String(cell.text);
      if (typeof cell === 'object' && 'result' in cell) return String(cell.result);
      return String(cell);
    });
    grid.push(values);
  });
  return grid;
}

// Part 2 fix — pure helper so the "never overwrite an existing source"
// rule is unit-testable without a database. `existingCustomFields` is the
// contact's current custom_fields (or {} for a brand-new contact created by
// this import); returns the next custom_fields object to persist.
function mergeImportCustomFields(existingCustomFields, rawEmail) {
  const cf = existingCustomFields || {};
  return {
    ...cf,
    email: rawEmail || cf.email || null,
    source: cf.source || 'excel',
  };
}

// POST /contacts/import — multipart/form-data, field name "file"
router.post('/contacts/import', requireRole('AGENT'), upload.single('file'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Phase 3C: never trust a client-supplied waNumber's workspace — confirm
    // it actually belongs to the caller's workspace before importing onto it.
    let waNumber;
    if (req.body.waNumber) {
      const candidate = String(req.body.waNumber).replace(/\D/g, '');
      const acc = await getAccountByPhoneNumber(candidate, workspaceId);
      if (!acc) return res.status(403).json({ error: 'This WhatsApp number does not belong to your workspace' });
      waNumber = candidate;
    } else {
      waNumber = await resolveSyncWaNumber(workspaceId);
    }

    // Phase 5B — server-side contact entitlement check. requestedIncrement
    // of 0 here: this is the up-front gate (rejects the whole import if the
    // workspace's billing status blocks new usage, or the entitlement
    // lookup itself fails — fail closed, never proceed on an unknown
    // limit). Per-row enforcement as new contacts are actually added
    // happens below via a locally-tracked running count, so a large import
    // isn't N sequential DB round-trips through checkLimit.
    const contactLimitCheck = await checkLimit(workspaceId, LIMIT_TYPES.CONTACTS, 0);
    if (!contactLimitCheck.allowed) {
      return res.status(403).json(limitExceededResponse(contactLimitCheck));
    }
    const maxContacts = contactLimitCheck.max; // null = unlimited
    let currentContactCount = contactLimitCheck.current ?? await countContacts(workspaceId);

    const grid = await parseWorkbookRows(req.file.buffer, req.file.originalname);
    if (grid.length < 2) return res.status(400).json({ error: 'Sheet is empty or has no data rows' });

    const headerIndex = buildImportHeaderIndex(grid[0]);
    if (headerIndex.phone === undefined) {
      return res.status(400).json({ error: 'Could not find a Name/Phone column in this file' });
    }

    let imported = 0, updated = 0, limitReached = false;
    const skipped = [];

    for (const row of grid.slice(1)) {
      const rawName = headerIndex.name !== undefined ? String(row[headerIndex.name] || '').trim() : '';
      const rawPhone = String(row[headerIndex.phone] || '').trim();
      const rawEmail = headerIndex.email !== undefined ? String(row[headerIndex.email] || '').trim() : '';

      const phone = normalizePhone(rawPhone);
      if (!phone) { skipped.push({ row: rawPhone || '(blank)', reason: 'invalid/missing phone' }); continue; }
      if (!rawName) { skipped.push({ row: rawPhone, reason: 'missing name' }); continue; }

      const { rows: existing } = await pool.query(
        `SELECT id, custom_fields FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $2 AND workspace_id = $3`,
        [waNumber, phone, workspaceId]
      );

      if (existing.length === 0) {
        // Phase 5B — per-row limit enforcement for genuinely NEW contacts
        // only (updates to existing contacts, the `else` branch below,
        // never consume additional entitlement). Fails closed at the exact
        // row that would exceed the cap; already-imported rows before this
        // point are kept (partial import), and every remaining row is
        // reported back as skipped so the frontend can show an accurate
        // upgrade prompt instead of a silently truncated import.
        if (maxContacts !== null && (currentContactCount + 1) > maxContacts) {
          skipped.push({ row: rawPhone, reason: 'workspace contact limit reached' });
          limitReached = true;
          continue;
        }
        await pool.query(
          `INSERT INTO coexistence.contacts (wa_number, contact_number, name, tags, custom_fields, workspace_id, updated_at)
           VALUES ($1, $2, $3, '[]'::jsonb, $4::jsonb, $5, NOW())`,
          [waNumber, phone, rawName, JSON.stringify({ email: rawEmail || null, source: 'excel' }), workspaceId]
        );
        currentContactCount++;
        imported++;
      } else {
        const cf = existing[0].custom_fields || {};
        // Part 2 fix: an existing contact's provenance (custom_fields.source)
        // must never be silently overwritten by an Excel/CSV import — e.g. a
        // Shopify-synced customer (source = 'shopify_sheet_sync') re-imported
        // from a spreadsheet must stay attributed to Shopify. Only a contact
        // with no source on file yet gets stamped with 'excel'.
        await pool.query(
          `UPDATE coexistence.contacts
              SET name = $1, custom_fields = $2::jsonb, updated_at = NOW()
            WHERE id = $3 AND workspace_id = $4`,
          [rawName, JSON.stringify(mergeImportCustomFields(cf, rawEmail)), existing[0].id, workspaceId]
        );
        updated++;
      }
    }

    res.json({
      ok: true, imported, updated, skipped, total: grid.length - 1,
      ...(limitReached ? { limitReached: true, limitType: LIMIT_TYPES.CONTACTS, max: maxContacts } : {}),
    });
  } catch (err) {
    console.error('[contacts] import error:', err.message);
    res.status(500).json({ error: 'Failed to import contacts' });
  }
});

module.exports = { router, mergeImportCustomFields };