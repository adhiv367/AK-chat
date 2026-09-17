// Phase 7 Part B — Sequence CRUD + Manual Enrollment: workspace-scoped data
// access for coexistence.sequences / sequence_steps / sequence_enrollments.
//
// Same convention as repositories/campaignRepository.js: every query takes
// workspaceId as an explicit, required argument and includes it in the
// WHERE clause — callers (routes/sequences.js) must always pass
// req.workspace.id (server-derived), never a client-supplied id.

const pool = require('../db');

const SEQUENCE_COLUMNS = `
  id, workspace_id, name, description, status,
  entry_config, exit_rules,
  created_by, created_at, updated_at
`;

const STEP_COLUMNS = `
  id, sequence_id, step_order, step_type,
  template_id, variable_mapping,
  delay_value, delay_unit,
  created_at, updated_at
`;

const ENROLLMENT_COLUMNS = `
  id, workspace_id, sequence_id, contact_number,
  status, current_step_id, next_due_at,
  enrolled_at, completed_at, exited_at, exit_reason,
  created_at, updated_at
`;

// ─── Sequences ──────────────────────────────────────────────────────────

async function listSequences(workspaceId, { search = '', status = '', limit = 50, offset = 0 } = {}) {
  const params = [workspaceId];
  let where = 'workspace_id = $1';

  if (search) {
    params.push(`%${search}%`);
    where += ` AND name ILIKE $${params.length}`;
  }
  if (status) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }

  const capLimit = Math.min(parseInt(limit, 10) || 50, 200);
  const capOffset = Math.max(parseInt(offset, 10) || 0, 0);

  const { rows } = await pool.query(
    `SELECT ${SEQUENCE_COLUMNS} FROM coexistence.sequences
      WHERE ${where}
      ORDER BY updated_at DESC
      LIMIT ${capLimit} OFFSET ${capOffset}`,
    params
  );
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM coexistence.sequences WHERE ${where}`,
    params
  );
  return { rows, total: countRows[0]?.total || 0 };
}

// Fetches a sequence by id, STRICTLY scoped to workspaceId. Returns
// undefined if the sequence doesn't exist OR belongs to a different
// workspace — callers must treat both cases identically (404), never
// leaking whether the id exists elsewhere.
async function getSequenceById(workspaceId, id) {
  const { rows } = await pool.query(
    `SELECT ${SEQUENCE_COLUMNS} FROM coexistence.sequences WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId]
  );
  return rows[0];
}

async function createSequence(workspaceId, data, createdBy) {
  const { name, description = null, entryConfig = {}, exitRules = [] } = data;
  const { rows } = await pool.query(
    `INSERT INTO coexistence.sequences
       (workspace_id, name, description, status, entry_config, exit_rules, created_by)
     VALUES ($1,$2,$3,'draft',$4,$5,$6)
     RETURNING ${SEQUENCE_COLUMNS}`,
    [workspaceId, name, description, JSON.stringify(entryConfig || {}), JSON.stringify(exitRules || []), createdBy]
  );
  return rows[0];
}

// Full-replace update of the editable fields on a DRAFT sequence. Callers
// (routes/sequences.js) are responsible for rejecting edits to non-draft
// sequences before calling this.
async function updateSequence(workspaceId, id, data) {
  const { name, description, entryConfig, exitRules } = data;
  const { rows } = await pool.query(
    `UPDATE coexistence.sequences SET
       name = $3, description = $4, entry_config = $5, exit_rules = $6
     WHERE id = $1 AND workspace_id = $2
     RETURNING ${SEQUENCE_COLUMNS}`,
    [id, workspaceId, name, description, JSON.stringify(entryConfig || {}), JSON.stringify(exitRules || [])]
  );
  return rows[0];
}

async function updateStatus(workspaceId, id, status) {
  const { rows } = await pool.query(
    `UPDATE coexistence.sequences SET status = $3
      WHERE id = $1 AND workspace_id = $2
      RETURNING ${SEQUENCE_COLUMNS}`,
    [id, workspaceId, status]
  );
  return rows[0];
}

async function deleteSequence(workspaceId, id) {
  const { rowCount } = await pool.query(
    `DELETE FROM coexistence.sequences WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId]
  );
  return rowCount > 0;
}

// ─── Sequence steps ─────────────────────────────────────────────────────
// Steps are not workspace-scoped directly (no workspace_id column — see
// sequencesSchema.js) so every caller must first resolve the sequence via
// getSequenceById(workspaceId, sequenceId) to establish ownership, then use
// these helpers scoped to that already-verified sequence_id.

async function listStepsBySequence(sequenceId) {
  const { rows } = await pool.query(
    `SELECT ${STEP_COLUMNS} FROM coexistence.sequence_steps
      WHERE sequence_id = $1
      ORDER BY step_order ASC`,
    [sequenceId]
  );
  return rows;
}

async function getStepById(sequenceId, stepId) {
  const { rows } = await pool.query(
    `SELECT ${STEP_COLUMNS} FROM coexistence.sequence_steps WHERE id = $1 AND sequence_id = $2`,
    [stepId, sequenceId]
  );
  return rows[0];
}

async function getMaxStepOrder(sequenceId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(MAX(step_order), 0)::int AS max_order
       FROM coexistence.sequence_steps WHERE sequence_id = $1`,
    [sequenceId]
  );
  return rows[0]?.max_order || 0;
}

