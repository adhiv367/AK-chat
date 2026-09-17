// Retarget module — import service.
// Shared logic for CSV/Excel file import AND Google Sheet sync:
//   - parse a workbook buffer into a grid
//   - detect Name/Phone/Email columns using the EXACT same parser as the
//     Contacts sheet importer (services/googleSheetService.js), plus
//     Retarget-only columns (ExitURL/RetargetType/Timestamp/Source) layered
//     on top — see buildHeaderIndex below
//   - normalize phone numbers using the EXACT same normalizer as Contacts
//     (services/contactSyncService.js's normalizePhone)
//   - auto-detect retarget_type (cart_abandonment / checkout_exit / page_exit
//     / other) from the exit URL when the sheet doesn't provide one
//   - upsert into coexistence.retarget_customers by phone number
//
// No column-detection or phone-normalization logic is duplicated here —
// both are imported from the Contacts modules so any future fix or new
// alias added there automatically applies to Retarget too.
//
// Phase 3C-4: every function that touches the DB now takes/uses workspaceId
// so CSV/Excel import and Google Sheet sync create/update retarget
// customers (and their mirrored Contacts) inside the caller's own
// workspace only. workspaceId must come from req.workspace.id (see
// retargetImportController.js / retargetSyncController.js) — never trust
// one supplied by the client.

const ExcelJS = require('exceljs');
const { Readable } = require('stream');
const retargetRepository = require('../repositories/retargetRepository');
const { detectRetargetType, detectExitCategory } = require('./retargetClassifier');
// Contacts bridge — every Retarget customer created/updated is mirrored into
// coexistence.contacts (Contacts <-> Retarget integration). Reuses the same
// upsert helper that Google Sheet sync / Shopify sync already rely on, so
// there's exactly one place that knows how to write a Retarget customer
// into Contacts.
const { upsertContactFromRetarget, normalizePhone } = require('./contactSyncService');
// Shared parser — the SAME parser the Contacts sheet importer (Shopify
// abandoned-cart sheet) uses. Retarget must never maintain its own, narrower
// column-alias map: it detects phone/name/email exactly like Contacts does,
// via the same HEADER_MAP + buildHeaderIndex, and only layers its own
// Retarget-only columns (exitUrl/retargetType/timestamp/source) on top
// through buildHeaderIndex's extraMap — those never override a shared
// Contacts field, so name/phone/email detection is byte-for-byte identical
// to Contacts.
const { buildHeaderIndex: buildContactsHeaderIndex } = require('./googleSheetService');

// Exact-match phone lookup, scoped to a workspace. retargetRepository.findAll()
// only supports ILIKE substring search, which isn't safe for dedupe (e.g.
// phone "919000012" would match "9190000123"), so import/sync upserts use
// retargetRepository.findByPhone instead — same layering rule as the rest
// of this module: no direct `pool` access here, SQL lives in the repository.
const findByPhone = retargetRepository.findByPhone;

// Retarget-only columns, layered on top of Contacts' HEADER_MAP (see
// buildHeaderIndex above). Pre-normalized keys ([a-z0-9] only) to match
// googleSheetService.normalizeHeaderKey's stripping of spaces/punctuation.
const RETARGET_EXTRA_HEADER_MAP = {
  exiturl: 'exitUrl', url: 'exitUrl', link: 'exitUrl', page: 'exitUrl', pageurl: 'exitUrl',
  retargettype: 'retargetType', type: 'retargetType', category: 'retargetType',
  timestamp: 'timestamp', date: 'timestamp', exitdate: 'timestamp', eventtime: 'timestamp', time: 'timestamp',
  source: 'source',
};

function buildHeaderIndex(headerRow) {
  return buildContactsHeaderIndex(headerRow, RETARGET_EXTRA_HEADER_MAP);
}

function cellToString(cell) {
  if (cell == null) return '';
  if (cell instanceof Date) return cell.toISOString();
  if (typeof cell === 'object' && 'text' in cell) return String(cell.text);
  if (typeof cell === 'object' && 'result' in cell) return String(cell.result);
  return String(cell);
}

// Parses a CSV or XLSX buffer into a raw grid (array of arrays of strings).
async function parseWorkbookRows(buffer, filename = '') {
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
    grid.push(row.values.slice(1).map(cellToString));
  });
  return grid;
}

