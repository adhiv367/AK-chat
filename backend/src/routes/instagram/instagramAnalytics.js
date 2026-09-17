const express = require('express');
const pool = require('../../db');
const router = express.Router();

// instagram_messages has no workspace_id of its own (it keys off
// conversation_id, and instagram_conversations now carries workspace_id
// directly — see instagramWorkspaceSchema.js), so counts here join up one
// level rather than duplicating the column onto every message row.
router.get('/instagram/analytics', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) {
      return res.json({ messagesSent: 0, messagesReceived: 0, activeConversations: 0, avgResponseTime: '—' });
    }
    const [sent, received, active] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS c
           FROM coexistence.instagram_messages m
           JOIN coexistence.instagram_conversations c ON c.id = m.conversation_id
          WHERE m.direction = 'outbound' AND c.workspace_id = $1`,
        [workspaceId]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS c
           FROM coexistence.instagram_messages m
           JOIN coexistence.instagram_conversations c ON c.id = m.conversation_id
          WHERE m.direction = 'inbound' AND c.workspace_id = $1`,
        [workspaceId]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS c FROM coexistence.instagram_conversations WHERE status = 'open' AND workspace_id = $1`,
        [workspaceId]
      ),
    ]);
    res.json({
      messagesSent: sent.rows[0].c,
      messagesReceived: received.rows[0].c,
      activeConversations: active.rows[0].c,
      avgResponseTime: '—',
    });
  } catch (err) {
    console.error('[instagram/analytics]', err.message);
    res.status(500).json({ error: 'Failed to load analytics' });
  }
});

module.exports = { router };
