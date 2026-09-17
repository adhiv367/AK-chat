// Phase 7C — Sequence Scheduler + Step Execution.
//
// Finds ACTIVE sequence_enrollments whose next_due_at has arrived and
// executes exactly their current step, following the same architecture as
// services/broadcastScheduler.js:
//   - Postgres is the source of truth (no in-memory timers).
//   - `SELECT ... FOR UPDATE SKIP LOCKED` so multiple workers/processes
//     never double-process the same enrollment.
//   - Restart-safe: every piece of durable state lives in
//     coexistence.sequence_enrollments / sequence_step_executions.
//
// SENDING: this file never calls Meta and never touches BullMQ send
// internals directly. It reuses, unmodified:
//   - services/messageSender.js  (resolveAccount, insertPendingRow)
//   - queue/sendQueue.js         (enqueueSend — the single outbound queue)
//   - routes/broadcasts.js       (buildTemplateComponents — the existing
//     Meta template-payload builder, exported additively for this reuse)
// The actual Meta call + delivery-status bookkeeping happens exactly where
// it always has, inside queue/sendQueue.js's worker. A small, explained hook
// was added there (see sendQueue.js's `sequence_step_execution` originRef
// branches) so that async result gets correlated back onto
// sequence_step_executions — mirroring the existing broadcast_log pattern
// exactly, not a parallel delivery-tracking system.
//
// CLAIM / LEASE MODEL (idempotency + restart safety):
//   claimDueEnrollmentIds() locks due rows with FOR UPDATE SKIP LOCKED and,
//   still holding that lock, pushes next_due_at forward by a short lease
//   (CLAIM_LEASE_MS) before committing. This is the "claim" — no other tick
//   (this process or another) can see the row as due again until the lease
//   expires. Two things follow from this:
//     1. Restart-safety: if this process dies mid-execution, the lease
//        simply expires and the row becomes due again on its own — no lost
//        work, no separate cleanup job, no in-memory bookkeeping needed.
//     2. It is a LEASE, not a completion mark — the real terminal state
//        (next_due_at recalculated, or NULL + status='completed') is only
//        written once execution actually finishes, and that write always
//        wins over the lease.
//   The hard guarantee against a step actually sending twice is not the
//   lease alone — it's coexistence.sequence_step_executions' existing
//   partial unique index `uq_sequence_step_executions_completed`
//   (enrollment_id, step_id) WHERE status IN ('sent','skipped') from Phase
//   7A: before doing any work for a step, we check for an existing
//   sent/skipped row for that exact (enrollment_id, step_id) and, if found,
//   just advance past it instead of re-executing. Database state — not a
//   JS flag — is what makes re-processing safe.

const pool = require('../db');
const { resolveAccount, insertPendingRow } = require('../services/messageSender');
const { enqueueSend } = require('../queue/sendQueue');
// Phase 7D — delayToMs moved to util/sequenceDelay.js (pure, no
// side-effecting requires) so routes/sequences.js's manual-enrollment
// handler can reuse the exact same conversion without also pulling in
// this file's Redis/BullMQ-connecting requires above. Re-exported below
// unchanged so every existing caller of sequenceScheduler.delayToMs still
// works.
const { delayToMs } = require('../util/sequenceDelay');
// Phase 7E — Exit Conditions. Pure rule-matching logic lives in its own
// util module (same reasoning as sequenceDelay.js above) so it can be unit
// tested with a fake pool without pulling in this file's Redis/BullMQ
// requires. See that file's header for the exact rule vocabulary.
const { evaluateExitRules, formatExitReason } = require('../util/sequenceExitRules');

// Matches templates.js's own vocabulary — only an APPROVED template may be
// sent (see routes/templates.js status lifecycle comments).
const APPROVED_TEMPLATE_STATUS = 'APPROVED';

// Poll every 20s. Sequence delay steps are specified in whole
// minutes/hours/days (see sequencesSchema.js DELAY_UNITS), so a much finer
// interval than broadcastScheduler's 60s isn't needed for correctness, but
// a slightly tighter one keeps "message immediately followed by another
// message step" (next_due_at = NOW()) feeling responsive.
const POLL_INTERVAL_MS = parseInt(process.env.SEQUENCE_SCHEDULER_POLL_MS || '20000', 10);

