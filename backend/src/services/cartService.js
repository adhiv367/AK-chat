// Phase 7.7 — Cart: service layer.
//
// PRODUCT PRINCIPLE: same as productService.js / metaCatalogConnectionService.js
// — this is generic, multi-tenant SaaS code. Nothing here references a
// specific customer/tenant, catalog id, or product id. Every function
// requires a `workspaceId` and every query is scoped to it — callers
// (routes/carts.js, routes/webhook.js) always derive workspaceId
// server-side (from req.workspace or from services/messageSender.js's
// resolveAccount()), never from client-supplied input.
//
// Scoped to the Phase 7.2 commerce schema (db/commerceSchema.js) only. No
// table is created, redesigned, or dropped here.
//
// Isolation model: every read filters WHERE workspace_id = $1 (carts) or
// joins back to a workspace-scoped cart (cart_items) — exactly like
// productService.js's model for products/variants. An id belonging to
// another workspace always looks like "not found", never a permission
// error that would leak its existence.
//
// contact_number (not a contact_id FK) identifies who a cart belongs to —
// this mirrors coexistence.carts/orders' own convention (see
// commerceSchema.js's comment block) and coexistence.contacts' own
// identity model. No FK is introduced here.
//
// cart_items has a real DB constraint: UNIQUE (cart_id, product_id,
// variant_id). addItem() below always upserts (INSERT ... ON CONFLICT DO
// UPDATE quantity = quantity + EXCLUDED.quantity) rather than inserting a
// second row for a product/variant already in the cart — this is required
// by that constraint, not just a style choice.

'use strict';

const pool = require('../db');
const { CART_STATUSES } = require('../db/commerceSchema');
const productService = require('./productService');
const { getAccountWithToken } = require('../routes/whatsappAccounts');

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

function requireContactNumber(contactNumber) {
  if (!contactNumber || !String(contactNumber).trim()) {
    throw new ValidationError('contactNumber is required');
  }
  return String(contactNumber).trim();
}

// Phase 7.10A — FIX 4: validate that a client-supplied whatsappAccountId
// actually belongs to the CALLER's own workspace before it's used to
// create/read/filter a cart. workspaceId here always comes from the
// authenticated request context (req.workspace.id in routes/carts.js) —
// never from the client — so this rejects a whatsappAccountId that either
// doesn't exist or belongs to a different workspace, without ever
// revealing which of those two is true (both just "not found"), same
// non-leaking 404 model the rest of this file already uses. Reuses the
// existing getAccountWithToken(accountId, workspaceId) ownership lookup
// (routes/whatsappAccounts.js) rather than a new query pattern.
async function assertAccountOwnership(workspaceId, whatsappAccountId) {
  if (whatsappAccountId == null || whatsappAccountId === '') return null;
  const account = await getAccountWithToken(whatsappAccountId, workspaceId);
  if (!account) {
    throw new ValidationError('whatsappAccountId does not belong to this workspace');
  }
  return account.id;
}

// Recomputes carts.total_amount from its cart_items — always run after any
// insert/update/delete on cart_items so the stored total never drifts from
// the line items. Kept as a small standalone query (not a trigger) so it
// stays visible/testable at the service layer, same convention as the rest
// of this codebase (no DB triggers beyond the generic touch_updated_at
// ones already defined in commerceSchema.js).
async function recalcCartTotal(cartId) {
  await pool.query(
    `UPDATE coexistence.carts
        SET total_amount = COALESCE((
          SELECT SUM(quantity * unit_price) FROM coexistence.cart_items WHERE cart_id = $1
        ), 0)
      WHERE id = $1`,
    [cartId]
  );
}

