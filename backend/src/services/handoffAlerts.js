// Human-handoff staff alerts.
//
// The Python AI bridge only DETECTS a handoff (handoff_required / handoff_reason).
// Everything else lives here:
//   raiseHandoff()  create ONE alert per customer per 20 min (race-safe), then send
//   processAlert()  claim + send to every active staff recipient, record the result
//   sweep()         retry failed sends (>=60s apart, max 5 attempts) and rescue stuck rows
//
// Design rules:
//   * Nothing here may throw into the caller: raiseHandoff() never rejects, so an
//     alert problem can never break the customer's normal AI reply.
//   * Tenant isolation: the workspace comes ONLY from whatsapp_accounts (matched on
//     the exact phone_number_id Meta delivered to). Recipients, the sending account
//     and the contact-name lookup are all filtered by that workspace_id.
//   * Sends reuse integrations/metaSend.js (sendText / sendTemplate) directly. They do
//     not go through enqueueSend, which would write fake chat_history rows and has its
//     own retry policy that would fight the 60s / 5-attempt rule below.

const pool = require('../db');
const { sendText, sendTemplate } = require('../integrations/metaSend');
const { getAccountByPhoneNumber } = require('../routes/whatsappAccounts');

const DEDUPE_MINUTES = 20;          // same customer -> no new alert inside this window
const RETRY_DELAY_SECONDS = 60;     // wait this long before retrying a failed send
const MAX_ATTEMPTS = 5;             // total send attempts per alert
const STALE_SENDING_SECONDS = 180;  // a 'sending' row this old belongs to a dead process
const PENDING_RESCUE_SECONDS = 30;  // a 'pending' row this old was never picked up
const SWEEP_INTERVAL_MS = 30 * 1000;
const EXCERPT_MAX = 200;

const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
// Template parameters may not contain newlines/tabs; collapse all whitespace.
const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Create an alert for this customer unless one already exists in the last 20 minutes,
 * then start sending. Safe to call concurrently for the same customer: a transaction
 * scoped advisory lock serialises the "check recent, then insert" step.
 * Never throws.
 */
async function raiseHandoff({ phoneNumberId, contactNumber, reason, message }) {
  try {
    const contact = digits(contactNumber);
    if (!phoneNumberId || !contact) return { created: false, skipped: 'missing_fields' };

    // Workspace comes from the account that received the message - never from the caller.
    const { rows: acc } = await pool.query(
      `SELECT workspace_id, regexp_replace(display_phone_number, '\\D', '', 'g') AS wa_number
         FROM coexistence.whatsapp_accounts
        WHERE phone_number_id = $1`,
      [String(phoneNumberId)]
    );
    if (acc.length !== 1 || !acc[0].workspace_id) {
      console.error('[handoff] workspace not resolved for phone_number_id; alert skipped');
      return { created: false, skipped: 'workspace_not_resolved' };
    }
    const workspaceId = acc[0].workspace_id;
    const waNumber = acc[0].wa_number || '';

    const client = await pool.connect();
    let alertId;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`handoff:${workspaceId}:${contact}`]);
      const recent = await client.query(
        `SELECT id FROM coexistence.handoff_alerts
          WHERE workspace_id = $1 AND contact_number = $2
            AND created_at > NOW() - ($3::int * INTERVAL '1 minute')
          LIMIT 1`,
        [workspaceId, contact, DEDUPE_MINUTES]
      );
      if (recent.rows.length) {
        await client.query('COMMIT');
        return { created: false, duplicateOf: recent.rows[0].id };
      }
      const ins = await client.query(
        `INSERT INTO coexistence.handoff_alerts
           (workspace_id, wa_number, contact_number, reason, message_excerpt)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [workspaceId, waNumber, contact, clean(reason, 300), clean(message, EXCERPT_MAX)]
      );
      await client.query('COMMIT');
      alertId = ins.rows[0].id;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // Fire-and-forget: the customer's reply never waits on WhatsApp to staff.
    setImmediate(() => processAlert(alertId).catch((e) => console.error('[handoff] send crashed:', e.message)));
    return { created: true, id: alertId };
  } catch (err) {
    console.error('[handoff] raise failed:', err.message);
    return { created: false, error: err.message };
  }
}

/**
 * Atomically claim an alert for sending. One UPDATE decides the winner, so concurrent
 * callers (or several server instances) can never both send. Returns the row or null.
 */
async function claimAlert(alertId) {
  const { rows } = await pool.query(
    `UPDATE coexistence.handoff_alerts
        SET status = 'sending', send_attempts = send_attempts + 1,
            last_send_at = NOW(), updated_at = NOW()
      WHERE id = (
        SELECT id FROM coexistence.handoff_alerts
         WHERE id = $1 AND send_attempts < $2
           AND (   status = 'pending'
                OR (status = 'failed'  AND last_send_at <= NOW() - ($3::int * INTERVAL '1 second'))
                OR (status = 'sending' AND last_send_at <= NOW() - ($4::int * INTERVAL '1 second')))
           FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [alertId, MAX_ATTEMPTS, RETRY_DELAY_SECONDS, STALE_SENDING_SECONDS]
  );
  return rows[0] || null;
}

