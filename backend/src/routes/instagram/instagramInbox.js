const express = require('express');
const pool = require('../../db');
const router = express.Router();

// instagram_messages / instagram_notes have no workspace_id of their own
// (see instagramWorkspaceSchema.js — "add workspace_id only where genuinely
// required") — they key off conversation_id / contact_id, both of which now
// carry workspace_id directly. This helper does that ownership check so
// every route below can 404 instead of ever touching another workspace's
// conversation.
async function getOwnedConversation(conversationId, workspaceId) {
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.instagram_conversations WHERE id = $1 AND workspace_id = $2`,
    [conversationId, workspaceId]
  );
  return rows[0] || null;
}

// List all conversations for the inbox left panel — scoped to the current
// workspace only.
router.get('/instagram/inbox', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) return res.json([]);
    const { rows } = await pool.query(`
    SELECT c.id,
           c.status,
           c.assignee_id,
           c.updated_at,
           ct.id AS contact_id,
           ct.username,
           ct.display_name,
           ct.ig_user_id,
           ct.last_message,
           ct.profile_picture
    FROM coexistence.instagram_conversations c
    JOIN coexistence.instagram_contacts ct
      ON ct.id = c.contact_id
    WHERE c.workspace_id = $1
    ORDER BY c.updated_at DESC
`, [workspaceId]);
    res.json(rows);
  } catch (err) {
    console.error('[instagram/inbox]', err.message);
    res.status(500).json({ error: 'Failed to load inbox' });
  }
});

// Get all messages in one conversation (chat thread)
router.get('/instagram/inbox/:conversationId/messages', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) return res.status(404).json({ error: 'Conversation not found' });
    const convo = await getOwnedConversation(req.params.conversationId, workspaceId);
    if (!convo) return res.status(404).json({ error: 'Conversation not found' });
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.instagram_messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [req.params.conversationId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[instagram/inbox/messages]', err.message);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// Send a message in a conversation (stub — no real Meta call yet)
router.post('/instagram/inbox/:conversationId/messages', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) return res.status(404).json({ error: 'Conversation not found' });
    const convo = await getOwnedConversation(req.params.conversationId, workspaceId);
    if (!convo) return res.status(404).json({ error: 'Conversation not found' });

    const { content } = req.body;
    const { conversationId } = req.params;
    const { rows } = await pool.query(
      `INSERT INTO coexistence.instagram_messages (conversation_id, direction, content, status)
       VALUES ($1, 'outbound', $2, 'sent') RETURNING *`,
      [conversationId, content]
    );
    await pool.query(
      `UPDATE coexistence.instagram_conversations SET updated_at = NOW() WHERE id = $1`,
      [conversationId]
    );
    await pool.query(
      `UPDATE coexistence.instagram_contacts SET last_message = $1, updated_at = NOW() WHERE id = $2`,
      [content, convo.contact_id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[instagram/inbox:send]', err.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Update conversation status / assignee
router.patch('/instagram/inbox/:conversationId', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) return res.status(404).json({ error: 'Conversation not found' });
    const convo = await getOwnedConversation(req.params.conversationId, workspaceId);
    if (!convo) return res.status(404).json({ error: 'Conversation not found' });

    const { status, assigneeId } = req.body;
    const fields = [];
    const values = [];
    let i = 1;
    if (status !== undefined) { fields.push(`status = $${i++}`); values.push(status); }
    if (assigneeId !== undefined) { fields.push(`assignee_id = $${i++}`); values.push(assigneeId); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    values.push(req.params.conversationId);
    const { rows } = await pool.query(
      `UPDATE coexistence.instagram_conversations SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${i} RETURNING *`,
      values
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[instagram/inbox:patch]', err.message);
    res.status(500).json({ error: 'Failed to update conversation' });
  }
});

// Notes for a conversation's contact
router.get('/instagram/inbox/:conversationId/notes', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) return res.json([]);
    const convo = await getOwnedConversation(req.params.conversationId, workspaceId);
    if (!convo) return res.json([]);
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.instagram_notes WHERE contact_id = $1 ORDER BY created_at DESC`,
      [convo.contact_id]
    );
    res.json(rows);
  } catch (err) {
    console.error('[instagram/inbox:notes]', err.message);
    res.status(500).json({ error: 'Failed to load notes' });
  }
});

router.post('/instagram/inbox/:conversationId/notes', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) return res.status(404).json({ error: 'Conversation not found' });
    const convo = await getOwnedConversation(req.params.conversationId, workspaceId);
    if (!convo) return res.status(404).json({ error: 'Conversation not found' });

    const { note } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO coexistence.instagram_notes (contact_id, note) VALUES ($1, $2) RETURNING *`,
      [convo.contact_id, note]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[instagram/inbox:add-note]', err.message);
    res.status(500).json({ error: 'Failed to add note' });
  }
});

// TEMPORARY dev helper — seed a test conversation so the UI has something
// to show before real Meta integration exists. Safe to remove in Phase 2.
// Scoped to the requesting workspace so seeded data doesn't leak into (or
// pollute) any other tenant's inbox.
router.post('/instagram/inbox/seed-test', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) return res.status(409).json({ error: 'No workspace found for this account. Please contact support.' });
    const { username, displayName, message } = req.body;
    const contact = await pool.query(
      `INSERT INTO coexistence.instagram_contacts (ig_user_id, username, display_name, last_message, workspace_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [`test_${Date.now()}`, username || 'test_user', displayName || 'Test User', message || 'Hello!', workspaceId]
    );
    const conversation = await pool.query(
      `INSERT INTO coexistence.instagram_conversations (contact_id, status, workspace_id) VALUES ($1, 'open', $2) RETURNING *`,
      [contact.rows[0].id, workspaceId]
    );
    await pool.query(
      `INSERT INTO coexistence.instagram_messages (conversation_id, direction, content, status)
       VALUES ($1, 'inbound', $2, 'received')`,
      [conversation.rows[0].id, message || 'Hello!']
    );
    res.json({ contact: contact.rows[0], conversation: conversation.rows[0] });
  } catch (err) {
    console.error('[instagram/inbox:seed]', err.message);
    res.status(500).json({ error: 'Failed to seed test conversation' });
  }
});

module.exports = { router };
