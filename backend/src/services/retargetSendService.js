// Retarget module — send flow ("Part 3").
// Turns eligible pending Retarget customers into ONE real broadcast, reusing
// the existing Broadcast/Meta template infrastructure end-to-end:
//   - coexistence.broadcasts (created here)
//   - routes/broadcasts.js#executeBroadcast (actual Meta sending, BullMQ,
//     broadcast_logs, chat_history — untouched, just called)
//   - the {{contact.retargetURL}} merge field (routes/broadcasts.js) resolves
//     each recipient's own exit URL at send time
//
// No second WhatsApp sending engine, no duplicate template system.
//
// Duplicate-send protection: only retarget_customers with status='pending'
// are ever eligible. On successful enqueue for a recipient, that row flips
// to 'contacted' — so a later Google Sheet re-sync (which never resets
// status) can never cause a second send for the same customer. A recipient
// whose enqueue attempt fails (per broadcast_logs) is left 'pending' so it
// can be retried, per the "don't mark contacted on failure" rule.
//
// Phase 3C-4: the whole flow is scoped to a single workspaceId end to end —
// this is the highest-risk surface in the Retarget module pre-3C, since an
// unscoped run would pick ANY workspace's WhatsApp account, ANY workspace's
// template, and send to EVERY workspace's pending customers in one shot.
// workspaceId must come from req.workspace.id (routes/retarget.js) — never
// trust one supplied by the client. executeBroadcast(broadcastId) itself
// stays unscoped-by-id, matching the established pattern in
// routes/broadcasts.js: the broadcast row's from_number is resolved to a
// specific account at creation time (here, from getSingleAccount(workspaceId)
// below), so an unscoped lookup by that exact phone number afterwards is
// safe — it can only resolve to the account that owns that number.

const pool = require('../db');
const { getSingleAccount } = require('../routes/whatsappAccounts');
const { resolveExitUrl } = require('./retargetUrlResolver');

/**
 * @param {object} opts
 * @param {number} opts.templateId - message_templates.id (must be an APPROVED
 *   template with a dynamic URL button, i.e. button.value contains {{1}})
 * @param {number} opts.buttonIndex - index (0-based) of the dynamic URL
 *   button within the template's buttons array
 * @param {number[]} [opts.retargetIds] - restrict to specific
 *   retarget_customers.id values (e.g. a UI selection). Omit to send to
 *   every eligible ('pending') Retarget customer in this workspace.
 * @param {number} opts.workspaceId - the caller's workspace (req.workspace.id).
 *   REQUIRED — every resource this flow touches (account, template,
 *   customers) is resolved/filtered against it.
 * @returns {Promise<{broadcastId:number, eligible:number, enqueued:number, contacted:number, skipped:Array}>}
 */
