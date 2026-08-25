const express = require('express');
const pool = require('../../db');
const router = express.Router();

// Mirrors sanitizeToLinear() from chatbots.js is NOT applied here — Instagram
// workflows keep the full free-form graph (this app doesn't force a linear
// shape), since Instagram's builder is meant to support the full node system.

// GET /instagram/workflows — list all
router.get('/instagram/workflows', async (req, res) => {
  try {
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
       WHERE ($1::bigint IS NULL OR instagram_account_id = $1)
       ORDER BY updated_at DESC`,
      [req.query.accountId || null]
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
    const { rows } = await pool.query(
      `SELECT id, name, description, status, trigger_type, config, created_at, updated_at
       FROM coexistence.instagram_workflows WHERE id = $1`,
      [req.params.id]
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
    const { name, description, status, trigger_type, config } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO coexistence.instagram_workflows (name, description, status, trigger_type, config)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [name.trim(), description || null, status || 'draft', trigger_type || 'keyword', JSON.stringify(config || {})]
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
       WHERE id = $6
       RETURNING *`,
      [name?.trim(), description, status, trigger_type, config !== undefined ? JSON.stringify(config) : undefined, req.params.id]
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
    const { status } = req.body; // 'active' | 'inactive' | 'draft'
    const { rows } = await pool.query(
      `UPDATE coexistence.instagram_workflows SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[instagram/workflows] status error:', err.message);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// POST /instagram/workflows/:id/duplicate
router.post('/instagram/workflows/:id/duplicate', async (req, res) => {
  try {
    const orig = await pool.query(`SELECT * FROM coexistence.instagram_workflows WHERE id = $1`, [req.params.id]);
    if (!orig.rows[0]) return res.status(404).json({ error: 'Workflow not found' });
    const w = orig.rows[0];
    const { rows } = await pool.query(
      `INSERT INTO coexistence.instagram_workflows (name, description, status, trigger_type, config)
       VALUES ($1, $2, 'draft', $3, $4) RETURNING *`,
      [`${w.name} (copy)`, w.description, w.trigger_type, w.config]
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
    await pool.query(`DELETE FROM coexistence.instagram_workflow_execution_steps WHERE execution_id IN
      (SELECT id FROM coexistence.instagram_workflow_executions WHERE workflow_id = $1)`, [req.params.id]);
    await pool.query(`DELETE FROM coexistence.instagram_workflow_executions WHERE workflow_id = $1`, [req.params.id]);
    await pool.query(`DELETE FROM coexistence.instagram_workflows WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[instagram/workflows] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete workflow' });
  }
});

// GET /instagram/workflows/:id/executions — execution history list
router.get('/instagram/workflows/:id/executions', async (req, res) => {
  try {
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
    const { runWorkflow } = require('../../engine/instagram/instagramWorkflowEngine')
    const { testMessage } = req.body;
    const result = await runWorkflow(req.params.id, testMessage || 'hello', { source: 'test' });
    res.json(result);
  } catch (err) {
    console.error('[instagram/workflows] test-run error:', err.message);
    res.status(500).json({ error: 'Failed to run workflow: ' + err.message });
  }
});

module.exports = { router };
