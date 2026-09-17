const express = require('express');
const pool = require('../../db');
const router = express.Router();

// Mirrors sanitizeToLinear() from chatbots.js is NOT applied here — Instagram
// workflows keep the full free-form graph (this app doesn't force a linear
// shape), since Instagram's builder is meant to support the full node system.

// instagram_workflow_executions / instagram_workflow_execution_steps have no
// workspace_id of their own (see instagramWorkspaceSchema.js — "add
// workspace_id only where genuinely required") — they key off workflow_id /
// execution_id, which resolve back to instagram_workflows.workspace_id.
// These helpers do that ownership check so every route below can 404
// instead of ever returning another workspace's execution history.
async function workflowOwnedByWorkspace(workflowId, workspaceId) {
  const { rows } = await pool.query(
    `SELECT id FROM coexistence.instagram_workflows WHERE id = $1 AND workspace_id = $2`,
    [workflowId, workspaceId]
  );
  return rows.length > 0;
}

async function executionOwnedByWorkspace(executionId, workspaceId) {
  const { rows } = await pool.query(
    `SELECT e.id
       FROM coexistence.instagram_workflow_executions e
       JOIN coexistence.instagram_workflows w ON w.id = e.workflow_id
      WHERE e.id = $1 AND w.workspace_id = $2`,
    [executionId, workspaceId]
  );
  return rows.length > 0;
}

// GET /instagram/workflows — list all for the current workspace
router.get('/instagram/workflows', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) return res.json([]);
    const { rows } = await pool.query(
      `SELECT id,
              name,
              description,
              status,
              trigger_type,
              config,
              created_at,
              updated_at
       FROM coexistence.instagram_workflows
       WHERE workspace_id = $1
       ORDER BY updated_at DESC`,
      [workspaceId]
    );

    res.json(rows);
  } catch (err) {
    console.error('[instagram/workflows] list error:', err.message);
    res.status(500).json({ error: 'Failed to fetch workflows' });
  }
});

// GET /instagram/workflows/:id — single workflow (full config for editor load)
router.get('/instagram/workflows/:id', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) return res.status(404).json({ error: 'Workflow not found' });
    const { rows } = await pool.query(
      `SELECT id, name, description, status, trigger_type, config, created_at, updated_at
       FROM coexistence.instagram_workflows WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, workspaceId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Workflow not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[instagram/workflows] get error:', err.message);
    res.status(500).json({ error: 'Failed to fetch workflow' });
  }
});

// POST /instagram/workflows — create
router.post('/instagram/workflows', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) return res.status(409).json({ error: 'No workspace found for this account. Please contact support.' });
    const { name, description, status, trigger_type, config } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO coexistence.instagram_workflows (name, description, status, trigger_type, config, workspace_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [name.trim(), description || null, status || 'draft', trigger_type || 'keyword', JSON.stringify(config || {}), workspaceId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[instagram/workflows] create error:', err.message);
    res.status(500).json({ error: 'Failed to create workflow' });
  }
});

// PUT /instagram/workflows/:id — update (name/description/status/trigger/full config)
router.put('/instagram/workflows/:id', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) return res.status(404).json({ error: 'Workflow not found' });
    const { name, description, status, trigger_type, config } = req.body;
    if (name !== undefined && !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    const { rows } = await pool.query(
      `UPDATE coexistence.instagram_workflows SET
        name = COALESCE($1, name),
        description = $2,
        status = COALESCE($3, status),
        trigger_type = COALESCE($4, trigger_type),
        config = COALESCE($5, config),
        updated_at = NOW()
       WHERE id = $6 AND workspace_id = $7
       RETURNING *`,
      [name?.trim(), description, status, trigger_type, config !== undefined ? JSON.stringify(config) : undefined, req.params.id, workspaceId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Workflow not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[instagram/workflows] update error:', err.message);
    res.status(500).json({ error: 'Failed to update workflow' });
  }
});

// PATCH /instagram/workflows/:id/status — quick enable/disable toggle
router.patch('/instagram/workflows/:id/status', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) return res.status(404).json({ error: 'Workflow not found' });
    const { status } = req.body; // 'active' | 'inactive' | 'draft'
    const { rows } = await pool.query(
      `UPDATE coexistence.instagram_workflows SET status = $1, updated_at = NOW() WHERE id = $2 AND workspace_id = $3 RETURNING *`,
      [status, req.params.id, workspaceId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Workflow not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[instagram/workflows] status error:', err.message);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// POST /instagram/workflows/:id/duplicate
router.post('/instagram/workflows/:id/duplicate', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) return res.status(404).json({ error: 'Workflow not found' });
    const orig = await pool.query(
      `SELECT * FROM coexistence.instagram_workflows WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, workspaceId]
    );
    if (!orig.rows[0]) return res.status(404).json({ error: 'Workflow not found' });
    const w = orig.rows[0];
    const { rows } = await pool.query(
      `INSERT INTO coexistence.instagram_workflows (name, description, status, trigger_type, config, workspace_id)
       VALUES ($1, $2, 'draft', $3, $4, $5) RETURNING *`,
      [`${w.name} (copy)`, w.description, w.trigger_type, w.config, workspaceId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[instagram/workflows] duplicate error:', err.message);
    res.status(500).json({ error: 'Failed to duplicate workflow' });
  }
});

