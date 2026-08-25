const express = require('express');
const pool = require('../../db');
const router = express.Router();

router.get('/instagram/contacts', async (req, res) => {
  try {
    const { rows } = await pool.query(
    `SELECT *
     FROM coexistence.instagram_contacts
     WHERE ($1::bigint IS NULL OR instagram_account_id = $1)
     ORDER BY created_at DESC`,
    [req.query.accountId || null]
);
    res.json(rows);
  } catch (err) {
    console.error('[instagram/contacts]', err.message);
    res.status(500).json({ error: 'Failed to load contacts' });
  }
});

router.post('/instagram/contacts', async (req, res) => {
  try {
    const { igUserId, username, displayName, profilePicture } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO coexistence.instagram_contacts (ig_user_id, username, display_name, profile_picture)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [igUserId, username, displayName, profilePicture]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[instagram/contacts:create]', err.message);
    res.status(500).json({ error: 'Failed to save contact' });
  }
});

router.delete('/instagram/contacts/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM coexistence.instagram_contacts WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[instagram/contacts:delete]', err.message);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

module.exports = { router };