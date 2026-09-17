// Phase 7.3 — SaaS Product Catalog Foundation: service layer.
//
// PRODUCT PRINCIPLE: AK Chat is a multi-tenant SaaS product. Nothing in
// this file, or anywhere else in Phase 7.3, references a specific
// customer/tenant (Invi Creations or otherwise). Every function below
// requires a `workspaceId` and every query is scoped to it — the caller
// (routes/products.js) always derives workspaceId server-side from
// req.workspace (never from the request body/query), exactly like every
// other Phase 3B+ service in this codebase (see businessFieldDefinitionService,
// zohoConnectionService).
//
// Scoped to the Phase 7.2 commerce schema (db/commerceSchema.js) only.
// No table is created, redesigned, or dropped here. No Shopify/Meta/Google
// Sheet/CSV sync logic lives here — `source` is just a plain string column
// on the row; this service never talks to an external API.
//
// Isolation model: every read filters WHERE workspace_id = $1. Every write
// to a product/variant/collection/inventory row first re-selects it scoped
// to workspace_id — an id belonging to another workspace always looks like
// "not found", never a permission error that would leak its existence.

'use strict';

const pool = require('../db');
const { PRODUCT_STATUSES, PRODUCT_SOURCES } = require('../db/commerceSchema');

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.status = 404;
  }
}

function requireWorkspaceId(workspaceId) {
  if (!workspaceId) throw new ValidationError('workspaceId is required');
}

function clampPage(value, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

function clampPageSize(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return 20;
  return Math.min(n, 100);
}

const PRODUCT_SORT_COLUMNS = {
  name: 'name',
  price: 'price',
  status: 'status',
  created_at: 'created_at',
  updated_at: 'updated_at',
};

// ── Products ─────────────────────────────────────────────────────────────

async function listProducts(workspaceId, opts = {}) {
  requireWorkspaceId(workspaceId);

  const {
    search,
    status,
    source,
    collectionId,
    page,
    pageSize,
    sortBy = 'created_at',
    sortDir = 'desc',
  } = opts;

  if (status && !PRODUCT_STATUSES.includes(status)) {
    throw new ValidationError(`Invalid status. Must be one of: ${PRODUCT_STATUSES.join(', ')}`);
  }
  if (source && !PRODUCT_SOURCES.includes(source)) {
    throw new ValidationError(`Invalid source. Must be one of: ${PRODUCT_SOURCES.join(', ')}`);
  }

  const sortColumn = PRODUCT_SORT_COLUMNS[sortBy] || 'created_at';
  const direction = String(sortDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const where = ['p.workspace_id = $1'];
  const params = [workspaceId];

  if (status) {
    params.push(status);
    where.push(`p.status = $${params.length}`);
  }
  if (source) {
    params.push(source);
    where.push(`p.source = $${params.length}`);
  }
  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    const idx = params.length;
    where.push(`(p.name ILIKE $${idx} OR p.sku ILIKE $${idx} OR p.product_id ILIKE $${idx} OR p.retailer_id ILIKE $${idx})`);
  }
  if (collectionId) {
    params.push(collectionId);
    where.push(`EXISTS (
      SELECT 1 FROM coexistence.product_collections pc
      JOIN coexistence.collections c ON c.id = pc.collection_id
      WHERE pc.product_id = p.id AND c.workspace_id = p.workspace_id AND pc.collection_id = $${params.length}
    )`);
  }

  const whereSql = where.join(' AND ');
  const pageNum = clampPage(page, 1);
  const size = clampPageSize(pageSize);
  const offset = (pageNum - 1) * size;

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS count FROM coexistence.products p WHERE ${whereSql}`,
    params
  );
  const total = countResult.rows[0]?.count || 0;

  params.push(size, offset);
  const { rows } = await pool.query(
    `SELECT p.*
       FROM coexistence.products p
      WHERE ${whereSql}
      ORDER BY p.${sortColumn} ${direction}, p.id ${direction}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    items: rows,
    pagination: { page: pageNum, pageSize: size, total, totalPages: Math.max(1, Math.ceil(total / size)) },
  };
}

async function getProduct(workspaceId, productId) {
  requireWorkspaceId(workspaceId);
  if (!productId) throw new ValidationError('productId is required');

  const { rows } = await pool.query(
    `SELECT * FROM coexistence.products WHERE id = $1 AND workspace_id = $2`,
    [productId, workspaceId]
  );
  if (rows.length === 0) throw new NotFoundError('Product not found');
  return rows[0];
}

