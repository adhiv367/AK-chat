// Phase 7.7 — Cart: order service.
//
// PRODUCT PRINCIPLE: generic, multi-tenant SaaS code — no hardcoded
// tenant/catalog/product id anywhere in this file. Every function requires
// a `workspaceId` and every query/write is scoped to it, same isolation
// model as cartService.js/productService.js.
//
// Two ways an order gets created, both funnelled through
// createOrderRecord() below so there's exactly one place that writes
// coexistence.orders/order_items:
//
//   1. checkout() — an agent converts an existing cart (built via the
//      chat "Add to cart" action) into an order. source = 'manual'.
//   2. createOrderFromWhatsappMessage() — a customer sends WhatsApp's own
//      native "Send Cart"/order message from a catalog (Meta webhook
//      `messages[].type === 'order'`). source = 'whatsapp'. Called from
//      routes/webhook.js.
//
// order_items ALWAYS snapshots product_name/sku/unit_price/total_price at
// creation time (per commerceSchema.js's own comment: "an order line must
// keep showing what the customer actually bought even if the
// product/variant is later renamed, re-SKU'd, or deleted") — never a live
// join back to coexistence.products for display.

'use strict';

const pool = require('../db');
const { ORDER_STATUSES, ORDER_PAYMENT_STATUSES, ORDER_FULFILLMENT_STATUSES, ORDER_SOURCES } = require('../db/commerceSchema');
const productService = require('./productService');
const cartService = require('./cartService');
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

// Phase 7.10A — FIX 4/5, order side: same ownership check as
// cartService.assertAccountOwnership(), reused here so an order-listing
// whatsappAccountId filter can never be used to probe/leak another
// workspace's account or orders.
async function assertAccountOwnership(workspaceId, whatsappAccountId) {
  if (whatsappAccountId == null || whatsappAccountId === '') return null;
  const account = await getAccountWithToken(whatsappAccountId, workspaceId);
  if (!account) {
    throw new ValidationError('whatsappAccountId does not belong to this workspace');
  }
  return account.id;
}

// order_number is a short, human-facing counter — NOT the DB primary key
// and not used for idempotency (external_order_id/shopify_order_id own
// that). Timestamp-based so it never collides without needing a separate
// per-workspace sequence table.
function generateOrderNumber() {
  return `WA-${Date.now().toString(36).toUpperCase()}`;
}

// Shared insert used by both checkout() and createOrderFromWhatsappMessage().
// `items` is an array of { productId, variantId, productName, sku,
// quantity, unitPrice } — already resolved/snapshotted by the caller so
// this function only ever writes, never looks anything up itself (keeps
// the two very different "where did these items come from" call sites
// from having to share a lookup strategy).
//
// Phase 7.10A — FIX 3: `waMessageId` (null for checkout()'s manual/agent
// carts) is the idempotency key for WhatsApp-native order ingestion. The
// INSERT targets the partial unique index on (workspace_id, wa_message_id)
// with ON CONFLICT ... DO NOTHING: if a redelivered webhook races this same
// call concurrently, Postgres serializes the two inserts against that
// index itself (the second one blocks until the first commits, then sees
// the conflict) — this is NOT an application-level SELECT-then-INSERT race.
// On conflict, no row is returned, so the caller's existing order is
// fetched and returned instead, and order_items are never inserted a
// second time. Returns { order, isNew } — isNew is always true for
// checkout() since waMessageId is always null there and null never
// conflicts (Postgres unique indexes never treat two NULLs as equal, and
// the index is additionally scoped to WHERE wa_message_id IS NOT NULL).
async function createOrderRecord(client, workspaceId, {
  whatsappAccountId = null,
  contactNumber,
  cartId = null,
  source = 'manual',
  externalOrderId = null,
  waMessageId = null,
  currency = null,
  items,
}) {
  if (!items || items.length === 0) {
    throw new ValidationError('Cannot create an order with no items');
  }

  const subtotal = items.reduce((sum, it) => sum + (Number(it.unitPrice) || 0) * (Number(it.quantity) || 0), 0);

  const { rows } = await client.query(
    `INSERT INTO coexistence.orders
        (workspace_id, whatsapp_account_id, contact_number, cart_id, external_order_id,
         wa_message_id, order_number, currency, subtotal, total_amount, payment_status,
         fulfillment_status, order_status, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,'pending','unfulfilled','open',$10)
     ON CONFLICT (workspace_id, wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [workspaceId, whatsappAccountId, contactNumber, cartId, externalOrderId,
      waMessageId, generateOrderNumber(), currency, subtotal, source]
  );

  if (rows.length === 0) {
    // Conflict: another (already-committed) call already created the order
    // for this workspace + wa_message_id. Fetch and reuse it rather than
    // creating a duplicate order or duplicate order_items.
    const { rows: existingRows } = await client.query(
      `SELECT * FROM coexistence.orders WHERE workspace_id = $1 AND wa_message_id = $2`,
      [workspaceId, waMessageId]
    );
    return { order: existingRows[0] || null, isNew: false };
  }

  const order = rows[0];

  for (const it of items) {
    const quantity = Number(it.quantity) || 0;
    const unitPrice = Number(it.unitPrice) || 0;
    await client.query(
      `INSERT INTO coexistence.order_items
          (order_id, product_id, variant_id, product_name, sku, quantity, unit_price, total_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [order.id, it.productId || null, it.variantId || null, it.productName, it.sku || null,
        quantity, unitPrice, quantity * unitPrice]
    );
  }

  return { order, isNew: true };
}

