const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requirePermission } = require('../middleware/access');
const { resolveAccount, insertPendingRow } = require('../services/messageSender');
const { enqueueSend } = require('../queue/sendQueue');

// Phase 7.12B fix: POST /broadcasts and PUT /broadcasts/:id previously wrote
// a client-supplied template_id / media_library_id straight into the
// broadcasts row with no ownership check, so an authenticated user in one
// workspace could reference another workspace's template or media item by
// id. Mirrors the validateReferences() pattern already used by
// routes/campaigns.js for the same fields — never trust a client-supplied
// id without confirming it belongs to req.workspace.id (server-resolved).
async function validateBroadcastReferences(workspaceId, { templateId, mediaLibraryId }) {
  if (templateId) {
    const { rows } = await pool.query(
      'SELECT id FROM coexistence.message_templates WHERE id = $1 AND workspace_id = $2',
      [templateId, workspaceId]
    );
    if (!rows.length) return 'template_id does not belong to this workspace';
  }
  if (mediaLibraryId) {
    const { rows } = await pool.query(
      'SELECT id FROM coexistence.media_library WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL',
      [mediaLibraryId, workspaceId]
    );
    if (!rows.length) return 'media_library_id does not belong to this workspace';
  }
  return null;
}

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
  // Retarget module — per-recipient exit URL, pre-resolved by
  // services/retargetUrlResolver.js and attached to the recipient object
  // (recipient.retargetUrl) before this broadcast is enqueued. Falls back to
  // the Invi homepage if a recipient somehow reaches here without one.
  out = out.replace(/\{\{contact\.retargetURL\}\}/g, recipient.retargetUrl || 'https://www.invicreation.com/');
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