async function sendRetargetReminders({ templateId, buttonIndex, retargetIds, workspaceId } = {}) {
  if (!templateId) throw new Error('templateId is required');
  if (buttonIndex === undefined || buttonIndex === null) throw new Error('buttonIndex is required');
  if (!workspaceId) throw new Error('No workspace found for this account. Please contact support.');

  // Scoped to this workspace's own WhatsApp account — getSingleAccount(null)
  // would silently pick an arbitrary workspace's account instead.
  const account = await getSingleAccount(workspaceId);
  if (!account) throw new Error('No WhatsApp Business account connected');

  // Template must belong to this workspace (via its linked WhatsApp account)
  // or be unassigned — same convention routes/templates.js uses for listing
  // templates, so a workspace can never borrow another workspace's approved
  // template to send its own Retarget reminders.
  const { rows: tRows } = await pool.query(
    `SELECT t.id, t.name, t.status, t.buttons
       FROM coexistence.message_templates t
       LEFT JOIN coexistence.whatsapp_accounts wa ON wa.id = t.whatsapp_account_id
      WHERE t.id = $1 AND (wa.workspace_id = $2 OR t.whatsapp_account_id IS NULL)`,
    [templateId, workspaceId]
  );
  if (tRows.length === 0) throw new Error('Template not found');
  const template = tRows[0];
  if (String(template.status).toUpperCase() !== 'APPROVED') {
    throw new Error(`Template "${template.name}" is not APPROVED by Meta yet`);
  }
  const buttons = Array.isArray(template.buttons) ? template.buttons : [];
  const targetBtn = buttons[buttonIndex];
  if (!targetBtn || targetBtn.type !== 'URL' || !/\{\{1\}\}/.test(targetBtn.value || '')) {
    throw new Error(`Template "${template.name}" button #${buttonIndex} is not a dynamic URL button`);
  }

  // ── Eligible customers ("pending" only, and only THIS workspace's — see
  // duplicate-send note above) ─────────────────────────────────────────────
  const params = ['pending', workspaceId];
  let where = `status = $1 AND workspace_id = $2`;
  if (Array.isArray(retargetIds) && retargetIds.length > 0) {
    params.push(retargetIds);
    where += ` AND id = ANY($3::bigint[])`;
  }
  const { rows: eligible } = await pool.query(
    `SELECT id, name, phone, email, exit_url FROM coexistence.retarget_customers WHERE ${where}`,
    params
  );
  if (eligible.length === 0) {
    return { broadcastId: null, eligible: 0, enqueued: 0, contacted: 0, skipped: [] };
  }

  const waNumber = account.displayPhoneNumber.replace(/\D/g, '');
  const skipped = [];
  const recipients = [];
  const idByPhone = new Map(); // normalized phone -> retarget_customers.id, for the reconciliation step

  for (const cust of eligible) {
    const { rows: cRows } = await pool.query(
      `SELECT custom_fields FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $2`,
      [waNumber, cust.phone]
    );
    const contact = cRows[0] || null;
    const { url } = await resolveExitUrl(cust.phone, contact, workspaceId);

    recipients.push({ contact_number: cust.phone, name: cust.name || '', retargetUrl: url });
    idByPhone.set(cust.phone, cust.id);
  }

  // ── Create the broadcast (one shared template, per-recipient dynamic URL
  // via the {{contact.retargetURL}} merge field resolved in broadcasts.js) ──
  const variableMapping = { buttons: { [String(buttonIndex)]: '{{contact.retargetURL}}' } };
  const { rows: bRows } = await pool.query(
    `INSERT INTO coexistence.broadcasts
       (workspace_id, from_number, recipient_numbers, template_id, status, name, variable_mapping, message_type, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, 'DRAFT', $5, $6::jsonb, 'template', NOW())
     RETURNING id`,
    [
      workspaceId,
      waNumber,
      JSON.stringify(recipients),
      templateId,
      `Retarget Reminder — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      JSON.stringify(variableMapping),
    ]
  );
  const broadcastId = bRows[0].id;

  const { executeBroadcast } = require('../routes/broadcasts');
  const enqueued = await executeBroadcast(broadcastId);

  // ── Reconciliation: only flip status for recipients whose job actually
  // enqueued (broadcast_logs row NOT status='failed'). Failed ones stay
  // 'pending' so they're retried on the next send, per rule #18. Scoped to
  // workspaceId too, though idByPhone (built from this workspace's eligible
  // customers only, above) already prevents cross-workspace updates. ──────
  const { rows: logRows } = await pool.query(
    `SELECT sent_to, status FROM coexistence.broadcast_logs WHERE broadcast_id = $1 AND action = 'BROADCAST'`,
    [broadcastId]
  );
  let contacted = 0;
  for (const log of logRows) {
    if (log.status === 'failed') {
      skipped.push({ phone: log.sent_to, reason: 'send failed' });
      continue;
    }
    const retargetId = idByPhone.get(log.sent_to);
    if (!retargetId) continue;
    await pool.query(
      `UPDATE coexistence.retarget_customers SET status = 'contacted', updated_at = NOW() WHERE id = $1 AND workspace_id = $2`,
      [retargetId, workspaceId]
    );
    contacted++;
  }

  return { broadcastId, eligible: eligible.length, enqueued, contacted, skipped };
}

module.exports = { sendRetargetReminders };