const express = require('express');
const pool = require('../../db');
const router = express.Router();

// req.workspace is attached by attachWorkspace (see index.js). Every query
// below scopes by req.workspace.id — an accountId/workspaceId from the
// client is never trusted (the previous ?accountId= query param was never
// even sent by the frontend, and honoured NULL as "match everything", which
// leaked every workspace's contacts to every other workspace).
router.get('/instagram/contacts', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) return res.json([]);
    const { rows } = await pool.query(
      `SELECT *
       FROM coexistence.instagram_contacts
       WHERE workspace_id = $1
       ORDER BY created_at DESC`,
      [workspaceId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[instagram/contacts]', err.message);
    res.status(500).json({ error: 'Failed to load contacts' });
  }
});

router.post('/instagram/contacts', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) return res.status(409).json({ error: 'No workspace found for this account. Please contact support.' });
    const { igUserId, username, displayName, profilePicture } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO coexistence.instagram_contacts (ig_user_id, username, display_name, profile_picture, workspace_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [igUserId, username, displayName, profilePicture, workspaceId]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[instagram/contacts:create]', err.message);
    res.status(500).json({ error: 'Failed to save contact' });
  }
});

router.delete('/instagram/contacts/:id', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) return res.status(404).json({ error: 'Not found' });
    const { rowCount } = await pool.query(
      `DELETE FROM coexistence.instagram_contacts WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, workspaceId]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[instagram/contacts:delete]', err.message);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

module.exports = { router };
