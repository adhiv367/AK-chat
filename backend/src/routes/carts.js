// Phase 7.7 — Cart: routes.
//
// Every route derives workspaceId from req.workspace (set server-side by
// middleware/workspaceContext.js's attachWorkspace, mounted ahead of this
// router in index.js) — never from req.body/req.query/req.params. Same
// pattern as routes/products.js.
//
// Gated by requirePermission('chats') — a cart is built/edited from
// inside the Chat window (see ChatWindow.jsx's Cart button/CartPanel), so
// it uses the same page permission chat sending already requires, rather
// than introducing a separate 'cart' page key nobody would navigate to
// directly. Orders (routes/orders.js) get their own page + permission
// key because Orders IS a standalone page.

const { Router } = require('express');
const { requirePermission } = require('../middleware/access');
const cartService = require('../services/cartService');
const orderService = require('../services/orderService');

const router = Router();

function handleError(res, err, fallbackMessage) {
  if (err.status === 400 || err instanceof cartService.ValidationError || err instanceof orderService.ValidationError) {
    return res.status(400).json({ error: err.message });
  }
  if (err.status === 404 || err instanceof cartService.NotFoundError || err instanceof orderService.NotFoundError) {
    return res.status(404).json({ error: err.message });
  }
  console.error(`[carts] ${fallbackMessage}:`, err.message);
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

const gate = requirePermission('chats');

// GET /api/carts?contactNumber=&status=&whatsappAccountId=
router.get('/carts', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const { contactNumber, status, whatsappAccountId } = req.query;
    const carts = await cartService.listCarts(workspaceId, { contactNumber, status, whatsappAccountId });
    res.json({ items: carts });
  } catch (err) {
    handleError(res, err, 'Failed to list carts');
  }
});

// GET /api/carts/active?contactNumber=&whatsappAccountId=
// Get-or-create the caller's one active cart for a contact — the entry
// point ChatWindow.jsx's CartPanel uses so it never has to track/store a
// cart id itself between chat sessions.
router.get('/carts/active', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const { contactNumber, whatsappAccountId } = req.query;
    const cart = await cartService.getOrCreateActiveCart(workspaceId, {
      contactNumber,
      whatsappAccountId: whatsappAccountId || null,
    });
    res.json(cart);
  } catch (err) {
    handleError(res, err, 'Failed to load active cart');
  }
});

// GET /api/carts/:id
router.get('/carts/:id', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const cart = await cartService.getCart(workspaceId, req.params.id);
    res.json(cart);
  } catch (err) {
    handleError(res, err, 'Failed to load cart');
  }
});

// POST /api/carts/:id/items  { productId, variantId?, quantity? }
router.post('/carts/:id/items', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const { productId, variantId, quantity } = req.body || {};
    const cart = await cartService.addItem(workspaceId, req.params.id, { productId, variantId, quantity });
    res.status(201).json(cart);
  } catch (err) {
    handleError(res, err, 'Failed to add item to cart');
  }
});

// PUT /api/carts/:id/items/:itemId  { quantity }
router.put('/carts/:id/items/:itemId', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const { quantity } = req.body || {};
    const cart = await cartService.updateItemQuantity(workspaceId, req.params.id, req.params.itemId, quantity);
    res.json(cart);
  } catch (err) {
    handleError(res, err, 'Failed to update cart item');
  }
});

// DELETE /api/carts/:id/items/:itemId
router.delete('/carts/:id/items/:itemId', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const cart = await cartService.removeItem(workspaceId, req.params.id, req.params.itemId);
    res.json(cart);
  } catch (err) {
    handleError(res, err, 'Failed to remove cart item');
  }
});

// DELETE /api/carts/:id  — clears all items (cart itself stays active)
router.delete('/carts/:id', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const cart = await cartService.clearCart(workspaceId, req.params.id);
    res.json(cart);
  } catch (err) {
    handleError(res, err, 'Failed to clear cart');
  }
});

// POST /api/carts/:id/cancel
router.post('/carts/:id/cancel', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const cart = await cartService.cancelCart(workspaceId, req.params.id);
    if (!cart) return res.status(404).json({ error: 'Cart not found' });
    res.json(cart);
  } catch (err) {
    handleError(res, err, 'Failed to cancel cart');
  }
});

// POST /api/carts/:id/checkout  { shipping? }
// Converts the cart into an order (coexistence.orders + order_items) and
// marks the cart 'converted'. Reuses orderService.checkout() — this route
// exists here (not only in routes/orders.js) so agents can go straight
// from the Cart panel to "Create order" without also needing the Orders
// page's own permission.
router.post('/carts/:id/checkout', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const { shipping } = req.body || {};
    const order = await orderService.checkout(workspaceId, req.params.id, { shipping });
    res.status(201).json(order);
  } catch (err) {
    handleError(res, err, 'Failed to check out cart');
  }
});

module.exports = { router };
