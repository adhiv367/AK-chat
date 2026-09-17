// Phase 7.4 — Catalog Connection Layer: Website / API / feed adapter.
//
// Fetches an arbitrary customer-hosted product feed (JSON array or CSV) and
// normalizes it into the same NormalizedProductRow shape every other
// adapter produces. Uses util/ssrfGuard.js's safeFetch() — the same
// outbound-fetch guard already used elsewhere in this codebase — because,
// unlike the Google Sheet source, this URL is customer-supplied and could
// point at an internal address.
//
// config: { feedUrl, format }  where format is 'json' | 'csv' (persisted on
// coexistence.catalog_connections.config)

const { safeFetch } = require('../../util/ssrfGuard');
const ExcelJS = require('exceljs');
const { Readable } = require('stream');

const FETCH_TIMEOUT_MS = 15000;

// A JSON feed is expected to be an array of objects, or { products: [...] }.
// Field names are matched case-insensitively against these aliases.
const JSON_FIELD_ALIASES = {
  name: ['name', 'title', 'productName', 'product'],
  sku: ['sku', 'itemCode', 'productCode', 'code', 'id'],
  price: ['price', 'amount', 'cost', 'sellingPrice'],
  currency: ['currency', 'currencyCode'],
  description: ['description', 'desc', 'details', 'body'],
  imageUrl: ['imageUrl', 'image', 'photo', 'picture', 'imageSrc'],
  productUrl: ['productUrl', 'url', 'link'],
};

function pickField(obj, aliases) {
  const lowerKeys = Object.keys(obj).reduce((acc, k) => {
    acc[k.toLowerCase()] = k;
    return acc;
  }, {});
  for (const alias of aliases) {
    const key = lowerKeys[alias.toLowerCase()];
    if (key !== undefined && obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return null;
}

function normalizeJsonRow(raw) {
  const name = pickField(raw, JSON_FIELD_ALIASES.name);
  if (!name) return null;
  const priceRaw = pickField(raw, JSON_FIELD_ALIASES.price);
  return {
    name: String(name).trim(),
    sku: pickField(raw, JSON_FIELD_ALIASES.sku) ? String(pickField(raw, JSON_FIELD_ALIASES.sku)) : null,
    price: priceRaw != null && priceRaw !== '' ? Number(priceRaw) : null,
    currency: pickField(raw, JSON_FIELD_ALIASES.currency) || null,
    description: pickField(raw, JSON_FIELD_ALIASES.description) || null,
    imageUrl: pickField(raw, JSON_FIELD_ALIASES.imageUrl) || null,
    productUrl: pickField(raw, JSON_FIELD_ALIASES.productUrl) || null,
    status: 'active',
  };
}

async function fetchJsonFeed(feedUrl) {
  const res = await safeFetch(feedUrl, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Feed returned HTTP ${res.status}`);
  const json = await res.json();
  const list = Array.isArray(json) ? json : (json.products || json.items || json.data || []);
  if (!Array.isArray(list)) throw new Error('Feed JSON must be an array, or an object with a "products"/"items"/"data" array');
  return list.map(normalizeJsonRow).filter(Boolean);
}

// CSV feeds reuse the exact same grid+header-alias logic as the CSV upload
// adapter (csvProductAdapter.js) and the Google Sheet adapter — kept
// intentionally close to those two so all three "tabular" sources behave
// identically from the customer's point of view.
const CSV_HEADER_ALIASES = {
  name: ['name', 'title', 'productname', 'product'],
  sku: ['sku', 'itemcode', 'productcode', 'code'],
  price: ['price', 'amount', 'cost', 'sellingprice'],
  currency: ['currency', 'currencycode'],
  description: ['description', 'desc', 'details'],
  imageurl: ['imageurl', 'image', 'photo', 'picture'],
  producturl: ['producturl', 'url', 'link'],
};

function normalizeHeaderKey(raw) {
  return String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function fetchCsvFeed(feedUrl) {
  const res = await safeFetch(feedUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Feed returned HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  const workbook = new ExcelJS.Workbook();
  await workbook.csv.read(Readable.from(buf));
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return [];

  const grid = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    grid.push(row.values.slice(1).map((c) => (c == null ? '' : String(c))));
  });
  if (grid.length === 0) return [];

  const fieldMap = {};
  grid[0].forEach((raw, idx) => {
    const key = normalizeHeaderKey(raw);
    for (const [field, aliases] of Object.entries(CSV_HEADER_ALIASES)) {
      if (aliases.includes(key)) fieldMap[idx] = field;
    }
  });

  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const row = {};
    Object.entries(fieldMap).forEach(([idx, field]) => { row[field] = (grid[r][idx] || '').trim(); });
    if (!row.name) continue;
    rows.push({
      name: row.name,
      sku: row.sku || null,
      price: row.price ? Number(row.price.replace(/[^0-9.\-]/g, '')) : null,
      currency: row.currency || null,
      description: row.description || null,
      imageUrl: row.imageurl || null,
      productUrl: row.producturl || null,
      status: 'active',
    });
  }
  return rows;
}

async function fetchRows(config) {
  const feedUrl = config && config.feedUrl;
  const format = (config && config.format) === 'csv' ? 'csv' : 'json';
  if (!feedUrl) throw Object.assign(new Error('feedUrl is required'), { status: 400 });

  const rows = format === 'csv' ? await fetchCsvFeed(feedUrl) : await fetchJsonFeed(feedUrl);
  return { rows };
}

module.exports = { fetchRows };