// Turns a raw grid into normalized row objects using the detected header index.
function gridToRows(grid) {
  if (grid.length < 2) return { rows: [], headerIndex: {} };
  const headerIndex = buildHeaderIndex(grid[0]);
  const get = (row, key) => (headerIndex[key] !== undefined ? (row[headerIndex[key]] ?? '').toString().trim() : '');

  const rows = grid.slice(1).map((row) => ({
    name: get(row, 'name'),
    phone: get(row, 'phone'),
    email: get(row, 'email'),
    exitUrl: get(row, 'exitUrl'),
    retargetType: get(row, 'retargetType'),
    timestamp: get(row, 'timestamp'),
    source: get(row, 'source'),
  }));

  return { rows, headerIndex };
}

function parseTimestamp(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Upserts one normalized row into coexistence.retarget_customers by phone.
 * - No phone -> skipped
 * - Existing phone -> update (name/email/exitUrl/type/timestamp refreshed
 *   only when the incoming value is non-empty, so a sparse re-sync never
 *   blanks out previously-known data)
 * - New phone -> create
 * @returns {Promise<{created?:boolean, updated?:boolean, skipped?:boolean, reason?:string}>}
 */
async function upsertRetargetRow(row, defaultSource = 'import', workspaceId) {
  const phone = normalizePhone(row.phone);
  if (!phone) return { skipped: true, reason: 'missing/invalid phone number' };

  const exitUrl = row.exitUrl?.trim() || null;
  const retargetType = row.retargetType?.trim() || detectRetargetType(exitUrl);
  const timestamp = parseTimestamp(row.timestamp);
  const source = row.source?.trim() || defaultSource;

  const existing = await findByPhone(phone, workspaceId);

  if (existing) {
    const updated = await retargetRepository.update(existing.id, {
      name: row.name?.trim() || existing.name,
      email: row.email?.trim() || existing.email,
      exitUrl: exitUrl || existing.exit_url,
      retargetType: retargetType || existing.retarget_type,
      timestamp: timestamp || existing.timestamp,
      source,
    }, workspaceId);
    await syncContactSafely(updated, workspaceId);
    return { updated: true, record: updated };
  }

  const created = await retargetRepository.create({
    name: row.name?.trim() || null,
    phone,
    email: row.email?.trim() || null,
    exitUrl,
    retargetType,
    timestamp,
    source,
    status: 'pending',
  }, workspaceId);
  await syncContactSafely(created, workspaceId);
  return { created: true, record: created };
}

// Mirrors a Retarget customer into Contacts. Never throws — a Contacts sync
// hiccup (e.g. no WhatsApp account connected yet) must not fail the
// Retarget import/sync run itself; it's logged and skipped instead.
async function syncContactSafely(retargetCustomer, workspaceId) {
  try {
    await upsertContactFromRetarget(retargetCustomer, workspaceId);
  } catch (err) {
    console.error('[retarget] contact sync error:', err.message);
  }
}

/**
 * Imports every row from a parsed grid. Returns full run statistics used by
 * both the CSV/Excel import endpoint and the Google Sheet sync tick, so
 * Sync History can display them uniformly.
 * @returns {Promise<{total:number, imported:number, updated:number, skipped:number, errors:Array}>}
 */
async function importRows(rows, defaultSource = 'import', workspaceId) {
  let imported = 0, updated = 0, skipped = 0;
  const errors = [];

  for (const row of rows) {
    try {
      const result = await upsertRetargetRow(row, defaultSource, workspaceId);
      if (result.created) imported++;
      else if (result.updated) updated++;
      else if (result.skipped) skipped++;
    } catch (err) {
      errors.push({ row: row.phone || row.name || '(unknown)', reason: err.message });
    }
  }

  return { total: rows.length, imported, updated, skipped, errors };
}

// Full pipeline for a CSV/Excel upload buffer.
async function importFromBuffer(buffer, filename, defaultSource, workspaceId) {
  const grid = await parseWorkbookRows(buffer, filename);
  if (grid.length < 2) {
    const err = new Error('File is empty or has no data rows');
    err.status = 400;
    throw err;
  }
  const { rows, headerIndex } = gridToRows(grid);
  if (headerIndex.phone === undefined) {
    const err = new Error('Could not find a Phone column in this file');
    err.status = 400;
    throw err;
  }
  return importRows(rows, defaultSource || (filename.toLowerCase().endsWith('.csv') ? 'csv_import' : 'excel_import'), workspaceId);
}

module.exports = {
  normalizePhone,
  detectRetargetType,
  detectExitCategory,
  parseWorkbookRows,
  gridToRows,
  buildHeaderIndex,
  upsertRetargetRow,
  importRows,
  importFromBuffer,
};
