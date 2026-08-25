// Reads customer/order rows from a public Google Sheet (Shopify's permanent
// export sheet). Uses the "anyone with the link" CSV export endpoint — no
// OAuth/service account needed for a public sheet. Only reads rows added
// since the last sync (caller passes lastSyncedRow), so we never re-download
// the whole sheet every tick.

const axios = require('axios');
const ExcelJS = require('exceljs');
const { Readable } = require('stream');

const FETCH_TIMEOUT_MS = 15000;

function parseSheetIdAndGid(sheetUrl) {
  const idMatch = String(sheetUrl).match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (!idMatch) throw new Error("That doesn't look like a valid Google Sheet URL");
  const gidMatch = String(sheetUrl).match(/[#&]gid=([0-9]+)/);
  return { sheetId: idMatch[1], gid: gidMatch ? gidMatch[1] : '0' };
}

// Fetch the full sheet as a raw grid (array of arrays of strings).
async function fetchSheetGrid(sheetUrl) {
  const { sheetId, gid } = parseSheetIdAndGid(sheetUrl);
  const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;

  let res;
  try {
    res = await axios.get(csvUrl, {
      responseType: 'arraybuffer',
      timeout: FETCH_TIMEOUT_MS,
      validateStatus: (s) => s === 200,
    });
  } catch (err) {
    if (err.response?.status === 401 || err.response?.status === 403) {
      throw new Error('Sheet is not public. Share it as "Anyone with the link can view", or configure a service account.');
    }
    throw new Error(`Could not reach Google Sheets: ${err.message}`);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.csv.read(Readable.from(Buffer.from(res.data)));
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

// Shopify-style export header aliases -> canonical field keys. Keys here are
// pre-normalized to [a-z0-9] only (no spaces/underscores/punctuation) — see
// normalizeHeaderKey below — so "Phone_No", "Phone No", "PHONE-NO" etc. all
// match the same 'phoneno' entry. Extend this map if your sheet uses
// different column names. Kept consistent with the alias sets in
// routes/messages.js so Excel import and Google Sheet sync recognize the
// same header variations.
const HEADER_MAP = {
  customername: 'name', name: 'name', fullname: 'name', clientname: 'name',
  customer: 'name', client: 'name', contactperson: 'name', personname: 'name',
  mobilenumber: 'phone', phone: 'phone', mobile: 'phone', phonenumber: 'phone',
  phoneno: 'phone', mobileno: 'phone', contactnumber: 'phone', contactno: 'phone',
  customerphone: 'phone', customermobile: 'phone', clientphone: 'phone', clientmobile: 'phone',
  whatsappnumber: 'phone', whatsapp: 'phone', msisdn: 'phone', telephone: 'phone', tel: 'phone',
  email: 'email', emailaddress: 'email', mail: 'email', customeremail: 'email', emailid: 'email',
  address: 'address',
  city: 'city',
  state: 'state',
  country: 'country',
  product: 'product',
  orderamount: 'orderAmount', total: 'orderAmount', amount: 'orderAmount',
  purchasedate: 'purchaseDate', date: 'purchaseDate',
  orderid: 'orderId',
  paymentstatus: 'paymentStatus',
  tags: 'tags',
};

function normalizeHeaderKey(h) {
  return String(h || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Builds a { canonicalField: columnIndex } map from a header row.
 *
 * @param {string[]} headerRow
 * @param {object} [extraMap] - Additional normalizedHeaderKey -> canonicalField
 *   entries layered on top of HEADER_MAP, for callers that need extra columns
 *   this sheet type doesn't have (e.g. Retarget's exitUrl/retargetType/
 *   timestamp/source). Never overrides an existing HEADER_MAP key — the
 *   shared Contacts aliases always win, so behaviour here stays identical to
 *   the Contacts sheet importer for every field they share.
 */
function buildHeaderIndex(headerRow, extraMap = {}) {
  const map = { ...extraMap, ...HEADER_MAP };
  const index = {};
  headerRow.forEach((h, i) => {
    const mapped = map[normalizeHeaderKey(h)];
    if (mapped) index[mapped] = i;
  });
  return index;
}

/**
 * Fetch only the rows added since lastSyncedRow (a data-row count, header
 * row excluded — 0 means "nothing synced yet, read everything").
 * Returns { newRows: [{name,phone,email,...}], totalDataRows }.
 */
async function fetchNewRows(sheetUrl, lastSyncedRow = 0) {
  const grid = await fetchSheetGrid(sheetUrl);
  if (grid.length === 0) return { newRows: [], totalDataRows: 0 };

  const headerIndex = buildHeaderIndex(grid[0]);
  if (headerIndex.phone === undefined) {
    throw new Error('Could not find a phone/mobile column in the sheet header row.');
  }

  const dataRows = grid.slice(1);
  const freshRows = dataRows.slice(lastSyncedRow);

  const newRows = freshRows.map((row) => {
    const get = (key) => (headerIndex[key] !== undefined ? (row[headerIndex[key]] ?? '') : '');
    return {
      name: get('name'), phone: get('phone'), email: get('email'),
      address: get('address'), city: get('city'), state: get('state'), country: get('country'),
      product: get('product'), orderAmount: get('orderAmount'), purchaseDate: get('purchaseDate'),
      orderId: get('orderId'), paymentStatus: get('paymentStatus'), tags: get('tags'),
    };
  });

  return { newRows, totalDataRows: dataRows.length };
}

module.exports = {
  fetchSheetGrid,
  fetchNewRows,
  parseSheetIdAndGid,
  normalizeHeaderKey,
  buildHeaderIndex,
  HEADER_MAP,
};