// DELETE /instagram/workflows/:id
router.delete('/instagram/workflows/:id', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) return res.status(404).json({ error: 'Workflow not found' });
    const owned = await workflowOwnedByWorkspace(req.params.id, workspaceId);
    if (!owned) return res.status(404).json({ error: 'Workflow not found' });
    await pool.query(`DELETE FROM coexistence.instagram_workflow_execution_steps WHERE execution_id IN
      (SELECT id FROM coexistence.instagram_workflow_executions WHERE workflow_id = $1)`, [req.params.id]);
    await pool.query(`DELETE FROM coexistence.instagram_workflow_executions WHERE workflow_id = $1`, [req.params.id]);
    await pool.query(`DELETE FROM coexistence.instagram_workflows WHERE id = $1 AND workspace_id = $2`, [req.params.id, workspaceId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[instagram/workflows] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete workflow' });
  }
});

// GET /instagram/workflows/:id/executions — execution history list
router.get('/instagram/workflows/:id/executions', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) return res.status(404).json({ error: 'Workflow not found' });
    const owned = await workflowOwnedByWorkspace(req.params.id, workspaceId);
    if (!owned) return res.status(404).json({ error: 'Workflow not found' });
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.instagram_workflow_executions WHERE workflow_id = $1 ORDER BY started_at DESC LIMIT 100`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('[instagram/workflows] executions error:', err.message);
    res.status(500).json({ error: 'Failed to fetch executions' });
  }
});

// GET /instagram/workflows/executions/:executionId/steps — node-by-node replay detail
router.get('/instagram/workflows/executions/:executionId/steps', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) return res.status(404).json({ error: 'Execution not found' });
    const owned = await executionOwnedByWorkspace(req.params.executionId, workspaceId);
    if (!owned) return res.status(404).json({ error: 'Execution not found' });
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.instagram_workflow_execution_steps WHERE execution_id = $1 ORDER BY started_at ASC`,
      [req.params.executionId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[instagram/workflows] steps error:', err.message);
    res.status(500).json({ error: 'Failed to fetch execution steps' });
  }
});

// POST /instagram/workflows/:id/test-run — manual test trigger
router.post('/instagram/workflows/:id/test-run', async (req, res) => {
  try {
    const workspaceId = req.workspace?.id;
    if (!workspaceId) return res.status(404).json({ error: 'Workflow not found' });
    const owned = await workflowOwnedByWorkspace(req.params.id, workspaceId);
    if (!owned) return res.status(404).json({ error: 'Workflow not found' });
    const { runWorkflow } = require('../../engine/instagram/instagramWorkflowEngine')
    const { testMessage } = req.body;
    // Manual test-run is always a dry run — see instagramWorkflowEngine's
    // `source: 'test'` handling — no real Gemini calls and no real Instagram
    // sends happen here, only "Would send…"-style simulated results. This
    // keeps the manual test endpoint safe to use during workflow authoring,
    // separate from the real webhook execution path (evaluateInstagramTriggers).
    const result = await runWorkflow(req.params.id, testMessage || 'hello', { workspaceId, source: 'test' });
    res.json(result);
  } catch (err) {
    console.error('[instagram/workflows] test-run error:', err.message);
    res.status(500).json({ error: 'Failed to run workflow: ' + err.message });
  }
});
module.exports = { router };