async function getCartWithItems(workspaceId, cartId) {
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.carts WHERE id = $1 AND workspace_id = $2`,
    [cartId, workspaceId]
  );
  if (rows.length === 0) throw new NotFoundError('Cart not found');
  const cart = rows[0];

  const { rows: items } = await pool.query(
    `SELECT ci.*, p.name AS product_name, p.image_url AS product_image_url,
            p.sku AS product_sku, pv.title AS variant_title, pv.sku AS variant_sku
       FROM coexistence.cart_items ci
       LEFT JOIN coexistence.products p ON p.id = ci.product_id
       LEFT JOIN coexistence.product_variants pv ON pv.id = ci.variant_id
      WHERE ci.cart_id = $1
      ORDER BY ci.created_at ASC`,
    [cartId]
  );
  return { ...cart, items };
}

// Lists carts in a workspace, optionally filtered by contact/status —
// mirrors productService.listProducts' filter-building pattern.
async function listCarts(workspaceId, opts = {}) {
  requireWorkspaceId(workspaceId);
  const { contactNumber, status, whatsappAccountId } = opts;

  if (status && !CART_STATUSES.includes(status)) {
    throw new ValidationError(`Invalid status. Must be one of: ${CART_STATUSES.join(', ')}`);
  }

  // FIX 4/5 — validate ownership before using it as a filter; existing
  // callers that only pass contactNumber are unaffected (whatsappAccountId
  // stays undefined/null -> assertAccountOwnership is a no-op below).
  const validatedAccountId = await assertAccountOwnership(workspaceId, whatsappAccountId);

  const where = ['workspace_id = $1'];
  const params = [workspaceId];

  if (contactNumber) {
    params.push(String(contactNumber).trim());
    where.push(`contact_number = $${params.length}`);
  }
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (validatedAccountId != null) {
    params.push(validatedAccountId);
    where.push(`whatsapp_account_id = $${params.length}`);
  }

  const { rows } = await pool.query(
    `SELECT * FROM coexistence.carts WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT 100`,
    params
  );
  return rows;
}

async function getCart(workspaceId, cartId) {
  requireWorkspaceId(workspaceId);
  if (!cartId) throw new ValidationError('cartId is required');
  return getCartWithItems(workspaceId, cartId);
}

// Returns the caller's single active cart for this contact (creating one
// if none exists) — the natural entry point for a chat agent's "Add to
// cart" action, which only ever needs ONE open cart per contact per
// WhatsApp account, not a cart id it has to track itself.
async function getOrCreateActiveCart(workspaceId, { whatsappAccountId = null, contactNumber } = {}) {
  requireWorkspaceId(workspaceId);
  const contact = requireContactNumber(contactNumber);
  // FIX 4 — reject a whatsappAccountId that doesn't belong to this workspace
  // before it's used to look up or create a cart.
  const validatedAccountId = await assertAccountOwnership(workspaceId, whatsappAccountId);

  const { rows: existing } = await pool.query(
    `SELECT * FROM coexistence.carts
      WHERE workspace_id = $1 AND contact_number = $2 AND status = 'active'
        AND whatsapp_account_id IS NOT DISTINCT FROM $3
      ORDER BY created_at DESC
      LIMIT 1`,
    [workspaceId, contact, validatedAccountId]
  );
  if (existing.length > 0) return getCartWithItems(workspaceId, existing[0].id);

  const { rows } = await pool.query(
    `INSERT INTO coexistence.carts (workspace_id, whatsapp_account_id, contact_number, status)
     VALUES ($1, $2, $3, 'active')
     RETURNING *`,
    [workspaceId, validatedAccountId, contact]
  );
  return getCartWithItems(workspaceId, rows[0].id);
}

async function assertCartInWorkspace(workspaceId, cartId) {
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.carts WHERE id = $1 AND workspace_id = $2`,
    [cartId, workspaceId]
  );
  if (rows.length === 0) throw new NotFoundError('Cart not found');
  return rows[0];
}

// Adds a product/variant to the cart, or increments its quantity if that
// exact (cart_id, product_id, variant_id) pair is already present —
// required by cart_items' own UNIQUE constraint (see file header). The
// unit price is snapshotted from the product/variant's CURRENT price at
// add-time (not re-read from the product on every future read) so a later
// price edit doesn't silently change an item already sitting in someone's
// cart — same "snapshot at the time of the action" principle order_items
// uses for product_name/sku.
async function addItem(workspaceId, cartId, { productId, variantId = null, quantity = 1 } = {}) {
  requireWorkspaceId(workspaceId);
  const cart = await assertCartInWorkspace(workspaceId, cartId);
  if (cart.status !== 'active') {
    throw new ValidationError(`Cannot add items to a ${cart.status} cart`);
  }
  if (!productId) throw new ValidationError('productId is required');

  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new ValidationError('quantity must be a positive number');
  }

  // Workspace-scoped product/variant lookup — productService.getProduct
  // already 404s (NotFoundError) if productId belongs to another
  // workspace, so a cross-tenant id can never be added to this cart.
  const product = await productService.getProduct(workspaceId, productId);

  let unitPrice = product.price != null ? Number(product.price) : 0;
  if (variantId) {
    const { rows: variantRows } = await pool.query(
      `SELECT * FROM coexistence.product_variants WHERE id = $1 AND product_id = $2`,
      [variantId, productId]
    );
    if (variantRows.length === 0) throw new ValidationError('variantId does not belong to this product');
    if (variantRows[0].price != null) unitPrice = Number(variantRows[0].price);
  }

  await pool.query(
    `INSERT INTO coexistence.cart_items (cart_id, product_id, variant_id, quantity, unit_price)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (cart_id, product_id, variant_id) DO UPDATE
        SET quantity = coexistence.cart_items.quantity + EXCLUDED.quantity,
            unit_price = EXCLUDED.unit_price,
            updated_at = NOW()`,
    [cartId, productId, variantId, qty, unitPrice]
  );

  if (!cart.currency && product.currency) {
    await pool.query(`UPDATE coexistence.carts SET currency = $1 WHERE id = $2`, [product.currency, cartId]);
  }

  await recalcCartTotal(cartId);
  return getCartWithItems(workspaceId, cartId);
}

