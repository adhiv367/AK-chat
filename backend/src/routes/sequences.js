// Phase 7 Part B — Sequence CRUD + Manual Enrollment.
//
// Builds on Phase 7A's schema-only foundation (coexistence.sequences /
// sequence_steps / sequence_enrollments / sequence_step_executions — see
// db/sequencesSchema.js). This file adds NO scheduler, NO execution, NO
// WhatsApp sending, NO automatic-entry triggers — manual enrollment here
// only establishes enrollment STATE (see the enroll handler's doc comment).
//
// Every route is workspace-scoped via req.workspace.id (resolved
// server-side by middleware/workspaceContext.js's attachWorkspace — never
// taken from the client), exactly the same pattern routes/campaigns.js
// uses. Every sequence lookup goes through repositories/sequenceRepository.js,
// which always includes workspace_id in its WHERE clause, so a sequence
// belonging to another workspace is indistinguishable from one that doesn't
// exist (404 either way).

const { Router } = require('express');
const pool = require('../db');
const { requirePermission, requireFeature } = require('../middleware/access');
const { FEATURE_KEYS } = require('../services/entitlementService');
// Phase 8F-6: first real feature-gate pilot. requireFeature(SEQUENCE_STUDIO)
// is added after (never instead of) the existing requirePermission
// ('sequence-studio') role check on every Sequence Studio route below. No
// plan grants this feature yet — see entitlementService.FEATURE_KEYS — so
// Sequence Studio is blocked by default until plan mapping is decided.
const gateSequenceStudio = requireFeature(FEATURE_KEYS.SEQUENCE_STUDIO);
const repo = require('../repositories/sequenceRepository');
const { STEP_TYPES, DELAY_UNITS } = require('../db/sequencesSchema');
// Phase 7D — reuse the exact same delay-unit conversion sequenceScheduler.js
// uses (imported from the shared, side-effect-free util so this route does
// NOT also pull in sequenceScheduler.js's module-level Redis/BullMQ
// requires — see util/sequenceDelay.js's header). Nothing about
// sequenceScheduler.js's own logic is changed by 7D.
const { delayToMs } = require('../util/sequenceDelay');

const router = Router();

// Only a DRAFT sequence's structural definition (name/description/entry/
// exit config, and its steps) may be modified — matches campaigns.js's
// EDITABLE_STATUSES convention (campaigns.js only allows editing 'draft'
// campaigns). Phase 7C, if it introduces a running/active sequence editor,
// will have to explicitly widen this.
const EDITABLE_STATUSES = new Set(['draft']);

// A sequence can be manually enrolled into while it's still being built
// (draft) or once it's live (active) — but never while paused or archived.
// There is no "activate" endpoint in 7B (that belongs to a later part,
// alongside the scheduler); 'active' is included here defensively so this
// rule does not need to change again once activation ships.
const ENROLLABLE_STATUSES = new Set(['draft', 'active']);

const MAX_NAME_LENGTH = 255;

// ─── Validation helpers ─────────────────────────────────────────────────

function validateSequenceInput({ name, entryConfig, exitRules }) {
  if (!name || !String(name).trim()) return 'name is required';
  if (String(name).trim().length > MAX_NAME_LENGTH) return `name cannot exceed ${MAX_NAME_LENGTH} characters`;
  if (entryConfig !== undefined && entryConfig !== null && typeof entryConfig !== 'object') {
    return 'entryConfig must be a JSON object';
  }
  if (exitRules !== undefined && exitRules !== null && !Array.isArray(exitRules)) {
    return 'exitRules must be a JSON array';
  }
  return null;
}

function validateStepInput(body) {
  const { stepType, templateId, delayValue, delayUnit } = body;
  if (!stepType || !STEP_TYPES.includes(stepType)) {
    return `stepType must be one of: ${STEP_TYPES.join(', ')}`;
  }
  if (stepType === 'message') {
    if (!templateId) return 'templateId is required for a message step';
  }
  if (stepType === 'delay') {
    const numericDelay = Number(delayValue);
    if (!Number.isFinite(numericDelay) || numericDelay <= 0 || !Number.isInteger(numericDelay)) {
      return 'delayValue must be a positive whole number';
    }
    if (!delayUnit || !DELAY_UNITS.includes(delayUnit)) {
      return `delayUnit must be one of: ${DELAY_UNITS.join(', ')}`;
    }
  }
  return null;
}