async function finish(alertId, status, lastError) {
  await pool.query(
    `UPDATE coexistence.handoff_alerts
        SET status = $2, last_error = $3, updated_at = NOW()
      WHERE id = $1 AND status = 'sending'`,
    [alertId, status, lastError ? String(lastError).slice(0, 1000) : null]
  );
}

/** Send one claimed alert to every active recipient that has not received it yet. */
async function deliver(alert) {
  const workspaceId = alert.workspace_id;

  // Recipients are read fresh on every attempt: a newly added person is included and a
  // deactivated one receives nothing, with no code change and no restart.
  const { rows: recips } = await pool.query(
    `SELECT phone, label FROM coexistence.staff_alert_recipients
      WHERE workspace_id = $1 AND is_active = TRUE
      ORDER BY sort_order, id`,
    [workspaceId]
  );
  if (!recips.length) return finish(alert.id, 'no_recipients', 'No active staff recipients configured');

  const delivered = new Set((alert.delivered_to || []).map(digits));
  const todo = recips.filter((r) => !delivered.has(digits(r.phone)));
  if (!todo.length) return finish(alert.id, 'sent', null);

  // Sending account: same business number the customer wrote to, in the SAME workspace.
  // (No workspace-less fallback - that could pick another tenant's account.)
  const account = await getAccountByPhoneNumber(alert.wa_number, workspaceId);
  if (!account) return finish(alert.id, 'failed', 'Sending WhatsApp account not found for this workspace');
  if (account.isActive === false) return finish(alert.id, 'failed', 'Sending WhatsApp account is inactive');
  if (!account.accessToken) return finish(alert.id, 'failed', 'Access token missing for sending account');

  let name = '';
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(NULLIF(name, ''), NULLIF(profile_name, '')) AS n
         FROM coexistence.contacts WHERE workspace_id = $1 AND contact_number = $2 LIMIT 1`,
      [workspaceId, alert.contact_number]
    );
    name = rows[0]?.n || '';
  } catch { /* name is cosmetic */ }
  const custName = clean(name, 60) || 'Unknown';
  const custPhone = clean(alert.contact_number, 30) || '-';
  const excerpt = clean(alert.message_excerpt, EXCERPT_MAX) || '-';
  const text = `Customer needs help: ${custName} (${custPhone}) wrote: "${excerpt}". Please open AK Chat and reply.`;

  const templateName = process.env.HANDOFF_ALERT_TEMPLATE_NAME || '';
  const languageCode = process.env.HANDOFF_ALERT_TEMPLATE_LANG || 'en';
  const errors = [];

  for (const r of todo) {
    const to = digits(r.phone);
    try {
      if (templateName) {
        await sendTemplate({
          accessToken: account.accessToken,
          phoneNumberId: account.phoneNumberId,
          to,
          templateName,
          languageCode,
          components: [{
            type: 'body',
            parameters: [
              { type: 'text', text: custName },
              { type: 'text', text: custPhone },
              { type: 'text', text: excerpt },
            ],
          }],
        });
      } else {
        await sendText({ accessToken: account.accessToken, phoneNumberId: account.phoneNumberId, to, body: text });
      }
      // Persist success immediately so a later failure/retry never re-sends to this person.
      await pool.query(
        `UPDATE coexistence.handoff_alerts
            SET delivered_to = delivered_to || to_jsonb($2::text), updated_at = NOW()
          WHERE id = $1 AND NOT (delivered_to @> to_jsonb($2::text))`,
        [alert.id, to]
      );
    } catch (err) {
      errors.push(`${to}: ${err.message}`);
    }
  }

  // Failures stay 'failed'; the sweeper retries them after 60s until send_attempts hits 5.
  return errors.length ? finish(alert.id, 'failed', errors.join(' | ')) : finish(alert.id, 'sent', null);
}

/** Claim then deliver. Returns true if this call did the sending. Never throws. */
async function processAlert(alertId) {
  try {
    const alert = await claimAlert(alertId);
    if (!alert) return false;
    try {
      await deliver(alert);
    } catch (err) {
      await finish(alert.id, 'failed', `internal: ${err.message}`).catch(() => {});
    }
    return true;
  } catch (err) {
    console.error('[handoff] process failed:', err.message);
    return false;
  }
}

let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const { rows } = await pool.query(
      `SELECT id FROM coexistence.handoff_alerts
        WHERE send_attempts < $1
          AND (   (status = 'failed'  AND last_send_at <= NOW() - ($2::int * INTERVAL '1 second'))
               OR (status = 'sending' AND last_send_at <= NOW() - ($3::int * INTERVAL '1 second'))
               OR (status = 'pending' AND created_at   <= NOW() - ($4::int * INTERVAL '1 second')))
        ORDER BY id LIMIT 20`,
      [MAX_ATTEMPTS, RETRY_DELAY_SECONDS, STALE_SENDING_SECONDS, PENDING_RESCUE_SECONDS]
    );
    for (const r of rows) await processAlert(r.id);
  } catch (err) {
    console.error('[handoff] sweep failed:', err.message);
  } finally {
    sweeping = false;
  }
}

let timer = null;
function startHandoffSweeper() {
  if (timer) return timer;
  timer = setInterval(() => { sweep(); }, SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}

module.exports = { raiseHandoff, processAlert, sweep, startHandoffSweeper, MAX_ATTEMPTS };
