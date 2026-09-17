const express = require('express');
const pool = require('../../db');
const router = express.Router();

// Scoped by req.workspace.id (see index.js attachWorkspace). The previous
// ?accountId= query param was never sent by the frontend and, when absent,
// matched every template across every workspace — never trust it.
router.get('/instagram/templates', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) return res.json([]);
    const { rows } = await pool.query(
      `SELECT *
       FROM coexistence.instagram_templates
       WHERE workspace_id = $1
       ORDER BY created_at DESC`,
      [workspaceId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[instagram/templates]', err.message);
    res.status(500).json({ error: 'Failed to load templates' });
  }
});

router.post('/instagram/templates', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) return res.status(409).json({ error: 'No workspace found for this account. Please contact support.' });
    const { title, shortcut, message, category } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO coexistence.instagram_templates (title, shortcut, message, category, workspace_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [title, shortcut, message, category, workspaceId]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[instagram/templates:create]', err.message);
    res.status(500).json({ error: 'Failed to save template' });
  }
});

router.put('/instagram/templates/:id', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) return res.status(404).json({ error: 'Not found' });
    const { title, shortcut, message, category } = req.body;
    const { rows } = await pool.query(
      `UPDATE coexistence.instagram_templates
       SET title=$1, shortcut=$2, message=$3, category=$4, updated_at=NOW()
       WHERE id=$5 AND workspace_id=$6 RETURNING *`,
      [title, shortcut, message, category, req.params.id, workspaceId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[instagram/templates:update]', err.message);
    res.status(500).json({ error: 'Failed to update template' });
  }
});

router.delete('/instagram/templates/:id', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) return res.status(404).json({ error: 'Not found' });
    const { rowCount } = await pool.query(
      `DELETE FROM coexistence.instagram_templates WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, workspaceId]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[instagram/templates:delete]', err.message);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

module.exports = { router };
