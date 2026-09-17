// Phase 7.4 — Catalog Connection Layer: CSV adapter.
//
// Parses an uploaded CSV/XLSX buffer into normalized product rows. Reuses
// ExcelJS the same way services/googleSheetService.js and
// services/retargetImportService.js already do (both already depend on it —
// no new package added), and the same header-alias-normalization idea as
// googleSheetService.js's HEADER_ALIASES, adapted to product fields.
//
// Every adapter in catalogAdapters/ exposes the same shape:
//   async function fetchRows(config, context) -> { rows: NormalizedProductRow[] }
// so services/catalogImportService.js can treat all five sources uniformly.
// NormalizedProductRow = { name, sku, price, currency, description,
//   imageUrl, productUrl, status }

const ExcelJS = require('exceljs');
const { Readable } = require('stream');

const HEADER_ALIASES = {
  name: ['name', 'title', 'productname', 'product'],
  sku: ['sku', 'itemcode', 'productcode', 'code'],
  price: ['price', 'amount', 'cost', 'sellingprice'],
  currency: ['currency', 'currencycode'],
  description: ['description', 'desc', 'details'],
  imageurl: ['imageurl', 'image', 'photo', 'picture'],
  producturl: ['producturl', 'url', 'link'],
  status: ['status'],
};

function normalizeHeaderKey(raw) {
  return String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildFieldMap(headerRow) {
  const map = {}; // column index -> canonical field name
  headerRow.forEach((raw, idx) => {
    const key = normalizeHeaderKey(raw);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(key)) {
        map[idx] = field;
        break;
      }
    }
  });
  return map;
}

async function bufferToGrid(buffer, filename) {
  const workbook = new ExcelJS.Workbook();
  const isCsv = /\.csv$/i.test(filename || '');
  if (isCsv) {
    await workbook.csv.read(Readable.from(buffer));
  } else {
    await workbook.xlsx.load(buffer);
  }
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return [];
  const grid = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
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

// config: not used (CSV has no persistent connection config — each run is
// a one-off upload). context: { buffer, filename } supplied by the route.
async function fetchRows(config, context) {
  const { buffer, filename } = context || {};
  if (!buffer) throw Object.assign(new Error('No file uploaded'), { status: 400 });

  const grid = await bufferToGrid(buffer, filename);
  if (grid.length === 0) return { rows: [] };

  const fieldMap = buildFieldMap(grid[0]);
  if (!Object.values(fieldMap).includes('name')) {
    throw Object.assign(
      new Error('CSV/Excel file must have a "Name" (or "Title"/"Product") column'),
      { status: 400 }
    );
  }

  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const raw = grid[r];
    const row = {};
    Object.entries(fieldMap).forEach(([idx, field]) => {
      row[field] = (raw[idx] || '').trim();
    });
    if (!row.name) continue; // skip blank rows

    rows.push({
      name: row.name,
      sku: row.sku || null,
      price: row.price ? Number(row.price.replace(/[^0-9.\-]/g, '')) : null,
      currency: row.currency || null,
      description: row.description || null,
      imageUrl: row.imageurl || null,
      productUrl: row.producturl || null,
      status: ['draft', 'active', 'archived'].includes(row.status) ? row.status : 'active',
    });
  }
  return { rows };
}

module.exports = { fetchRows };