async function createStep(sequenceId, data) {
  const {
    stepOrder, stepType,
    templateId = null, variableMapping = {},
    delayValue = null, delayUnit = null,
  } = data;
  const { rows } = await pool.query(
    `INSERT INTO coexistence.sequence_steps
       (sequence_id, step_order, step_type, template_id, variable_mapping, delay_value, delay_unit)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING ${STEP_COLUMNS}`,
    [sequenceId, stepOrder, stepType, templateId, JSON.stringify(variableMapping || {}), delayValue, delayUnit]
  );
  return rows[0];
}

async function updateStep(sequenceId, stepId, data) {
  const {
    stepOrder, stepType,
    templateId = null, variableMapping = {},
    delayValue = null, delayUnit = null,
  } = data;
  const { rows } = await pool.query(
    `UPDATE coexistence.sequence_steps SET
       step_order = $3, step_type = $4, template_id = $5, variable_mapping = $6,
       delay_value = $7, delay_unit = $8
     WHERE id = $1 AND sequence_id = $2
     RETURNING ${STEP_COLUMNS}`,
    [stepId, sequenceId, stepOrder, stepType, templateId, JSON.stringify(variableMapping || {}), delayValue, delayUnit]
  );
  return rows[0];
}

// Used only for the swap-order step of reorder-on-delete — bypasses the
// unique(sequence_id, step_order) constraint check by only ever touching
// order values already known to be free (see routes/sequences.js).
async function setStepOrder(sequenceId, stepId, stepOrder) {
  const { rows } = await pool.query(
    `UPDATE coexistence.sequence_steps SET step_order = $3
      WHERE id = $1 AND sequence_id = $2
      RETURNING ${STEP_COLUMNS}`,
    [stepId, sequenceId, stepOrder]
  );
  return rows[0];
}

async function deleteStep(sequenceId, stepId) {
  const { rowCount } = await pool.query(
    `DELETE FROM coexistence.sequence_steps WHERE id = $1 AND sequence_id = $2`,
    [stepId, sequenceId]
  );
  return rowCount > 0;
}

async function getFirstStep(sequenceId) {
  const { rows } = await pool.query(
    `SELECT ${STEP_COLUMNS} FROM coexistence.sequence_steps
      WHERE sequence_id = $1
      ORDER BY step_order ASC
      LIMIT 1`,
    [sequenceId]
  );
  return rows[0];
}

// ─── Enrollments ────────────────────────────────────────────────────────