// Phase 7.6 — Product Search / Product ID.
//
// Resolves a single product by one of its EXTERNAL identifiers — the
// merchant-facing Product ID column, the SKU, or the Meta/Shopify retailer
// id — rather than the internal `id` primary key `getProduct()` above
// requires. This is what a chat agent or an automation actually has in
// hand ("look up SKU ABC-123"), not the opaque internal row id.
//
// Same isolation model as every other read in this file: always scoped to
// `workspace_id = $1`, so a value that matches a product in a different
// workspace is indistinguishable from no match at all — never a leak, never
// a permission error. Exactly one identifier is required per call; callers
// (routes/messages.js, engine/automationEngine.js via
// services/whatsappProductMessage.js) decide which one they have.
//
// Matching is exact (not ILIKE/partial) and, when more than one row
// matches (e.g. a blank/duplicate SKU across manually-entered products),
// the most recently created row wins — mirrors "most recent wins" used
// elsewhere in this codebase for ambiguous matches (see
// catalogImportService.js) rather than silently picking an arbitrary row.
async function findProductByExternalId(workspaceId, { productId, sku, retailerId } = {}) {
  requireWorkspaceId(workspaceId);
  const identifier = productId || sku || retailerId;
  if (!identifier || !String(identifier).trim()) {
    throw new ValidationError('One of productId, sku, or retailerId is required');
  }

  const where = ['workspace_id = $1'];
  const params = [workspaceId];

  if (productId) {
    params.push(String(productId).trim());
    where.push(`product_id = $${params.length}`);
  } else if (sku) {
    params.push(String(sku).trim());
    where.push(`sku = $${params.length}`);
  } else {
    params.push(String(retailerId).trim());
    where.push(`retailer_id = $${params.length}`);
  }

  const { rows } = await pool.query(
    `SELECT * FROM coexistence.products
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT 1`,
    params
  );
  if (rows.length === 0) throw new NotFoundError('Product not found');
  return rows[0];
}

function validateProductInput(input, { partial = false } = {}) {
  const out = {};
  if (!partial || input.name !== undefined) {
    if (!input.name || !String(input.name).trim()) {
      throw new ValidationError('name is required');
    }
    out.name = String(input.name).trim();
  }
  if (input.status !== undefined) {
    if (!PRODUCT_STATUSES.includes(input.status)) {
      throw new ValidationError(`Invalid status. Must be one of: ${PRODUCT_STATUSES.join(', ')}`);
    }
    out.status = input.status;
  } else if (!partial) {
    out.status = 'draft';
  }
  if (input.source !== undefined) {
    if (!PRODUCT_SOURCES.includes(input.source)) {
      throw new ValidationError(`Invalid source. Must be one of: ${PRODUCT_SOURCES.join(', ')}`);
    }
    out.source = input.source;
  } else if (!partial) {
    out.source = 'manual';
  }
  if (input.price !== undefined) {
    if (input.price !== null && Number.isNaN(Number(input.price))) {
      throw new ValidationError('price must be a number');
    }
    out.price = input.price === null || input.price === '' ? null : Number(input.price);
  }
  const passthroughFields = [
    'description', 'productId', 'retailerId', 'sku', 'currency',
    'productUrl', 'imageUrl', 'whatsappAccountId',
  ];
  const columnMap = {
    productId: 'product_id',
    retailerId: 'retailer_id',
    productUrl: 'product_url',
    imageUrl: 'image_url',
    whatsappAccountId: 'whatsapp_account_id',
  };
  for (const field of passthroughFields) {
    if (input[field] !== undefined) {
      out[columnMap[field] || field] = input[field] === '' ? null : input[field];
    }
  }
  return out;
}

async function assertWhatsappAccountInWorkspace(workspaceId, whatsappAccountId) {
  if (!whatsappAccountId) return;
  const { rows } = await pool.query(
    `SELECT id FROM coexistence.whatsapp_accounts WHERE id = $1 AND workspace_id = $2`,
    [whatsappAccountId, workspaceId]
  );
  if (rows.length === 0) throw new ValidationError('whatsappAccountId does not belong to this workspace');
}

async function createProduct(workspaceId, input) {
  requireWorkspaceId(workspaceId);
  const data = validateProductInput(input, { partial: false });
  await assertWhatsappAccountInWorkspace(workspaceId, data.whatsapp_account_id);

  const columns = ['workspace_id', ...Object.keys(data)];
  const values = [workspaceId, ...Object.values(data)];
  const placeholders = values.map((_, i) => `$${i + 1}`);

  const { rows } = await pool.query(
    `INSERT INTO coexistence.products (${columns.join(', ')})
     VALUES (${placeholders.join(', ')})
     RETURNING *`,
    values
  );
  return rows[0];
}

