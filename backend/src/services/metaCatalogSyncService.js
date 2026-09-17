// Phase 7.5 — Meta Commerce Catalog Integration: outbound sync engine.
//
// Pushes coexistence.products rows OUT to a workspace's connected Meta
// Catalog — the mirror image of services/catalogImportService.js (which
// pulls external rows IN). This file never modifies catalogImportService.js,
// catalogSyncScheduler.js, or coexistence.catalog_connections/catalog_sync_log
// — it owns its own outbound log table, coexistence.meta_catalog_sync_log
// (db/metaCatalogSchema.js).
//
// Idempotency: every product pushed carries retailer_id (falling back to
// sku, then the AK Chat product id) as Meta's item key — Meta's items_batch
// UPDATE method upserts by retailer_id, so re-running a sync is always
// safe. meta_product_id (existing column) is not required by Meta's batch
// API and is left untouched by this file; retailer_id is the sync key on
// both sides, per the audit.
//
// Archived products are never hard-deleted from the Meta Catalog by the
// routine sync path — they are pushed with availability = 'out of stock',
// a safe, reversible state. Hard delete is only exposed as an explicit,
// separate action (see deleteProductFromCatalog below), never invoked by
// runSync().

'use strict';

const pool = require('../db');
const metaCatalog = require('../integrations/metaCatalog');
const { resolveAccessToken } = require('./metaCatalogConnectionService');

const BATCH_SIZE = 50;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function startLog(workspaceId, whatsappAccountId, connectionId, triggeredBy) {
  const { rows } = await pool.query(
    `INSERT INTO coexistence.meta_catalog_sync_log
        (workspace_id, whatsapp_account_id, connection_id, triggered_by, status)
     VALUES ($1, $2, $3, $4, 'running')
     RETURNING *`,
    [workspaceId, whatsappAccountId, connectionId, triggeredBy]
  );
  return rows[0];
}

async function finishLog(logId, patch) {
  const keys = Object.keys(patch);
  const setSql = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await pool.query(
    `UPDATE coexistence.meta_catalog_sync_log SET ${setSql}, finished_at = NOW() WHERE id = $1`,
    [logId, ...keys.map((k) => patch[k])]
  );
}

async function markProductSynced(productId) {
  await pool.query(
    `UPDATE coexistence.products
        SET meta_sync_status = 'synced', meta_last_synced_at = NOW(), meta_last_error = NULL
      WHERE id = $1`,
    [productId]
  );
}

async function markProductError(productId, message) {
  await pool.query(
    `UPDATE coexistence.products
        SET meta_sync_status = 'error', meta_last_error = $2
      WHERE id = $1`,
    [productId, message]
  );
}

/**
 * Fetch the products a workspace+account's sync should push: active +
 * archived products for that workspace, optionally scoped to a single
 * WhatsApp account (whatsapp_account_id column already exists on
 * coexistence.products). draft products are excluded — same convention
 * as "active" meaning customer-visible everywhere else in this codebase.
 */
