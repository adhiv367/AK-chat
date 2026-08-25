const express = require('express');
const pool = require('../../db');
const router = express.Router();

router.get('/instagram/analytics', async (req, res) => {
  try {
    const [sent, received, active] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS c FROM coexistence.instagram_messages WHERE direction = 'outbound'`),
      pool.query(`SELECT COUNT(*)::int AS c FROM coexistence.instagram_messages WHERE direction = 'inbound'`),
      pool.query(`SELECT COUNT(*)::int AS c FROM coexistence.instagram_conversations WHERE status = 'open'`),
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