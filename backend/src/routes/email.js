const express = require('express');
const router = express.Router();
const axios = require('axios');
const pool = require('../db');

// -- Sheet Sources --------------------------------------------------

router.get('/email/sources', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*, COUNT(sub.id)::int AS subscriber_count
      FROM coexistence.email_sheet_sources s
      LEFT JOIN coexistence.email_subscribers sub ON sub.source_id = s.id
      GROUP BY s.id
      ORDER BY s.created_at DESC
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/email/sources', async (req, res) => {
  try {
    const { name, sheetUrl } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, error: 'name required' });
    }
    const result = await pool.query(
      `INSERT INTO coexistence.email_sheet_sources (name, sheet_url) VALUES ($1, $2) RETURNING *`,
      [name, sheetUrl || null]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/email/sources/:id', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'name required' });
    const result = await pool.query(
      `UPDATE coexistence.email_sheet_sources SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [name, req.params.id]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/email/sources/:id', async (req, res) => {
  try {
    // ON DELETE CASCADE on subscribers.source_id removes that source's subscribers too
    await pool.query('DELETE FROM coexistence.email_sheet_sources WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -- Subscribers ------------------------------------------------------

router.get('/email/subscribers', async (req, res) => {
  try {
    const { sourceId } = req.query;
    let result;
    if (sourceId) {
      result = await pool.query(
        'SELECT * FROM coexistence.email_subscribers WHERE source_id = $1 ORDER BY created_at DESC',
        [sourceId]
      );
    } else {
      result = await pool.query('SELECT * FROM coexistence.email_subscribers ORDER BY created_at DESC');
    }
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/email/subscribers', async (req, res) => {
  try {
    const { email, name, sourceId } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'Email required' });
    await pool.query(
      `INSERT INTO coexistence.email_subscribers (email, name, source, status, source_id)
       VALUES ($1, $2, 'manual', 'active', $3)
       ON CONFLICT (email) DO UPDATE SET source_id = COALESCE(EXCLUDED.source_id, coexistence.email_subscribers.source_id)`,
      [email.toLowerCase().trim(), name || '', sourceId || null]
    );
    res.json({ success: true, message: 'Subscriber added' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
// Bulk import now tied to a named source. If sourceId is omitted, a new
// source is created from sourceName + sheetUrl (first-time import flow).
router.post('/email/subscribers/bulk', async (req, res) => {
  try {
    const { emails, sourceId, sourceName, sheetUrl } = req.body;
    if (!emails || !Array.isArray(emails)) {
      return res.status(400).json({ success: false, error: 'emails array required' });
    }

    let resolvedSourceId = sourceId;
    if (!resolvedSourceId) {
      if (!sourceName || !sheetUrl) {
        return res.status(400).json({ success: false, error: 'sourceName and sheetUrl required for new source' });
      }
      const src = await pool.query(
        `INSERT INTO coexistence.email_sheet_sources (name, sheet_url) VALUES ($1, $2) RETURNING id`,
        [sourceName, sheetUrl]
      );
      resolvedSourceId = src.rows[0].id;
    }

    let added = 0;
    for (const email of emails) {
      if (!email || !email.includes('@')) continue;
      const result = await pool.query(
        `INSERT INTO coexistence.email_subscribers (email, name, source, status, source_id)
         VALUES ($1, '', 'sheet_import', 'active', $2)
         ON CONFLICT (email) DO UPDATE SET source_id = EXCLUDED.source_id
         RETURNING id`,
        [email.toLowerCase().trim(), resolvedSourceId]
      );
      if (result.rows.length > 0) added++;
    }
    res.json({ success: true, added, sourceId: resolvedSourceId, message: `${added} subscribers imported` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/email/subscribers/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM coexistence.email_subscribers WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -- Templates ----------------------------------------------------

router.get('/email/templates', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM coexistence.email_templates ORDER BY created_at DESC');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/email/templates', async (req, res) => {
  try {
    const { title, subject, htmlBody } = req.body;
    if (!title || !subject || !htmlBody) {
      return res.status(400).json({ success: false, error: 'title, subject and htmlBody required' });
    }
    const result = await pool.query(
      `INSERT INTO coexistence.email_templates (title, subject, html_body) VALUES ($1, $2, $3) RETURNING *`,
      [title, subject, htmlBody]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/email/templates/:id', async (req, res) => {
  try {
    const { title, subject, htmlBody } = req.body;
    const result = await pool.query(
      `UPDATE coexistence.email_templates SET title = $1, subject = $2, html_body = $3, updated_at = NOW() WHERE id = $4 RETURNING *`,
      [title, subject, htmlBody, req.params.id]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/email/templates/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM coexistence.email_templates WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -- Campaigns ------------------------------------------------------

// ── SENDERS ──────────────────────────────────────────────────────────────

router.get('/email/senders', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM coexistence.email_senders ORDER BY is_default DESC, created_at ASC');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/email/senders', async (req, res) => {
  try {
    const { name, email, isDefault } = req.body;
    if (!name || !email) return res.status(400).json({ success: false, error: 'name and email required' });
    if (isDefault) {
      await pool.query('UPDATE coexistence.email_senders SET is_default = FALSE');
    }
    const result = await pool.query(
      `INSERT INTO coexistence.email_senders (name, email, is_default) VALUES ($1, $2, $3) RETURNING *`,
      [name.trim(), email.trim().toLowerCase(), !!isDefault]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, error: 'This email is already added as a sender.' });
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/email/senders/:id/default', async (req, res) => {
  try {
    await pool.query('UPDATE coexistence.email_senders SET is_default = FALSE');
    const result = await pool.query('UPDATE coexistence.email_senders SET is_default = TRUE WHERE id = $1 RETURNING *', [req.params.id]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/email/senders/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM coexistence.email_senders WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


router.post('/email/campaigns/send', async (req, res) => {
  const client = await pool.connect();
  try {
    let { templateId, subject, htmlBody, sourceId, sourceIds, senderId } = req.body;

    if (templateId) {
      const t = await client.query('SELECT * FROM coexistence.email_templates WHERE id = $1', [templateId]);
      if (t.rows.length === 0) {
        return res.status(400).json({ success: false, error: 'Template not found' });
      }
      subject = subject || t.rows[0].subject;
      htmlBody = htmlBody || t.rows[0].html_body;
    }

    if (!subject || !htmlBody) {
      return res.status(400).json({ success: false, error: 'subject and htmlBody required (or pick a template)' });
    }

  let subs;
    if (Array.isArray(sourceIds) && sourceIds.length > 0) {
      subs = await client.query(
        'SELECT id, email, name FROM coexistence.email_subscribers WHERE status = $1 AND source_id = ANY($2::bigint[])',
        ['active', sourceIds]
      );
    } else if (sourceId) {
      subs = await client.query(
        'SELECT id, email, name FROM coexistence.email_subscribers WHERE status = $1 AND source_id = $2',
        ['active', sourceId]
      );
    } else {
      subs = await client.query(
        'SELECT id, email, name FROM coexistence.email_subscribers WHERE status = $1',
        ['active']
      );
    }

    if (subs.rows.length === 0) {
      return res.json({ success: false, error: 'No active subscribers found for this selection' });
    }

    const campaignInsert = await client.query(
      `INSERT INTO coexistence.email_campaigns (template_id, subject, recipient_count, status, started_at)
       VALUES ($1, $2, $3, 'sending', NOW()) RETURNING id`,
      [templateId || null, subject, subs.rows.length]
    );
    const campaignId = campaignInsert.rows[0].id;

    let senderName = process.env.BREVO_SENDER_NAME;
    let senderEmail = process.env.BREVO_SENDER_EMAIL;
    if (senderId) {
      const senderRow = await client.query('SELECT * FROM coexistence.email_senders WHERE id = $1', [senderId]);
      if (senderRow.rows.length > 0) {
        senderName = senderRow.rows[0].name;
        senderEmail = senderRow.rows[0].email;
      }
    }

    let sent = 0;
    let failed = 0;
    let lastError = null;

    for (const subscriber of subs.rows) {
      try {
        await axios.post('https://api.brevo.com/v3/smtp/email', {
         sender: { name: senderName, email: senderEmail },
          to: [{ email: subscriber.email, ...(subscriber.name ? { name: subscriber.name } : {}) }],
          subject,
          htmlContent: htmlBody,
        }, {
          headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
        });
        sent++;
      } catch (err) {
        const brevoError = err.response?.data?.message || err.response?.data || err.message;
        console.error('[email/campaigns/send] Brevo error for', subscriber.email, ':', brevoError);
        lastError = brevoError;
        failed++;
      }
    }

    await client.query(
      `UPDATE coexistence.email_campaigns SET sent_count = $1, failed_count = $2, status = $3, error_message = $4, finished_at = NOW() WHERE id = $5`,
      [sent, failed, 'completed', lastError ? String(lastError) : null, campaignId]
    );

    res.json({ success: true, sent, failed, total: subs.rows.length, campaignId, lastError });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

router.get('/email/campaigns', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, t.title AS template_title
      FROM coexistence.email_campaigns c
      LEFT JOIN coexistence.email_templates t ON t.id = c.template_id
      ORDER BY c.created_at DESC
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = { router };