const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requirePermission } = require('../middleware/access');
const { resolveAccount, insertPendingRow } = require('../services/messageSender');
const { enqueueSend } = require('../queue/sendQueue');

/**
 * Extract the sorted, de-duplicated list of {{n}} variable indices from a
 * template text string (body or header). Mirrors routes/templates.js's
 * extractVars so broadcast-send agrees with what Meta actually approved.
 */
function extractVars(text) {
  const m = [...(text || '').matchAll(/\{\{(\d+)\}\}/g)];
  return [...new Set(m.map(x => x[1]))].sort((a, b) => +a - +b);
}

function resolveMergeFields(val, recipient) {
  let out = String(val == null ? '' : val);
  out = out.replace(/\{\{contact\.name\}\}/g, recipient.name || '');
  out = out.replace(/\{\{contact\.number\}\}/g, recipient.contact_number || '');
  return out;
}

/**
 * Build Meta template `components` array from variable_mapping + recipient ctx.
 * variable_mapping is { "1": "<source>", "2": "<source>", header: { "1": "<source>" },
 * buttons: { "<buttonIndex>": "<source>" } } where <source> is either a literal
 * string or a placeholder like "{{contact.name}}".
 *
 * IMPORTANT: the number and order of parameters sent to Meta for each component
 * (header/body/button) MUST exactly match the {{n}} variables Meta approved for
 * that template — not just whatever keys happen to be present in variable_mapping.
 * Sending too few/too many parameters is the #1 cause of approved templates
 * failing to send (Meta error 132000 "Number of parameters does not match the
 * expected number of params"). We therefore always derive the *required* set
 * from the template definition itself, and only pull values out of
 * variable_mapping — never derive requirements from variable_mapping.
 */
function buildTemplateComponents(template, variableMapping, recipient, headerMediaId) {
  const components = [];
  const vm = variableMapping || {};
  const bodyMap = vm.body && typeof vm.body === 'object' ? vm.body : vm; // back-compat: flat map = body vars
  const headerMap = vm.header && typeof vm.header === 'object' ? vm.header : {};
  const buttonMap = vm.buttons && typeof vm.buttons === 'object' ? vm.buttons : {};

  // ── Header ────────────────────────────────────────────────────────────
  // Media headers (IMAGE/VIDEO/DOCUMENT) require the header media as a
  // runtime parameter (resolved to a per-account Meta media id); omitting it
  // causes Meta error 132012.
  const ht = String(template.header_type || 'NONE').toUpperCase();
  if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(ht)) {
    if (!headerMediaId) {
      throw new Error(`Template "${template.name}" requires a ${ht} header image but no media was resolved for this broadcast`);
    }
    const key = ht.toLowerCase(); // image | video | document
    components.push({ type: 'header', parameters: [{ type: key, [key]: { id: headerMediaId } }] });
  } else if (ht === 'TEXT') {
    // TEXT headers only need a parameter when they contain a {{1}} variable.
    const headerVars = extractVars(template.header_text);
    if (headerVars.length > 0) {
      const k = headerVars[0]; // Meta allows exactly one header variable
      const raw = headerMap[k];
      if (raw == null || String(raw).trim() === '') {
        throw new Error(`Template "${template.name}" header requires a value for {{${k}}} but none was provided`);
      }
      components.push({ type: 'header', parameters: [{ type: 'text', text: resolveMergeFields(raw, recipient) }] });
    }
  }
  // Static TEXT / NONE headers need no header component at all.

  // ── Body ──────────────────────────────────────────────────────────────
  // Required variable indices come from the template's own body text, NOT
  // from whatever keys happen to be in variable_mapping. If the template has
  // no {{n}} in its body, we must NOT send a body component/parameters at
  // all — Meta rejects a "parameters" array on a template with a static body.
  const requiredBodyVars = extractVars(template.body);
  if (requiredBodyVars.length > 0) {
    const missing = requiredBodyVars.filter(k => bodyMap[k] == null || String(bodyMap[k]).trim() === '');
    if (missing.length > 0) {
      throw new Error(
        `Template "${template.name}" body requires values for ${missing.map(k => `{{${k}}}`).join(', ')} but they were not provided in variable_mapping`
      );
    }
    const parameters = requiredBodyVars.map(k => ({ type: 'text', text: resolveMergeFields(bodyMap[k], recipient) }));
    components.push({ type: 'body', parameters });
  }

  // ── Buttons ───────────────────────────────────────────────────────────
  // Only buttons with a DYNAMIC value (contains {{n}} in their registered
  // url / copy-code) need a runtime button component. Static URL / phone /
  // quick-reply buttons must NOT get a button component — Meta rejects
  // button parameters that weren't registered on the template.
  const templateButtons = Array.isArray(template.buttons) ? template.buttons : [];
  templateButtons.forEach((btn, index) => {
    if (btn.type === 'URL') {
      const isDynamic = extractVars(btn.value || '').length > 0;
      if (!isDynamic) return; // static URL button — no component needed
      // Prefer a per-broadcast/per-recipient value; fall back to the sample
      // URL suffix Meta already approved so the send doesn't fail outright.
      const raw = buttonMap[index] ?? buttonMap[String(index)] ?? btn.urlSample;
      if (raw == null || String(raw).trim() === '') {
        throw new Error(`Template "${template.name}" button #${index} is a dynamic URL button but no value/sample is available`);
      }
      components.push({
        type: 'button',
        sub_type: 'url',
        index: String(index),
        parameters: [{ type: 'text', text: resolveMergeFields(raw, recipient) }],
      });
    } else if (btn.type === 'COPY_CODE') {
      const raw = buttonMap[index] ?? buttonMap[String(index)] ?? btn.value;
      if (raw == null || String(raw).trim() === '') {
        throw new Error(`Template "${template.name}" button #${index} is a COPY_CODE button but no value is available`);
      }
      components.push({
        type: 'button',
        sub_type: 'copy_code',
        index: String(index),
        parameters: [{ type: 'coupon_code', coupon_code: String(raw) }],
      });
    }
    // PHONE_NUMBER, QUICK_REPLY, OTP buttons are static from Meta's POV — no
    // runtime button component required.
  });

  return components;
}

