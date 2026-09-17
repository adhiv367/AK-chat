// Phase 7.5 — Meta Commerce Catalog Integration: Graph API client.
//
// Pure API wrapper, same shape as integrations/metaSend.js: every function
// takes { accessToken, ... } explicitly (no DB access, no token lookup —
// that happens in services/metaCatalogConnectionService.js /
// metaCatalogSyncService.js), so this module is trivially mockable in tests
// and never talks to a real Meta endpoint unless a real fetch is injected.
//
// No catalog ID, business ID, WABA ID, or any tenant data is hardcoded
// anywhere in this file — every id is a parameter supplied by the caller.

'use strict';

const META_API_VERSION = process.env.META_API_VERSION || 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

function buildUrl(path, query) {
  const u = new URL(`${GRAPH_BASE}/${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) u.searchParams.set(k, v);
    }
  }
  return u.toString();
}

async function request(method, path, { accessToken, query, body } = {}) {
  const res = await fetch(buildUrl(path, query), {
    method,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw text below */ }
  if (!res.ok) {
    const errMsg = parsed?.error?.message || text.slice(0, 300) || `HTTP ${res.status}`;
    const err = new Error(`Meta ${res.status}: ${errMsg}`);
    err.status = res.status;
    err.metaError = parsed?.error || null;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

/**
 * List product catalogs owned by a Meta Business Manager account that the
 * given token can see. Used to populate the "select a catalog" picker.
 */
async function listOwnedCatalogs({ accessToken, businessId }) {
  const data = await request('GET', `${encodeURIComponent(businessId)}/owned_product_catalogs`, {
    accessToken,
    query: { fields: 'id,name,product_count' },
  });
  return data?.data || [];
}

/**
 * List the catalog(s) already associated with a WhatsApp Business Account —
 * lets the UI show "currently linked" state without a separate DB round trip
 * being the only source of truth.
 */
async function listWabaCatalogs({ accessToken, wabaId }) {
  const data = await request('GET', `${encodeURIComponent(wabaId)}/product_catalogs`, {
    accessToken,
    query: { fields: 'id,name' },
  });
  return data?.data || [];
}

/**
 * Create a new, empty product catalog under a Business Manager account.
 */
async function createCatalog({ accessToken, businessId, name }) {
  return request('POST', `${encodeURIComponent(businessId)}/owned_product_catalogs`, {
    accessToken,
    body: { name },
  });
}

/**
 * Associate an existing catalog with a WhatsApp Business Account so it can
 * be used for WhatsApp catalog messaging/commerce.
 */
async function associateCatalogWithWaba({ accessToken, wabaId, catalogId }) {
  return request('POST', `${encodeURIComponent(wabaId)}/product_catalogs`, {
    accessToken,
    body: { catalog_id: catalogId },
  });
}

/**
 * Remove a catalog's association with a WhatsApp Business Account. Does
 * NOT delete the catalog or its items — only unlinks it from this WABA.
 */
async function dissociateCatalogFromWaba({ accessToken, wabaId, catalogId }) {
  return request('DELETE', `${encodeURIComponent(wabaId)}/product_catalogs`, {
    accessToken,
    query: { catalog_id: catalogId },
  });
}

/**
 * Map one AK Chat product row to a Meta Commerce Catalog item. `availability`
 * defaults to 'in stock' for active products; callers pass 'out of stock'
 * for archived products (see metaCatalogSyncService.js) — Meta Catalog has
 * no per-item hard-delete semantics that are safe for routine archiving, so
 * "out of stock" is the reversible, non-destructive default.
 */
function toCatalogItem(product, { availability } = {}) {
  return {
    retailer_id: product.retailer_id || product.sku || String(product.id),
    name: product.name,
    description: product.description || '',
    price: product.price != null ? Math.round(Number(product.price) * 100) : undefined,
    currency: product.currency || undefined,
    url: product.product_url || undefined,
    image_url: product.image_url || undefined,
    availability: availability || (product.status === 'archived' ? 'out of stock' : 'in stock'),
  };
}

/**
 * Batch-upsert items into a catalog using Meta's items_batch endpoint.
 * `items` is an array of { retailer_id, ...fields }. Each entry becomes an
 * UPDATE request, which Meta treats as an upsert (creates the item if
 * retailer_id doesn't exist yet) — this is what makes retailer_id the
 * idempotency key on the Meta side, mirroring meta_product_id/retailer_id
 * as the idempotency key on the AK Chat side.
 */
async function upsertCatalogItems({ accessToken, catalogId, items }) {
  const requests = items.map((item) => ({
    method: 'UPDATE',
    retailer_id: item.retailer_id,
    data: item,
  }));
  return request('POST', `${encodeURIComponent(catalogId)}/items_batch`, {
    accessToken,
    body: { requests, item_type: 'PRODUCT_ITEM' },
  });
}

/**
 * Mark a single catalog item out of stock (the safe, reversible equivalent
 * of "removing" a product without a hard delete). Used when an AK Chat
 * product is archived.
 */
async function markItemOutOfStock({ accessToken, catalogId, retailerId }) {
  return upsertCatalogItems({
    accessToken,
    catalogId,
    items: [{ retailer_id: retailerId, availability: 'out of stock' }],
  });
}

/**
 * Hard-delete a single catalog item. NOT called by the routine archive
 * flow (see metaCatalogSyncService.js) — reserved for an explicit,
 * caller-initiated delete action only.
 */
async function deleteCatalogItem({ accessToken, catalogId, retailerId }) {
  const requests = [{ method: 'DELETE', retailer_id: retailerId }];
  return request('POST', `${encodeURIComponent(catalogId)}/items_batch`, {
    accessToken,
    body: { requests, item_type: 'PRODUCT_ITEM' },
  });
}
module.exports = {
  listOwnedCatalogs,
  listWabaCatalogs,
  createCatalog,
  associateCatalogWithWaba,
  dissociateCatalogFromWaba,
  toCatalogItem,
  upsertCatalogItems,
  markItemOutOfStock,
  deleteCatalogItem,
};