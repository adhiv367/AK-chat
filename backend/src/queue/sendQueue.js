// BullMQ outbound send queue. Rate-limited at 60 messages/sec by default
// (well under Meta Tier 1's 80/sec ceiling). All four send-origin paths
// (chat reply, broadcast, automation, template test) enqueue here.

const { Queue, Worker, QueueEvents } = require('bullmq');
const IORedis = require('ioredis');
const pool = require('../db');
const { getAccountWithToken } = require('../routes/whatsappAccounts');
const { sendText, sendTemplate, sendMedia, sendInteractive, sendFlowMessage, sendLocation, sendContacts, sendReaction } = require('../integrations/metaSend');
const { markSent, markFailed, formatSendError } = require('../services/messageSender');
const { markAccountHealth, classifyMetaError } = require('../services/accountHealth');
// Phase 8A — message usage metering. Incremented ONLY below, right after a
// successful markSent() actually updates the pending row — never on
// enqueue, never on failure, never on a retry attempt that doesn't reach
// this line. See messageUsageService.js for the counting contract.
const { incrementMessageUsage } = require('../services/messageUsageService');

const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const QUEUE_NAME = 'akchat-send';
const CONCURRENCY = parseInt(process.env.SEND_QUEUE_CONCURRENCY || '5', 10);
const RATE_MAX = parseInt(process.env.SEND_RATE_MAX || '60', 10);
const RATE_DURATION_MS = parseInt(process.env.SEND_RATE_DURATION_MS || '1000', 10);
const ATTEMPTS = parseInt(process.env.SEND_QUEUE_ATTEMPTS || '4', 10);

const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});
connection.on('error', err => console.error('[sendQueue] redis error:', err.message));

const sendQueue = new Queue(QUEUE_NAME, { connection });

let worker = null;
let queueEvents = null;

/**
 * Job data shape:
 * {
 *   kind: 'text' | 'template' | 'media',
 *   accountId: number,        // resolved WhatsApp account id
 *   to: string,               // recipient phone (digits only)
 *   localMessageId: string,   // matches the optimistic chat_history row
 *   payload: {                // shape depends on kind
 *     // text:    { body, previewUrl? }
 *     // template:{ name, languageCode, components, broadcastLogId? }
 *     // media:   { type, mediaId | link, caption?, filename? }
 *     // flow:    { flowId, flowToken, flowCta, bodyText, headerText?,
 *     //            footerText?, flowAction?, flowActionPayload? }
 *   },
 *   originRef?: {             // optional cross-table linkage for status writes
 *     kind: 'broadcast_log' | 'automation_step',
 *     id: number,
 *   }
 * }
 */
