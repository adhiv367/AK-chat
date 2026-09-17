// Contacts CRUD + manual add + Excel/CSV import.
// Reuses normalizePhone/resolveSyncWaNumber from contactSyncService.js so
// phone format and dedupe logic match Google Sheet sync exactly — one
// source of truth for "what counts as a duplicate contact".

const { Router } = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { Readable } = require('stream');
const pool = require('../db');
const { normalizePhone, resolveSyncWaNumber } = require('../services/contactSyncService');

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── GET /contacts?number=91xxxxxxxxxx&search=&tagIds=1,2 ────────────────────
router.get('/contacts', async (req, res) => {
  try {
    const waNumber = req.query.number ? String(req.query.number).replace(/\D/g, '') : await resolveSyncWaNumber();
    const search = (req.query.search || '').trim();

    const params = [waNumber];
    let where = `c.wa_number = $1`;
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
    res.json(rows);
  } catch (err) {
    console.error('[contacts] GET list error:', err.message);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

// ── GET /contacts/:id ────────────────────────────────────────────────────
router.get('/contacts/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*, u.display_name AS assigned_user_name
         FROM coexistence.contacts c
         LEFT JOIN coexistence.users u ON u.id = c.assigned_user_id
        WHERE c.id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Contact not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[contacts] GET one error:', err.message);
    res.status(500).json({ error: 'Failed to fetch contact' });
  }
});

// ── POST /contacts — manual "Add Contact" ───────────────────────────────
// Rejects duplicates (per spec: manual entry must NOT silently update).
router.post('/contacts', async (req, res) => {
  try {
    const { name, phone, email, city, notes, waNumber: bodyWaNumber } = req.body || {};

    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    const normPhone = normalizePhone(phone);
    if (!normPhone) return res.status(400).json({ error: 'Enter a valid phone number' });

    const waNumber = bodyWaNumber ? String(bodyWaNumber).replace(/\D/g, '') : await resolveSyncWaNumber();

    const { rows: existing } = await pool.query(
      `SELECT id FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $2`,
      [waNumber, normPhone]
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
      `INSERT INTO coexistence.contacts (wa_number, contact_number, name, tags, custom_fields, updated_at)
       VALUES ($1, $2, $3, '[]'::jsonb, $4::jsonb, NOW())
       RETURNING *`,
      [waNumber, normPhone, name.trim(), JSON.stringify(customFields)]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Contact already exists.' });
    console.error('[contacts] POST error:', err.message);
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

// ── PUT /contacts/:id — edit (name, tags, custom_fields, assignment) ───────
router.put('/contacts/:id', async (req, res) => {
  try {
    const { name, tags, customFields, assignedUserId } = req.body || {};
    const sets = ['updated_at = NOW()'];
    const params = [];
    let i = 1;
    const push = (col, val) => { sets.push(`${col} = $${i++}`); params.push(val); };

    if (name !== undefined) push('name', name.trim());
    if (tags !== undefined) push('tags', JSON.stringify(tags));
    if (customFields !== undefined) push('custom_fields', JSON.stringify(customFields));
    if (assignedUserId !== undefined) push('assigned_user_id', assignedUserId || null);

    params.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE coexistence.contacts SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
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
router.delete('/contacts/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM coexistence.contacts WHERE id = $1`, [req.params.id]);
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

// POST /contacts/import — multipart/form-data, field name "file"
router.post('/contacts/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const waNumber = req.body.waNumber
      ? String(req.body.waNumber).replace(/\D/g, '')
      : await resolveSyncWaNumber();

    const grid = await parseWorkbookRows(req.file.buffer, req.file.originalname);
    if (grid.length < 2) return res.status(400).json({ error: 'Sheet is empty or has no data rows' });

    const headerIndex = buildImportHeaderIndex(grid[0]);
    if (headerIndex.phone === undefined) {
      return res.status(400).json({ error: 'Could not find a Name/Phone column in this file' });
    }

    let imported = 0, updated = 0;
    const skipped = [];

    for (const row of grid.slice(1)) {
      const rawName = headerIndex.name !== undefined ? String(row[headerIndex.name] || '').trim() : '';
      const rawPhone = String(row[headerIndex.phone] || '').trim();
      const rawEmail = headerIndex.email !== undefined ? String(row[headerIndex.email] || '').trim() : '';

      const phone = normalizePhone(rawPhone);
      if (!phone) { skipped.push({ row: rawPhone || '(blank)', reason: 'invalid/missing phone' }); continue; }
      if (!rawName) { skipped.push({ row: rawPhone, reason: 'missing name' }); continue; }

      const { rows: existing } = await pool.query(
        `SELECT id, custom_fields FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $2`,
        [waNumber, phone]
      );

      if (existing.length === 0) {
        await pool.query(
          `INSERT INTO coexistence.contacts (wa_number, contact_number, name, tags, custom_fields, updated_at)
           VALUES ($1, $2, $3, '[]'::jsonb, $4::jsonb, NOW())`,
          [waNumber, phone, rawName, JSON.stringify({ email: rawEmail || null, source: 'excel' })]
        );
        imported++;
      } else {
        const cf = existing[0].custom_fields || {};
        await pool.query(
          `UPDATE coexistence.contacts
              SET name = $1, custom_fields = $2::jsonb, updated_at = NOW()
            WHERE id = $3`,
          [rawName, JSON.stringify({ ...cf, email: rawEmail || cf.email || null, source: 'excel' }), existing[0].id]
        );
        updated++;
      }
    }

    res.json({ ok: true, imported, updated, skipped, total: grid.length - 1 });
  } catch (err) {
    console.error('[contacts] import error:', err.message);
    res.status(500).json({ error: 'Failed to import contacts' });
  }
});

module.exports = { router };