// How many enrollments a single tick claims at once. Kept modest —
// processing is cheap (DB writes + a queue enqueue, never a synchronous
// Meta call) so ticks stay fast even under load.
const BATCH_SIZE = parseInt(process.env.SEQUENCE_SCHEDULER_BATCH_SIZE || '25', 10);

// Claim lease — see file header. Comfortably longer than a single
// enrollment's processing time (no synchronous Meta call ever happens on
// this path) while still short enough that a crashed process's claimed rows
// recover quickly.
const CLAIM_LEASE_MS = parseInt(process.env.SEQUENCE_SCHEDULER_LEASE_MS || '30000', 10);

/**
 * Atomically claim up to `limit` due, active enrollments.
 * Returns an array of enrollment ids. Never throws for "nothing due" —
 * returns [].
 */
async function claimDueEnrollmentIds(limit = BATCH_SIZE) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id
         FROM coexistence.sequence_enrollments
        WHERE status = 'active'
          AND next_due_at IS NOT NULL
          AND next_due_at <= NOW()
        ORDER BY next_due_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit]
    );
    if (rows.length === 0) {
      await client.query('COMMIT');
      return [];
    }
    const ids = rows.map((r) => r.id);
    await client.query(
      `UPDATE coexistence.sequence_enrollments
          SET next_due_at = NOW() + ($2 || ' milliseconds')::interval
        WHERE id = ANY($1::bigint[])`,
      [ids, String(CLAIM_LEASE_MS)]
    );
    await client.query('COMMIT');
    return ids;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Record a failed step execution. Never advances the enrollment past a
 * failed step (Part 6). Clears next_due_at (rather than leaving the claim
 * lease in place or resetting it to "now") so the enrollment stops being
 * picked up automatically — avoiding an infinite retry loop — while
 * remaining fully intact (status stays 'active', current_step_id
 * unchanged) for a future retry-policy phase to resume. The failure itself
 * is never lost: it's persisted on sequence_step_executions.
 */
async function recordFailure(enrollment, step, errorMessage) {
  await pool.query(
    `INSERT INTO coexistence.sequence_step_executions
       (enrollment_id, step_id, status, error_message, executed_at)
     VALUES ($1,$2,'failed',$3,NOW())`,
    [enrollment.id, step ? step.id : null, String(errorMessage || 'execution failed').slice(0, 1000)]
  );
  await pool.query(
    `UPDATE coexistence.sequence_enrollments
        SET next_due_at = NULL
      WHERE id = $1`,
    [enrollment.id]
  );
}

/**
 * Advance an enrollment past `currentStep` (whose execution just completed
 * successfully — sent or skipped). Finds the next step by step_order; if
 * none exists, completes the enrollment (Part 4).
 */
async function advanceEnrollment(enrollment, currentStep) {
  const { rows: nextRows } = await pool.query(
    `SELECT id, step_order, step_type, delay_value, delay_unit
       FROM coexistence.sequence_steps
      WHERE sequence_id = $1 AND step_order > $2
      ORDER BY step_order ASC
      LIMIT 1`,
    [enrollment.sequence_id, currentStep.step_order]
  );
  const nextStep = nextRows[0];

  if (!nextStep) {
    await pool.query(
      `UPDATE coexistence.sequence_enrollments
          SET status = 'completed', completed_at = NOW(),
              current_step_id = NULL, next_due_at = NULL
        WHERE id = $1`,
      [enrollment.id]
    );
    return;
  }

  // The due time for the step we just moved PAST a delay step's own
  // delay_value/delay_unit; a message (or skip-worthy) step has no wait
  // attached to it, so the next step becomes due immediately (picked up on
  // the following tick).
  const nextDueAt =
    currentStep.step_type === 'delay'
      ? new Date(Date.now() + delayToMs(currentStep.delay_value, currentStep.delay_unit))
      : new Date();

  await pool.query(
    `UPDATE coexistence.sequence_enrollments
        SET current_step_id = $2, next_due_at = $3
      WHERE id = $1`,
    [enrollment.id, nextStep.id, nextDueAt]
  );
}