async function getOrderWithItems(workspaceId, orderId) {
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.orders WHERE id = $1 AND workspace_id = $2`,
    [orderId, workspaceId]
  );
  if (rows.length === 0) throw new NotFoundError('Order not found');
  const order = rows[0];

  const { rows: items } = await pool.query(
    `SELECT * FROM coexistence.order_items WHERE order_id = $1 ORDER BY created_at ASC`,
    [orderId]
  );
  return { ...order, items };
}

async function getOrder(workspaceId, orderId) {
  requireWorkspaceId(workspaceId);
  if (!orderId) throw new ValidationError('orderId is required');
  return getOrderWithItems(workspaceId, orderId);
}

// Phase 7.8 — Orders: status updates.
//
// Generic, multi-tenant: every update is scoped by (id, workspace_id) in
// the same WHERE-clause pattern getOrderWithItems() already uses, so a
// caller can never touch another workspace's order regardless of what id
// it passes. Only the three status columns are mutable here — everything
// else about an order (items, contact, totals) is set once at creation
// (checkout()/createOrderFromWhatsappMessage()) and is intentionally not
// editable via this path. No inventory/notification/audit-log side effects
// are triggered by this function (deliberately out of scope for Phase 7.8 —
// see routes/orders.js's own comment).
async function updateOrderStatus(workspaceId, orderId, updates = {}) {
  requireWorkspaceId(workspaceId);
  if (!orderId) throw new ValidationError('orderId is required');

  const { orderStatus, paymentStatus, fulfillmentStatus } = updates;
  if (orderStatus === undefined && paymentStatus === undefined && fulfillmentStatus === undefined) {
    throw new ValidationError('At least one of orderStatus, paymentStatus, fulfillmentStatus is required');
  }
  if (orderStatus !== undefined && !ORDER_STATUSES.includes(orderStatus)) {
    throw new ValidationError(`Invalid orderStatus. Must be one of: ${ORDER_STATUSES.join(', ')}`);
  }
  if (paymentStatus !== undefined && !ORDER_PAYMENT_STATUSES.includes(paymentStatus)) {
    throw new ValidationError(`Invalid paymentStatus. Must be one of: ${ORDER_PAYMENT_STATUSES.join(', ')}`);
  }
  if (fulfillmentStatus !== undefined && !ORDER_FULFILLMENT_STATUSES.includes(fulfillmentStatus)) {
    throw new ValidationError(`Invalid fulfillmentStatus. Must be one of: ${ORDER_FULFILLMENT_STATUSES.join(', ')}`);
  }

  const sets = [];
  const params = [];
  if (orderStatus !== undefined) {
    params.push(orderStatus);
    sets.push(`order_status = $${params.length}`);
  }
  if (paymentStatus !== undefined) {
    params.push(paymentStatus);
    sets.push(`payment_status = $${params.length}`);
  }
  if (fulfillmentStatus !== undefined) {
    params.push(fulfillmentStatus);
    sets.push(`fulfillment_status = $${params.length}`);
  }
  sets.push(`updated_at = NOW()`);

  params.push(orderId, workspaceId);
  const { rows } = await pool.query(
    `UPDATE coexistence.orders SET ${sets.join(', ')}
      WHERE id = $${params.length - 1} AND workspace_id = $${params.length}
      RETURNING *`,
    params
  );
  if (rows.length === 0) throw new NotFoundError('Order not found');

  return getOrderWithItems(workspaceId, orderId);
}

// cancelOrder: a thin, explicit convenience wrapper over
// updateOrderStatus() for the common "cancel this order" action — sets
// order_status to 'cancelled' only, leaving payment/fulfillment status
// untouched (a refund or restock is a separate, deliberate action outside
// Phase 7.8's scope, not implied by cancellation).
async function cancelOrder(workspaceId, orderId) {
  if (!ORDER_STATUSES.includes('cancelled')) {
    throw new ValidationError(`'cancelled' is not a valid order status`);
  }
  return updateOrderStatus(workspaceId, orderId, { orderStatus: 'cancelled' });
}

async function listOrders(workspaceId, opts = {}) {
  requireWorkspaceId(workspaceId);
  const { contactNumber, orderStatus, paymentStatus, source, whatsappAccountId, page, pageSize } = opts;

  if (orderStatus && !ORDER_STATUSES.includes(orderStatus)) {
    throw new ValidationError(`Invalid orderStatus. Must be one of: ${ORDER_STATUSES.join(', ')}`);
  }
  if (paymentStatus && !ORDER_PAYMENT_STATUSES.includes(paymentStatus)) {
    throw new ValidationError(`Invalid paymentStatus. Must be one of: ${ORDER_PAYMENT_STATUSES.join(', ')}`);
  }
  if (source && !ORDER_SOURCES.includes(source)) {
    throw new ValidationError(`Invalid source. Must be one of: ${ORDER_SOURCES.join(', ')}`);
  }

  // FIX 5 — optional whatsappAccountId filter, alongside contactNumber.
  // Existing callers that only pass contactNumber are unaffected.
  const validatedAccountId = await assertAccountOwnership(workspaceId, whatsappAccountId);

  const where = ['workspace_id = $1'];
  const params = [workspaceId];

  if (contactNumber) {
    params.push(String(contactNumber).trim());
    where.push(`contact_number = $${params.length}`);
  }
  if (orderStatus) {
    params.push(orderStatus);
    where.push(`order_status = $${params.length}`);
  }
  if (paymentStatus) {
    params.push(paymentStatus);
    where.push(`payment_status = $${params.length}`);
  }
  if (source) {
    params.push(source);
    where.push(`source = $${params.length}`);
  }
  if (validatedAccountId != null) {
    params.push(validatedAccountId);
    where.push(`whatsapp_account_id = $${params.length}`);
  }

  const pageNum = Number.isFinite(parseInt(page, 10)) && parseInt(page, 10) > 0 ? parseInt(page, 10) : 1;
  const size = Math.min(Number.isFinite(parseInt(pageSize, 10)) && parseInt(pageSize, 10) > 0 ? parseInt(pageSize, 10) : 20, 100);
  const offset = (pageNum - 1) * size;

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM coexistence.orders WHERE ${where.join(' AND ')}`,
    params
  );

  params.push(size, offset);
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.orders WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return { items: rows, total: countRows[0]?.count || 0, page: pageNum, pageSize: size };
}