async function fetchSyncableProducts(workspaceId, whatsappAccountId, { productIds } = {}) {
  const params = [workspaceId];
  let where = `workspace_id = $1 AND status IN ('active', 'archived')`;
  if (whatsappAccountId) {
    params.push(whatsappAccountId);
    where += ` AND (whatsapp_account_id = $${params.length} OR whatsapp_account_id IS NULL)`;
  }
  if (productIds && productIds.length) {
    params.push(productIds);
    where += ` AND id = ANY($${params.length})`;
  }
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.products WHERE ${where} ORDER BY id`,
    params
  );
  return rows;
}

/**
 * Run one outbound sync for a workspace + WhatsApp account's connected
 * catalog. Always writes a meta_catalog_sync_log row, success or failure,
 * mirroring catalogImportService.runImport()'s log lifecycle.
 */
async function runSync(workspaceId, whatsappAccountId, connection, { triggeredBy = 'manual', productIds } = {}) {
  if (!connection || connection.status === 'disconnected') {
    throw Object.assign(new Error('No active Meta catalog connection for this WhatsApp account'), { status: 400 });
  }

  const log = await startLog(workspaceId, whatsappAccountId, connection.id, triggeredBy);

  let created = 0, updated = 0, failed = 0, readCount = 0;
  try {
    const accessToken = await resolveAccessToken(workspaceId, whatsappAccountId, connection);
    const products = await fetchSyncableProducts(workspaceId, whatsappAccountId, { productIds });
    readCount = products.length;

    for (const batch of chunk(products, BATCH_SIZE)) {
      const items = batch.map((p) => metaCatalog.toCatalogItem(p));
      try {
        await metaCatalog.upsertCatalogItems({ accessToken, catalogId: connection.catalog_id, items });
        for (const p of batch) {
          await markProductSynced(p.id);
          if (p.meta_sync_status === 'not_synced' || p.meta_sync_status == null) created++; else updated++;
        }
      } catch (batchErr) {
        // One failed batch degrades to per-item retry so a single bad
        // product never fails the whole run (mirrors catalogImportService.js's
        // per-row try/catch).
        for (const p of batch) {
          try {
            await metaCatalog.upsertCatalogItems({ accessToken, catalogId: connection.catalog_id, items: [metaCatalog.toCatalogItem(p)] });
            await markProductSynced(p.id);
            updated++;
          } catch (itemErr) {
            failed++;
            await markProductError(p.id, itemErr.message);
          }
        }
      }
    }

    await pool.query(
      `UPDATE coexistence.meta_catalog_connections
          SET status = 'connected', last_synced_at = NOW(), last_error = NULL, last_error_at = NULL
        WHERE id = $1`,
      [connection.id]
    );
    await finishLog(log.id, {
      status: 'success', rows_read: readCount, rows_created: created, rows_updated: updated, rows_failed: failed,
    });
  } catch (err) {
    await pool.query(
      `UPDATE coexistence.meta_catalog_connections
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

/**
 * Retry a single product that previously failed (or hasn't synced yet).
 * Scoped to workspace_id + whatsapp_account_id like every other query here.
 */
async function retryProduct(workspaceId, whatsappAccountId, connection, productId) {
  const products = await fetchSyncableProducts(workspaceId, whatsappAccountId, { productIds: [productId] });
  if (!products[0]) {
    throw Object.assign(new Error('Product not found for this workspace/account'), { status: 404 });
  }
  return runSync(workspaceId, whatsappAccountId, connection, { triggeredBy: 'retry', productIds: [productId] });
}

/**
 * Explicit hard delete of a single product from the Meta Catalog. NEVER
 * called automatically by runSync()/archiving — must be invoked directly
 * by a caller that truly wants a hard delete, not just an availability
 * change.
 */
async function deleteProductFromCatalog(workspaceId, whatsappAccountId, connection, productId) {
  const products = await fetchSyncableProducts(workspaceId, whatsappAccountId, { productIds: [productId] });
  const product = products[0];
  if (!product) throw Object.assign(new Error('Product not found for this workspace/account'), { status: 404 });

  const accessToken = await resolveAccessToken(workspaceId, whatsappAccountId, connection);
  const retailerId = product.retailer_id || product.sku || String(product.id);
  await metaCatalog.deleteCatalogItem({ accessToken, catalogId: connection.catalog_id, retailerId });
  await pool.query(
    `UPDATE coexistence.products SET meta_sync_status = 'not_synced', meta_last_synced_at = NOW(), meta_last_error = NULL WHERE id = $1`,
    [productId]
  );
  return { ok: true };
}

async function listSyncLog(workspaceId, whatsappAccountId) {
  const params = [workspaceId];
  let where = 'workspace_id = $1';
  if (whatsappAccountId) {
    params.push(whatsappAccountId);
    where += ` AND whatsapp_account_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.meta_catalog_sync_log
      WHERE ${where}
      ORDER BY started_at DESC LIMIT 50`,
    params
  );
  return rows;
}

module.exports = {
  runSync,
  retryProduct,
  deleteProductFromCatalog,
  listSyncLog,
  fetchSyncableProducts,
};