/**
 * Execute exactly the current step of one claimed enrollment. Safe to call
 * more than once for the same enrollment (idempotent — see file header).
 */
async function executeDueEnrollmentById(enrollmentId) {
  const { rows: enrollmentRows } = await pool.query(
    `SELECT * FROM coexistence.sequence_enrollments WHERE id = $1`,
    [enrollmentId]
  );
  const enrollment = enrollmentRows[0];
  if (!enrollment || enrollment.status !== 'active') return; // paused/completed/exited/cancelled/deleted since claim

  // ── Exit-condition check (Phase 7E) ────────────────────────────────────
  // Evaluated for every freshly-loaded ACTIVE enrollment, before anything
  // else — before the "no steps left" completion path below, before the
  // current-step lookup, before any delay/message processing. A match here
  // takes priority over further progression (OR semantics: any matching
  // rule exits). exit_rules lives on coexistence.sequences (the sequence
  // definition), not on the enrollment row, so it's fetched separately.
  //
  // Any failure here (DB error loading exit_rules, resolving the
  // workspace's WhatsApp account for the replied_since_enrollment check,
  // or evaluating the rules themselves) leaves the enrollment untouched —
  // status stays 'active', current_step_id/next_due_at are not modified —
  // so the existing claim lease simply expires and the next scheduler tick
  // retries. This mirrors recordFailure's "never lose state, never mark a
  // false terminal status" posture, without actually calling recordFailure
  // (this isn't a step execution failure).
  try {
    const { rows: seqRows } = await pool.query(
      `SELECT exit_rules FROM coexistence.sequences WHERE id = $1`,
      [enrollment.sequence_id]
    );
    const rawExitRules = seqRows[0] ? seqRows[0].exit_rules : [];
    const exitRules = Array.isArray(rawExitRules)
      ? rawExitRules
      : (typeof rawExitRules === 'string' ? JSON.parse(rawExitRules) : []);

    if (exitRules.length > 0) {
      let waNumber = null;
      if (exitRules.some((r) => r && r.type === 'replied_since_enrollment')) {
        const { account } = await resolveAccount({ workspaceId: enrollment.workspace_id });
        waNumber = account ? String(account.displayPhoneNumber).replace(/\D/g, '') : null;
      }

      const matchedRule = await evaluateExitRules({
        pool,
        workspaceId: enrollment.workspace_id,
        contactNumber: enrollment.contact_number,
        enrolledAt: enrollment.enrolled_at,
        waNumber,
        exitRules,
      });

      if (matchedRule) {
        // Matched — exit now. No sequence_step_executions row is written;
        // no step actually executed. The scheduler naturally stops picking
        // this enrollment up again because it's no longer 'active'.
        await pool.query(
          `UPDATE coexistence.sequence_enrollments
              SET status = 'exited', exited_at = NOW(), exit_reason = $2,
                  current_step_id = NULL, next_due_at = NULL
            WHERE id = $1`,
          [enrollment.id, formatExitReason(matchedRule)]
        );
        return;
      }
    }
  } catch (err) {
    console.error(`[sequenceScheduler] exit-rule evaluation error for enrollment ${enrollment.id}:`, err.message);
    return; // leave enrollment active; next tick retries
  }

  if (!enrollment.current_step_id) {
    // 7B allows enrolling into a sequence with zero steps — nothing to run.
    await pool.query(
      `UPDATE coexistence.sequence_enrollments
          SET status = 'completed', completed_at = NOW(), next_due_at = NULL
        WHERE id = $1`,
      [enrollment.id]
    );
    return;
  }

  const { rows: stepRows } = await pool.query(
    `SELECT * FROM coexistence.sequence_steps WHERE id = $1 AND sequence_id = $2`,
    [enrollment.current_step_id, enrollment.sequence_id]
  );
  const step = stepRows[0];
  if (!step) {
    // The step this enrollment pointed at was deleted out from under it.
    // Don't guess a replacement — record and stall, same as any other
    // failure (Part 6).
    await recordFailure(enrollment, null, 'Current sequence step no longer exists');
    return;
  }

  // ── Idempotency guard ──────────────────────────────────────────────────
  const { rows: doneRows } = await pool.query(
    `SELECT id FROM coexistence.sequence_step_executions
      WHERE enrollment_id = $1 AND step_id = $2 AND status IN ('sent','skipped')`,
    [enrollment.id, step.id]
  );
  if (doneRows.length > 0) {
    // Already executed (crash-after-send-before-advance, or a duplicate
    // claim slipping past the lease). Do not send again — just advance.
    await advanceEnrollment(enrollment, step);
    return;
  }

  // ── Delay step ──────────────────────────────────────────────────────────
  if (step.step_type === 'delay') {
    await pool.query(
      `INSERT INTO coexistence.sequence_step_executions
         (enrollment_id, step_id, status, executed_at)
       VALUES ($1,$2,'skipped',NOW())`,
      [enrollment.id, step.id]
    );
    await advanceEnrollment(enrollment, step);
    return;
  }

  // ── Message step ─────────────────────────────────────────────────────
  if (step.step_type === 'message') {
    // buildTemplateComponents is required lazily (not at module load) to
    // sidestep any require-order edge cases between broadcasts.js and this
    // new file — same defensive style already used for messageSender/
    // sendQueue inside engine/automationEngine.js's node handlers.
    const { buildTemplateComponents } = require('../routes/broadcasts');

    if (!step.template_id) {
      await recordFailure(enrollment, step, 'Message step has no template configured');
      return;
    }

    // Workspace ownership is enforced directly in the WHERE clause — same
    // pattern as every other template lookup in routes/templates.js.
    const { rows: tplRows } = await pool.query(
      `SELECT * FROM coexistence.message_templates WHERE id = $1 AND workspace_id = $2`,
      [step.template_id, enrollment.workspace_id]
    );
    const template = tplRows[0];
    if (!template) {
      await recordFailure(enrollment, step, 'Message template not found or belongs to another workspace');
      return;
    }
    if (String(template.status).toUpperCase() !== APPROVED_TEMPLATE_STATUS) {
      await recordFailure(enrollment, step, `Message template "${template.name}" is not APPROVED (status=${template.status})`);
      return;
    }

    const { rows: contactRows } = await pool.query(
      `SELECT contact_number, name FROM coexistence.contacts
        WHERE workspace_id = $1 AND contact_number = $2
        LIMIT 1`,
      [enrollment.workspace_id, enrollment.contact_number]
    );
    const recipient = contactRows[0] || { contact_number: enrollment.contact_number, name: null };

    const { account, error: accErr } = await resolveAccount({ workspaceId: enrollment.workspace_id });
    if (accErr || !account) {
      await recordFailure(enrollment, step, accErr || 'No WhatsApp Business account available for this workspace');
      return;
    }

    let components;
    try {
      // Sequences don't yet resolve header media (no media step in 7C's
      // scope), so media-header templates fail cleanly here with a clear
      // reason rather than silently sending a malformed payload.
      components = buildTemplateComponents(template, step.variable_mapping, recipient, null);
    } catch (buildErr) {
      await recordFailure(enrollment, step, buildErr.message);
      return;
    }

    // Create the correlation row FIRST (status='pending') so there is
    // always a durable record of "we started this", then hand off to the
    // existing send pipeline exactly like broadcasts.js/automationEngine.js
    // do — insertPendingRow (optimistic chat_history row) + enqueueSend.
    const { rows: execRows } = await pool.query(
      `INSERT INTO coexistence.sequence_step_executions (enrollment_id, step_id, status)
       VALUES ($1,$2,'pending')
       RETURNING id`,
      [enrollment.id, step.id]
    );
    const executionId = execRows[0].id;

    let localId;
    try {
      localId = await insertPendingRow({
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
      // Stash the local correlation id in wa_message_id (the existing
      // column, per Part 2/8 — "do not invent unnecessary columns"). The
      // sendQueue.js hook overwrites this with the real wamid once Meta
      // actually accepts the message.
      await pool.query(
        `UPDATE coexistence.sequence_step_executions SET wa_message_id = $1 WHERE id = $2`,
        [localId, executionId]
      );
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
        originRef: { kind: 'sequence_step_execution', id: executionId },
      });
    } catch (sendErr) {
      // Synchronous failure to even hand off to the existing queue (e.g.
      // Redis unreachable) — this IS a "queue/send infrastructure failure"
      // per Part 6, so the step is marked failed and the enrollment does
      // not advance.
      await pool.query(
        `UPDATE coexistence.sequence_step_executions SET status='failed', error_message=$1 WHERE id=$2`,
        [String(sendErr.message || sendErr).slice(0, 1000), executionId]
      ).catch(() => {});
      await pool.query(
        `UPDATE coexistence.sequence_enrollments SET next_due_at = NULL WHERE id = $1`,
        [enrollment.id]
      );
      return;
    }

    // Handed off successfully to the existing send pipeline — mark this
    // step done from the sequence's point of view (matches how a broadcast
    // is considered "executed" once its recipients are enqueued, not once
    // Meta has actually delivered every message) and advance. The eventual
    // Meta-level success/failure is still tracked asynchronously on this
    // same execution row by the sendQueue.js hook, for observability.
    await pool.query(
      `UPDATE coexistence.sequence_step_executions SET status='sent', executed_at=NOW() WHERE id=$1`,
      [executionId]
    );
    await advanceEnrollment(enrollment, step);
    return;
  }

  // Unknown step type — schema CHECK constraint should make this
  // unreachable, but never silently no-op.
  await recordFailure(enrollment, step, `Unsupported step_type "${step.step_type}"`);
}