// Sets (not increments) a cart item's quantity — used by the cart UI's
// quantity stepper. quantity <= 0 removes the line, same convention as
// most cart UIs (and avoids a zero-quantity row nobody can act on).
async function updateItemQuantity(workspaceId, cartId, itemId, quantity) {
  requireWorkspaceId(workspaceId);
  const cart = await assertCartInWorkspace(workspaceId, cartId);
  if (cart.status !== 'active') {
    throw new ValidationError(`Cannot modify items in a ${cart.status} cart`);
  }
  const qty = Number(quantity);
  if (!Number.isFinite(qty)) throw new ValidationError('quantity must be a number');

  const { rows } = await pool.query(
    `SELECT id FROM coexistence.cart_items WHERE id = $1 AND cart_id = $2`,
    [itemId, cartId]
  );
  if (rows.length === 0) throw new NotFoundError('Cart item not found');

  if (qty <= 0) {
    await pool.query(`DELETE FROM coexistence.cart_items WHERE id = $1`, [itemId]);
  } else {
    await pool.query(
      `UPDATE coexistence.cart_items SET quantity = $1, updated_at = NOW() WHERE id = $2`,
      [qty, itemId]
    );
  }

  await recalcCartTotal(cartId);
  return getCartWithItems(workspaceId, cartId);
}

async function removeItem(workspaceId, cartId, itemId) {
  requireWorkspaceId(workspaceId);
  const cart = await assertCartInWorkspace(workspaceId, cartId);
  if (cart.status !== 'active') {
    throw new ValidationError(`Cannot modify items in a ${cart.status} cart`);
  }
  const { rowCount } = await pool.query(
    `DELETE FROM coexistence.cart_items WHERE id = $1 AND cart_id = $2`,
    [itemId, cartId]
  );
  if (rowCount === 0) throw new NotFoundError('Cart item not found');

  await recalcCartTotal(cartId);
  return getCartWithItems(workspaceId, cartId);
}
// Clears every line item without changing the cart's status — distinct
// from cancelCart(), which also marks the cart itself 'cancelled'.
async function clearCart(workspaceId, cartId) {
  requireWorkspaceId(workspaceId);
  const cart = await assertCartInWorkspace(workspaceId, cartId);
  if (cart.status !== 'active') {
    throw new ValidationError(`Cannot modify items in a ${cart.status} cart`);
  }
  await pool.query(`DELETE FROM coexistence.cart_items WHERE cart_id = $1`, [cartId]);
  await recalcCartTotal(cartId);
  return getCartWithItems(workspaceId, cartId);
}
async function cancelCart(workspaceId, cartId) {
  requireWorkspaceId(workspaceId);
  await assertCartInWorkspace(workspaceId, cartId);
  const { rows } = await pool.query(
    `UPDATE coexistence.carts SET status = 'cancelled' WHERE id = $1 AND workspace_id = $2 RETURNING *`,
    [cartId, workspaceId]
  );
  return rows[0];
}
// Marks a cart 'converted' — called by orderService.createOrderFromCart()
// once the order + order_items rows exist. Kept here (rather than inline
// in orderService) so "what does converting a cart mean" stays owned by
// cartService, same separation productService/whatsappProductMessage.js
// already use.
async function markConverted(workspaceId, cartId) {
  const { rows } = await pool.query(
    `UPDATE coexistence.carts SET status = 'converted' WHERE id = $1 AND workspace_id = $2 RETURNING *`,
    [cartId, workspaceId]
  );
  return rows[0];
}
module.exports = {
  ValidationError,
  NotFoundError,
  listCarts,
  getCart,
  getOrCreateActiveCart,
  addItem,
  updateItemQuantity,
  removeItem,
  clearCart,
  cancelCart,
  markConverted,
  recalcCartTotal,
};