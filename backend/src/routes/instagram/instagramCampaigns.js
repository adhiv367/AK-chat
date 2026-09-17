const express = require('express');
const pool = require('../../db');
const router = express.Router();

// Scoped by req.workspace.id (see index.js attachWorkspace). The previous
// ?accountId= query param was never sent by the frontend and, when absent,
// matched every campaign across every workspace — never trust it.
router.get('/instagram/campaigns', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) return res.json([]);
    const { rows } = await pool.query(
      `SELECT *
       FROM coexistence.instagram_campaigns
       WHERE workspace_id = $1
       ORDER BY created_at DESC`,
      [workspaceId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[instagram/campaigns]', err.message);
    res.status(500).json({ error: 'Failed to load campaigns' });
  }
});

router.post('/instagram/campaigns', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) return res.status(409).json({ error: 'No workspace found for this account. Please contact support.' });
    const { name, scheduledAt } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO coexistence.instagram_campaigns (name, scheduled_at, workspace_id) VALUES ($1, $2, $3) RETURNING *`,
      [name, scheduledAt || null, workspaceId]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[instagram/campaigns:create]', err.message);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
});

module.exports = { router };
