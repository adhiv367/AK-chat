// Phase 7.7 — Cart: order routes.
//
// Every route derives workspaceId from req.workspace (set server-side by
// middleware/workspaceContext.js's attachWorkspace) — never from
// req.body/req.query/req.params. Same pattern as routes/products.js and
// routes/carts.js.
//
// Gated by requirePermission('orders') — Orders is its own page (see
// frontend/src/pages/OrdersPage.jsx, App.jsx, Sidebar.jsx), distinct from
// the Cart panel embedded in Chat, so it gets its own permission page key
// (backend/src/permissions.js) rather than reusing 'chats'/'products'.

const { Router } = require('express');
const { requirePermission } = require('../middleware/access');
const orderService = require('../services/orderService');

const router = Router();

function handleError(res, err, fallbackMessage) {
  if (err.status === 400 || err instanceof orderService.ValidationError) {
    return res.status(400).json({ error: err.message });
  }
  if (err.status === 404 || err instanceof orderService.NotFoundError) {
    return res.status(404).json({ error: err.message });
  }
  console.error(`[orders] ${fallbackMessage}:`, err.message);
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

const gate = requirePermission('orders');

// GET /api/orders?contactNumber=&orderStatus=&paymentStatus=&source=&whatsappAccountId=&page=&pageSize=
router.get('/orders', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const { contactNumber, orderStatus, paymentStatus, source, whatsappAccountId, page, pageSize } = req.query;
    const result = await orderService.listOrders(workspaceId, {
      contactNumber, orderStatus, paymentStatus, source, whatsappAccountId, page, pageSize,
    });
    res.json(result);
  } catch (err) {
    handleError(res, err, 'Failed to list orders');
  }
});

// GET /api/orders/:id
router.get('/orders/:id', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const order = await orderService.getOrder(workspaceId, req.params.id);
    res.json(order);
  } catch (err) {
    handleError(res, err, 'Failed to load order');
  }
});

// PATCH /api/orders/:id — Phase 7.8. Status-only update: order_status,
// payment_status, fulfillment_status. Same 'orders' permission gate as the
// read routes above (no separate write-permission tier exists yet — see
// Phase 7.8 audit). Deliberately does NOT touch items/contact/totals,
// inventory, or send any WhatsApp notification — those stay out of scope
// here (see orderService.updateOrderStatus's own comment).
router.patch('/orders/:id', gate, async (req, res) => {
  const workspaceId = getWorkspaceId(req, res);
  if (!workspaceId) return;
  try {
    const { orderStatus, paymentStatus, fulfillmentStatus } = req.body || {};
    const order = await orderService.updateOrderStatus(workspaceId, req.params.id, {
      orderStatus, paymentStatus, fulfillmentStatus,
    });
    res.json(order);
  } catch (err) {
    handleError(res, err, 'Failed to update order');
  }
});

module.exports = { router };