async function processJob(job) {
  const { kind, accountId, to, localMessageId, payload, originRef } = job.data || {};
  const account = await getAccountWithToken(accountId);
  if (!account) throw new Error(`Account id=${accountId} not found`);
  if (!account.accessToken) throw new Error('Access token missing');
  if (!account.isActive) throw new Error(`Account "${account.displayName}" is inactive`);

  const args = {
    accessToken: account.accessToken,
    phoneNumberId: account.phoneNumberId,
    to,
  };

  let result;
  try {
    if (kind === 'text') {
      result = await sendText({ ...args, body: payload.body, previewUrl: payload.previewUrl, contextMessageId: payload.contextMessageId });
    } else if (kind === 'template') {
      // Full outgoing payload, exactly as sent to Meta — required for debugging
      // "approved template still fails to send" issues (component mismatches).
      console.log(
        `[sendQueue] → Meta template send: name="${payload.name}" to=${to}`,
        JSON.stringify(
          { messaging_product: 'whatsapp', to, type: 'template', template: { name: payload.name, language: { code: payload.languageCode }, components: payload.components } },
          null,
          2
        )
      );
      result = await sendTemplate({ ...args, templateName: payload.name, languageCode: payload.languageCode, components: payload.components });
    } else if (kind === 'media') {
      result = await sendMedia({ ...args, type: payload.type, mediaId: payload.mediaId, link: payload.link, caption: payload.caption, filename: payload.filename, contextMessageId: payload.contextMessageId });
    } else if (kind === 'interactive') {
      result = await sendInteractive({ ...args, interactive: payload.interactive });
    } else if (kind === 'flow') {
      result = await sendFlowMessage({
        ...args,
        flowId: payload.flowId,
        flowToken: payload.flowToken,
        flowCta: payload.flowCta,
        bodyText: payload.bodyText,
        headerText: payload.headerText,
        footerText: payload.footerText,
        flowAction: payload.flowAction,
        flowActionPayload: payload.flowActionPayload,
      });
    } else if (kind === 'location') {
      result = await sendLocation({ ...args, latitude: payload.latitude, longitude: payload.longitude, name: payload.name, address: payload.address });
    } else if (kind === 'contacts') {
      result = await sendContacts({ ...args, contacts: payload.contacts });
    } else if (kind === 'reaction') {
      result = await sendReaction({ ...args, messageId: payload.messageId, emoji: payload.emoji });
    } else {
      throw new Error(`unknown send kind: ${kind}`);
    }
    await markAccountHealth(account.id, 'healthy');
  } catch (err) {
    if (kind === 'template') {
      console.error(`[sendQueue] TEMPLATE SEND FAILED — name="${payload.name}" language="${payload.languageCode}" components=${JSON.stringify(payload.components)}`);
    }
    // Meta's full structured error, exactly as returned by the Graph API —
    // this is what tells us WHY it failed instead of just "FAILED".
    if (err.metaError) {
      console.error('[sendQueue] Meta error detail:', JSON.stringify(err.metaError, null, 2));
    } else if (err.body) {
      console.error('[sendQueue] Meta response body:', JSON.stringify(err.body, null, 2));
    }
    const cls = classifyMetaError(err);
    await markAccountHealth(account.id, cls, err.message);
    // Don't retry auth failures — they'll fail every time until token is fixed
    if (cls === 'invalid_token') {
      err.skipRetry = true;
    }
    throw err;
  }

  const wamid = result?.messages?.[0]?.id;
  if (!wamid) throw new Error('Meta returned no message id');

  // Swap the optimistic row's local id for the real wamid
  if (localMessageId) {
    const updated = await markSent(localMessageId, wamid, account.workspaceId);
    // Phase 8A: only count a message when markSent actually updated a row
    // (updated === true) — a false/duplicate result (e.g. a repeat call for
    // an already-swapped localId) is never counted, which is what prevents
    // double-counting on retries/re-processing. Never awaited into the
    // critical path in a way that could affect delivery — errors are
    // logged and swallowed by incrementMessageUsage() itself, and this
    // never touches the existing retry/error-handling logic below.
    if (updated && account.workspaceId) await incrementMessageUsage(account.workspaceId);
  }

  // Update origin-side linkage (broadcast_log etc) if provided
  if (originRef?.kind === 'broadcast_log' && originRef.id) {
    await pool.query(
      `UPDATE coexistence.broadcast_logs
          SET status = 'sent', wa_message_id = $1, sent_at = NOW()
        WHERE id = $2`,
      [wamid, originRef.id]
    ).catch(err => console.error('[sendQueue] broadcast_log update failed:', err.message));
  }
  if (originRef?.kind === 'automation_step' && originRef.id) {
    await pool.query(
      `UPDATE coexistence.automation_execution_steps
          SET wa_message_id = $1, wa_message_status = 'sent'
        WHERE id = $2`,
      [wamid, originRef.id]
    ).catch(() => {});
  }
  // Phase 7C — Sequence Scheduler integration hook. Additive only, mirrors
  // the broadcast_log branch above exactly: once Meta actually accepts the
  // message, swap the sequence_step_executions row's temporary correlation
  // value (the chat_history localMessageId, stashed in wa_message_id by
  // sequenceScheduler.js at enqueue time) for the real wamid and flip the
  // row to 'sent'. This is the "safest integration point" for Part 8 —
  // reuses the existing success path instead of a parallel delivery-tracker.
  if (originRef?.kind === 'sequence_step_execution' && originRef.id) {
    await pool.query(
      `UPDATE coexistence.sequence_step_executions
          SET status = 'sent', wa_message_id = $1, executed_at = NOW()
        WHERE id = $2`,
      [wamid, originRef.id]
    ).catch(err => console.error('[sendQueue] sequence_step_execution update failed:', err.message));
  }

  return { wamid };
}