async function updateProduct(workspaceId, productId, input) {
  requireWorkspaceId(workspaceId);
  if (!productId) throw new ValidationError('productId is required');
  const data = validateProductInput(input, { partial: true });
  if (data.whatsapp_account_id !== undefined) {
    await assertWhatsappAccountInWorkspace(workspaceId, data.whatsapp_account_id);
  }

  const keys = Object.keys(data);
  if (keys.length === 0) {
    return getProduct(workspaceId, productId);
  }

  const setSql = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
  const { rows } = await pool.query(
    `UPDATE coexistence.products
        SET ${setSql}, updated_at = NOW()
      WHERE id = $1 AND workspace_id = $2
      RETURNING *`,
    [productId, workspaceId, ...keys.map((k) => data[k])]
  );
  if (rows.length === 0) throw new NotFoundError('Product not found');
  return rows[0];
}

// Archives a product (status = 'archived') rather than deleting the row —
// per the Phase 7.3 spec, permanent deletion is avoided when archive is
// more appropriate. Used by both PUT (explicit status='archived') and the
// DELETE route (soft-delete).
async function archiveProduct(workspaceId, productId) {
  requireWorkspaceId(workspaceId);
  const { rows } = await pool.query(
    `UPDATE coexistence.products
        SET status = 'archived', updated_at = NOW()
      WHERE id = $1 AND workspace_id = $2
      RETURNING *`,
    [productId, workspaceId]
  );
  if (rows.length === 0) throw new NotFoundError('Product not found');
  return rows[0];
}

// ── Variants ─────────────────────────────────────────────────────────────

async function assertProductInWorkspace(workspaceId, productId) {
  const { rows } = await pool.query(
    `SELECT id FROM coexistence.products WHERE id = $1 AND workspace_id = $2`,
    [productId, workspaceId]
  );
  if (rows.length === 0) throw new NotFoundError('Product not found');
}

async function listVariants(workspaceId, productId) {
  requireWorkspaceId(workspaceId);
  await assertProductInWorkspace(workspaceId, productId);
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.product_variants WHERE product_id = $1 ORDER BY id ASC`,
    [productId]
  );
  return rows;
}

function validateVariantInput(input, { partial = false } = {}) {
  const out = {};
  if (input.title !== undefined) out.title = input.title === '' ? null : input.title;
  else if (!partial) out.title = null;
  if (input.sku !== undefined) out.sku = input.sku === '' ? null : input.sku;
  if (input.price !== undefined) {
    if (input.price !== null && Number.isNaN(Number(input.price))) {
      throw new ValidationError('price must be a number');
    }
    out.price = input.price === null || input.price === '' ? null : Number(input.price);
  }
  if (input.inventoryQuantity !== undefined) {
    const n = Number(input.inventoryQuantity);
    if (Number.isNaN(n)) throw new ValidationError('inventoryQuantity must be a number');
    out.inventory_quantity = n;
  } else if (!partial) {
    out.inventory_quantity = 0;
  }
  if (input.variantId !== undefined) out.variant_id = input.variantId || null;
  return out;
}

async function createVariant(workspaceId, productId, input) {
  requireWorkspaceId(workspaceId);
  await assertProductInWorkspace(workspaceId, productId);
  const data = validateVariantInput(input, { partial: false });

  const columns = ['product_id', ...Object.keys(data)];
  const values = [productId, ...Object.values(data)];
  const placeholders = values.map((_, i) => `$${i + 1}`);

  const { rows } = await pool.query(
    `INSERT INTO coexistence.product_variants (${columns.join(', ')})
     VALUES (${placeholders.join(', ')})
     RETURNING *`,
    values
  );
  return rows[0];
}

async function updateVariant(workspaceId, productId, variantId, input) {
  requireWorkspaceId(workspaceId);
  await assertProductInWorkspace(workspaceId, productId);
  const data = validateVariantInput(input, { partial: true });

  const keys = Object.keys(data);
  if (keys.length === 0) {
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.product_variants WHERE id = $1 AND product_id = $2`,
      [variantId, productId]
    );
    if (rows.length === 0) throw new NotFoundError('Variant not found');
    return rows[0];
  }

  const setSql = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
  const { rows } = await pool.query(
    `UPDATE coexistence.product_variants
        SET ${setSql}, updated_at = NOW()
      WHERE id = $1 AND product_id = $2
      RETURNING *`,
    [variantId, productId, ...keys.map((k) => data[k])]
  );
  if (rows.length === 0) throw new NotFoundError('Variant not found');
  return rows[0];
}

