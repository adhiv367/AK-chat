// AI Agent — Workspace-Level Business Profile.
//
// One row per workspace: a persistent baseline (business type + system
// instructions) that every ai_reply automation node in that workspace
// inherits from, unless the individual node's own goal/instructions
// narrows or overrides it (see aiReplyService.generateReply's
// businessProfile param — profile applies first, node config layers on
// top, nothing is ever silently dropped).
//
// Mirrors the existing idempotent `CREATE TABLE IF NOT EXISTS` + backfill
// convention used throughout db/*Schema.js (workspaceDefaultsSchema.js is
// the closest match — same one-row-per-workspace shape).

const pool = require('../db');

// Small starting library of business-type presets. Picking a type in the UI
// pre-fills systemInstructions with one of these — still fully editable
// afterward. Kept here (not in a separate table) since these are static,
// code-shipped starting points, not per-workspace data.
const BUSINESS_TYPE_PRESETS = Object.freeze({
  general: '',
  real_estate: 'We are a real estate agency. Help customers with property enquiries — location, price range, and whether they want to buy or rent. Never quote a specific price or availability unless it is explicitly provided to you elsewhere in this conversation.',
  clothing: 'We are a clothing/fashion retailer. Help customers find products by style, color, size, and occasion. Never state stock, price, or size availability unless explicitly provided to you elsewhere in this conversation.',
  construction: 'We are a construction/contracting business. Help customers with project enquiries — type of work, rough scope, and timeline expectations. Never quote a specific price or committed timeline unless explicitly provided to you elsewhere in this conversation.',
});

const VALID_BUSINESS_TYPES = new Set(Object.keys(BUSINESS_TYPE_PRESETS));

async function ensureWorkspaceAiProfileTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.workspace_ai_profile (
      workspace_id       BIGINT PRIMARY KEY
                            REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,
      business_type      TEXT NOT NULL DEFAULT 'general',
      system_instructions TEXT NOT NULL DEFAULT '',
      default_model      TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Backfill: every workspace that predates this table gets exactly one
  // profile row with safe empty defaults (business_type='general', empty
  // instructions — a no-op for generateReply's prompt, identical to today's
  // behavior until someone actually sets it via the UI).
  const { rowCount } = await pool.query(
    `INSERT INTO coexistence.workspace_ai_profile (workspace_id)
     SELECT w.id FROM coexistence.workspaces w
      WHERE NOT EXISTS (
        SELECT 1 FROM coexistence.workspace_ai_profile p WHERE p.workspace_id = w.id
      )`
  );
  if (rowCount > 0) {
    console.log(`[workspace-ai-profile] backfilled profile for ${rowCount} workspace(s)`);
  }
}

// Create a profile row for exactly one newly-created workspace. Safe to
// call inside an existing transaction — used by POST /workspaces so a new
// workspace never depends on a server restart to get its own row.
async function ensureAiProfileRowForWorkspace(client, workspaceId) {
  await client.query(
    `INSERT INTO coexistence.workspace_ai_profile (workspace_id)
     VALUES ($1) ON CONFLICT (workspace_id) DO NOTHING`,
    [workspaceId]
  );
}

// Fetch a workspace's profile in the shape aiReplyService.generateReply
// expects for its businessProfile param. Returns null (not throws) if the
// workspace has no row yet or the query fails — same fail-quiet contract
// as every other DB helper this AI reply path depends on, so a lookup
// problem here degrades to "no profile applied" rather than breaking the
// whole automation.
async function getWorkspaceAiProfile(workspaceId) {
  if (!workspaceId) return null;
  try {
    const { rows } = await pool.query(
      `SELECT business_type, system_instructions, default_model
         FROM coexistence.workspace_ai_profile WHERE workspace_id = $1`,
      [workspaceId]
    );
    if (!rows.length) return null;
    const row = rows[0];
    if (!row.system_instructions) return null; // nothing to add — same as omitting the param
    return {
      businessType: row.business_type,
      systemInstructions: row.system_instructions,
      defaultModel: row.default_model || undefined,
    };
  } catch (err) {
    console.error('[workspace-ai-profile] getWorkspaceAiProfile failed:', err.message);
    return null;
  }
}

module.exports = {
  ensureWorkspaceAiProfileTable,
  ensureAiProfileRowForWorkspace,
  getWorkspaceAiProfile,
  BUSINESS_TYPE_PRESETS,
  VALID_BUSINESS_TYPES,
};