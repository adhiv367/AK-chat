const express = require('express');
const pool = require('../../db');
const router = express.Router();

router.get('/instagram/settings', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.instagram_settings ORDER BY id DESC LIMIT 1`
    );
    res.json(rows[0] || null);
  } catch (err) {
    console.error('[instagram/settings]', err.message);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

router.post('/instagram/settings', async (req, res) => {
  try {
    const { pageId, businessAccountId, accessToken, webhookUrl, verifyToken, appSecret } = req.body;
    const existing = await pool.query(`SELECT id FROM coexistence.instagram_settings ORDER BY id DESC LIMIT 1`);
    let rows;
    if (existing.rows.length) {
      ({ rows } = await pool.query(
        `UPDATE coexistence.instagram_settings
         SET page_id=$1, business_account_id=$2, access_token=$3, webhook_url=$4, verify_token=$5, app_secret=$6, updated_at=NOW()
         WHERE id=$7 RETURNING *`,
        [pageId, businessAccountId, accessToken, webhookUrl, verifyToken, appSecret, existing.rows[0].id]
      ));
    } else {
      ({ rows } = await pool.query(
        `INSERT INTO coexistence.instagram_settings (page_id, business_account_id, access_token, webhook_url, verify_token, app_secret)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [pageId, businessAccountId, accessToken, webhookUrl, verifyToken, appSecret]
      ));
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('[instagram/settings:save]', err.message);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

module.exports = { router };