async function listEnrollments(workspaceId, sequenceId, { limit = 50, offset = 0 } = {}) {
  const capLimit = Math.min(parseInt(limit, 10) || 50, 200);
  const capOffset = Math.max(parseInt(offset, 10) || 0, 0);
  const { rows } = await pool.query(
    `SELECT ${ENROLLMENT_COLUMNS} FROM coexistence.sequence_enrollments
      WHERE workspace_id = $1 AND sequence_id = $2
      ORDER BY enrolled_at DESC
      LIMIT ${capLimit} OFFSET ${capOffset}`,
    [workspaceId, sequenceId]
  );
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM coexistence.sequence_enrollments
      WHERE workspace_id = $1 AND sequence_id = $2`,
    [workspaceId, sequenceId]
  );
  return { rows, total: countRows[0]?.total || 0 };
}

async function getEnrollmentById(workspaceId, sequenceId, enrollmentId) {
  const { rows } = await pool.query(
    `SELECT ${ENROLLMENT_COLUMNS} FROM coexistence.sequence_enrollments
      WHERE id = $1 AND workspace_id = $2 AND sequence_id = $3`,
    [enrollmentId, workspaceId, sequenceId]
  );
  return rows[0];
}

async function getActiveEnrollment(workspaceId, sequenceId, contactNumber) {
  const { rows } = await pool.query(
    `SELECT ${ENROLLMENT_COLUMNS} FROM coexistence.sequence_enrollments
      WHERE workspace_id = $1 AND sequence_id = $2 AND contact_number = $3 AND status = 'active'`,
    [workspaceId, sequenceId, contactNumber]
  );
  return rows[0];
}

// Creates a manual enrollment. `nextDueAt` defaults to NULL only for
// callers that don't pass one (there are none left in routes/sequences.js
// as of Phase 7D — see that file's enroll handler for how a real
// next_due_at is now always computed from the first step).
async function createEnrollment(workspaceId, sequenceId, { contactNumber, currentStepId = null, nextDueAt = null }) {
  const { rows } = await pool.query(
    `INSERT INTO coexistence.sequence_enrollments
       (workspace_id, sequence_id, contact_number, status, current_step_id, next_due_at)
     VALUES ($1,$2,$3,'active',$4,$5)
     RETURNING ${ENROLLMENT_COLUMNS}`,
    [workspaceId, sequenceId, contactNumber, currentStepId, nextDueAt]
  );
  return rows[0];
}

// ─── Phase 7E — Pause / Resume ──────────────────────────────────────────
// Both are single, atomic, conditional UPDATEs — no read-then-write —
// so two concurrent pause (or resume) requests for the same enrollment
// race safely at the database level: only the first one's WHERE clause
// still matches, the second gets rowCount 0 / undefined back and the
// route layer turns that into a 409, exactly like the existing
// duplicate-archive handling in DELETE /sequences/:id.

// Pauses an ACTIVE enrollment. Deliberately does NOT touch current_step_id,
// next_due_at, or any sequence_step_executions row — pausing only flips
// status. next_due_at is left exactly as it was (not nulled) so resume can
// tell how much of a delay step's wait had already elapsed; it plays no
// part in scheduler eligibility once status != 'active' (see
// sequenceScheduler.claimDueEnrollmentIds' WHERE clause and its partial
// index, both scoped to status = 'active').
async function pauseEnrollment(workspaceId, sequenceId, enrollmentId) {
  const { rows } = await pool.query(
    `UPDATE coexistence.sequence_enrollments
        SET status = 'paused'
      WHERE id = $1 AND workspace_id = $2 AND sequence_id = $3 AND status = 'active'
      RETURNING ${ENROLLMENT_COLUMNS}`,
    [enrollmentId, workspaceId, sequenceId]
  );
  return rows[0];
}

// Resumes a PAUSED enrollment from its existing current_step_id — never
// step 1. next_due_at semantics (see routes/sequences.js's resume handler
// doc comment for the full reasoning): if the enrollment's preserved
// next_due_at is still in the future, it is left untouched (a delay step's
// remaining wait is honoured); if it's null or already in the past, it's
// set to NOW() so the step becomes due on the next scheduler tick (correct
// for a message step, or a delay step whose wait had already elapsed
// before/while paused).
async function resumeEnrollment(workspaceId, sequenceId, enrollmentId) {
  const { rows } = await pool.query(
    `UPDATE coexistence.sequence_enrollments
        SET status = 'active',
            next_due_at = CASE
              WHEN next_due_at IS NULL OR next_due_at <= NOW() THEN NOW()
              ELSE next_due_at
            END
      WHERE id = $1 AND workspace_id = $2 AND sequence_id = $3 AND status = 'paused'
      RETURNING ${ENROLLMENT_COLUMNS}`,
    [enrollmentId, workspaceId, sequenceId]
  );
  return rows[0];
}

// ─── Phase 7F Part 2 — Execution history (read-only) ───────────────────
// sequence_step_executions is already written by sequenceScheduler.js /
// queue/sendQueue.js (Phase 7C onward) but was never exposed through the
// API. This is a pure additive read: no new table, no new column, no
// write path — just surfacing existing rows so the enrollment-detail
// route (routes/sequences.js) can display them. Scoped to a single
// enrollment_id only; the caller (routes/sequences.js) has already
// verified that enrollment belongs to this workspace/sequence via
// getEnrollmentById before calling this.
const STEP_EXECUTION_COLUMNS = `
  id, enrollment_id, step_id, status, wa_message_id, error_message,
  executed_at, created_at, updated_at
`;

async function listStepExecutions(enrollmentId) {
  const { rows } = await pool.query(
    `SELECT ${STEP_EXECUTION_COLUMNS} FROM coexistence.sequence_step_executions
      WHERE enrollment_id = $1
      ORDER BY created_at ASC`,
    [enrollmentId]
  );
  return rows;
}

module.exports = {
  SEQUENCE_COLUMNS, STEP_COLUMNS, ENROLLMENT_COLUMNS, STEP_EXECUTION_COLUMNS,
  listSequences, getSequenceById, createSequence, updateSequence, updateStatus, deleteSequence,
  listStepsBySequence, getStepById, getMaxStepOrder, createStep, updateStep, setStepOrder, deleteStep, getFirstStep,
  listEnrollments, getEnrollmentById, getActiveEnrollment, createEnrollment,
  pauseEnrollment, resumeEnrollment,
  listStepExecutions,
};
