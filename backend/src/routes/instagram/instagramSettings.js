const express = require('express');
const pool = require('../../db');
const { requirePermission } = require('../../middleware/access');
const router = express.Router();

// Phase 7.14B fix: these settings hold live Instagram/Meta credentials
// (access token, app secret, verify token) and were previously reachable
// by any authenticated workspace member, including VIEWER/AGENT/MANAGER.
// Gated on the same 'admin-settings:whatsapp-accounts' page key used for
// the analogous WhatsApp channel-connection settings (see
// routes/whatsappAccounts.js) — OWNER/ADMIN only, via requirePermission()'s
// existing role/permission-map architecture (no new page key added).
const manageInstagramSettings = requirePermission('admin-settings:whatsapp-accounts');

// Legacy single-row settings table, now one row per workspace (see
// instagramWorkspaceSchema.js — partial UNIQUE index on workspace_id).
router.get('/instagram/settings', manageInstagramSettings, async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) return res.json(null);
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.instagram_settings WHERE workspace_id = $1 ORDER BY id DESC LIMIT 1`,
      [workspaceId]
    );
    res.json(rows[0] || null);
  } catch (err) {
    console.error('[instagram/settings]', err.message);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

router.post('/instagram/settings', manageInstagramSettings, async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) return res.status(409).json({ error: 'No workspace found for this account. Please contact support.' });
    const { pageId, businessAccountId, accessToken, webhookUrl, verifyToken, appSecret } = req.body;
    const existing = await pool.query(
      `SELECT id FROM coexistence.instagram_settings WHERE workspace_id = $1 ORDER BY id DESC LIMIT 1`,
      [workspaceId]
    );
    let rows;
    if (existing.rows.length) {
      ({ rows } = await pool.query(
        `UPDATE coexistence.instagram_settings
         SET page_id=$1, business_account_id=$2, access_token=$3, webhook_url=$4, verify_token=$5, app_secret=$6, updated_at=NOW()
         WHERE id=$7 AND workspace_id=$8 RETURNING *`,
        [pageId, businessAccountId, accessToken, webhookUrl, verifyToken, appSecret, existing.rows[0].id, workspaceId]
      ));
    } else {
      ({ rows } = await pool.query(
        `INSERT INTO coexistence.instagram_settings (page_id, business_account_id, access_token, webhook_url, verify_token, app_secret, workspace_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [pageId, businessAccountId, accessToken, webhookUrl, verifyToken, appSecret, workspaceId]
      ));
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('[instagram/settings:save]', err.message);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

module.exports = { router };