// Variants have no status column in the Phase 7.2 schema, so "archive" is
// a real delete here (cascades from product delete already; this is the
// explicit single-variant delete path). Deleting a variant does not touch
// its parent product.
async function deleteVariant(workspaceId, productId, variantId) {
  requireWorkspaceId(workspaceId);
  await assertProductInWorkspace(workspaceId, productId);
  const { rowCount } = await pool.query(
    `DELETE FROM coexistence.product_variants WHERE id = $1 AND product_id = $2`,
    [variantId, productId]
  );
  if (rowCount === 0) throw new NotFoundError('Variant not found');
  return { ok: true };
}

// ── Collections ──────────────────────────────────────────────────────────

async function listCollections(workspaceId, opts = {}) {
  requireWorkspaceId(workspaceId);
  const { search, includeArchived = false, page, pageSize } = opts;

  const where = ['workspace_id = $1'];
  const params = [workspaceId];
  if (!includeArchived) where.push('archived_at IS NULL');
  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    where.push(`name ILIKE $${params.length}`);
  }
  const whereSql = where.join(' AND ');

  const pageNum = clampPage(page, 1);
  const size = clampPageSize(pageSize);
  const offset = (pageNum - 1) * size;

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS count FROM coexistence.collections WHERE ${whereSql}`,
    params
  );
  const total = countResult.rows[0]?.count || 0;

  params.push(size, offset);
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.collections
      WHERE ${whereSql}
      ORDER BY name ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return {
    items: rows,
    pagination: { page: pageNum, pageSize: size, total, totalPages: Math.max(1, Math.ceil(total / size)) },
  };
}

async function getCollection(workspaceId, collectionId) {
  requireWorkspaceId(workspaceId);
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.collections WHERE id = $1 AND workspace_id = $2`,
    [collectionId, workspaceId]
  );
  if (rows.length === 0) throw new NotFoundError('Collection not found');
  return rows[0];
}

async function createCollection(workspaceId, input) {
  requireWorkspaceId(workspaceId);
  if (!input?.name || !String(input.name).trim()) {
    throw new ValidationError('name is required');
  }
  const { rows } = await pool.query(
    `INSERT INTO coexistence.collections (workspace_id, name, description)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [workspaceId, String(input.name).trim(), input.description || null]
  );
  return rows[0];
}

async function updateCollection(workspaceId, collectionId, input) {
  requireWorkspaceId(workspaceId);
  const fields = [];
  const values = [];
  if (input.name !== undefined) {
    if (!String(input.name).trim()) throw new ValidationError('name cannot be empty');
    values.push(String(input.name).trim());
    fields.push(`name = $${values.length + 2}`);
  }
  if (input.description !== undefined) {
    values.push(input.description || null);
    fields.push(`description = $${values.length + 2}`);
  }
  if (fields.length === 0) return getCollection(workspaceId, collectionId);

  const { rows } = await pool.query(
    `UPDATE coexistence.collections
        SET ${fields.join(', ')}, updated_at = NOW()
      WHERE id = $1 AND workspace_id = $2
      RETURNING *`,
    [collectionId, workspaceId, ...values]
  );
  if (rows.length === 0) throw new NotFoundError('Collection not found');
  return rows[0];
}

async function archiveCollection(workspaceId, collectionId) {
  requireWorkspaceId(workspaceId);
  const { rows } = await pool.query(
    `UPDATE coexistence.collections
        SET archived_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND workspace_id = $2
      RETURNING *`,
    [collectionId, workspaceId]
  );
  if (rows.length === 0) throw new NotFoundError('Collection not found');
  return rows[0];
}

async function assignProductToCollection(workspaceId, productId, collectionId) {
  requireWorkspaceId(workspaceId);
  await assertProductInWorkspace(workspaceId, productId);
  await getCollection(workspaceId, collectionId); // validates ownership

  const { rows } = await pool.query(
    `INSERT INTO coexistence.product_collections (product_id, collection_id)
     VALUES ($1, $2)
     ON CONFLICT (product_id, collection_id) DO NOTHING
     RETURNING *`,
    [productId, collectionId]
  );
  if (rows.length > 0) return rows[0];
  const { rows: existing } = await pool.query(
    `SELECT * FROM coexistence.product_collections WHERE product_id = $1 AND collection_id = $2`,
    [productId, collectionId]
  );
  return existing[0];
}

async function removeProductFromCollection(workspaceId, productId, collectionId) {
  requireWorkspaceId(workspaceId);
  await assertProductInWorkspace(workspaceId, productId);
  await getCollection(workspaceId, collectionId);

  const { rowCount } = await pool.query(
    `DELETE FROM coexistence.product_collections WHERE product_id = $1 AND collection_id = $2`,
    [productId, collectionId]
  );
  if (rowCount === 0) throw new NotFoundError('Product is not in this collection');
  return { ok: true };
}

async function listProductCollections(workspaceId, productId) {
  requireWorkspaceId(workspaceId);
  await assertProductInWorkspace(workspaceId, productId);
  const { rows } = await pool.query(
    `SELECT c.* FROM coexistence.collections c
       JOIN coexistence.product_collections pc ON pc.collection_id = c.id
      WHERE pc.product_id = $1 AND c.workspace_id = $2
      ORDER BY c.name ASC`,
    [productId, workspaceId]
  );
  return rows;
}

// ── Inventory ────────────────────────────────────────────────────────────

async function getInventory(workspaceId, productId, variantId = null) {
  requireWorkspaceId(workspaceId);
  await assertProductInWorkspace(workspaceId, productId);
  const params = [productId, variantId];
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.inventory_levels
      WHERE product_id = $1 AND variant_id IS NOT DISTINCT FROM $2`,
    params
  );
  return rows[0] || null;
}

