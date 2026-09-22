const express = require('express');
const router = express.Router();
const pool = require('../db');

router.get('/lead-intelligence', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id || 1;

    const { rows: profiles } = await pool.query(
      `SELECT contact_number, current_intent, buying_score,
              products_viewed_count, last_activity
         FROM coexistence.customer_intent_profiles
        WHERE workspace_id = $1
        ORDER BY buying_score DESC, last_activity DESC`,
      [workspaceId]
    );

    const { rows: contacts } = await pool.query(
      `SELECT contact_number, name, profile_name
         FROM coexistence.contacts
        WHERE workspace_id = $1`,
      [workspaceId]
    );
    const contactMap = {};
    contacts.forEach(c => { contactMap[c.contact_number] = c; });

    const merged = profiles.map(p => ({
      ...p,
      name: contactMap[p.contact_number]?.name || null,
      profile_name: contactMap[p.contact_number]?.profile_name || null,
    }));

    res.json(merged);
  } catch (err) {
    console.error('[lead-intelligence] Error:', err.message);
    res.status(500).json({ error: 'Failed to load lead intelligence data' });
  }
});

module.exports = { router };