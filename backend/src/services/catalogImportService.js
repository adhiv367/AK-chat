// Phase 7.4 — Catalog Connection Layer: import orchestration.
//
// The single place that ties a connection (source + config + secret) to
// the right adapter (catalogAdapters/*), runs the import, and writes every
// row through the EXISTING Phase 7.3 product write path
// (services/productService.js) — this file never inserts into
// coexistence.products directly. It also writes a coexistence.catalog_sync_log
// row per run, same idea as retargetImportService.js's per-file sync log.
//
// Match/upsert strategy (idempotency):
//   - Shopify rows carry a stable shopifyProductId -> upsert via the
//     existing UNIQUE(workspace_id, shopify_product_id) constraint
//     (commerceSchema.js), same as Meta catalog sync already does.
//   - Website/Sheet/CSV rows have no platform-assigned id, so we match on
//     (workspace_id, sku) when a SKU is present, else fall back to
//     (workspace_id, name) — both are best-effort and NOT DB-enforced
//     unique constraints today. This is a known/documented limitation (see
//     audit §2 "Missing pieces" — no column-mapping/unique-key config yet);
//     acceptable for a minimal 7.4 because it still prevents duplicate rows
//     on every scheduled re-sync of the same feed, which is the main
//     practical risk.

'use strict';

const pool = require('../db');
const productService = require('./productService');
const { decrypt } = require('../util/crypto');

const shopifyAdapter = require('./catalogAdapters/shopifyAdapter');
const websiteFeedAdapter = require('./catalogAdapters/websiteFeedAdapter');
const googleSheetProductAdapter = require('./catalogAdapters/googleSheetProductAdapter');
const csvProductAdapter = require('./catalogAdapters/csvProductAdapter');

const ADAPTERS = {
  shopify: shopifyAdapter,
  website: websiteFeedAdapter,
  google_sheet: googleSheetProductAdapter,
  csv: csvProductAdapter,
};

async function findExistingByShopifyId(workspaceId, shopifyProductId) {
  const { rows } = await pool.query(
    `SELECT id FROM coexistence.products WHERE workspace_id = $1 AND shopify_product_id = $2`,
    [workspaceId, shopifyProductId]
  );
  return rows[0] || null;
}

async function findExistingBySkuOrName(workspaceId, sku, name) {
  if (sku) {
    const { rows } = await pool.query(
      `SELECT id FROM coexistence.products WHERE workspace_id = $1 AND sku = $2 LIMIT 1`,
      [workspaceId, sku]
    );
    if (rows[0]) return rows[0];
  }
  const { rows } = await pool.query(
    `SELECT id FROM coexistence.products WHERE workspace_id = $1 AND name = $2 LIMIT 1`,
    [workspaceId, name]
  );
  return rows[0] || null;
}

async function upsertRow(workspaceId, source, row) {
  const input = {
    name: row.name,
    source,
    status: row.status || 'active',
    price: row.price,
    description: row.description,
    sku: row.sku,
    currency: row.currency,
    productUrl: row.productUrl,
    imageUrl: row.imageUrl,
  };
  if (row.shopifyProductId) input.productId = row.shopifyProductId;

  const existing = row.shopifyProductId
    ? await findExistingByShopifyId(workspaceId, row.shopifyProductId)
    : await findExistingBySkuOrName(workspaceId, row.sku, row.name);

  if (existing) {
    await productService.updateProduct(workspaceId, existing.id, input);
    return 'updated';
  }
  await productService.createProduct(workspaceId, input);
  return 'created';
}

async function startLog(workspaceId, connectionId, source, triggeredBy) {
  const { rows } = await pool.query(
    `INSERT INTO coexistence.catalog_sync_log (workspace_id, connection_id, source, triggered_by, status)
     VALUES ($1, $2, $3, $4, 'running')
     RETURNING *`,
    [workspaceId, connectionId, source, triggeredBy]
  );
  return rows[0];
}

async function finishLog(logId, patch) {
  const keys = Object.keys(patch);
  const setSql = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await pool.query(
    `UPDATE coexistence.catalog_sync_log SET ${setSql}, finished_at = NOW() WHERE id = $1`,
    [logId, ...keys.map((k) => patch[k])]
  );
}

// Runs one import: workspace + connection row (from catalog_connections) +
// context (e.g. { buffer, filename } for CSV upload). Always writes a
// catalog_sync_log row, success or failure.
async function runImport(workspaceId, connection, { triggeredBy = 'manual', context = {} } = {}) {
  const adapter = ADAPTERS[connection.source];
  if (!adapter) throw Object.assign(new Error(`No adapter for source "${connection.source}"`), { status: 400 });

  const log = await startLog(workspaceId, connection.id, connection.source, triggeredBy);

  let created = 0, updated = 0, failed = 0, readCount = 0;
  try {
    const secret = connection.secret_encrypted ? decrypt(connection.secret_encrypted) : null;
    const { rows } = await adapter.fetchRows(connection.config || {}, { ...context, secret });
    readCount = rows.length;

    for (const row of rows) {
      try {
        const result = await upsertRow(workspaceId, connection.source, row);
        if (result === 'created') created++; else updated++;
      } catch (rowErr) {
        failed++;
      }
    }

    await pool.query(
      `UPDATE coexistence.catalog_connections
          SET status = 'connected', last_synced_at = NOW(), last_error = NULL, last_error_at = NULL
        WHERE id = $1`,
      [connection.id]
    );
    await finishLog(log.id, {
      status: 'success', rows_read: readCount, rows_created: created, rows_updated: updated, rows_failed: failed,
    });
  } catch (err) {
    await pool.query(
      `UPDATE coexistence.catalog_connections
          SET status = 'error', last_error = $2, last_error_at = NOW()
        WHERE id = $1`,
      [connection.id, err.message]
    );
    await finishLog(log.id, {
      status: 'error', rows_read: readCount, rows_created: created, rows_updated: updated, rows_failed: failed,
      error_message: err.message,
    });
    throw err;
  }

  return { rowsRead: readCount, rowsCreated: created, rowsUpdated: updated, rowsFailed: failed };
}

module.exports = { runImport, ADAPTERS };