// Converts an active cart into an order. The cart's own items (already
// workspace-scoped, since cartService.getCart already enforces that) are
// snapshotted into order_items, the cart is marked 'converted', and the
// order links back via cart_id — never the reverse (a cart never gains an
// order_id column; commerceSchema.js's orders.cart_id is the only FK
// between the two).
async function checkout(workspaceId, cartId, { shipping = {} } = {}) {
  requireWorkspaceId(workspaceId);
  const cart = await cartService.getCart(workspaceId, cartId);
  if (cart.status !== 'active') {
    throw new ValidationError(`Cannot check out a ${cart.status} cart`);
  }
  if (!cart.items || cart.items.length === 0) {
    throw new ValidationError('Cannot check out an empty cart');
  }

  const items = cart.items.map((it) => ({
    productId: it.product_id,
    variantId: it.variant_id,
    productName: it.variant_title ? `${it.product_name} — ${it.variant_title}` : (it.product_name || 'Product'),
    sku: it.variant_sku || it.product_sku || null,
    quantity: it.quantity,
    unitPrice: it.unit_price,
  }));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { order } = await createOrderRecord(client, workspaceId, {
      whatsappAccountId: cart.whatsapp_account_id,
      contactNumber: cart.contact_number,
      cartId: cart.id,
      source: 'manual',
      currency: cart.currency,
      items,
    });
    if (shipping && Object.keys(shipping).length > 0) {
      await client.query(
        `UPDATE coexistence.orders
            SET shipping_name = $1, shipping_address = $2, shipping_city = $3,
                shipping_state = $4, shipping_postal_code = $5, shipping_country = $6,
                shipping_phone = $7
          WHERE id = $8`,
        [shipping.name || null, shipping.address || null, shipping.city || null,
          shipping.state || null, shipping.postalCode || null, shipping.country || null,
          shipping.phone || null, order.id]
      );
    }
    await client.query('COMMIT');

    await cartService.markConverted(workspaceId, cartId);
    return getOrderWithItems(workspaceId, order.id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
// Phase 7.7 — WhatsApp-native cart/order ingestion. Called from
// routes/webhook.js when an incoming message has `type === 'order'`.
// `waOrder` is Meta's own payload shape:
//   { catalog_id, product_items: [{ product_retailer_id, quantity, item_price, currency }], text }
//
// Each line item is matched against THIS WORKSPACE's own catalog by
// retailer_id via productService.findProductByExternalId — the same
// identifier resolution services/whatsappProductMessage.js already uses
// for outbound product messages (see its resolveRetailerId()), so an
// inbound cart line and an outbound "send this product" message always
// agree on which internal product a given retailer_id maps to. A line
// item whose retailer_id doesn't match any product in this workspace's
// catalog is NOT dropped — it's still recorded on the order (product_id
// left NULL) using WhatsApp's own price/quantity, with a fallback
// product_name, since the customer still expects to see what they
// ordered even if the catalog since changed.
//
// external_order_id is deliberately left null — Meta's "order" message
// carries no order id of its own (unlike a Shopify webhook), only a
// catalog id and line items, so there's nothing to dedupe against beyond
// the underlying chat_history.message_id already deduped by
// routes/webhook.js's own ON CONFLICT (message_id) upsert.
async function createOrderFromWhatsappMessage(workspaceId, { whatsappAccountId, contactNumber, waOrder, waMessageId = null }) {
  requireWorkspaceId(workspaceId);
  if (!contactNumber) throw new ValidationError('contactNumber is required');
  const productItems = Array.isArray(waOrder?.product_items) ? waOrder.product_items : [];
  if (productItems.length === 0) {
    throw new ValidationError('WhatsApp order message has no product_items');
  }

  let currency = null;
  const items = [];
  for (const line of productItems) {
    const retailerId = line.product_retailer_id ? String(line.product_retailer_id) : null;
    const quantity = Number(line.quantity) || 1;
    const waUnitPrice = line.item_price != null ? Number(line.item_price) : 0;
    if (line.currency && !currency) currency = line.currency;

    let product = null;
    if (retailerId) {
      try {
        product = await productService.findProductByExternalId(workspaceId, { retailerId });
      } catch (err) {
        if (!(err instanceof productService.NotFoundError)) throw err;
      }
    }

    items.push({
      productId: product ? product.id : null,
      variantId: null,
      productName: product ? product.name : `Product ${retailerId || ''}`.trim(),
      sku: product ? product.sku : null,
      quantity,
      // Prefer the WhatsApp-supplied price for this line (what the
      // customer actually saw/agreed to at send time); fall back to the
      // catalog's current price only when Meta didn't send one.
      unitPrice: waUnitPrice || (product && product.price != null ? Number(product.price) : 0),
    });
  }
  // If the contact has an open cart with this WhatsApp account, link the
  // resulting order back to it and mark it converted — same relationship
  // checkout() creates for an agent-built cart. A WhatsApp-native order
  // does not require a pre-existing cart to have been built in this app,
  // so this is best-effort (cartId stays null if there isn't one).
  let cart = null;
  try {
    const { rows: activeCarts } = await pool.query(
      `SELECT id FROM coexistence.carts
        WHERE workspace_id = $1 AND contact_number = $2 AND status = 'active'
          AND whatsapp_account_id IS NOT DISTINCT FROM $3
        ORDER BY created_at DESC LIMIT 1`,
      [workspaceId, contactNumber, whatsappAccountId || null]
    );
    if (activeCarts.length > 0) cart = activeCarts[0];
  } catch (err) {
    // Best-effort linkage only — never block order creation on this lookup.
    console.error('[orderService] active-cart lookup for WhatsApp order failed:', err.message);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { order, isNew } = await createOrderRecord(client, workspaceId, {
      whatsappAccountId: whatsappAccountId || null,
      contactNumber,
      cartId: cart ? cart.id : null,
      source: 'whatsapp',
      currency,
      waMessageId,
      items,
    });
    await client.query('COMMIT');

    // A redelivered webhook for the same message_id reuses the order
    // created the first time — order_items and the cart-conversion below
    // only ever happen once, on the original (isNew) call.
    if (isNew && cart) {
      await cartService.markConverted(workspaceId, cart.id);
    }
    return getOrderWithItems(workspaceId, order.id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
module.exports = {
  ValidationError,
  NotFoundError,
  getOrder,
  listOrders,
  checkout,
  createOrderFromWhatsappMessage,
  updateOrderStatus,
  cancelOrder,
};

