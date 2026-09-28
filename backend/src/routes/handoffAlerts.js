// Handoff alert API.
//   Bell (any logged-in user of the workspace):
//     GET  /handoff-alerts            recent alerts + unread count
//     GET  /handoff-alerts/unread-count
//     POST /handoff-alerts/read-all
//     POST /handoff-alerts/:id/read
//   Staff recipient list (needs the existing 'admin-settings:workspace' permission):
//     GET    /staff-alert-recipients
//     POST   /staff-alert-recipients        { label, phone }
//     PATCH  /staff-alert-recipients/:id    { label?, phone?, isActive? }
//     DELETE /staff-alert-recipients/:id
//
// Mount AFTER authMiddleware + attachWorkspace, like the other protected routers.
// The workspace ALWAYS comes from req.workspace (server-validated membership),
// never from the request body/query. Every statement filters by workspace_id.

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requirePermission, buildWaScope } = require('../middleware/access');

const MANAGE = requirePermission('admin-settings:workspace');
const MAX_ATTEMPTS = 5; // keep in sync with services/handoffAlerts.js

function workspaceId(req, res) {
  const id = req.workspace && req.workspace.id;
  if (!id) { res.status(403).json({ error: 'No active workspace' }); return null; }
  return id;
}
const isId = (v) => /^\d{1,18}$/.test(String(v));
const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');

// ---- Bell ---------------------------------------------------------------

router.get('/handoff-alerts', async (req, res) => {
  const ws = workspaceId(req, res); if (!ws) return;
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const scope = await buildWaScope(req, 'a', 2);
    const and = scope.sql ? ` AND ${scope.sql}` : '';
    const limitIdx = 2 + scope.params.length;
    const { rows } = await pool.query(
      `SELECT a.id, a.contact_number, a.reason, a.message_excerpt, a.status, a.send_attempts,
              a.is_read, a.created_at,
              COALESCE(NULLIF(c.name, ''), NULLIF(c.profile_name, '')) AS contact_name
         FROM coexistence.handoff_alerts a
         LEFT JOIN coexistence.contacts c
                ON c.workspace_id = a.workspace_id AND c.contact_number = a.contact_number
        WHERE a.workspace_id = $1${and}
        ORDER BY a.created_at DESC
        LIMIT $${limitIdx}`,
      [ws, ...scope.params, limit]
    );
    const { rows: cnt } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM coexistence.handoff_alerts a WHERE a.workspace_id = $1 AND a.is_read = FALSE${and}`,
      [ws, ...scope.params]
    );
    res.json({
      unreadCount: cnt[0].n,
      alerts: rows.map((r) => ({
        id: r.id,
        contactNumber: r.contact_number,
        contactName: r.contact_name || null,
        reason: r.reason,
        messageExcerpt: r.message_excerpt,
        // staff-facing delivery state; internal errors and staff numbers are not exposed here
        delivery: r.status === 'sent' ? 'sent'
          : r.status === 'no_recipients' ? 'no_recipients'
          : (r.status === 'failed' && r.send_attempts >= MAX_ATTEMPTS) ? 'gave_up'
          : 'in_progress',
        isRead: r.is_read,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error('[handoff-alerts] list failed:', err.message);
    res.status(500).json({ error: 'Failed to load alerts' });
  }
});

router.get('/handoff-alerts/unread-count', async (req, res) => {
  const ws = workspaceId(req, res); if (!ws) return;
  try {
    const scope = await buildWaScope(req, 'a', 2);
    const and = scope.sql ? ` AND ${scope.sql}` : '';
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM coexistence.handoff_alerts a WHERE a.workspace_id = $1 AND a.is_read = FALSE${and}`, [ws, ...scope.params]);
    res.json({ unreadCount: rows[0].n });
  } catch (err) {
    console.error('[handoff-alerts] count failed:', err.message);
    res.status(500).json({ error: 'Failed to load alert count' });
  }
});

router.post('/handoff-alerts/read-all', async (req, res) => {
  const ws = workspaceId(req, res); if (!ws) return;
  try {
    const scope = await buildWaScope(req, 'a', 2);
    const and = scope.sql ? ` AND ${scope.sql}` : '';
    const r = await pool.query(
      `UPDATE coexistence.handoff_alerts a SET is_read = TRUE, read_at = NOW(), updated_at = NOW()
        WHERE a.workspace_id = $1 AND a.is_read = FALSE${and}`, [ws, ...scope.params]);
    res.json({ ok: true, updated: r.rowCount });
  } catch (err) {
    console.error('[handoff-alerts] read-all failed:', err.message);
    res.status(500).json({ error: 'Failed to update alerts' });
  }
});

