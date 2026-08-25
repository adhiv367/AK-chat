const express = require('express');
const pool = require('../../db');
const router = express.Router();

router.get('/instagram/templates', async (req, res) => {
  try {
    const { rows } = await pool.query(
    `SELECT *
     FROM coexistence.instagram_templates
     WHERE ($1::bigint IS NULL OR instagram_account_id = $1)
     ORDER BY created_at DESC`,
    [req.query.accountId || null]
);
    res.json(rows);
  } catch (err) {
    console.error('[instagram/templates]', err.message);
    res.status(500).json({ error: 'Failed to load templates' });
  }
});

router.post('/instagram/templates', async (req, res) => {
  try {
    const { title, shortcut, message, category } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO coexistence.instagram_templates (title, shortcut, message, category)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [title, shortcut, message, category]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[instagram/templates:create]', err.message);
    res.status(500).json({ error: 'Failed to save template' });
  }
});

router.put('/instagram/templates/:id', async (req, res) => {
  try {
    const { title, shortcut, message, category } = req.body;
    const { rows } = await pool.query(
      `UPDATE coexistence.instagram_templates
       SET title=$1, shortcut=$2, message=$3, category=$4, updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [title, shortcut, message, category, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[instagram/templates:update]', err.message);
    res.status(500).json({ error: 'Failed to update template' });
  }
});

router.delete('/instagram/templates/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM coexistence.instagram_templates WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[instagram/templates:delete]', err.message);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

module.exports = { router };