// Validates that templateId exists, belongs to workspaceId, and is usable
// (APPROVED — the same status Broadcast/Campaign Studio require before a
// template can actually be sent; see routes/templates.js's status
// vocabulary). Does NOT implement sending — only reference validation.
async function validateTemplateReference(workspaceId, templateId) {
  const { rows } = await pool.query(
    `SELECT id, status FROM coexistence.message_templates WHERE id = $1 AND workspace_id = $2`,
    [templateId, workspaceId]
  );
  if (!rows.length) return 'templateId does not belong to this workspace';
  if (rows[0].status !== 'APPROVED') return 'templateId must reference an APPROVED template';
  return null;
}

// Renumbers the given ordered list of step ids to 1..n, contiguous, no
// duplicates. Two-phase (negative, then positive) so the
// (sequence_id, step_order) unique constraint is never violated mid-way —
// a direct single-phase renumber can collide with another row's current
// order value while updates are still in flight.
async function renumberSteps(client, sequenceId, orderedStepIds) {
  for (let i = 0; i < orderedStepIds.length; i++) {
    await client.query(
      `UPDATE coexistence.sequence_steps SET step_order = $3 WHERE id = $1 AND sequence_id = $2`,
      [orderedStepIds[i], sequenceId, -(i + 1)]
    );
  }
  for (let i = 0; i < orderedStepIds.length; i++) {
    await client.query(
      `UPDATE coexistence.sequence_steps SET step_order = $3 WHERE id = $1 AND sequence_id = $2`,
      [orderedStepIds[i], sequenceId, i + 1]
    );
  }
}

// ─── Sequence CRUD ──────────────────────────────────────────────────────

router.get('/sequences', requirePermission('sequence-studio'), gateSequenceStudio, async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.json({ rows: [], total: 0 });

    const { search = '', status = '', limit = 50, offset = 0 } = req.query;
    const result = await repo.listSequences(workspaceId, { search, status, limit, offset });
    res.json(result);
  } catch (err) {
    console.error('[sequences] list error:', err.message);
    res.status(500).json({ error: 'Failed to list sequences' });
  }
});

router.post('/sequences', requirePermission('sequence-studio'), gateSequenceStudio, async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const body = req.body || {};
    const validationError = validateSequenceInput(body);
    if (validationError) return res.status(400).json({ error: validationError });

    const sequence = await repo.createSequence(
      workspaceId,
      { name: String(body.name).trim(), description: body.description ?? null, entryConfig: body.entryConfig, exitRules: body.exitRules },
      req.user?.id ?? null
    );
    res.json(sequence);
  } catch (err) {
    console.error('[sequences] create error:', err.message);
    res.status(500).json({ error: 'Failed to create sequence' });
  }
});

router.get('/sequences/:id', requirePermission('sequence-studio'), gateSequenceStudio, async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const sequence = await repo.getSequenceById(workspaceId, req.params.id);
    if (!sequence) return res.status(404).json({ error: 'Sequence not found' });

    // Steps MUST be returned ordered by step_order ASC.
    const steps = await repo.listStepsBySequence(sequence.id);

    // Enrollment summary — cheap grouped count, same pattern as
    // repo.getCampaignStats for campaigns. Only queried here (detail view),
    // never on the list endpoint, matching campaigns.js's stats being a
    // separate endpoint rather than embedded in every list row.
    const { rows: statusRows } = await pool.query(
      `SELECT status, COUNT(*)::int AS count
         FROM coexistence.sequence_enrollments
        WHERE workspace_id = $1 AND sequence_id = $2
        GROUP BY status`,
      [workspaceId, sequence.id]
    );
    const enrollmentSummary = { total: 0 };
    for (const r of statusRows) {
      enrollmentSummary[r.status] = r.count;
      enrollmentSummary.total += r.count;
    }

    res.json({ ...sequence, steps, enrollmentSummary });
  } catch (err) {
    console.error('[sequences] get error:', err.message);
    res.status(500).json({ error: 'Failed to load sequence' });
  }
});