router.post('/handoff-alerts/:id/read', async (req, res) => {
  const ws = workspaceId(req, res); if (!ws) return;
  if (!isId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const scope = await buildWaScope(req, 'a', 3);
    const and = scope.sql ? ` AND ${scope.sql}` : '';
    const r = await pool.query(
      `UPDATE coexistence.handoff_alerts a SET is_read = TRUE, read_at = COALESCE(read_at, NOW()), updated_at = NOW()
        WHERE a.id = $1 AND a.workspace_id = $2${and}`, [req.params.id, ws, ...scope.params]);
    if (!r.rowCount) return res.status(404).json({ error: 'Alert not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[handoff-alerts] read failed:', err.message);
    res.status(500).json({ error: 'Failed to update alert' });
  }
});

// ---- Staff recipients ---------------------------------------------------

const shape = (r) => ({
  id: r.id, label: r.label, phone: r.phone, isActive: r.is_active, sortOrder: r.sort_order, createdAt: r.created_at,
});

router.get('/staff-alert-recipients', MANAGE, async (req, res) => {
  const ws = workspaceId(req, res); if (!ws) return;
  try {
    const { rows } = await pool.query(
      `SELECT id, label, phone, is_active, sort_order, created_at
         FROM coexistence.staff_alert_recipients WHERE workspace_id = $1 ORDER BY sort_order, id`, [ws]);
    res.json(rows.map(shape));
  } catch (err) {
    console.error('[staff-alerts] list failed:', err.message);
    res.status(500).json({ error: 'Failed to load staff recipients' });
  }
});

router.post('/staff-alert-recipients', MANAGE, async (req, res) => {
  const ws = workspaceId(req, res); if (!ws) return;
  const phone = digits(req.body && req.body.phone);
  const label = String((req.body && req.body.label) || '').trim().slice(0, 80);
  if (phone.length < 8 || phone.length > 15) {
    return res.status(400).json({ error: 'Enter the WhatsApp number with country code, digits only (8-15 digits)' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO coexistence.staff_alert_recipients (workspace_id, label, phone, sort_order)
       VALUES ($1, $2, $3, COALESCE((SELECT MAX(sort_order) + 1 FROM coexistence.staff_alert_recipients WHERE workspace_id = $1), 0))
       RETURNING id, label, phone, is_active, sort_order, created_at`,
      [ws, label, phone]
    );
    res.status(201).json(shape(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This number is already in the staff list' });
    console.error('[staff-alerts] create failed:', err.message);
    res.status(500).json({ error: 'Failed to add staff recipient' });
  }
});

router.patch('/staff-alert-recipients/:id', MANAGE, async (req, res) => {
  const ws = workspaceId(req, res); if (!ws) return;
  if (!isId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  const b = req.body || {};
  const sets = []; const vals = [];
  if (b.label !== undefined) { vals.push(String(b.label).trim().slice(0, 80)); sets.push(`label = $${vals.length}`); }
  if (b.phone !== undefined) {
    const p = digits(b.phone);
    if (p.length < 8 || p.length > 15) return res.status(400).json({ error: 'Invalid phone number' });
    vals.push(p); sets.push(`phone = $${vals.length}`);
  }
  if (b.isActive !== undefined) { vals.push(!!b.isActive); sets.push(`is_active = $${vals.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  try {
    vals.push(req.params.id, ws);
    const { rows } = await pool.query(
      `UPDATE coexistence.staff_alert_recipients SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${vals.length - 1} AND workspace_id = $${vals.length}
        RETURNING id, label, phone, is_active, sort_order, created_at`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Recipient not found' });
    res.json(shape(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This number is already in the staff list' });
    console.error('[staff-alerts] update failed:', err.message);
    res.status(500).json({ error: 'Failed to update staff recipient' });
  }
});

router.delete('/staff-alert-recipients/:id', MANAGE, async (req, res) => {
  const ws = workspaceId(req, res); if (!ws) return;
  if (!isId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const r = await pool.query(
      `DELETE FROM coexistence.staff_alert_recipients WHERE id = $1 AND workspace_id = $2`, [req.params.id, ws]);
    if (!r.rowCount) return res.status(404).json({ error: 'Recipient not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[staff-alerts] delete failed:', err.message);
    res.status(500).json({ error: 'Failed to remove staff recipient' });
  }
});

module.exports = { router };
