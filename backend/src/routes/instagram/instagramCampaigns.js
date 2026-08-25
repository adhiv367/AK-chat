const express = require('express');
const pool = require('../../db');
const router = express.Router();

router.get('/instagram/campaigns', async (req, res) => {
  try {
    const { rows } = await pool.query(
    `SELECT *
     FROM coexistence.instagram_campaigns
     WHERE ($1::bigint IS NULL OR instagram_account_id = $1)
     ORDER BY created_at DESC`,
    [req.query.accountId || null]
);
    res.json(rows);
  } catch (err) {
    console.error('[instagram/campaigns]', err.message);
    res.status(500).json({ error: 'Failed to load campaigns' });
  }
});

router.post('/instagram/campaigns', async (req, res) => {
  try {
    const { name, scheduledAt } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO coexistence.instagram_campaigns (name, scheduled_at) VALUES ($1, $2) RETURNING *`,
      [name, scheduledAt || null]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[instagram/campaigns:create]', err.message);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
});

module.exports = { router };