router.put('/sequences/:id', requirePermission('sequence-studio'), gateSequenceStudio, async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const existing = await repo.getSequenceById(workspaceId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Sequence not found' });
    if (!EDITABLE_STATUSES.has(existing.status)) {
      return res.status(409).json({ error: `Sequence in status "${existing.status}" can no longer be edited` });
    }

    const body = req.body || {};
    // Same partial-update merge convention as campaigns.js's PUT /campaigns/:id
    // — only a field the client explicitly sends (even `null`) is changed;
    // an absent (`undefined`) key keeps its current value, so a client that
    // only sends `name` never wipes entryConfig/exitRules.
    const merged = {
      name: body.name !== undefined ? body.name : existing.name,
      description: body.description !== undefined ? body.description : existing.description,
      entryConfig: body.entryConfig !== undefined ? body.entryConfig : existing.entry_config,
      exitRules: body.exitRules !== undefined ? body.exitRules : existing.exit_rules,
    };

    const validationError = validateSequenceInput(merged);
    if (validationError) return res.status(400).json({ error: validationError });
    merged.name = String(merged.name).trim();

    const updated = await repo.updateSequence(workspaceId, existing.id, merged);
    res.json(updated);
  } catch (err) {
    console.error('[sequences] update error:', err.message);
    res.status(500).json({ error: 'Failed to update sequence' });
  }
});

// ─── Delete / archive ───────────────────────────────────────────────────
// Hard-deleting a sequence would cascade-delete (via FK ON DELETE CASCADE —
// see sequencesSchema.js) its steps, enrollments, and step-execution
// history, destroying real enrollment history the moment any contact has
// ever been enrolled. The schema already reserves an 'archived' lifecycle
// status specifically for this (SEQUENCE_STATUSES in sequencesSchema.js),
// the same "status flag over row deletion" convention campaigns.js/
// media_library use elsewhere in this codebase (media_library uses
// deleted_at; campaigns never row-deletes anything with delivery history).
// So DELETE here is always a soft-archive — sequences are never
// hard-deleted by this endpoint, draft or not, safe by construction.
router.delete('/sequences/:id', requirePermission('sequence-studio'), gateSequenceStudio, async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const existing = await repo.getSequenceById(workspaceId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Sequence not found' });
    if (existing.status === 'archived') {
      return res.status(409).json({ error: 'Sequence is already archived' });
    }

    const archived = await repo.updateStatus(workspaceId, existing.id, 'archived');
    res.json(archived);
  } catch (err) {
    console.error('[sequences] delete error:', err.message);
    res.status(500).json({ error: 'Failed to archive sequence' });
  }
});

// ─── Sequence steps ─────────────────────────────────────────────────────

