// Phase 7 Part A — Sequence / Drip Automation: SCHEMA FOUNDATION ONLY.
//
// This file creates four NEW, additive tables:
//   coexistence.sequences
//   coexistence.sequence_steps
//   coexistence.sequence_enrollments
//   coexistence.sequence_step_executions
//
// No CRUD, enrollment, scheduler, or trigger logic lives here or anywhere
// else yet — this is deliberately schema-only (see project instructions for
// Phase 7 Part A). It follows the same idempotent `CREATE TABLE IF NOT
// EXISTS` + `CREATE INDEX IF NOT EXISTS` convention used throughout this
// db/ folder (see campaignsSchema.js, planChangeRequestsSchema.js).
//
// Sequences are a SEPARATE domain from Campaign Studio (coexistence.campaigns)
// by explicit project requirement — this file does not touch campaigns,
// broadcasts, broadcast_logs, message_templates, contacts, or any Phase 1–6
// table in any way. It only reads their id/column shapes to reference them
// correctly via FK.
//
// Contact identity: this project does not have a synthetic contacts.id used
// for WhatsApp identity — contacts are addressed by `wa_number`
// (digits-only-tolerant TEXT), the same identifier coexistence.broadcasts /
// coexistence.broadcast_logs / coexistence.campaigns.audience_contact_ids
// use elsewhere (see contactsWorkspaceSchema.js). sequence_enrollments
// therefore stores `contact_number` as TEXT rather than a contacts FK, to
// match that existing convention exactly (no new contact table, no
// duplicated identity model).
//
// Must run after:
//   - ensureWorkspaceTables()            (FKs coexistence.workspaces)
//   - ensureTables()                     (FKs coexistence.akchat_users via created_by)
//   - ensureTemplatesWorkspaceColumns()  (FKs coexistence.message_templates via sequence_steps.template_id)
// See index.js boot order — placed after ensureCampaignsTable() for the
// same reason Phase 6 was placed where it is (all of the above already
// guaranteed to exist by that point in boot).

const pool = require('../db');

// Sequence lifecycle. Mirrors the campaigns.js convention of a plain TEXT
// column + CHECK constraint (not a Postgres ENUM type), so a future status
// can be added later with just a CHECK-constraint migration, not a type
// migration.
const SEQUENCE_STATUSES = ['draft', 'active', 'paused', 'archived'];

// Phase 7A only supports these two step types, by explicit instruction.
// Future-phase step types (flow/commerce/payment/AI/email/instagram/
// facebook/omnichannel) are intentionally NOT added here.
const STEP_TYPES = ['message', 'delay'];

const DELAY_UNITS = ['minutes', 'hours', 'days'];

// Per-contact enrollment lifecycle. 'active' = currently progressing,
// 'paused' = manually held (Part 7 of the roadmap), 'completed' = ran all
// steps to the end, 'exited' = left early via an exit condition (Part 6),
// 'cancelled' = manually removed before completion.
const ENROLLMENT_STATUSES = ['active', 'paused', 'completed', 'exited', 'cancelled'];

// Execution-attempt status per step per enrollment. Mirrors the
// pending/sent/failed vocabulary already used by
// coexistence.broadcast_logs / coexistence.automation_executions elsewhere
// in this codebase, kept minimal since 7A does not implement retry logic.
const STEP_EXECUTION_STATUSES = ['pending', 'sent', 'failed', 'skipped'];