function startSendWorker() {
  if (worker) return worker;
  worker = new Worker(QUEUE_NAME, processJob, {
    connection,
    concurrency: CONCURRENCY,
    limiter: { max: RATE_MAX, duration: RATE_DURATION_MS },
  });

  worker.on('completed', (job) => {
    console.log(`[sendQueue] ${job.data?.kind} to ${job.data?.to} → ${job.returnvalue?.wamid}`);
  });
  worker.on('failed', async (job, err) => {
    const localId = job?.data?.localMessageId;
    const skipRetry = err?.skipRetry || /invalid.*token|access token has expired|Error validating access token/i.test(err?.message || '');
    const finalAttempt = (job?.attemptsMade || 0) >= ATTEMPTS || skipRetry;
    console.error(`[sendQueue] ${job?.data?.kind} to ${job?.data?.to} failed attempt=${job?.attemptsMade}/${ATTEMPTS}${skipRetry ? ' (no-retry: auth)' : ''}: ${err.message}`);
    if (finalAttempt && localId) {
      // Pass the full error object (not just .message) so markFailed can
      // persist Meta's code/error_subcode/error_data/fbtrace_id — the exact
      // reason, not just "failed".
      await markFailed(localId, err).catch(() => {});
      if (job?.data?.originRef?.kind === 'broadcast_log') {
        const detail = formatSendError(err);
        await pool.query(
          `UPDATE coexistence.broadcast_logs SET status='failed', error_message=$1 WHERE id=$2`,
          [detail.slice(0, 500), job.data.originRef.id]
        ).catch(() => {});
      }
      // Phase 7C — same reasoning as the broadcast_log branch above: persist
      // the real Meta failure onto the sequence_step_executions row once all
      // retry attempts are exhausted. The sequence itself was already
      // advanced past this step at enqueue time (see sequenceScheduler.js);
      // this only updates the execution record for observability/history,
      // per Part 6 ("do not lose the error message").
      if (job?.data?.originRef?.kind === 'sequence_step_execution') {
        const detail = formatSendError(err);
        await pool.query(
          `UPDATE coexistence.sequence_step_executions SET status='failed', error_message=$1 WHERE id=$2`,
          [detail.slice(0, 500), job.data.originRef.id]
        ).catch(() => {});
      }
    }
  });

  queueEvents = new QueueEvents(QUEUE_NAME, { connection });
  queueEvents.on('error', err => console.error('[sendQueue] events error:', err.message));

  console.log(`[sendQueue] worker started, concurrency=${CONCURRENCY}, rate=${RATE_MAX}/${RATE_DURATION_MS}ms, attempts=${ATTEMPTS}`);
  return worker;
}

async function enqueueSend(jobData, opts = {}) {
  const idKey = jobData.localMessageId || `${jobData.accountId}-${jobData.to}-${Date.now()}`;
  const addOpts = {
    jobId: `send-${idKey}`,
    attempts: ATTEMPTS,
    backoff: { type: 'exponential', delay: 1500 },
    removeOnComplete: { count: 500, age: 3600 },
    removeOnFail: { count: 1000, age: 86400 },
  };
  // Optional delayed delivery (used by automation Delay nodes so a later message
  // lands after an earlier one). BullMQ holds the job for `delayMs` before a
  // worker picks it up — non-blocking, no scheduler needed.
  if (opts.delayMs && opts.delayMs > 0) addOpts.delay = Math.round(opts.delayMs);
  await sendQueue.add('send', jobData, addOpts);
}

async function shutdownSendQueue() {
  try {
    if (worker) await worker.close();
    if (queueEvents) await queueEvents.close();
    await sendQueue.close();
    await connection.quit();
  } catch (err) {
    console.error('[sendQueue] shutdown error:', err.message);
  }
}

module.exports = { sendQueue, startSendWorker, enqueueSend, shutdownSendQueue };