router.post('/sequences/:id/steps', requirePermission('sequence-studio'), gateSequenceStudio, async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const sequence = await repo.getSequenceById(workspaceId, req.params.id);
    if (!sequence) return res.status(404).json({ error: 'Sequence not found' });
    if (!EDITABLE_STATUSES.has(sequence.status)) {
      return res.status(409).json({ error: `Sequence in status "${sequence.status}" can no longer be edited` });
    }

    const body = req.body || {};
    const validationError = validateStepInput(body);
    if (validationError) return res.status(400).json({ error: validationError });

    if (body.stepType === 'message') {
      const refError = await validateTemplateReference(workspaceId, body.templateId);
      if (refError) return res.status(403).json({ error: refError });
    }

    const client = await pool.connect();
    let created;
    try {
      await client.query('BEGIN');

      const existingSteps = await client.query(
        `SELECT id FROM coexistence.sequence_steps WHERE sequence_id = $1 ORDER BY step_order ASC`,
        [sequence.id]
      );
      const orderedIds = existingSteps.rows.map((r) => r.id);

      // Insert with a temporary, guaranteed-unused order (beyond any
      // existing value) so the INSERT itself can never collide with the
      // unique(sequence_id, step_order) constraint; renumberSteps below
      // assigns its real final position.
      const { rows: maxRows } = await client.query(
        `SELECT COALESCE(MAX(step_order), 0)::int AS max_order FROM coexistence.sequence_steps WHERE sequence_id = $1 FOR UPDATE`,
        [sequence.id]
      );
      const tempOrder = (maxRows[0]?.max_order || 0) + 1000;

      const { rows: insertedRows } = await client.query(
        `INSERT INTO coexistence.sequence_steps
           (sequence_id, step_order, step_type, template_id, variable_mapping, delay_value, delay_unit)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id`,
        [
          sequence.id, tempOrder, body.stepType,
          body.stepType === 'message' ? body.templateId : null,
          JSON.stringify(body.stepType === 'message' ? (body.variableMapping || {}) : {}),
          body.stepType === 'delay' ? Number(body.delayValue) : null,
          body.stepType === 'delay' ? body.delayUnit : null,
        ]
      );
      const newStepId = insertedRows[0].id;

      // `position` (1-based) optionally places the new step at a specific
      // spot; omitted/invalid -> append at the end. Never trust it blindly
      // — clamp into [1, length].
      let insertAt = orderedIds.length; // default: append (0-based end index)
      if (Number.isInteger(body.position) && body.position >= 1) {
        insertAt = Math.min(body.position - 1, orderedIds.length);
      }
      orderedIds.splice(insertAt, 0, newStepId);

      await renumberSteps(client, sequence.id, orderedIds);
      await client.query('COMMIT');

      created = await repo.getStepById(sequence.id, newStepId);
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    res.json(created);
  } catch (err) {
    console.error('[sequences] add step error:', err.message);
    res.status(500).json({ error: 'Failed to add step' });
  }
});

router.put('/sequences/:id/steps/:stepId', requirePermission('sequence-studio'), gateSequenceStudio, async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const sequence = await repo.getSequenceById(workspaceId, req.params.id);
    if (!sequence) return res.status(404).json({ error: 'Sequence not found' });
    if (!EDITABLE_STATUSES.has(sequence.status)) {
      return res.status(409).json({ error: `Sequence in status "${sequence.status}" can no longer be edited` });
    }

    const existingStep = await repo.getStepById(sequence.id, req.params.stepId);
    if (!existingStep) return res.status(404).json({ error: 'Step not found' });

    const body = req.body || {};
    const merged = {
      // step_order is deliberately NOT taken from the client here — the
      // only supported way to reposition a step is the explicit numeric
      // `position` field handled further down (via renumberSteps), which
      // keeps the (sequence_id, step_order) unique constraint intact by
      // construction. Repositioning is applied to the DB as a second,
      // separate step below, so this field-update always preserves the
      // step's CURRENT order.
      stepOrder: existingStep.step_order,
      stepType: body.stepType !== undefined ? body.stepType : existingStep.step_type,
      templateId: body.templateId !== undefined ? body.templateId : existingStep.template_id,
      variableMapping: body.variableMapping !== undefined ? body.variableMapping : existingStep.variable_mapping,
      delayValue: body.delayValue !== undefined ? body.delayValue : existingStep.delay_value,
      delayUnit: body.delayUnit !== undefined ? body.delayUnit : existingStep.delay_unit,
    };

    const validationError = validateStepInput(merged);
    if (validationError) return res.status(400).json({ error: validationError });

    if (merged.stepType === 'message') {
      const refError = await validateTemplateReference(workspaceId, merged.templateId);
      if (refError) return res.status(403).json({ error: refError });
      merged.delayValue = null;
      merged.delayUnit = null;
    } else {
      merged.templateId = null;
      merged.variableMapping = {};
      merged.delayValue = Number(merged.delayValue);
    }

    const updated = await repo.updateStep(sequence.id, existingStep.id, merged);

    // Reposition only if `position` was explicitly sent.
    if (Number.isInteger(body.position) && body.position >= 1) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `SELECT id FROM coexistence.sequence_steps WHERE sequence_id = $1 ORDER BY step_order ASC`,
          [sequence.id]
        );
        const orderedIds = rows.map((r) => r.id).filter((id) => id !== existingStep.id);
        const insertAt = Math.min(body.position - 1, orderedIds.length);
        orderedIds.splice(insertAt, 0, existingStep.id);
        await renumberSteps(client, sequence.id, orderedIds);
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK');
        throw txErr;
      } finally {
        client.release();
      }
    }

    const finalStep = await repo.getStepById(sequence.id, existingStep.id);
    res.json(finalStep || updated);
  } catch (err) {
    console.error('[sequences] update step error:', err.message);
    res.status(500).json({ error: 'Failed to update step' });
  }
});