/**
 * One scheduler tick: claim due enrollments, then process each
 * independently — one enrollment's failure must never affect another's
 * (Part 11 test 23), same "fire independently, don't let one throw stop the
 * batch" posture as broadcastScheduler.js's runSchedulerTick.
 */
async function runSequenceSchedulerTick() {
  let ids;
  try {
    ids = await claimDueEnrollmentIds(BATCH_SIZE);
  } catch (err) {
    console.error('[sequenceScheduler] claim error:', err.message);
    return;
  }
  if (ids.length === 0) return;

  console.log(`[sequenceScheduler] ${ids.length} enrollment(s) due`);

  await Promise.all(
    ids.map((id) =>
      executeDueEnrollmentById(id).catch((err) => {
        console.error(`[sequenceScheduler] enrollment ${id} failed:`, err.message);
      })
    )
  );
}

let schedulerInterval = null;

/**
 * Start the sequence scheduler. Call once at server startup, alongside
 * startBroadcastScheduler() (see index.js). Safe to call repeatedly.
 */
function startSequenceScheduler() {
  if (schedulerInterval) {
    console.log('[sequenceScheduler] Already running — skipping duplicate start');
    return;
  }
  console.log(`[sequenceScheduler] ✓ Started — checking every ${POLL_INTERVAL_MS / 1000}s for due sequence steps`);

  runSequenceSchedulerTick().catch((err) =>
    console.error('[sequenceScheduler] Startup tick error:', err.message)
  );

  schedulerInterval = setInterval(() => {
    runSequenceSchedulerTick().catch((err) =>
      console.error('[sequenceScheduler] Tick error:', err.message)
    );
  }, POLL_INTERVAL_MS);

  if (schedulerInterval.unref) schedulerInterval.unref();
}

function stopSequenceScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[sequenceScheduler] Stopped');
  }
}

module.exports = {
  startSequenceScheduler,
  stopSequenceScheduler,
  runSequenceSchedulerTick,
  claimDueEnrollmentIds,
  // Exposed for tests / manual single-enrollment execution (Part 10) — no
  // new public HTTP endpoint was added for this.
  executeDueEnrollmentById,
  // Re-exported from util/sequenceDelay.js for backward compatibility with
  // anything already importing delayToMs from this module — see that
  // file's header for why routes/sequences.js imports it from there
  // directly instead of from here.
  delayToMs,
};


