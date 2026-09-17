// Retarget module — Google Sheet service.
// Reads Name/Phone/Email/ExitURL/RetargetType/Timestamp rows from a public
// Google Sheet. Reuses the CSV-export fetch (no OAuth needed for a public
// sheet) from services/googleSheetService.js, but applies Retarget's own
// header map since the sheet columns are different from the Shopify-order
// sheet used by contacts sync.

const { fetchSheetGrid, parseSheetIdAndGid } = require('./googleSheetService');
const { gridToRows } = require('./retargetImportService');

/**
 * Fetch only the rows added since lastSyncedRow (a data-row count, header
 * row excluded — 0 means "nothing synced yet, read everything").
 * @returns {Promise<{newRows: object[], totalDataRows: number}>}
 */
async function fetchNewRetargetRows(sheetUrl, lastSyncedRow = 0) {
  const grid = await fetchSheetGrid(sheetUrl);
  if (grid.length === 0) return { newRows: [], totalDataRows: 0 };

  const { rows, headerIndex } = gridToRows(grid);
  if (headerIndex.phone === undefined) {
    throw new Error('Could not find a Phone column in the sheet header row.');
  }

  const totalDataRows = rows.length;
  const newRows = rows.slice(lastSyncedRow);

  return { newRows, totalDataRows };
}

module.exports = { fetchNewRetargetRows, parseSheetIdAndGid };

