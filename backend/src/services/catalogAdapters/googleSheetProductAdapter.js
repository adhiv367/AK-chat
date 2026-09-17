// Phase 7.4 — Catalog Connection Layer: Google Sheet adapter.
//
// Reuses services/googleSheetService.js's fetchSheetGrid() verbatim (public
// "Anyone with the link" CSV-export fetch, already used for the contact
// sheet sync) — no new fetching/parsing logic needed, just a different
// header-alias map and output shape (products instead of contacts).
//
// config: { sheetUrl }  (persisted on coexistence.catalog_connections.config)

const { fetchSheetGrid } = require('../googleSheetService');

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
  const map = {};
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

async function fetchRows(config) {
  const sheetUrl = config && config.sheetUrl;
  if (!sheetUrl) throw Object.assign(new Error('sheetUrl is required'), { status: 400 });

  const grid = await fetchSheetGrid(sheetUrl);
  if (grid.length === 0) return { rows: [] };

  const fieldMap = buildFieldMap(grid[0]);
  if (!Object.values(fieldMap).includes('name')) {
    throw Object.assign(
      new Error('Sheet must have a "Name" (or "Title"/"Product") column in row 1'),
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
    if (!row.name) continue;

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