async function enqueueBroadcastRecipient({ broadcast, template, account, recipient, broadcastLogId, resolvedMediaId }) {
  const msgType = broadcast.message_type || 'template';

  // ── Template ──────────────────────────────────────────────────────────
  if (msgType === 'template') {
    // resolvedMediaId doubles as the header image for media-header templates.
    const components = buildTemplateComponents(template, broadcast.variable_mapping, recipient, resolvedMediaId);
    console.log(
      `[broadcasts] template payload for "${template.name}" → ${recipient.contact_number}:`,
      JSON.stringify({ name: template.name, language: { code: template.language || 'en' }, components }, null, 2)
    );
    const localId = await insertPendingRow({
      account,
      toNumber: recipient.contact_number,
      messageType: 'template',
      messageBody: template.body || `Template: ${template.name}`,
      templateMeta: {
        header_type: template.header_type || 'NONE',
        header_text: template.header_text || null,
        footer: template.footer || null,
        buttons: Array.isArray(template.buttons) ? template.buttons : (template.buttons || []),
      },
    });
    await enqueueSend({
      kind: 'template',
      accountId: account.id,
      to: String(recipient.contact_number).replace(/\D/g, ''),
      localMessageId: localId,
      payload: {
        name: template.name,
        languageCode: template.language || 'en',
        components,
      },
      originRef: broadcastLogId ? { kind: 'broadcast_log', id: broadcastLogId } : undefined,
    });
    return;
  }

  // ── Text ──────────────────────────────────────────────────────────────
  if (msgType === 'text') {
    const body = (broadcast.body || '').replace(/\{\{contact\.name\}\}/g, recipient.name || '').replace(/\{\{contact\.number\}\}/g, recipient.contact_number || '');
    const localId = await insertPendingRow({
      account,
      toNumber: recipient.contact_number,
      messageType: 'text',
      messageBody: body,
    });
    await enqueueSend({
      kind: 'text',
      accountId: account.id,
      to: String(recipient.contact_number).replace(/\D/g, ''),
      localMessageId: localId,
      payload: { body },
      originRef: broadcastLogId ? { kind: 'broadcast_log', id: broadcastLogId } : undefined,
    });
    return;
  }

  // ── Link ──────────────────────────────────────────────────────────────
  if (msgType === 'link') {
    const body = (broadcast.url || '').replace(/\{\{contact\.name\}\}/g, recipient.name || '').replace(/\{\{contact\.number\}\}/g, recipient.contact_number || '');
    const localId = await insertPendingRow({
      account,
      toNumber: recipient.contact_number,
      messageType: 'text',
      messageBody: body,
    });
    await enqueueSend({
      kind: 'text',
      accountId: account.id,
      to: String(recipient.contact_number).replace(/\D/g, ''),
      localMessageId: localId,
      payload: { body, previewUrl: true },
      originRef: broadcastLogId ? { kind: 'broadcast_log', id: broadcastLogId } : undefined,
    });
    return;
  }

  // ── Media (image / video / audio / document) ──────────────────────────
  if (['image', 'video', 'audio', 'document'].includes(msgType)) {
    const caption = (broadcast.caption || '')
      .replace(/\{\{contact\.name\}\}/g, recipient.name || '')
      .replace(/\{\{contact\.number\}\}/g, recipient.contact_number || '');
    const localId = await insertPendingRow({
      account,
      toNumber: recipient.contact_number,
      messageType: msgType,
      messageBody: caption || `${msgType} message`,
    });
    await enqueueSend({
      kind: 'media',
      accountId: account.id,
      to: String(recipient.contact_number).replace(/\D/g, ''),
      localMessageId: localId,
      payload: {
        type: msgType,
        mediaId: resolvedMediaId || null,
        link: resolvedMediaId ? null : (broadcast.url || null),
        caption: caption || undefined,
      },
      originRef: broadcastLogId ? { kind: 'broadcast_log', id: broadcastLogId } : undefined,
    });
    return;
  }

  throw new Error(`Unsupported broadcast message_type: ${msgType}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getBroadcastWithLogs(id) {
  const { rows: bRows } = await pool.query(
    `SELECT b.*, t.name AS template_name, t.category AS template_category,
            t.language AS template_language, t.header_type, t.header_text,
            t.media_handle, t.body AS template_body, t.footer AS template_footer,
            t.buttons AS template_buttons, t.samples AS template_samples,
            t.security_recommendation, t.code_expiry_minutes
     FROM coexistence.broadcasts b
     LEFT JOIN coexistence.message_templates t ON t.id = b.template_id
     WHERE b.id = $1`,
    [id]
  );
  if (bRows.length === 0) return null;

  // Aggregate BROADCAST logs into a single summary entry;
  // keep TEST logs as individual rows.
  const { rows: broadcastAgg } = await pool.query(
    `SELECT
       COUNT(*)::int AS recipient_count,
       MAX(sent_at) AS sent_at,
       CASE
         WHEN COUNT(*) FILTER (WHERE status = 'PENDING') > 0 THEN 'PENDING'
         WHEN COUNT(*) FILTER (WHERE status = 'failed') > 0
          AND COUNT(*) FILTER (WHERE status IN ('sent','delivered','read')) = 0 THEN 'failed'
         WHEN COUNT(*) FILTER (WHERE status = 'failed') > 0 THEN 'sent'
         WHEN COUNT(*) FILTER (WHERE status IN ('sent','delivered','read')) > 0 THEN 'sent'
         ELSE MAX(status)
       END AS status,
       ARRAY_AGG(DISTINCT error_message) FILTER (WHERE error_message IS NOT NULL) AS errors
     FROM coexistence.broadcast_logs
     WHERE broadcast_id = $1 AND action = 'BROADCAST'`,
    [id]
  );

  const { rows: testLogs } = await pool.query(
    `SELECT id, action, sent_to, status, sent_at, wa_message_id, error_message
     FROM coexistence.broadcast_logs
     WHERE broadcast_id = $1 AND action = 'TEST'
     ORDER BY sent_at DESC`,
    [id]
  );

  // Cumulative funnel: a message that was read passed through delivered & sent
  // first. Counting only the *current* status (exclusive buckets) makes a fully
  // delivered broadcast look like "0 sent / 0 delivered / 2 read" — which is
  // semantically correct but confusing in a Delivery Summary. Users expect:
  //   sent      = ever-sent (sent OR delivered OR read)
  //   delivered = ever-delivered (delivered OR read)
  //   read      = read (terminal)
  const { rows: rollup } = await pool.query(
    `SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE bl.status = 'PENDING')::int AS pending,
        COUNT(*) FILTER (WHERE bl.status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE ch.status IN ('sent','delivered','read'))::int AS sent,
        COUNT(*) FILTER (WHERE ch.status IN ('delivered','read'))::int AS delivered,
        COUNT(*) FILTER (WHERE ch.status = 'read')::int AS read
       FROM coexistence.broadcast_logs bl
       LEFT JOIN coexistence.chat_history ch ON ch.message_id = bl.wa_message_id
      WHERE bl.broadcast_id = $1 AND bl.action = 'BROADCAST'`,
    [id]
  );

  // Normalise aggregated BROADCAST row to match the log shape the frontend expects
  const logs = [];
  if (broadcastAgg[0]?.recipient_count > 0) {
    logs.push({
      id: `broadcast-${id}`,
      action: 'BROADCAST',
      sent_to: `${broadcastAgg[0].recipient_count} contact${broadcastAgg[0].recipient_count !== 1 ? 's' : ''}`,
      status: broadcastAgg[0].status,
      sent_at: broadcastAgg[0].sent_at,
      wa_message_id: null,
      error_message: broadcastAgg[0].errors?.length ? broadcastAgg[0].errors.join('; ') : null,
      _recipientCount: broadcastAgg[0].recipient_count,
    });
  }
  logs.push(...testLogs);
  logs.sort((a, b) => new Date(b.sent_at || 0) - new Date(a.sent_at || 0));

  return { ...bRows[0], logs, statusRollup: rollup[0] || {} };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /broadcasts — list all with template name and live status rollup
router.get('/broadcasts', async (req, res) => {
  try {
    const { status } = req.query;
    const params = [];
    const conditions = [];

    const { rows } = await pool.query(
      `WITH base AS (
         SELECT b.*, t.name AS template_name,
                (SELECT COUNT(*) FROM coexistence.broadcast_logs WHERE broadcast_id = b.id) AS log_count,
                (SELECT MAX(sent_at) FROM coexistence.broadcast_logs WHERE broadcast_id = b.id) AS last_activity,
                (
                  SELECT
                    CASE
                      WHEN b.status = 'DRAFT'     THEN 'DRAFT'
                      WHEN b.status = 'SCHEDULED' THEN 'SCHEDULED'
                      WHEN b.status = 'SENDING'   THEN 'SENDING'
                      WHEN COUNT(*) FILTER (WHERE bl.status = 'PENDING') > 0 THEN 'SENDING'
                      WHEN COUNT(*) FILTER (WHERE bl.status = 'failed') > 0
                       AND COUNT(*) FILTER (WHERE bl.status IN ('sent','delivered','read')) = 0 THEN 'FAILED'
                      WHEN COUNT(*) FILTER (WHERE bl.status = 'failed') > 0 THEN 'PARTIAL'
                      WHEN COUNT(*) FILTER (WHERE bl.status IN ('sent','delivered','read')) > 0 THEN 'SENT'
                      ELSE b.status
                    END
                  FROM coexistence.broadcast_logs bl
                  WHERE bl.broadcast_id = b.id AND bl.action = 'BROADCAST'
                ) AS display_status
         FROM coexistence.broadcasts b
         LEFT JOIN coexistence.message_templates t ON t.id = b.template_id
       )
       SELECT * FROM base
       ${status && status !== 'all' ? 'WHERE display_status = $1' : ''}
       ORDER BY created_at DESC`,
      status && status !== 'all' ? [status] : []
    );
    // Map display_status over status for the frontend
    res.json(rows.map(r => ({ ...r, status: r.display_status || r.status })));
  } catch (err) {
    console.error('[broadcasts] /broadcasts error:', err.message);
    res.status(500).json({ error: 'Failed to fetch broadcasts' });
  }
});

// GET /broadcasts/:id — single broadcast with template and logs
router.get('/broadcasts/:id', async (req, res) => {
  try {
    const data = await getBroadcastWithLogs(req.params.id);
    if (!data) return res.status(404).json({ error: 'Broadcast not found' });
    res.json(data);
  } catch (err) {
    console.error('[broadcasts] /broadcasts/:id error:', err.message);
    res.status(500).json({ error: 'Failed to fetch broadcast' });
  }
});

// POST /broadcasts — create broadcast + optional log entry
// NEW: accepts optional scheduled_at (ISO UTC string) to schedule a future broadcast.
// If scheduled_at is given and is a future time, status = 'SCHEDULED' automatically.
router.post('/broadcasts', requirePermission('bulk-message'), async (req, res) => {
  try {
    const {
      from_number, recipient_numbers, template_id, status, test_number,
      name, variable_mapping, message_type, body, url, media_library_id, caption,
      scheduled_at,
    } = req.body;

    if (!from_number || !recipient_numbers) {
      return res.status(400).json({ error: 'from_number and recipient_numbers required' });
    }
    if (!Array.isArray(recipient_numbers) || recipient_numbers.length === 0) {
      return res.status(400).json({ error: 'recipient_numbers must be a non-empty array' });
    }
    if (recipient_numbers.length > 5000) {
      return res.status(400).json({ error: 'Too many recipients (max 5000 per broadcast)' });
    }

    const msgType = message_type || 'template';
    if (msgType === 'template' && !template_id) {
      return res.status(400).json({ error: 'template_id required for template broadcasts' });
    }

    // Decide status and scheduled_at
    let resolvedStatus = status || 'DRAFT';
    let resolvedScheduledAt = null;

    if (scheduled_at) {
      const d = new Date(scheduled_at);
      if (isNaN(d.getTime())) {
        return res.status(400).json({ error: 'scheduled_at must be a valid ISO date string (e.g. 2026-06-15T10:00:00.000Z)' });
      }
      // Use a 1-minute buffer to avoid false rejections due to browser/server
      // timezone differences (e.g. browser in IST, server in UTC).
      const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
      if (d < oneMinuteAgo) {
        return res.status(400).json({ error: 'scheduled_at must be in the future' });
      }
      resolvedStatus = 'SCHEDULED';
      resolvedScheduledAt = d.toISOString();
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `INSERT INTO coexistence.broadcasts
         (from_number, recipient_numbers, template_id, status, test_number, name,
          variable_mapping, message_type, body, url, media_library_id, caption,
          scheduled_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
         RETURNING *`,
        [
          from_number,
          JSON.stringify(recipient_numbers || []),
          template_id || null,
          resolvedStatus,
          test_number || null,
          name || null,
          JSON.stringify(variable_mapping || {}),
          msgType,
          body || null,
          url || null,
          media_library_id || null,
          caption || null,
          resolvedScheduledAt,
        ]
      );
      const broadcast = rows[0];

      if (test_number) {
        await client.query(
          `INSERT INTO coexistence.broadcast_logs (broadcast_id, action, sent_to, status)
           VALUES ($1, $2, $3, $4)`,
          [broadcast.id, 'TEST', test_number, 'PENDING']
        );
      }

      await client.query('COMMIT');
      res.status(201).json(broadcast);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[broadcasts] POST /broadcasts error:', err.message);
    res.status(500).json({ error: 'Failed to create broadcast' });
  }
});

// PUT /broadcasts/:id — update (only if DRAFT or SCHEDULED)
router.put('/broadcasts/:id', requirePermission('bulk-message'), async (req, res) => {
  try {
    const { rows: existing } = await pool.query(
      'SELECT status FROM coexistence.broadcasts WHERE id = $1', [req.params.id]
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Broadcast not found' });
    if (!['DRAFT', 'SCHEDULED'].includes(existing[0].status)) {
      return res.status(403).json({ error: 'Only DRAFT or SCHEDULED broadcasts can be edited' });
    }

    const {
      from_number, recipient_numbers, template_id, test_number, name,
      variable_mapping, message_type, body, url, media_library_id, caption,
      scheduled_at,
    } = req.body;

    // Figure out new status and scheduled_at
    let newStatus = null;
    let touchScheduledAt = false;
    let newScheduledAt = null;

    if (scheduled_at === null || scheduled_at === '') {
      // User cleared the schedule — go back to DRAFT
      newStatus = 'DRAFT';
      touchScheduledAt = true;
      newScheduledAt = null;
    } else if (scheduled_at) {
      const d = new Date(scheduled_at);
      if (isNaN(d.getTime())) {
        return res.status(400).json({ error: 'scheduled_at must be a valid ISO date string' });
      }
      // 1-minute buffer — same fix as POST route (timezone safety)
      const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
      if (d < oneMinuteAgo) {
        return res.status(400).json({ error: 'scheduled_at must be in the future' });
      }
      newStatus = 'SCHEDULED';
      touchScheduledAt = true;
      newScheduledAt = d.toISOString();
    }

    const { rows } = await pool.query(
      `UPDATE coexistence.broadcasts SET
        from_number       = COALESCE($1,  from_number),
        recipient_numbers = COALESCE($2,  recipient_numbers),
        template_id       = COALESCE($3,  template_id),
        test_number       = COALESCE($4,  test_number),
        name              = COALESCE($5,  name),
        variable_mapping  = COALESCE($6,  variable_mapping),
        message_type      = COALESCE($7,  message_type),
        body              = COALESCE($8,  body),
        url               = COALESCE($9,  url),
        media_library_id  = COALESCE($10, media_library_id),
        caption           = COALESCE($11, caption),
        status            = COALESCE($12, status),
        scheduled_at      = CASE WHEN $13 THEN $14::timestamptz ELSE scheduled_at END,
        updated_at        = NOW()
       WHERE id = $15
       RETURNING *`,
      [
        from_number       || null,
        recipient_numbers ? JSON.stringify(recipient_numbers) : null,
        template_id       || null,
        test_number       || null,
        name              || null,
        variable_mapping  ? JSON.stringify(variable_mapping) : null,
        message_type      || null,
        body              || null,
        url               || null,
        media_library_id  || null,
        caption           || null,
        newStatus,               // $12
        touchScheduledAt,        // $13 — whether to overwrite scheduled_at
        newScheduledAt,          // $14 — new value (null = clear it)
        req.params.id,           // $15
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[broadcasts] PUT /broadcasts/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update broadcast' });
  }
});

// DELETE /broadcasts/:id
router.delete('/broadcasts/:id', requirePermission('bulk-message'), async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM coexistence.broadcasts WHERE id = $1', [req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Broadcast not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[broadcasts] DELETE /broadcasts/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete broadcast' });
  }
});

// POST /broadcasts/:id/send — real Meta send, one job per recipient via BullMQ
router.post('/broadcasts/:id/send', requirePermission('bulk-message'), async (req, res) => {
  try {
    const { rows: bRows } = await pool.query(
      `SELECT b.*, t.id AS t_id, t.name AS t_name, t.language AS t_language, t.body AS t_body,
              t.header_type AS t_header_type, t.header_text AS t_header_text, t.footer AS t_footer, t.buttons AS t_buttons
         FROM coexistence.broadcasts b
         LEFT JOIN coexistence.message_templates t ON t.id = b.template_id
        WHERE b.id = $1`,
      [req.params.id]
    );
    if (bRows.length === 0) return res.status(404).json({ error: 'Broadcast not found' });
    const broadcast = bRows[0];
    const template = broadcast.message_type === 'template'
      ? { id: broadcast.t_id, name: broadcast.t_name, language: broadcast.t_language, body: broadcast.t_body,
          header_type: broadcast.t_header_type, header_text: broadcast.t_header_text, footer: broadcast.t_footer, buttons: broadcast.t_buttons }
      : null;

    const { account, error } = await resolveAccount({ fromPhoneNumber: broadcast.from_number });
    if (error) return res.status(400).json({ error });

    const recipients = Array.isArray(broadcast.recipient_numbers) ? broadcast.recipient_numbers : [];
    if (recipients.length === 0) return res.status(400).json({ error: 'No recipients selected' });

    // Resolve media once for media-type broadcasts
    let resolvedMediaId = null;
    // Resolve the media id for media-type broadcasts AND for template broadcasts
    // whose template has a media header (IMAGE/VIDEO/DOCUMENT) — both pull from
    // broadcast.media_library_id.
    const _tplHt = template ? String(template.header_type || '').toUpperCase() : '';
    const _needsHeaderMedia = broadcast.message_type === 'template' && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(_tplHt);
    if ((['image', 'video', 'audio', 'document'].includes(broadcast.message_type) || _needsHeaderMedia) && broadcast.media_library_id) {
      const { syncMediaToAccount } = require('./mediaLibrary');
      const { rows: mRows } = await pool.query(
        `SELECT * FROM coexistence.media_library WHERE id = $1 AND deleted_at IS NULL`,
        [broadcast.media_library_id]
      );
      if (mRows.length) {
        const media = mRows[0];
        const { rows: sRows } = await pool.query(
          `SELECT * FROM coexistence.media_meta_sync WHERE media_id = $1 AND account_id = $2`,
          [media.id, account.id]
        );
        let sync = sRows[0];
        const needsSync = !sync || sync.status !== 'synced' || !sync.meta_media_id || (sync.expires_at && new Date(sync.expires_at) <= new Date());
        if (needsSync) {
          sync = await syncMediaToAccount(media.id, account.id);
          sync = {
            meta_media_id: sync.metaMediaId,
            expires_at: sync.expiresAt,
            status: sync.status,
          };
        }
        resolvedMediaId = sync.meta_media_id;
      }
    }

    await pool.query(
      `UPDATE coexistence.broadcasts SET status = 'SENDING', updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    let enqueued = 0;
    for (const r of recipients) {
      const recipient = typeof r === 'string' ? { contact_number: r, name: '' } : r;
      const { rows: logRows } = await pool.query(
        `INSERT INTO coexistence.broadcast_logs (broadcast_id, action, sent_to, status)
         VALUES ($1, 'BROADCAST', $2, 'PENDING') RETURNING id`,
        [req.params.id, recipient.contact_number]
      );
      try {
        await enqueueBroadcastRecipient({
          broadcast, template, account, recipient, broadcastLogId: logRows[0].id, resolvedMediaId,
        });
        enqueued++;
      } catch (jobErr) {
        await pool.query(
          `UPDATE coexistence.broadcast_logs SET status='failed', error_message=$1 WHERE id=$2`,
          [jobErr.message.slice(0, 500), logRows[0].id]
        );
      }
    }

    await pool.query(
      `UPDATE coexistence.broadcasts SET status = 'SENT', updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    const data = await getBroadcastWithLogs(req.params.id);
    res.json({ ...data, enqueued });
  } catch (err) {
    console.error('[broadcasts] POST /broadcasts/:id/send error:', err.message);
    res.status(500).json({ error: 'Failed to send broadcast' });
  }
});

// POST /broadcasts/:id/test — real Meta send to a single test number
router.post('/broadcasts/:id/test', requirePermission('bulk-message'), async (req, res) => {
  try {
    const { test_number } = req.body;
    if (!test_number) return res.status(400).json({ error: 'test_number required' });

    const { rows: bRows } = await pool.query(
      `SELECT b.*, t.id AS t_id, t.name AS t_name, t.language AS t_language, t.body AS t_body,
              t.header_type AS t_header_type, t.header_text AS t_header_text, t.footer AS t_footer, t.buttons AS t_buttons
         FROM coexistence.broadcasts b
         LEFT JOIN coexistence.message_templates t ON t.id = b.template_id
        WHERE b.id = $1`,
      [req.params.id]
    );
    if (bRows.length === 0) return res.status(404).json({ error: 'Broadcast not found' });
    const broadcast = bRows[0];
    const template = broadcast.message_type === 'template'
      ? { id: broadcast.t_id, name: broadcast.t_name, language: broadcast.t_language, body: broadcast.t_body,
          header_type: broadcast.t_header_type, header_text: broadcast.t_header_text, footer: broadcast.t_footer, buttons: broadcast.t_buttons }
      : null;

    const { account, error } = await resolveAccount({ fromPhoneNumber: broadcast.from_number });
    if (error) return res.status(400).json({ error });

    // Resolve media once for media-type broadcasts
    let resolvedMediaId = null;
    // Resolve the media id for media-type broadcasts AND for template broadcasts
    // whose template has a media header (IMAGE/VIDEO/DOCUMENT) — both pull from
    // broadcast.media_library_id.
    const _tplHt = template ? String(template.header_type || '').toUpperCase() : '';
    const _needsHeaderMedia = broadcast.message_type === 'template' && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(_tplHt);
    if ((['image', 'video', 'audio', 'document'].includes(broadcast.message_type) || _needsHeaderMedia) && broadcast.media_library_id) {
      const { syncMediaToAccount } = require('./mediaLibrary');
      const { rows: mRows } = await pool.query(
        `SELECT * FROM coexistence.media_library WHERE id = $1 AND deleted_at IS NULL`,
        [broadcast.media_library_id]
      );
      if (mRows.length) {
        const media = mRows[0];
        const { rows: sRows } = await pool.query(
          `SELECT * FROM coexistence.media_meta_sync WHERE media_id = $1 AND account_id = $2`,
          [media.id, account.id]
        );
        let sync = sRows[0];
        const needsSync = !sync || sync.status !== 'synced' || !sync.meta_media_id || (sync.expires_at && new Date(sync.expires_at) <= new Date());
        if (needsSync) {
          sync = await syncMediaToAccount(media.id, account.id);
          sync = {
            meta_media_id: sync.metaMediaId,
            expires_at: sync.expiresAt,
            status: sync.status,
          };
        }
        resolvedMediaId = sync.meta_media_id;
      }
    }

    const { rows: logRows } = await pool.query(
      `INSERT INTO coexistence.broadcast_logs (broadcast_id, action, sent_to, status)
       VALUES ($1, 'TEST', $2, 'PENDING') RETURNING id`,
      [req.params.id, test_number]
    );

    await enqueueBroadcastRecipient({
      broadcast, template, account,
      recipient: { contact_number: test_number, name: 'Test' },
      broadcastLogId: logRows[0].id,
      resolvedMediaId,
    });

    await pool.query(
      `UPDATE coexistence.broadcasts SET test_number = $1, updated_at = NOW() WHERE id = $2`,
      [test_number, req.params.id]
    );

    const data = await getBroadcastWithLogs(req.params.id);
    res.json(data);
  } catch (err) {
    console.error('[broadcasts] POST /broadcasts/:id/test error:', err.message);
    res.status(500).json({ error: 'Failed to send test' });
  }
});

// POST /broadcasts/:id/cancel-schedule — cancel a SCHEDULED broadcast, put it back to DRAFT
router.post('/broadcasts/:id/cancel-schedule', requirePermission('bulk-message'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE coexistence.broadcasts
          SET status = 'DRAFT', scheduled_at = NULL, updated_at = NOW()
        WHERE id = $1 AND status = 'SCHEDULED'
        RETURNING *`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Broadcast not found or not in SCHEDULED status' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('[broadcasts] cancel-schedule error:', err.message);
    res.status(500).json({ error: 'Failed to cancel schedule' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// executeBroadcast(broadcastId)
//
// Shared function used by BOTH:
//   - POST /broadcasts/:id/send  (the "Broadcast Now" button)
//   - broadcastScheduler.js      (the background scheduler)
//
// This means scheduled broadcasts use the EXACT same send logic as manual sends.
// ─────────────────────────────────────────────────────────────────────────────
async function executeBroadcast(broadcastId) {
  const { rows: bRows } = await pool.query(
    `SELECT b.*, t.id AS t_id, t.name AS t_name, t.language AS t_language, t.body AS t_body,
            t.header_type AS t_header_type, t.header_text AS t_header_text,
            t.footer AS t_footer, t.buttons AS t_buttons
       FROM coexistence.broadcasts b
       LEFT JOIN coexistence.message_templates t ON t.id = b.template_id
      WHERE b.id = $1`,
    [broadcastId]
  );
  if (bRows.length === 0) throw new Error(`Broadcast ${broadcastId} not found`);
  const broadcast = bRows[0];

  const template = broadcast.message_type === 'template'
    ? {
        id: broadcast.t_id, name: broadcast.t_name, language: broadcast.t_language,
        body: broadcast.t_body, header_type: broadcast.t_header_type,
        header_text: broadcast.t_header_text, footer: broadcast.t_footer,
        buttons: broadcast.t_buttons,
      }
    : null;

  const { account, error } = await resolveAccount({ fromPhoneNumber: broadcast.from_number });
  if (error) throw new Error(`Account resolve error: ${error}`);

  const recipients = Array.isArray(broadcast.recipient_numbers) ? broadcast.recipient_numbers : [];
  if (recipients.length === 0) throw new Error('No recipients');

  // Resolve media for media-type broadcasts and template broadcasts with media headers
  let resolvedMediaId = null;
  const _tplHt = template ? String(template.header_type || '').toUpperCase() : '';
  const _needsHeaderMedia = broadcast.message_type === 'template' && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(_tplHt);
  if ((['image', 'video', 'audio', 'document'].includes(broadcast.message_type) || _needsHeaderMedia) && broadcast.media_library_id) {
    const { syncMediaToAccount } = require('./mediaLibrary');
    const { rows: mRows } = await pool.query(
      `SELECT * FROM coexistence.media_library WHERE id = $1 AND deleted_at IS NULL`,
      [broadcast.media_library_id]
    );
    if (mRows.length) {
      const media = mRows[0];
      const { rows: sRows } = await pool.query(
        `SELECT * FROM coexistence.media_meta_sync WHERE media_id = $1 AND account_id = $2`,
        [media.id, account.id]
      );
      let sync = sRows[0];
      const needsSync = !sync || sync.status !== 'synced' || !sync.meta_media_id ||
        (sync.expires_at && new Date(sync.expires_at) <= new Date());
      if (needsSync) {
        sync = await syncMediaToAccount(media.id, account.id);
        sync = { meta_media_id: sync.metaMediaId, expires_at: sync.expiresAt, status: sync.status };
      }
      resolvedMediaId = sync.meta_media_id;
    }
  }

  await pool.query(
    `UPDATE coexistence.broadcasts SET status = 'SENDING', updated_at = NOW() WHERE id = $1`,
    [broadcastId]
  );

  let enqueued = 0;
  for (const r of recipients) {
    const recipient = typeof r === 'string' ? { contact_number: r, name: '' } : r;
    const { rows: logRows } = await pool.query(
      `INSERT INTO coexistence.broadcast_logs (broadcast_id, action, sent_to, status)
       VALUES ($1, 'BROADCAST', $2, 'PENDING') RETURNING id`,
      [broadcastId, recipient.contact_number]
    );
    try {
      await enqueueBroadcastRecipient({
        broadcast, template, account, recipient,
        broadcastLogId: logRows[0].id, resolvedMediaId,
      });
      enqueued++;
    } catch (jobErr) {
      await pool.query(
        `UPDATE coexistence.broadcast_logs SET status='failed', error_message=$1 WHERE id=$2`,
        [jobErr.message.slice(0, 500), logRows[0].id]
      );
    }
  }

  await pool.query(
    `UPDATE coexistence.broadcasts SET status = 'SENT', updated_at = NOW() WHERE id = $1`,
    [broadcastId]
  );

  console.log(`[broadcasts] executeBroadcast ${broadcastId} complete — ${enqueued} enqueued`);
  return enqueued;
}

module.exports = { router, executeBroadcast };