async function listInventoryForProduct(workspaceId, productId) {
  requireWorkspaceId(workspaceId);
  await assertProductInWorkspace(workspaceId, productId);
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.inventory_levels WHERE product_id = $1 ORDER BY variant_id NULLS FIRST`,
    [productId]
  );
  return rows;
}

async function upsertInventory(workspaceId, productId, input) {
  requireWorkspaceId(workspaceId);
  await assertProductInWorkspace(workspaceId, productId);

  const variantId = input.variantId || null;
  if (variantId) {
    const { rows } = await pool.query(
      `SELECT id FROM coexistence.product_variants WHERE id = $1 AND product_id = $2`,
      [variantId, productId]
    );
    if (rows.length === 0) throw new ValidationError('variantId does not belong to this product');
  }

  const availableQuantity = input.availableQuantity !== undefined ? Number(input.availableQuantity) : 0;
  const reservedQuantity = input.reservedQuantity !== undefined ? Number(input.reservedQuantity) : 0;
  if (Number.isNaN(availableQuantity) || Number.isNaN(reservedQuantity)) {
    throw new ValidationError('availableQuantity/reservedQuantity must be numbers');
  }
  const source = input.source && PRODUCT_SOURCES.includes(input.source) ? input.source : 'manual';

  const { rows } = await pool.query(
    `INSERT INTO coexistence.inventory_levels
        (workspace_id, product_id, variant_id, available_quantity, reserved_quantity, source, external_inventory_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (product_id, variant_id) DO UPDATE
        SET available_quantity = EXCLUDED.available_quantity,
            reserved_quantity = EXCLUDED.reserved_quantity,
            source = EXCLUDED.source,
            external_inventory_id = EXCLUDED.external_inventory_id,
            updated_at = NOW()
     RETURNING *`,
    [workspaceId, productId, variantId, availableQuantity, reservedQuantity, source, input.externalInventoryId || null]
  );
  return rows[0];
}

// Phase 7.4 — thin wrapper so catalog adapters (services/catalogAdapters/*)
// have one obvious entry point. Delegates to the existing
// createProduct()/updateProduct() above; does not change their validation
// or workspace-isolation behavior. `matchFn(workspaceId, row)` decides
// whether a given normalized row already exists (e.g. by shopify_product_id,
// or by sku/name) — see services/catalogImportService.js for the actual
// matching strategy per source.
async function bulkUpsertFromSource(workspaceId, source, rows, matchFn) {
  const results = { created: 0, updated: 0, failed: 0 };
  for (const row of rows) {
    try {
      const existing = await matchFn(workspaceId, row);
      if (existing) {
        await updateProduct(workspaceId, existing.id, { ...row, source });
        results.updated++;
      } else {
        await createProduct(workspaceId, { ...row, source });
        results.created++;
      }
    } catch (err) {
      results.failed++;
    }
  }
  return results;
}

module.exports = {
  ValidationError,
  NotFoundError,
  listProducts,
  getProduct,
  findProductByExternalId, // Phase 7.6
  createProduct,
  updateProduct,
  archiveProduct,
  bulkUpsertFromSource, // Phase 7.4
  listVariants,
  createVariant,
  updateVariant,
  deleteVariant,
  listCollections,
  getCollection,
  createCollection,
  updateCollection,
  archiveCollection,
  assignProductToCollection,
  removeProductFromCollection,
  listProductCollections,
  getInventory,
  listInventoryForProduct,
  upsertInventory,
};