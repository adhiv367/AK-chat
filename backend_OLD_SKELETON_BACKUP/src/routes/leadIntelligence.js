const express = require('express');
const router = express.Router();
const pool = require('../db'); // local DB — has contacts
const { Pool } = require('pg');

// Second connection pool — Render's DB, where the Python bot writes
// customer_intent_profiles. Separate database from the local one above,
// so this can't be a single SQL JOIN — merged in JS instead.
const renderPool = new Pool({
  connectionString: 'postgresql://akchat_bot_db_user:lxnnz657p45rLPJQGrjH7I3xL6i7WqCd@dpg-da6k21vavr4c73952v90-a.oregon-postgres.render.com/akchat_bot_db?sslmode=require',
});

router.get('/lead-intelligence', async (req, res) => {
  try {
    const { rows: profiles } = await renderPool.query(`
      SELECT contact_number, current_intent, buying_score,
             products_viewed_count, last_activity
      FROM coexistence.customer_intent_profiles
      ORDER BY buying_score DESC, last_activity DESC
    `);

    const { rows: contacts } = await pool.query(`
      SELECT contact_number, name, profile_name
      FROM coexistence.contacts
    `);
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