// Phase 7.6 — Product Search / Product ID: WhatsApp product message builder.
//
// PRODUCT PRINCIPLE: same as productService.js — this is generic, multi-
// tenant SaaS code. Nothing here references a specific customer/tenant.
// Every function requires a workspaceId (and, where a WhatsApp send is
// involved, a whatsappAccountId) and every lookup is scoped to it.
//
// This module has two jobs:
//
//   1. Resolve, server-side only, the two things a WhatsApp "single
//      product" interactive message needs: the Meta catalog id linked to
//      the sending WhatsApp account (never accepted from the client) and
//      the product's retailer_id (the id Meta's catalog actually indexes
//      items by — see integrations/metaCatalog.js's toCatalogItem, which
//      this mirrors so a message always references the same identifier the
//      sync path uses).
//
//   2. Build the exact Meta `interactive` payload for a single-product
//      message (`type: 'product'`) and a catalog message
//      (`type: 'catalog_message'`). This logic previously lived inline in
//      engine/automationEngine.js's direct-message handler; it is
//      extracted here, UNCHANGED, so both the Automation Builder path and
//      the new Chat "send product" path (routes/messages.js) build the
//      identical payload instead of maintaining two copies that can drift.
//
// This module never talks to Meta's Graph API itself and never touches
// the send queue — it only resolves/validates/builds. Sending still goes
// through the existing, untouched integrations/metaSend.js `sendInteractive`
// via queue/sendQueue.js's `kind: 'interactive'` job, reached the same way
// every other interactive message already is (see messageSender.js +
// sendQueue.enqueueSend).

'use strict';

const productService = require('./productService');
const metaCatalogConnectionService = require('./metaCatalogConnectionService');

// Reuse productService's error classes rather than declaring parallel
// ones — callers (routes/messages.js, automationEngine.js) can `instanceof`
// check against a single source of truth regardless of which service
// actually threw.
const { ValidationError, NotFoundError } = productService;

/**
 * Resolve a product for messaging, scoped to the caller's workspace.
 * Accepts EITHER the product's internal id OR one of its external
 * identifiers (productId/sku/retailerId) — the Chat "send product" flow
 * uses the internal id (the agent picked a row from ProductPicker), while
 * a future free-text "search by SKU" entry point can pass the external
 * id instead. Never accepts/trusts a workspaceId from the caller's input —
 * only the workspaceId argument (always derived server-side by the route)
 * is used to scope the lookup.
 */
async function resolveProductForMessage(workspaceId, { id, productId, sku, retailerId } = {}) {
  if (id) {
    return productService.getProduct(workspaceId, id);
  }
  return productService.findProductByExternalId(workspaceId, { productId, sku, retailerId });
}

/**
 * The retailer_id a Meta catalog actually indexes this product under.
 * Mirrors integrations/metaCatalog.js's toCatalogItem() fallback chain
 * exactly (retailer_id -> sku -> internal id) so a "send this product"
 * message always references the same identifier the catalog sync path
 * would have used to create/update the item in Meta's catalog. Kept as a
 * local pure function (no dependency on metaCatalog.js, which is a Graph
 * API client, not a shared identifier helper) to avoid coupling a pure
 * SaaS product-messaging module to the Meta integration layer.
 */
function resolveRetailerId(product) {
  return product.retailer_id || product.sku || String(product.id);
}
/**
 * Resolve the Meta catalog id to send against for a given workspace +
 * WhatsApp account. ALWAYS server-side — a catalog_id is never accepted
 * from the client (see routes/messages.js), only ever resolved here from
 * coexistence.meta_catalog_connections via
 * metaCatalogConnectionService.getConnection(), which is itself scoped to
 * BOTH workspace_id and whatsapp_account_id. Throws ValidationError (not a
 * silent fallback) when no catalog is connected, since sending a product
 * message with no catalog would otherwise fail opaquely at Meta.
 */
async function resolveCatalogForAccount(workspaceId, whatsappAccountId) {
  const connection = await metaCatalogConnectionService.getConnection(workspaceId, whatsappAccountId);
  if (!connection || connection.status !== 'connected' || !connection.catalog_id) {
    throw new ValidationError('No Meta catalog is connected for this WhatsApp account. Connect one in Settings first.');
  }
  return connection.catalog_id;
}
/**
 * Build a Meta single-product interactive payload
 * (`interactive.type === 'product'`).
 *
 * Extracted verbatim from engine/automationEngine.js's `directType ===
 * 'product'` branch — same required-field check, same error message, same
 * 1024-char body truncation, same "drop the body key entirely when empty"
 * behavior (Meta tolerates a missing body for single-product but it's
 * recommended; an explicit `body: undefined` key is not the same as no key
 * at all once JSON.stringify'd downstream). Do not change this shape
 * without re-verifying both callers (automationEngine.js and
 * routes/messages.js) still produce byte-identical payloads to before this
 * extraction.
 */
function buildProductInteractive({ catalogId, productRetailerId, bodyText }) {
  if (!catalogId || !productRetailerId) {
    throw new ValidationError('automation product: catalog_id and product_retailer_id are required');
  }
  const interactive = {
    type: 'product',
    body: bodyText ? { text: String(bodyText).slice(0, 1024) } : undefined,
    action: { catalog_id: catalogId, product_retailer_id: productRetailerId },
  };
  // Meta tolerates missing body for single-product but it's recommended; drop if empty
  if (!interactive.body) delete interactive.body;
  return interactive;
}
/**
 * Build a Meta catalog-message interactive payload
 * (`interactive.type === 'catalog_message'`).
 *
 * Extracted verbatim from engine/automationEngine.js's `directType ===
 * 'catalog'` branch — same required-body check/message, same 1024-char
 * truncation, same optional `thumbnail_product_retailer_id` parameter.
 * Not used by the Phase 7.6 chat "send product" flow (single-product
 * only, per spec) — extracted alongside buildProductInteractive() purely
 * so automationEngine.js has one shared module for both instead of the
 * refactor leaving one branch inline and one extracted.
 */
function buildCatalogInteractive({ catalogId, bodyText }) {
  if (!bodyText || !String(bodyText).trim()) {
    throw new ValidationError('automation catalog: body text is required by Meta');
  }
  const interactive = {
    type: 'catalog_message',
    body: { text: String(bodyText).slice(0, 1024) },
    action: { name: 'catalog_message' },
  };
  if (catalogId) {
    interactive.action.parameters = { thumbnail_product_retailer_id: catalogId };
  }
  return interactive;
}
module.exports = {
  ValidationError,
  NotFoundError,
  resolveProductForMessage,
  resolveRetailerId,
  resolveCatalogForAccount,
  buildProductInteractive,
  buildCatalogInteractive,
};