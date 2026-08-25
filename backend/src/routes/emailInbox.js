const express = require('express');
const router = express.Router();
const axios = require('axios');
const pool = require('../db');

// -- List conversations (one row per contact, latest message + unread count)
router.get('/email/inbox', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (contact_email)
        contact_email, contact_name, subject, body_text, direction, created_at,
        (SELECT COUNT(*)::int FROM coexistence.email_inbox_messages m2
           WHERE m2.contact_email = m1.contact_email AND m2.direction = 'inbound' AND m2.is_read = FALSE) AS unread_count
      FROM coexistence.email_inbox_messages m1
      ORDER BY contact_email, created_at DESC
    `);
    result.rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -- Full thread for one contact, marks inbound messages as read
router.get('/email/inbox/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase().trim();
    const result = await pool.query(
      `SELECT * FROM coexistence.email_inbox_messages WHERE contact_email = $1 ORDER BY created_at ASC`,
      [email]
    );
    await pool.query(
      `UPDATE coexistence.email_inbox_messages SET is_read = TRUE WHERE contact_email = $1 AND direction = 'inbound'`,
      [email]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -- Send a reply to a contact
router.post('/email/inbox/:email/reply', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase().trim();
    const { subject, htmlBody } = req.body;
    if (!htmlBody) return res.status(400).json({ success: false, error: 'htmlBody required' });

    await axios.post('https://api.brevo.com/v3/smtp/email', {
      sender: { name: process.env.BREVO_SENDER_NAME, email: process.env.BREVO_SENDER_EMAIL },
      to: [{ email }],
      subject: subject || 'Re: your message',
      htmlContent: htmlBody,
    }, {
      headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
    });

    const sub = await pool.query('SELECT id FROM coexistence.email_subscribers WHERE email = $1', [email]);
    await pool.query(
      `INSERT INTO coexistence.email_inbox_messages
         (subscriber_id, contact_email, direction, subject, body_html)
       VALUES ($1, $2, 'outbound', $3, $4)`,
      [sub.rows[0]?.id || null, email, subject || 'Re: your message', htmlBody]
    );

    res.json({ success: true, message: 'Reply sent' });
  } catch (err) {
    const brevoError = err.response?.data?.message || err.message;
    res.status(500).json({ success: false, error: brevoError });
  }
});

module.exports = { router };