router.delete('/sequences/:id/steps/:stepId', requirePermission('sequence-studio'), gateSequenceStudio, async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const sequence = await repo.getSequenceById(workspaceId, req.params.id);
    if (!sequence) return res.status(404).json({ error: 'Sequence not found' });
    if (!EDITABLE_STATUSES.has(sequence.status)) {
      return res.status(409).json({ error: `Sequence in status "${sequence.status}" can no longer be edited` });
    }

    const existingStep = await repo.getStepById(sequence.id, req.params.stepId);
    if (!existingStep) return res.status(404).json({ error: 'Step not found' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM coexistence.sequence_steps WHERE id = $1 AND sequence_id = $2`,
        [existingStep.id, sequence.id]
      );
      const { rows } = await client.query(
        `SELECT id FROM coexistence.sequence_steps WHERE sequence_id = $1 ORDER BY step_order ASC`,
        [sequence.id]
      );
      // Close the gap left by the deleted step so remaining steps stay a
      // contiguous, deterministic 1..n sequence — never leave a hole or a
      // duplicate order value behind.
      await renumberSteps(client, sequence.id, rows.map((r) => r.id));
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[sequences] delete step error:', err.message);
    res.status(500).json({ error: 'Failed to delete step' });
  }
});

// ─── Manual enrollment ──────────────────────────────────────────────────
//
// Phase 7D — ACTIVATION. Enrollment still only establishes STATE here (this
// route never calls Meta, never touches the send queue, never executes a
// step itself — see sequenceScheduler.js for all of that); what changed
// from 7B is that this handler now computes a real `next_due_at` instead of
// always leaving it NULL, which is what actually lets the enrollment enter
// the 7C scheduler's `WHERE status = 'active' AND next_due_at <= NOW()`
// claim query. That NULL was the entire root cause of the "7C scheduler has
// no production enrollment that becomes due" gap described in Phase 7D's
// brief — 7B's manual enrollment was otherwise complete.
//
// `current_step_id` is set to the sequence's first step, exactly as 7B
// already did. `next_due_at` now follows the first step's own type, using
// the exact same delay semantics sequenceScheduler.js's advanceEnrollment()
// already applies when walking PAST a delay step later on (delayToMs,
// imported above) — so "what a delay step means" has one definition for
// the whole feature, not a separate guess here:
//   - first step is 'message'  -> next_due_at = NOW()   (send right away;
//     nothing in the schema/roadmap suggests a message-first sequence
//     should silently wait before its first message, and the scheduler
//     already treats a freshly-advanced-to message step the same way)
//   - first step is 'delay'    -> next_due_at = NOW() + that step's own
//     delay_value/delay_unit (the delay is honoured as authored, not
//     skipped just because it's first)
//   - sequence has no steps yet -> next_due_at = NOW(), current_step_id
//     stays NULL. This still reuses the scheduler unchanged: its
//     executeDueEnrollmentById() already has a branch for
//     "!enrollment.current_step_id" that immediately marks the enrollment
//     completed — so a stepless sequence's enrollment now actually reaches
//     that terminal state via the scheduler, instead of sitting in 'active'
//     with next_due_at = NULL forever (silently unreachable, the same bug
//     shape as the one this phase fixes for the step-having case).
router.post('/sequences/:id/enroll', requirePermission('sequence-studio'), gateSequenceStudio, async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const sequence = await repo.getSequenceById(workspaceId, req.params.id);
    if (!sequence) return res.status(404).json({ error: 'Sequence not found' });
    if (!ENROLLABLE_STATUSES.has(sequence.status)) {
      return res.status(409).json({ error: `Sequence in status "${sequence.status}" cannot accept enrollments` });
    }

    const body = req.body || {};
    // The project's existing contact identity convention (wa_number /
    // contact_number — see sequencesSchema.js's file-header comment).
    // sequence_enrollments only stores contact_number (the customer's own
    // number), matching how coexistence.contacts is deduplicated elsewhere
    // (services/audienceFilter.js's DISTINCT ON (c.contact_number)).
    const contactNumber = String(body.contactNumber || body.contact_number || '').trim();
    if (!contactNumber) return res.status(400).json({ error: 'contactNumber is required' });

    const { rows: contactRows } = await pool.query(
      `SELECT id FROM coexistence.contacts WHERE contact_number = $1 AND workspace_id = $2 LIMIT 1`,
      [contactNumber, workspaceId]
    );
    if (!contactRows.length) return res.status(404).json({ error: 'Contact not found in this workspace' });

    // Application-level duplicate-active check first (clean 409 for the
    // common case)...
    const activeExisting = await repo.getActiveEnrollment(workspaceId, sequence.id, contactNumber);
    if (activeExisting) {
      return res.status(409).json({ error: 'Contact already has an active enrollment in this sequence' });
    }

    const firstStep = await repo.getFirstStep(sequence.id);

    // See the doc comment above this route for the full reasoning — this
    // is the Phase 7D activation fix.
    let nextDueAt;
    if (firstStep && firstStep.step_type === 'delay') {
      nextDueAt = new Date(Date.now() + delayToMs(firstStep.delay_value, firstStep.delay_unit));
    } else {
      // Covers both "first step is 'message'" and "no steps at all" —
      // both become due immediately; the scheduler's existing branches
      // (send the message / complete a stepless enrollment) take it from
      // there unchanged.
      nextDueAt = new Date();
    }

    try {
      // ...then the Phase 7A partial unique index
      // (uq_sequence_enrollments_active_contact) is the final DB-level
      // safety net against a concurrent duplicate enrollment racing this
      // same request — the application check above is not itself atomic.
      const enrollment = await repo.createEnrollment(workspaceId, sequence.id, {
        contactNumber,
        currentStepId: firstStep ? firstStep.id : null,
        nextDueAt,
      });
      res.json(enrollment);
    } catch (dbErr) {
      if (dbErr.code === '23505') {
        return res.status(409).json({ error: 'Contact already has an active enrollment in this sequence' });
      }
      throw dbErr;
    }
  } catch (err) {
    console.error('[sequences] enroll error:', err.message);
    res.status(500).json({ error: 'Failed to enroll contact' });
  }
});

router.get('/sequences/:id/enrollments', requirePermission('sequence-studio'), gateSequenceStudio, async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const sequence = await repo.getSequenceById(workspaceId, req.params.id);
    if (!sequence) return res.status(404).json({ error: 'Sequence not found' });

    const { limit = 50, offset = 0 } = req.query;
    const result = await repo.listEnrollments(workspaceId, sequence.id, { limit, offset });
    res.json(result);
  } catch (err) {
    console.error('[sequences] list enrollments error:', err.message);
    res.status(500).json({ error: 'Failed to list enrollments' });
  }
});

router.get('/sequences/:id/enrollments/:enrollmentId', requirePermission('sequence-studio'), gateSequenceStudio, async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const sequence = await repo.getSequenceById(workspaceId, req.params.id);
    if (!sequence) return res.status(404).json({ error: 'Sequence not found' });

    const enrollment = await repo.getEnrollmentById(workspaceId, sequence.id, req.params.enrollmentId);
    if (!enrollment) return res.status(404).json({ error: 'Enrollment not found' });

    // Relevant step info, just enough to identify the enrollment safely —
    // not execution history (that's a later part).
    let currentStep = null;
    if (enrollment.current_step_id) {
      currentStep = await repo.getStepById(sequence.id, enrollment.current_step_id);
    }

    // Phase 7F Part 2 — execution history. Read-only surface of rows the
    // scheduler/sendQueue already write to sequence_step_executions (see
    // repositories/sequenceRepository.js's listStepExecutions doc comment).
    // No field here is invented — this is exactly the STEP_EXECUTION_COLUMNS
    // shape already persisted by sequenceScheduler.js / queue/sendQueue.js.
    const executions = await repo.listStepExecutions(enrollment.id);

    res.json({ ...enrollment, sequence: { id: sequence.id, name: sequence.name, status: sequence.status }, currentStep, executions });
  } catch (err) {
    console.error('[sequences] get enrollment error:', err.message);
    res.status(500).json({ error: 'Failed to load enrollment' });
  }
});

// ─── Phase 7E — Pause / Resume ──────────────────────────────────────────
//
// Both handlers do the same two-step dance: 404 if the sequence/enrollment
// doesn't exist in this workspace (never leak existence across workspaces
// — same convention as every other route in this file), then delegate the
// actual state transition to a single atomic conditional UPDATE in the
// repository (pauseEnrollment / resumeEnrollment). That UPDATE's WHERE
// clause (status = 'active' for pause, status = 'paused' for resume) is
// what makes duplicate/concurrent requests safe — a second pause request
// racing the first simply finds zero matching rows and gets a 409, no
// read-then-write window to race inside.
//
// Neither handler touches sequence_step_executions — execution history is
// never deleted or rewritten by a pause/resume, exactly as required.

router.post('/sequences/:id/enrollments/:enrollmentId/pause', requirePermission('sequence-studio'), gateSequenceStudio, async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const sequence = await repo.getSequenceById(workspaceId, req.params.id);
    if (!sequence) return res.status(404).json({ error: 'Sequence not found' });

    const existing = await repo.getEnrollmentById(workspaceId, sequence.id, req.params.enrollmentId);
    if (!existing) return res.status(404).json({ error: 'Enrollment not found' });

    if (existing.status !== 'active') {
      // Covers "already paused" (duplicate pause), and every terminal
      // status (completed/exited/cancelled) — none of those can be
      // paused. Same status-check-before-mutate shape as
      // EDITABLE_STATUSES/ENROLLABLE_STATUSES elsewhere in this file.
      return res.status(409).json({ error: `Enrollment in status "${existing.status}" cannot be paused` });
    }

    const paused = await repo.pauseEnrollment(workspaceId, sequence.id, existing.id);
    if (!paused) {
      // Lost a race against a concurrent pause/resume/scheduler-driven
      // status change between the check above and the UPDATE — the
      // conditional UPDATE's WHERE clause is the real safety net, this is
      // just turning "0 rows updated" into a clean 409 instead of
      // silently returning stale data.
      return res.status(409).json({ error: 'Enrollment is no longer active' });
    }

    res.json(paused);
  } catch (err) {
    console.error('[sequences] pause enrollment error:', err.message);
    res.status(500).json({ error: 'Failed to pause enrollment' });
  }
});

router.post('/sequences/:id/enrollments/:enrollmentId/resume', requirePermission('sequence-studio'), gateSequenceStudio, async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const sequence = await repo.getSequenceById(workspaceId, req.params.id);
    if (!sequence) return res.status(404).json({ error: 'Sequence not found' });

    const existing = await repo.getEnrollmentById(workspaceId, sequence.id, req.params.enrollmentId);
    if (!existing) return res.status(404).json({ error: 'Enrollment not found' });

    if (existing.status !== 'paused') {
      return res.status(409).json({ error: `Enrollment in status "${existing.status}" cannot be resumed` });
    }

    const resumed = await repo.resumeEnrollment(workspaceId, sequence.id, existing.id);
    if (!resumed) {
      return res.status(409).json({ error: 'Enrollment is no longer paused' });
    }

    res.json(resumed);
  } catch (err) {
    console.error('[sequences] resume enrollment error:', err.message);
    res.status(500).json({ error: 'Failed to resume enrollment' });
  }
});

module.exports = { router, EDITABLE_STATUSES, ENROLLABLE_STATUSES, validateSequenceInput, validateStepInput };



