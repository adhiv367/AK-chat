// src/routes/internal.js
//
// Internal, server-to-server endpoints called by the Python bot
// (ai_bridge_phase2.py), never by a browser. Mounted in index.js
// BEFORE authMiddleware (same pattern as webhookRouter /
// billingWebhookRouter) because there is no AKChat session cookie here —
// protection is a shared secret instead (see requireInternalSecret).
//
// POST /internal/prepare-followup
//   Creates a DRAFT broadcast for manual review (never sends
//   automatically — a human must click Send in the Broadcast UI).
//   Body: { customer_number, template_id, name, variable_mapping }

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { resolveAccount } = require('../services/messageSender');

// ─── Shared-secret guard ────────────────────────────────────────────────
// Set INTERNAL_API_SECRET in both the Node backend's and the Python bot's
// environment (Render → Environment tab, both services). The Python side
// must send it as `X-Internal-Secret` on every call to these routes.
function requireInternalSecret(req, res, next) {
  const expected = process.env.INTERNAL_API_SECRET;
  if (!expected) {
    console.error('[internal] INTERNAL_API_SECRET is not set — refusing internal request');
    return res.status(500).json({ error: 'Internal auth not configured' });
  }
  const provided = req.get('X-Internal-Secret');
  if (provided !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(requireInternalSecret);

// POST /internal/prepare-followup
router.post('/internal/prepare-followup', async (req, res) => {
  try {
    const { customer_number, template_id, name, variable_mapping } = req.body;

    if (!customer_number || !template_id) {
      return res.status(400).json({ error: 'customer_number and template_id are required' });
    }

    const { rows: tplRows } = await pool.query(
      'SELECT * FROM coexistence.message_templates WHERE id = $1',
      [template_id]
    );
    if (tplRows.length === 0) {
      return res.status(404).json({ error: `Template ${template_id} not found` });
    }
    const tpl = tplRows[0];
    const workspaceId = tpl.workspace_id;

    const { account, error: accErr } = await resolveAccount({
      accountId: tpl.whatsapp_account_id || null,
      workspaceId,
    });
    if (accErr) {
      return res.status(400).json({ error: accErr });
    }

    const { rows } = await pool.query(
      `INSERT INTO coexistence.broadcasts
         (workspace_id, from_number, recipient_numbers, template_id, status,
          test_number, name, variable_mapping, message_type, body, url,
          media_library_id, caption, scheduled_at, updated_at)
       VALUES ($1, $2, $3, $4, 'DRAFT', NULL, $5, $6, 'template', NULL, NULL,
               NULL, NULL, NULL, NOW())
       RETURNING id`,
      [
        workspaceId,
        account.displayPhoneNumber,
        JSON.stringify([customer_number]),
        template_id,
        name || null,
        JSON.stringify(variable_mapping || {}),
      ]
    );

    return res.status(200).json({ status: 'draft_created', broadcast_id: rows[0].id });
  } catch (err) {
    console.error('[internal] prepare-followup error:', err.message);
    return res.status(500).json({ error: 'Failed to create draft broadcast' });
  }
});

module.exports = { router };