// Phase 6 Part 3C — atomic double-send guard for a whole broadcast execution.
//
// Investigation finding: unlike routes/campaigns.js's POST /:id/send (which
// already row-locks the campaign and only proceeds from 'draft'/'scheduled'),
// sendBroadcastById/executeBroadcast had NO such guard — every call
// unconditionally set status='SENDING' and inserted a brand-new PENDING
// broadcast_logs row + enqueued a fresh send for EVERY recipient, including
// ones that had already succeeded. A double-click on Broadcast Studio's Send
// button, a network retry of the POST, or the scheduler firing twice on the
// same row would therefore resend to every recipient a second time — exactly
// the "successful recipient gets resent" failure Part 3C Step 3/4 asks to
// rule out. BullMQ's own attempts/backoff (queue/sendQueue.js) already
// retries a single failed job safely and only for that one recipient; this
// guard is the missing piece one level up — it stops a second whole-broadcast
// execution from ever starting, using the exact same row-lock pattern
// campaigns.js already uses. It is not a new retry system: it protects the
// existing one from being invoked twice on the same broadcast.
//
// Broadcast status only ever holds DRAFT/SCHEDULED/SENDING in the DB (SENT/
// PARTIAL/FAILED are display-only, derived at read time by
// computeDisplayStatus) — so once a broadcast reaches SENDING it must never
// be claimed again; there is no terminal DB status to "retry from".
async function claimBroadcastForSending(broadcastId, workspaceId /* nullable for scheduler/background context */) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const params = workspaceId != null ? [broadcastId, workspaceId] : [broadcastId];
    const { rows } = await client.query(
      `SELECT status FROM coexistence.broadcasts WHERE id = $1${workspaceId != null ? ' AND workspace_id = $2' : ''} FOR UPDATE`,
      params
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return { claimed: false, reason: 'not_found' };
    }
    if (!['DRAFT', 'SCHEDULED'].includes(rows[0].status)) {
      await client.query('ROLLBACK');
      return { claimed: false, reason: 'already_sent', status: rows[0].status };
    }
    await client.query(
      `UPDATE coexistence.broadcasts SET status = 'SENDING', updated_at = NOW() WHERE id = $1`,
      [broadcastId]
    );
    await client.query('COMMIT');
    return { claimed: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Single source of truth for turning a broadcast's raw lifecycle status +
// its recipients' terminal outcomes into the status the UI actually shows.
// Mirrors GET /broadcasts' SQL CASE exactly (see router.get('/broadcasts')
// below) so the list and detail endpoints can never disagree.
//   DRAFT/SCHEDULED        -> passthrough (recipients don't exist yet)
//   any PENDING recipient  -> SENDING (still in flight)
//   all recipients failed  -> FAILED
//   some failed, some ok   -> PARTIAL
//   all recipients ok      -> SENT
//   no BROADCAST logs yet  -> passthrough raw status (e.g. SENDING)
function computeDisplayStatus(rawStatus, { pending_count = 0, failed_count = 0, success_count = 0 } = {}) {
  if (rawStatus === 'DRAFT') return 'DRAFT';
  if (rawStatus === 'SCHEDULED') return 'SCHEDULED';
  if (pending_count > 0) return 'SENDING';
  if (failed_count > 0 && success_count === 0) return 'FAILED';
  if (failed_count > 0) return 'PARTIAL';
  if (success_count > 0) return 'SENT';
  return rawStatus;
}

// ─── Part 3E: Delivery rollup (SENT/DELIVERED/READ/FAILED/PENDING) ─────────
//
// Root cause of the "recipient table shows sent/sent but Delivery shows all
// zeroes" bug: the old rollup derived SENT/DELIVERED/READ *entirely* from a
// `LEFT JOIN coexistence.chat_history ch ON ch.message_id = bl.wa_message_id`
// — i.e. a recipient only counted as "sent" if a chat_history row happened to
// exist and join cleanly. coexistence.broadcast_logs.status is the value
// that's actually proven reliable elsewhere in this file (computeDisplayStatus,
// the list endpoint's SQL CASE, campaigns.js's reconcileCampaignStatus all key
// off it directly) and is exactly what the recipient table below the counters
// already renders — so whenever a broadcast_logs row said 'sent' but its
// chat_history join didn't resolve (missing row, replica lag, any transformation
// that touches message_id/wa_message_id), the counters silently disagreed with
// the table sitting right underneath them.
//
// Fix: broadcast_logs.status is the FLOOR for "sent" (it's already known-good —
// see above), and chat_history is used only to layer on the more granular
// delivered/read signal that only Meta's webhook status receipts carry (Part 3B:
// broadcast_logs itself is never written 'delivered'/'read', only chat_history
// is). A recipient never needs its chat_history row to resolve just to be
// counted as "sent" once broadcast_logs already says so.
//
// normalizeStatus() exists because status casing is inconsistent in this schema
// by design — broadcast_logs.status is 'PENDING' (uppercase) while every
// terminal status ('sent'/'delivered'/'read'/'failed') is lowercase (see the
// INSERT/UPDATE statements throughout this file and campaigns.js). Rather than
// rewriting stored values, casing is normalized once, here, at the aggregation
// boundary.
function normalizeStatus(status) {
  return typeof status === 'string' ? status.toLowerCase() : status;
}

// Pure function, exported for unit testing — takes the same `recipients` rows
// getBroadcastWithLogs already fetches (bl.status, bl.wa_message_id) plus a
// { [wa_message_id]: chat_history.status } map, and returns the exact shape
// the frontend's Delivery section reads (statusRollup.{sent,delivered,read,
// failed,pending}). No DB access — safe to call with zero recipients.
function computeDeliveryRollup(recipients, chatStatusByMessageId = {}) {
  let pending = 0, failed = 0, sent = 0, delivered = 0, read = 0;

  for (const r of recipients || []) {
    const blStatus = normalizeStatus(r.status);
    const chStatus = r.wa_message_id ? normalizeStatus(chatStatusByMessageId[r.wa_message_id]) : null;

    if (blStatus === 'pending') pending++;
    if (blStatus === 'failed') failed++;

    // "sent" = broadcast_logs already confirms it (or better), OR
    // chat_history's more granular status confirms it — either signal is
    // sufficient; neither is required to have the other.
    if (['sent', 'delivered', 'read'].includes(blStatus) || ['sent', 'delivered', 'read'].includes(chStatus)) {
      sent++;
    }
    // delivered/read can only ever come from chat_history (Part 3B: Meta's
    // webhook status receipts are the only place these are recorded).
    if (chStatus === 'delivered' || chStatus === 'read') delivered++;
    if (chStatus === 'read') read++;
  }

  return { total: (recipients || []).length, pending, failed, sent, delivered, read };
}

// workspaceId is mandatory and must always come from req.workspace.id
// (never the client) — a broadcast id from another workspace resolves as
// "not found", not leaking its data or logs.
async function getBroadcastWithLogs(id, workspaceId) {
  const { rows: bRows } = await pool.query(
    `SELECT b.*, t.name AS template_name, t.category AS template_category,
            t.language AS template_language, t.header_type, t.header_text,
            t.media_handle, t.body AS template_body, t.footer AS template_footer,
            t.buttons AS template_buttons, t.samples AS template_samples,
            t.security_recommendation, t.code_expiry_minutes
     FROM coexistence.broadcasts b
     LEFT JOIN coexistence.message_templates t ON t.id = b.template_id
     WHERE b.id = $1 AND b.workspace_id = $2`,
    [id, workspaceId]
  );
  if (bRows.length === 0) return null;

  // Aggregate BROADCAST logs (counts only — the display-status derivation
  // itself happens in JS below via computeDisplayStatus, so this stays in
  // lockstep with the list endpoint's SQL CASE in GET /broadcasts instead of
  // drifting into its own separate copy of the same logic).
  const { rows: broadcastAgg } = await pool.query(
    `SELECT
       COUNT(*)::int AS recipient_count,
       MAX(sent_at) AS sent_at,
       COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending_count,
       COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
       COUNT(*) FILTER (WHERE status IN ('sent','delivered','read'))::int AS success_count,
       ARRAY_AGG(DISTINCT error_message) FILTER (WHERE error_message IS NOT NULL) AS errors
     FROM coexistence.broadcast_logs
     WHERE broadcast_id = $1 AND action = 'BROADCAST'`,
    [id]
  );

  // Individual recipient records for a real BROADCAST — previously these
  // were only ever collapsed into the single synthetic aggregate row below,
  // hiding per-recipient failures from the UI. Exposed here in ADDITION to
  // (not instead of) the aggregate row.
  const { rows: recipients } = await pool.query(
    `SELECT id, sent_to, status, wa_message_id, error_message, sent_at
     FROM coexistence.broadcast_logs
     WHERE broadcast_id = $1 AND action = 'BROADCAST'
     ORDER BY sent_at DESC NULLS LAST, id DESC`,
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
  //
  // See computeDeliveryRollup's doc comment above for why this is no longer a
  // single SQL join: broadcast_logs.status (already fetched into `recipients`
  // above) is the floor for "sent", and chat_history is only consulted here —
  // by message id, for the wa_message_ids we actually have — to layer on
  // delivered/read. A recipient's chat_history row failing to exist/join no
  // longer erases a "sent" that broadcast_logs already confirmed.
  const waMessageIds = recipients.map((r) => r.wa_message_id).filter(Boolean);
  let chatStatusByMessageId = {};
  if (waMessageIds.length > 0) {
    const { rows: chatRows } = await pool.query(
      `SELECT message_id, status FROM coexistence.chat_history WHERE message_id = ANY($1)`,
      [waMessageIds]
    );
    chatStatusByMessageId = Object.fromEntries(chatRows.map((c) => [c.message_id, c.status]));
  }
  const rollup = [computeDeliveryRollup(recipients, chatStatusByMessageId)];

  const agg = broadcastAgg[0] || {};
  const displayStatus = computeDisplayStatus(bRows[0].status, agg);

  // Normalise aggregated BROADCAST row to match the log shape the frontend expects
  const logs = [];
  if (agg.recipient_count > 0) {
    logs.push({
      id: `broadcast-${id}`,
      action: 'BROADCAST',
      sent_to: `${agg.recipient_count} contact${agg.recipient_count !== 1 ? 's' : ''}`,
      status: displayStatus,
      sent_at: agg.sent_at,
      wa_message_id: null,
      error_message: agg.errors?.length ? agg.errors.join('; ') : null,
      _recipientCount: agg.recipient_count,
    });
  }
  logs.push(...testLogs);
  logs.sort((a, b) => new Date(b.sent_at || 0) - new Date(a.sent_at || 0));

  return {
    ...bRows[0],
    // The broadcast's own lifecycle status column (DRAFT/SCHEDULED/SENDING)
    // is left untouched in the DB (see executeBroadcast/POST /:id/send — they
    // no longer stamp a terminal SENT the moment jobs are enqueued); the
    // *displayed* status here is derived from actual recipient outcomes,
    // exactly like GET /broadcasts already does.
    status: displayStatus,
    logs,
    recipients,
    statusRollup: rollup[0] || {},
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /broadcasts — list all with template name and live status rollup
router.get('/broadcasts', async (req, res) => {
  try {
    // workspaceId always comes from req.workspace (attachWorkspace, mounted
    // globally in index.js) — never from the client. No workspace resolved
    // for this session -> no broadcasts, never another workspace's, fail
    // closed exactly like every other Phase 3 module.
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.json([]);

    const { status } = req.query;
    const params = [workspaceId];
    const statusParamIdx = status && status !== 'all' ? (params.push(status), params.length) : null;

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
                      WHEN COUNT(*) FILTER (WHERE bl.status = 'PENDING') > 0 THEN 'SENDING'
WHEN COUNT(*) FILTER (WHERE bl.status = 'failed') > 0
 AND COUNT(*) FILTER (WHERE bl.status IN ('sent','delivered','read')) = 0 THEN 'FAILED'
WHEN COUNT(*) FILTER (WHERE bl.status = 'failed') > 0 THEN 'PARTIAL'
WHEN COUNT(*) FILTER (WHERE bl.status IN ('sent','delivered','read')) > 0 THEN 'SENT'
WHEN b.status = 'SENDING' THEN 'SENDING'
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
         WHERE b.workspace_id = $1
       )
       SELECT * FROM base
       ${statusParamIdx ? `WHERE display_status = $${statusParamIdx}` : ''}
       ORDER BY created_at DESC`,
      params
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
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(404).json({ error: 'Broadcast not found' });
    const data = await getBroadcastWithLogs(req.params.id, workspaceId);
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
    // workspaceId always comes from req.workspace, never the client.
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

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

    // Phase 7.12B fix: confirm any client-supplied template_id/media_library_id
    // actually belongs to this workspace before it's ever written to the row.
    const refError = await validateBroadcastReferences(workspaceId, {
      templateId: template_id || null,
      mediaLibraryId: media_library_id || null,
    });
    if (refError) return res.status(400).json({ error: refError });

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
         (workspace_id, from_number, recipient_numbers, template_id, status, test_number, name,
          variable_mapping, message_type, body, url, media_library_id, caption,
          scheduled_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
         RETURNING *`,
        [
          workspaceId,
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
          `INSERT INTO coexistence.broadcast_logs (broadcast_id, workspace_id, action, sent_to, status)
           VALUES ($1, $2, $3, $4, $5)`,
          [broadcast.id, workspaceId, 'TEST', test_number, 'PENDING']
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
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(404).json({ error: 'Broadcast not found' });

    const { rows: existing } = await pool.query(
      'SELECT status FROM coexistence.broadcasts WHERE id = $1 AND workspace_id = $2', [req.params.id, workspaceId]
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

    // Phase 7.12B fix: same ownership check as POST /broadcasts — a
    // client-supplied template_id/media_library_id must belong to this
    // workspace before it's written into the existing row.
    const refError = await validateBroadcastReferences(workspaceId, {
      templateId: template_id || null,
      mediaLibraryId: media_library_id || null,
    });
    if (refError) return res.status(400).json({ error: refError });

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
       WHERE id = $15 AND workspace_id = $16
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
        workspaceId,              // $16
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
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(404).json({ error: 'Broadcast not found' });
    const { rowCount } = await pool.query(
      'DELETE FROM coexistence.broadcasts WHERE id = $1 AND workspace_id = $2', [req.params.id, workspaceId]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Broadcast not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[broadcasts] DELETE /broadcasts/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete broadcast' });
  }
});

// POST /broadcasts/:id/send — real Meta send, one job per recipient via BullMQ
// Campaign Studio Part 3A: the actual "dispatch this broadcast" logic lives
// here, extracted verbatim from the route handler below, so that
// routes/campaigns.js's Send Now endpoint can delegate to the EXACT same
// send/queue/Meta pipeline instead of re-implementing any part of it.
// Returns { statusCode, body } — never throws for expected/handled failures
// (bad broadcast id, no account, no recipients), only for genuinely
// unexpected errors, which callers should catch themselves.
async function sendBroadcastById(workspaceId, broadcastId) {
  if (!workspaceId) return { statusCode: 404, body: { error: 'Broadcast not found' } };

  const { rows: bRows } = await pool.query(
    `SELECT b.*, t.id AS t_id, t.name AS t_name, t.language AS t_language, t.body AS t_body,
            t.header_type AS t_header_type, t.header_text AS t_header_text, t.footer AS t_footer, t.buttons AS t_buttons
       FROM coexistence.broadcasts b
       LEFT JOIN coexistence.message_templates t ON t.id = b.template_id
      WHERE b.id = $1 AND b.workspace_id = $2`,
    [broadcastId, workspaceId]
  );
  if (bRows.length === 0) return { statusCode: 404, body: { error: 'Broadcast not found' } };
  const broadcast = bRows[0];
  const template = broadcast.message_type === 'template'
    ? { id: broadcast.t_id, name: broadcast.t_name, language: broadcast.t_language, body: broadcast.t_body,
        header_type: broadcast.t_header_type, header_text: broadcast.t_header_text, footer: broadcast.t_footer, buttons: broadcast.t_buttons }
    : null;

  const { account, error } = await resolveAccount({ fromPhoneNumber: broadcast.from_number, workspaceId });
  if (error) return { statusCode: 400, body: { error } };

  const recipients = Array.isArray(broadcast.recipient_numbers) ? broadcast.recipient_numbers : [];
  if (recipients.length === 0) return { statusCode: 400, body: { error: 'No recipients selected' } };

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
      `SELECT * FROM coexistence.media_library WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
      [broadcast.media_library_id, broadcast.workspace_id]
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
        sync = await syncMediaToAccount(media.id, account.id, broadcast.workspace_id);
        sync = {
          meta_media_id: sync.metaMediaId,
          expires_at: sync.expiresAt,
          status: sync.status,
        };
      }
      resolvedMediaId = sync.meta_media_id;
    }
  }

  // Atomically claim this broadcast: only a row currently DRAFT/SCHEDULED can
  // start sending, and the claim (row lock + status flip) happens as one
  // transaction — see claimBroadcastForSending's doc comment above. A second
  // concurrent/duplicate call (double-click, retried POST) sees status
  // already SENDING and is rejected before any recipient is touched, so
  // already-succeeded recipients from the first call can never be resent.
  const claim = await claimBroadcastForSending(broadcastId, workspaceId);
  if (!claim.claimed) {
    if (claim.reason === 'not_found') return { statusCode: 404, body: { error: 'Broadcast not found' } };
    // already_sent — return the current state instead of erroring; the
    // caller (e.g. a duplicate POST) gets the real, already-in-progress
    // broadcast back rather than a confusing failure.
    const data = await getBroadcastWithLogs(broadcastId, workspaceId);
    return { statusCode: 200, body: { ...data, enqueued: 0, alreadySent: true } };
  }

  let enqueued = 0;
  for (const r of recipients) {
    const recipient = typeof r === 'string' ? { contact_number: r, name: '' } : r;
    const { rows: logRows } = await pool.query(
      `INSERT INTO coexistence.broadcast_logs (broadcast_id, workspace_id, action, sent_to, status)
       VALUES ($1, $2, 'BROADCAST', $3, 'PENDING') RETURNING id`,
      [broadcastId, workspaceId, recipient.contact_number]
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

  // NOTE: the broadcast intentionally stays 'SENDING' here — do not stamp
  // a terminal SENT just because jobs were enqueued (see requirement A).
  // getBroadcastWithLogs() below derives the real display status from
  // each recipient's terminal outcome once their jobs actually complete.

  const data = await getBroadcastWithLogs(broadcastId, workspaceId);
  return { statusCode: 200, body: { ...data, enqueued } };
}

router.post('/broadcasts/:id/send', requirePermission('bulk-message'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    const { statusCode, body } = await sendBroadcastById(workspaceId, req.params.id);
    res.status(statusCode).json(body);
  } catch (err) {
    console.error('[broadcasts] POST /broadcasts/:id/send error:', err.message);
    res.status(500).json({ error: 'Failed to send broadcast' });
  }
});

// POST /broadcasts/:id/test — real Meta send to a single test number
router.post('/broadcasts/:id/test', requirePermission('bulk-message'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(404).json({ error: 'Broadcast not found' });

    const { test_number } = req.body;
    if (!test_number) return res.status(400).json({ error: 'test_number required' });

    const { rows: bRows } = await pool.query(
      `SELECT b.*, t.id AS t_id, t.name AS t_name, t.language AS t_language, t.body AS t_body,
              t.header_type AS t_header_type, t.header_text AS t_header_text, t.footer AS t_footer, t.buttons AS t_buttons
         FROM coexistence.broadcasts b
         LEFT JOIN coexistence.message_templates t ON t.id = b.template_id
        WHERE b.id = $1 AND b.workspace_id = $2`,
      [req.params.id, workspaceId]
    );
    if (bRows.length === 0) return res.status(404).json({ error: 'Broadcast not found' });
    const broadcast = bRows[0];
    const template = broadcast.message_type === 'template'
      ? { id: broadcast.t_id, name: broadcast.t_name, language: broadcast.t_language, body: broadcast.t_body,
          header_type: broadcast.t_header_type, header_text: broadcast.t_header_text, footer: broadcast.t_footer, buttons: broadcast.t_buttons }
      : null;

    const { account, error } = await resolveAccount({ fromPhoneNumber: broadcast.from_number, workspaceId: req.workspace?.id });
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
        `SELECT * FROM coexistence.media_library WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
        [broadcast.media_library_id, broadcast.workspace_id]
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
          sync = await syncMediaToAccount(media.id, account.id, broadcast.workspace_id);
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
      `INSERT INTO coexistence.broadcast_logs (broadcast_id, workspace_id, action, sent_to, status)
       VALUES ($1, $2, 'TEST', $3, 'PENDING') RETURNING id`,
      [req.params.id, workspaceId, test_number]
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

    const data = await getBroadcastWithLogs(req.params.id, workspaceId);
    res.json(data);
  } catch (err) {
    console.error('[broadcasts] POST /broadcasts/:id/test error:', err.message);
    res.status(500).json({ error: 'Failed to send test' });
  }
});

// POST /broadcasts/:id/cancel-schedule — cancel a SCHEDULED broadcast, put it back to DRAFT
router.post('/broadcasts/:id/cancel-schedule', requirePermission('bulk-message'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(404).json({ error: 'Broadcast not found or not in SCHEDULED status' });
    const { rows } = await pool.query(
      `UPDATE coexistence.broadcasts
          SET status = 'DRAFT', scheduled_at = NULL, updated_at = NOW()
        WHERE id = $1 AND status = 'SCHEDULED' AND workspace_id = $2
        RETURNING *`,
      [req.params.id, workspaceId]
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

  // Background/scheduler context — no req here, so workspace is derived
  // strictly from the stored broadcast row itself (broadcast.workspace_id,
  // Phase 3F-1B), never from a request. This scopes the account resolution
  // (including its "default account" fallback) to that broadcast's own
  // workspace, so a scheduled broadcast can never resolve or send from
  // another workspace's WhatsApp account even if a from_number happened to
  // collide across workspaces.
  const { account, error } = await resolveAccount({ fromPhoneNumber: broadcast.from_number, workspaceId: broadcast.workspace_id });
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
      `SELECT * FROM coexistence.media_library WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
      [broadcast.media_library_id, broadcast.workspace_id]
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
        sync = await syncMediaToAccount(media.id, account.id, broadcast.workspace_id);
        sync = { meta_media_id: sync.metaMediaId, expires_at: sync.expiresAt, status: sync.status };
      }
      resolvedMediaId = sync.meta_media_id;
    }
  }

  // NOTE: unlike sendBroadcastById below, this function deliberately does
  // NOT call claimBroadcastForSending. Its one caller, broadcastScheduler.js's
  // runSchedulerTick, already performs its own atomic claim first — it
  // SELECTs due rows with FOR UPDATE SKIP LOCKED, flips them to 'SENDING'
  // while still holding that lock, and only then (after releasing the lock)
  // calls executeBroadcast — see runSchedulerTick's "Immediately mark all of
  // them as SENDING while we still hold the lock" step. By the time
  // executeBroadcast runs here the row is therefore already 'SENDING', so a
  // second claim attempt would always find it non-DRAFT/SCHEDULED and
  // wrongly reject the scheduler's own legitimate, already-claimed fire.
  // SKIP LOCKED + the immediate status flip is that pathway's full
  // duplicate-fire protection; adding a second one would just conflict.
  await pool.query(
    `UPDATE coexistence.broadcasts SET status = 'SENDING', updated_at = NOW() WHERE id = $1`,
    [broadcastId]
  );

  let enqueued = 0;
  for (const r of recipients) {
    const recipient = typeof r === 'string' ? { contact_number: r, name: '' } : r;
    const { rows: logRows } = await pool.query(
      `INSERT INTO coexistence.broadcast_logs (broadcast_id, workspace_id, action, sent_to, status)
       VALUES ($1, $2, 'BROADCAST', $3, 'PENDING') RETURNING id`,
      [broadcastId, broadcast.workspace_id, recipient.contact_number]
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

  // NOTE: intentionally no terminal SENT stamp here — see requirement A.
  // The broadcast remains 'SENDING' until recipient jobs reach terminal
  // states; getBroadcastWithLogs()/GET /broadcasts derive the real display
  // status (SENT/PARTIAL/FAILED) from broadcast_logs at read time.

  console.log(`[broadcasts] executeBroadcast ${broadcastId} complete — ${enqueued} enqueued`);
  return enqueued;
}

module.exports = {
  router, executeBroadcast, getBroadcastWithLogs, computeDisplayStatus, computeDeliveryRollup, sendBroadcastById,
  // Phase 7C — Sequence scheduler reuses this exact template-component
  // builder (rather than duplicating Meta payload-construction logic) so a
  // sequence message step and a broadcast recipient are built identically.
  // Pure function, no behavior change; purely an additive export.
  buildTemplateComponents,
};