async function ensureSequencesTable() {
  // ── 1. coexistence.sequences ────────────────────────────────────────────
  // The sequence definition (envelope). `entry_config` / `exit_rules` are
  // JSONB so Part 6 (exit conditions) and Part 10 (automatic entry
  // triggers) can extend their shape without any further schema change —
  // same reasoning as campaigns.audience_filters being JSONB from Part 1.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.sequences (
      id              BIGSERIAL PRIMARY KEY,
      workspace_id    BIGINT NOT NULL REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,

      name            TEXT NOT NULL,
      description     TEXT,

      status          TEXT NOT NULL DEFAULT 'draft',

      -- How contacts get in. Part 10 (automatic entry) will read/write this;
      -- 7A only reserves the column. Empty object today = "manual enrollment
      -- only", which is all 7A/manual-enrollment (a later part) needs.
      entry_config    JSONB NOT NULL DEFAULT '{}'::jsonb,

      -- Conditions that pull a contact OUT of the sequence early
      -- (Part 6). Empty array today = no exit conditions defined yet.
      exit_rules      JSONB NOT NULL DEFAULT '[]'::jsonb,

      created_by      BIGINT REFERENCES coexistence.akchat_users(id) ON DELETE SET NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT sequences_status_check CHECK (status IN (${SEQUENCE_STATUSES.map((s) => `'${s}'`).join(', ')}))
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sequences_workspace_id
      ON coexistence.sequences (workspace_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sequences_workspace_status
      ON coexistence.sequences (workspace_id, status)
  `);

  // updated_at auto-touch trigger, same local-function-per-table pattern as
  // coexistence.campaigns (campaignsSchema.js) — kept local rather than
  // shared in case a shared trigger function doesn't exist in every install.
  await pool.query(`
    CREATE OR REPLACE FUNCTION coexistence.sequences_touch_updated_at()
    RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    DROP TRIGGER IF EXISTS trg_sequences_touch_updated_at ON coexistence.sequences
  `);
  await pool.query(`
    CREATE TRIGGER trg_sequences_touch_updated_at
      BEFORE UPDATE ON coexistence.sequences
      FOR EACH ROW EXECUTE FUNCTION coexistence.sequences_touch_updated_at()
  `);

  // ── 2. coexistence.sequence_steps ───────────────────────────────────────
  // Ordered steps belonging to a sequence. `template_id` is only meaningful
  // for step_type='message' (nullable so 'delay' steps leave it NULL).
  // `delay_value`/`delay_unit` are only meaningful for step_type='delay'.
  // Both step "shapes" live in one table (rather than two) to keep
  // step_order a single simple sequence, matching how sequence_steps will
  // need to be walked in order at execution time.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.sequence_steps (
      id                BIGSERIAL PRIMARY KEY,
      sequence_id       BIGINT NOT NULL REFERENCES coexistence.sequences(id) ON DELETE CASCADE,

      step_order        INTEGER NOT NULL,
      step_type         TEXT NOT NULL,

      -- message-step fields (NULL for delay steps)
      template_id       BIGINT REFERENCES coexistence.message_templates(id) ON DELETE SET NULL,
      variable_mapping  JSONB NOT NULL DEFAULT '{}'::jsonb,

      -- delay-step fields (NULL for message steps)
      delay_value       INTEGER,
      delay_unit        TEXT,

      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT sequence_steps_type_check
        CHECK (step_type IN (${STEP_TYPES.map((s) => `'${s}'`).join(', ')})),
      CONSTRAINT sequence_steps_delay_unit_check
        CHECK (delay_unit IS NULL OR delay_unit IN (${DELAY_UNITS.map((s) => `'${s}'`).join(', ')})),
      -- One step_order per sequence — the ordering itself must be
      -- unambiguous for the future execution walk.
      CONSTRAINT sequence_steps_sequence_order_unique UNIQUE (sequence_id, step_order)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sequence_steps_sequence_id
      ON coexistence.sequence_steps (sequence_id, step_order)
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION coexistence.sequence_steps_touch_updated_at()
    RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    DROP TRIGGER IF EXISTS trg_sequence_steps_touch_updated_at ON coexistence.sequence_steps
  `);
  await pool.query(`
    CREATE TRIGGER trg_sequence_steps_touch_updated_at
      BEFORE UPDATE ON coexistence.sequence_steps
      FOR EACH ROW EXECUTE FUNCTION coexistence.sequence_steps_touch_updated_at()
  `);

  // ── 3. coexistence.sequence_enrollments ─────────────────────────────────
  // A contact's membership + progress in a sequence. `contact_number`
  // (TEXT) matches the existing wa_number/contact_number convention used
  // throughout broadcasts/campaigns/contacts — no new contact identity
  // model, no duplicated contact table (see file header).
  //
  // `current_step_id` is nullable (NULL before the first step executes, or
  // after completion/exit) and ON DELETE SET NULL so deleting a step
  // definition can never cascade-delete an enrollment.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.sequence_enrollments (
      id                BIGSERIAL PRIMARY KEY,
      workspace_id      BIGINT NOT NULL REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,
      sequence_id       BIGINT NOT NULL REFERENCES coexistence.sequences(id) ON DELETE CASCADE,
      contact_number    TEXT NOT NULL,

      status            TEXT NOT NULL DEFAULT 'active',
      current_step_id   BIGINT REFERENCES coexistence.sequence_steps(id) ON DELETE SET NULL,

      -- Scheduler foundation (Part 4 will consume this; 7A only reserves
      -- and indexes it). NULL = nothing currently due for this enrollment.
      next_due_at       TIMESTAMPTZ,

      enrolled_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at      TIMESTAMPTZ,
      exited_at         TIMESTAMPTZ,
      exit_reason       TEXT,

      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT sequence_enrollments_status_check
        CHECK (status IN (${ENROLLMENT_STATUSES.map((s) => `'${s}'`).join(', ')}))
    )
  `);

  // Duplicate-ACTIVE-enrollment protection: at most one *active* enrollment
  // per (sequence, contact) at the database level. A partial unique index
  // (not a plain UNIQUE constraint) so a contact CAN be re-enrolled after
  // completing/exiting/being cancelled — only a currently-active row is
  // exclusive. Same partial-unique-index technique already used by
  // planChangeRequestsSchema.js (uq_plan_change_requests_one_pending).
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sequence_enrollments_active_contact
      ON coexistence.sequence_enrollments (sequence_id, contact_number)
      WHERE status = 'active'
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_workspace_id
      ON coexistence.sequence_enrollments (workspace_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_sequence_id
      ON coexistence.sequence_enrollments (sequence_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_contact_number
      ON coexistence.sequence_enrollments (contact_number)
  `);
  // The scheduler-foundation index: efficiently find active enrollments due
  // now, matching the "FOR UPDATE SKIP LOCKED over WHERE status = X AND
  // due_at <= NOW()" shape used by broadcastScheduler.js — the future
  // sequence scheduler (Part 4, NOT implemented here) will query exactly
  // this shape. Partial on status='active' so paused/completed/exited/
  // cancelled rows never bloat this index.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_due
      ON coexistence.sequence_enrollments (next_due_at)
      WHERE status = 'active' AND next_due_at IS NOT NULL
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION coexistence.sequence_enrollments_touch_updated_at()
    RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    DROP TRIGGER IF EXISTS trg_sequence_enrollments_touch_updated_at ON coexistence.sequence_enrollments
  `);
  await pool.query(`
    CREATE TRIGGER trg_sequence_enrollments_touch_updated_at
      BEFORE UPDATE ON coexistence.sequence_enrollments
      FOR EACH ROW EXECUTE FUNCTION coexistence.sequence_enrollments_touch_updated_at()
  `);

  // ── 4. coexistence.sequence_step_executions ─────────────────────────────
  // Execution history for each (enrollment, step) attempt. `wa_message_id`
  // mirrors the existing broadcast_logs convention of recording the Meta
  // message id for later webhook delivery-status correlation.
  //
  // Idempotency foundation: a partial unique index on (enrollment_id,
  // step_id) WHERE status IN ('sent','skipped') ensures a given step can
  // only be *successfully* recorded once per enrollment — a 'failed' row
  // does NOT block a future retry attempt from being recorded, since the
  // future retry logic (not implemented in 7A) will need to insert a new
  // attempt row after a failure. This is the safest constraint shape
  // without yet knowing whether retries will UPDATE-in-place or INSERT a
  // new attempt row — schema only, per instructions.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.sequence_step_executions (
      id              BIGSERIAL PRIMARY KEY,
      enrollment_id   BIGINT NOT NULL REFERENCES coexistence.sequence_enrollments(id) ON DELETE CASCADE,
      step_id         BIGINT NOT NULL REFERENCES coexistence.sequence_steps(id) ON DELETE CASCADE,

      status          TEXT NOT NULL DEFAULT 'pending',
      wa_message_id   TEXT,
      error_message   TEXT,

      executed_at     TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT sequence_step_executions_status_check
        CHECK (status IN (${STEP_EXECUTION_STATUSES.map((s) => `'${s}'`).join(', ')}))
    )
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sequence_step_executions_completed
      ON coexistence.sequence_step_executions (enrollment_id, step_id)
      WHERE status IN ('sent', 'skipped')
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sequence_step_executions_enrollment_id
      ON coexistence.sequence_step_executions (enrollment_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sequence_step_executions_step_id
      ON coexistence.sequence_step_executions (step_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sequence_step_executions_wa_message_id
      ON coexistence.sequence_step_executions (wa_message_id)
      WHERE wa_message_id IS NOT NULL
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION coexistence.sequence_step_executions_touch_updated_at()
    RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    DROP TRIGGER IF EXISTS trg_sequence_step_executions_touch_updated_at ON coexistence.sequence_step_executions
  `);
  await pool.query(`
    CREATE TRIGGER trg_sequence_step_executions_touch_updated_at
      BEFORE UPDATE ON coexistence.sequence_step_executions
      FOR EACH ROW EXECUTE FUNCTION coexistence.sequence_step_executions_touch_updated_at()
  `);
}

module.exports = {
  ensureSequencesTable,
  SEQUENCE_STATUSES,
  STEP_TYPES,
  DELAY_UNITS,
  ENROLLMENT_STATUSES,
  STEP_EXECUTION_STATUSES,
};




