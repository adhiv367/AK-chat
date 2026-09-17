// Phase 7.3 — SaaS Product Catalog Foundation: routes.
//
// Every route derives workspaceId from req.workspace (set server-side by
// middleware/workspaceContext.js's attachWorkspace, mounted ahead of this
// router in index.js) — never from req.body/req.query/req.params. This is
// the same pattern used throughout the codebase (see routes/categories.js,
// routes/businessFields.js): a workspace_id supplied by the client is never
// trusted, so Customer A can never read or write Customer B's catalog by
// guessing/forging an id.
//
// Generic, source-agnostic: nothing here assumes a product came from
// Shopify. `source` is a plain filterable/searchable column.

const { Router } = require('express');
const { requirePermission } = require('../middleware/access');
const productService = require('../services/productService');

const router = Router();

function handleError(res, err, fallbackMessage) {
  if (err.status === 400 || err instanceof productService.ValidationError) {
    return res.status(400).json({ error: err.message });
  }
  if (err.status === 404 || err instanceof productService.NotFoundError) {
    return res.status(404).json({ error: err.message });
  }
  console.error(`[products] ${fallbackMessage}:`, err.message);
  return res.status(500).json({ error: fallbackMessage });
}

function getWorkspaceId(req, res) {
  const workspaceId = req.workspace?.id ?? null;
  if (!workspaceId) {
    res.status(403).json({ error: 'No workspace found for this account' });
    return null;
  }
  return workspaceId;
}

const gate = requirePermission('products');

/* ------------------------------------------------------------------ */
/*  Products                                                           */
/* ------------------------------------------------------------------ */

// GET /api/products
router.get('/products', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const { search, status, source, collectionId, page, pageSize, sortBy, sortDir } = req.query;
    const result = await productService.listProducts(workspaceId, {
      search, status, source, collectionId, page, pageSize, sortBy, sortDir,
    });
    res.json(result);
  } catch (err) {
    handleError(res, err, 'Failed to fetch products');
  }
});

// GET /api/products/:id
router.get('/products/:id', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const product = await productService.getProduct(workspaceId, req.params.id);
    res.json(product);
  } catch (err) {
    handleError(res, err, 'Failed to fetch product');
  }
});

// POST /api/products
router.post('/products', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const product = await productService.createProduct(workspaceId, req.body || {});
    res.status(201).json(product);
  } catch (err) {
    handleError(res, err, 'Failed to create product');
  }
});

// PUT /api/products/:id
router.put('/products/:id', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const product = await productService.updateProduct(workspaceId, req.params.id, req.body || {});
    res.json(product);
  } catch (err) {
    handleError(res, err, 'Failed to update product');
  }
});

// DELETE /api/products/:id
// Soft-delete: archives the product (status = 'archived') rather than
// removing the row — per spec, archive is preferred over permanent
// deletion so order history / variants / collection membership stay intact.
router.delete('/products/:id', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const product = await productService.archiveProduct(workspaceId, req.params.id);
    res.json({ ok: true, product });
  } catch (err) {
    handleError(res, err, 'Failed to archive product');
  }
});

/* ------------------------------------------------------------------ */
/*  Variants                                                            */
/* ------------------------------------------------------------------ */

// GET /api/products/:id/variants
router.get('/products/:id/variants', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const variants = await productService.listVariants(workspaceId, req.params.id);
    res.json(variants);
  } catch (err) {
    handleError(res, err, 'Failed to fetch variants');
  }
});

// POST /api/products/:id/variants
router.post('/products/:id/variants', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const variant = await productService.createVariant(workspaceId, req.params.id, req.body || {});
    res.status(201).json(variant);
  } catch (err) {
    handleError(res, err, 'Failed to create variant');
  }
});

// PUT /api/products/:id/variants/:variantId
router.put('/products/:id/variants/:variantId', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const variant = await productService.updateVariant(workspaceId, req.params.id, req.params.variantId, req.body || {});
    res.json(variant);
  } catch (err) {
    handleError(res, err, 'Failed to update variant');
  }
});

// DELETE /api/products/:id/variants/:variantId
router.delete('/products/:id/variants/:variantId', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const result = await productService.deleteVariant(workspaceId, req.params.id, req.params.variantId);
    res.json(result);
  } catch (err) {
    handleError(res, err, 'Failed to delete variant');
  }
});

/* ------------------------------------------------------------------ */
/*  Product <-> Collection assignment                                   */
/* ------------------------------------------------------------------ */

// GET /api/products/:id/collections
router.get('/products/:id/collections', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const collections = await productService.listProductCollections(workspaceId, req.params.id);
    res.json(collections);
  } catch (err) {
    handleError(res, err, 'Failed to fetch product collections');
  }
});

// POST /api/products/:id/collections/:collectionId
router.post('/products/:id/collections/:collectionId', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const link = await productService.assignProductToCollection(workspaceId, req.params.id, req.params.collectionId);
    res.status(201).json(link);
  } catch (err) {
    handleError(res, err, 'Failed to assign product to collection');
  }
});

// DELETE /api/products/:id/collections/:collectionId
router.delete('/products/:id/collections/:collectionId', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const result = await productService.removeProductFromCollection(workspaceId, req.params.id, req.params.collectionId);
    res.json(result);
  } catch (err) {
    handleError(res, err, 'Failed to remove product from collection');
  }
});

/* ------------------------------------------------------------------ */
/*  Collections                                                         */
/* ------------------------------------------------------------------ */

// GET /api/collections
router.get('/collections', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const { search, includeArchived, page, pageSize } = req.query;
    const result = await productService.listCollections(workspaceId, {
      search, includeArchived: includeArchived === 'true', page, pageSize,
    });
    res.json(result);
  } catch (err) {
    handleError(res, err, 'Failed to fetch collections');
  }
});

// GET /api/collections/:id
router.get('/collections/:id', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const collection = await productService.getCollection(workspaceId, req.params.id);
    res.json(collection);
  } catch (err) {
    handleError(res, err, 'Failed to fetch collection');
  }
});

// POST /api/collections
router.post('/collections', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const collection = await productService.createCollection(workspaceId, req.body || {});
    res.status(201).json(collection);
  } catch (err) {
    handleError(res, err, 'Failed to create collection');
  }
});

// PUT /api/collections/:id
router.put('/collections/:id', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const collection = await productService.updateCollection(workspaceId, req.params.id, req.body || {});
    res.json(collection);
  } catch (err) {
    handleError(res, err, 'Failed to update collection');
  }
});

// DELETE /api/collections/:id  (archive, not permanent delete)
router.delete('/collections/:id', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const collection = await productService.archiveCollection(workspaceId, req.params.id);
    res.json({ ok: true, collection });
  } catch (err) {
    handleError(res, err, 'Failed to archive collection');
  }
});

/* ------------------------------------------------------------------ */
/*  Inventory                                                           */
/* ------------------------------------------------------------------ */

// GET /api/products/:id/inventory  (all variants' inventory, plus base product row if present)
router.get('/products/:id/inventory', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const inventory = await productService.listInventoryForProduct(workspaceId, req.params.id);
    res.json(inventory);
  } catch (err) {
    handleError(res, err, 'Failed to fetch inventory');
  }
});

// PUT /api/products/:id/inventory  (body: { variantId?, availableQuantity, reservedQuantity, source? })
router.put('/products/:id/inventory', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const inventory = await productService.upsertInventory(workspaceId, req.params.id, req.body || {});
    res.json(inventory);
  } catch (err) {
    handleError(res, err, 'Failed to update inventory');
  }
});

module.exports = { router };
