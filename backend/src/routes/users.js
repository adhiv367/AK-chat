// Admin-only user management.
//
//   GET    /users                 — list all users
//   POST   /users                 — create user (returns plaintext password if generated)
//   GET    /users/:id             — single user with WA assignments
//   PATCH  /users/:id             — update displayName / email / role / permissions / is_active / wa_numbers
//   DELETE /users/:id             — remove user (and CASCADE wa assignments)
//   POST   /users/:id/reset-password — set or generate new password, returns plaintext once

const { Router } = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { adminOnly, auditLog } = require('../middleware/access');
const { PAGES, ROLE_PAGE_DEFAULTS, isPlatformAdmin } = require('../permissions');
const { ensureMembershipForUser, ROLE_TO_WORKSPACE_ROLE } = require('../db/workspaceSchema');
const { getAccountByPhoneNumber } = require('./whatsappAccounts');
// Phase 5B — same entitlement check routes/invitations.js already uses for
// its own creation path. POST /users is a second, older direct-creation
// path (Admin Settings -> Users -> Add user) that must be gated the same
// way — see checkLimit() call below, added before any insert.
const { checkLimit, limitExceededResponse, LIMIT_TYPES } = require('../services/entitlementService');

const router = Router();

const VALID_ROLES = Object.keys(ROLE_PAGE_DEFAULTS);

function shapeUser(row, waAssignments = [], workspace = null) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    isActive: row.is_active,
    permissions: row.permissions || null,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    assignedWaNumbers: waAssignments,
    // Phase 3A: workspace-aware fields. workspaceRole comes from the
    // caller's workspace_members join (not akchat_users.role, which is kept
    // separate/untouched). workspace is the current workspace's own name —
    // this app resolves a single workspace per request via req.workspace,
    // never from client input.
    workspaceRole: row.workspace_role || null,
    // Phase 4D: workspace_members.status surfaced as-is ('active' | 'pending').
    // Every existing call site below still only queries active memberships
    // and never sets this, so it safely defaults to 'active' for them —
    // only the list query (GET /users) now also passes 'pending' through.
    membershipStatus: row.membership_status || 'active',
    workspace: workspace ? { id: workspace.id, name: workspace.name, slug: workspace.slug } : null,
  };
}

// Phase 3A: every user-management endpoint operates only on the current
// request's workspace (req.workspace, resolved server-side from req.user via
// attachWorkspace — see middleware/workspaceContext.js). A workspace_id
// supplied by the client is never trusted or accepted.
function requireWorkspace(req, res) {
  if (!req.workspace || !req.workspace.id) {
    res.status(400).json({ error: 'No workspace found for this account' });
    return null;
  }
  return req.workspace;
}

async function loadAssignments(userIds) {
  if (userIds.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT user_id, wa_number FROM coexistence.user_wa_assignments WHERE user_id = ANY($1::bigint[])`,
    [userIds]
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.user_id)) map.set(r.user_id, []);
    map.get(r.user_id).push(r.wa_number);
  }
  return map;
}

function generatePassword(len = 12) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

// Client-safe validation error: its message MAY be returned to the caller.
// Unmarked errors are treated as internal and reported with a static message.
function badRequest(msg) { const e = new Error(msg); e.expose = true; return e; }

function validateRole(role) {
  if (!VALID_ROLES.includes(role)) {
    throw badRequest(`Role must be one of: ${VALID_ROLES.join(', ')}`);
  }
}

function validatePermissions(perms) {
  if (perms == null) return null;
  if (typeof perms !== 'object' || Array.isArray(perms)) {
    throw badRequest('permissions must be an object with optional grant[] and revoke[] arrays');
  }
  const out = {};
  for (const k of ['grant', 'revoke']) {
    if (perms[k] == null) continue;
    if (!Array.isArray(perms[k])) throw badRequest(`permissions.${k} must be an array`);
    const cleaned = perms[k].map(p => String(p)).filter(p => PAGES.includes(p));
    if (cleaned.length) out[k] = cleaned;
  }
  return Object.keys(out).length ? out : null;
}

// Workspace ownership check for user_wa_assignments (Phase 3F-1 fix).
// user_wa_assignments carries no workspace_id of its own — ownership is
// derived transitively: wa_number -> whatsapp_accounts.workspace_id. Every
// number a client submits in assignedWaNumbers MUST resolve to a
// whatsapp_accounts row that belongs to the caller's own req.workspace.id,
// via the same getAccountByPhoneNumber() lookup/normalization already used
// by contacts.js and messages.js — never a second resolution system, and
// never a client-supplied workspace_id. Numbers that don't resolve inside
// the caller's workspace are rejected outright (never silently dropped or
// silently inserted), so an admin in one workspace can never tie one of
// their own users to another workspace's WhatsApp account.
async function resolveOwnedWaNumbers(waNumbers, workspaceId) {
  const list = Array.isArray(waNumbers) ? waNumbers : [];
  const cleaned = [];
  const invalid = [];
  for (const wa of list) {
    const raw = String(wa).replace(/\D/g, '');
    if (!raw) continue;
    const account = await getAccountByPhoneNumber(raw, workspaceId);
    if (!account) {
      invalid.push(wa);
      continue;
    }
    if (!cleaned.includes(raw)) cleaned.push(raw);
  }
  if (invalid.length > 0) {
    throw badRequest(`These WhatsApp numbers don't belong to your workspace: ${invalid.join(', ')}`);
  }
  return cleaned;
}

// ─── List ───────────────────────────────────────────────────────────
// Server-side workspace filtering: only members of req.workspace (resolved
// from the authenticated user, never from client input) are returned.
router.get('/users', adminOnly, async (req, res) => {
  const workspace = requireWorkspace(req, res);
  if (!workspace) return;
  try {
    // Phase 4D: also include 'pending' memberships (invited, not yet
    // accepted) so the Team overview can show them — still strictly scoped
    // to this workspace via wm.workspace_id = $1, exactly as before.
    const { rows } = await pool.query(
      `SELECT au.*, wm.workspace_role, wm.status AS membership_status
         FROM coexistence.akchat_users au
         JOIN coexistence.workspace_members wm
           ON wm.user_id = au.id AND wm.workspace_id = $1 AND wm.status IN ('active', 'pending')
        ORDER BY au.created_at`,
      [workspace.id]
    );
    const assignmentsMap = await loadAssignments(rows.map(r => r.id));
    res.json(rows.map(r => shapeUser(r, assignmentsMap.get(r.id) || [], workspace)));
  } catch (err) {
    console.error('[users] list error:', err.message);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

router.get('/users/:id', adminOnly, async (req, res) => {
  const workspace = requireWorkspace(req, res);
  if (!workspace) return;
  try {
    const { rows } = await pool.query(
      `SELECT au.*, wm.workspace_role
         FROM coexistence.akchat_users au
         JOIN coexistence.workspace_members wm
           ON wm.user_id = au.id AND wm.workspace_id = $1 AND wm.status = 'active'
        WHERE au.id = $2`,
      [workspace.id, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const assignmentsMap = await loadAssignments([rows[0].id]);
    res.json(shapeUser(rows[0], assignmentsMap.get(rows[0].id) || [], workspace));
  } catch (err) {
    console.error('[users] get error:', err.message);
    res.status(500).json({ error: 'Failed to load user' });
  }
});

// ─── Create ────────────────────────────────────────────────────────
router.post('/users', adminOnly, async (req, res) => {
  const workspace = requireWorkspace(req, res);
  if (!workspace) return;
  const { username, email, displayName, password, role = 'bda_sales', permissions = null, assignedWaNumbers = [] } = req.body || {};
  try {
    if (!username?.trim() || !email?.trim() || !displayName?.trim()) {
      return res.status(400).json({ error: 'username, email and displayName are required' });
    }
    validateRole(role);
    const cleanPerms = validatePermissions(permissions);

    // Phase 5B — server-side seat entitlement check. Mirrors the identical
    // check in routes/invitations.js. Runs BEFORE any akchat_users /
    // workspace_members write, using the server-resolved workspace.id
    // (never a client-supplied workspace_id), so a limit-reached request
    // never creates a partial user or membership row.
    const seatCheck = await checkLimit(workspace.id, LIMIT_TYPES.SEATS);
    if (!seatCheck.allowed) {
      return res.status(403).json(limitExceededResponse(seatCheck));
    }

    // Phase 3F-1 fix: resolve + validate assignedWaNumbers against this
    // workspace's own whatsapp_accounts BEFORE any writes, so an invalid
    // (cross-workspace) number fails the request instead of silently
    // creating a cross-workspace assignment.
    const waList = await resolveOwnedWaNumbers(assignedWaNumbers, workspace.id);
    const finalPassword = password?.trim() || generatePassword();
    const hash = await bcrypt.hash(finalPassword, 10);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO coexistence.akchat_users
           (username, email, password, display_name, role, permissions, created_by)
         VALUES ($1, LOWER($2), $3, $4, $5, $6::jsonb, $7)
         RETURNING *`,
        [
          username.trim(),
          email.trim(),
          hash,
          displayName.trim(),
          role,
          cleanPerms ? JSON.stringify(cleanPerms) : null,
          req.user.id,
        ]
      );
      const user = rows[0];

      // Phase 3A: associate the new user with the CURRENT workspace
      // (req.workspace, resolved server-side from the creating admin's own
      // membership) rather than an implicit "first workspace" lookup.
      // Purely additive; never blocks or fails user creation.
      try {
        await ensureMembershipForUser(client, user.id, user.role, workspace.id);
      } catch (e) {
        console.error('[users] workspace membership backfill failed:', e.message);
      }

      // Set WA assignments (only meaningful for bda_sales; admin override is
      // technically allowed and just gets ignored at query time). waList was
      // already validated above to belong to this workspace.
      for (const clean of waList) {
        await client.query(
          `INSERT INTO coexistence.user_wa_assignments (user_id, wa_number, created_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, wa_number) DO NOTHING`,
          [user.id, clean, req.user.id]
        );
      }

      await client.query('COMMIT');
      await auditLog({
        actor: req.user, action: 'user.create',
        targetType: 'user', targetId: user.id,
        payload: { username: user.username, role: user.role, waNumbers: waList },
      });

      // Return shape includes the one-time plaintext password so the UI can show it
      const assignments = await loadAssignments([user.id]);
      const shape = shapeUser({ ...user, workspace_role: ROLE_TO_WORKSPACE_ROLE[user.role] || null }, assignments.get(user.id) || [], workspace);
      res.status(201).json({ ...shape, generatedPassword: password ? null : finalPassword, password: finalPassword });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[users] create error:', err.message);
    if (err.code === '23505') return res.status(409).json({ error: 'Email or username already in use' });
    // Only surface explicit validation messages; hide unexpected internal errors.
    if (err.expose) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// ─── Update ────────────────────────────────────────────────────────
router.patch('/users/:id', adminOnly, async (req, res) => {
  const workspace = requireWorkspace(req, res);
  if (!workspace) return;
  const id = req.params.id;
  try {
    // Workspace isolation: the target user must be an active member of the
    // caller's own workspace. This prevents cross-workspace editing even if
    // an admin from another workspace guesses a valid user id.
    const { rows: existing } = await pool.query(
      `SELECT au.*, wm.workspace_role
         FROM coexistence.akchat_users au
         JOIN coexistence.workspace_members wm
           ON wm.user_id = au.id AND wm.workspace_id = $1 AND wm.status = 'active'
        WHERE au.id = $2`,
      [workspace.id, id]
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Not found' });
    const before = existing[0];

    // Prevent admins from demoting / deactivating themselves to lock everyone out
    if (String(req.user.id) === String(id)) {
      if (req.body.role && req.body.role !== before.role) {
        return res.status(400).json({ error: 'You cannot change your own role' });
      }
      if (req.body.isActive === false) {
        return res.status(400).json({ error: 'You cannot deactivate yourself' });
      }
    }

    // Owner protection: the workspace must never be left without an active
    // OWNER. If this user is the workspace's only active OWNER, block any
    // deactivation or role change that would remove that status.
    const wouldLoseOwnerRole = req.body.role && req.body.role !== before.role &&
      before.workspace_role === 'OWNER';
    const wouldDeactivate = req.body.isActive === false;
    if (before.workspace_role === 'OWNER' && (wouldLoseOwnerRole || wouldDeactivate)) {
      const { rows: ownerCount } = await pool.query(
        `SELECT COUNT(*)::int AS n
           FROM coexistence.workspace_members
          WHERE workspace_id = $1 AND workspace_role = 'OWNER' AND status = 'active' AND user_id <> $2`,
        [workspace.id, id]
      );
      if (ownerCount[0].n === 0) {
        return res.status(400).json({ error: 'Cannot remove the only owner of this workspace' });
      }
    }

    const fields = [];
    const params = [];
    let idx = 1;
    const set = (sqlFragment, val) => {
      fields.push(sqlFragment.replace('$$', `$${idx++}`));
      params.push(val);
    };

    if (req.body.displayName != null) set('display_name = $$', String(req.body.displayName).trim());
    if (req.body.email != null) set('email = $$', String(req.body.email).trim().toLowerCase());
    if (req.body.role != null) {
      validateRole(req.body.role);
      set('role = $$', req.body.role);
    }
    if (req.body.permissions !== undefined) {
      const cleanPerms = validatePermissions(req.body.permissions);
      set('permissions = $$::jsonb', cleanPerms ? JSON.stringify(cleanPerms) : null);
    }
    if (req.body.isActive != null) set('is_active = $$', !!req.body.isActive);
    fields.push(`updated_at = NOW()`);

    // Phase 3F-1 fix: resolve + validate assignedWaNumbers against this
    // workspace's own whatsapp_accounts BEFORE the transaction opens, so an
    // invalid (cross-workspace) number 400s cleanly with no DELETE having
    // happened yet — never a partially-replaced assignment set.
    let waList = null;
    if (Array.isArray(req.body.assignedWaNumbers)) {
      waList = await resolveOwnedWaNumbers(req.body.assignedWaNumbers, workspace.id);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let updated = before;
      if (params.length > 0) {
        params.push(id);
        const sql = `UPDATE coexistence.akchat_users SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`;
        const result = await client.query(sql, params);
        updated = result.rows[0];
      }

      // Keep workspace_members.workspace_role in sync when the akchat role
      // changes, using the same mapping applied at user-creation time. Owner
      // protection above already guarantees this never drops the last OWNER.
      let newWorkspaceRole = before.workspace_role;
      if (req.body.role != null && req.body.role !== before.role) {
        newWorkspaceRole = ROLE_TO_WORKSPACE_ROLE[req.body.role] || before.workspace_role;
        await client.query(
          `UPDATE coexistence.workspace_members SET workspace_role = $1, updated_at = NOW()
             WHERE workspace_id = $2 AND user_id = $3`,
          [newWorkspaceRole, workspace.id, id]
        );
      }

      // Replace wa assignments if provided. waList was already validated
      // above (before BEGIN) to belong to this workspace.
      if (waList !== null) {
        await client.query(`DELETE FROM coexistence.user_wa_assignments WHERE user_id = $1`, [id]);
        for (const clean of waList) {
          await client.query(
            `INSERT INTO coexistence.user_wa_assignments (user_id, wa_number, created_by)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, wa_number) DO NOTHING`,
            [id, clean, req.user.id]
          );
        }
      }

      await client.query('COMMIT');

      // Build a diff for the audit log
      const changes = {};
      ['display_name', 'email', 'role', 'is_active', 'permissions'].forEach(k => {
        if (JSON.stringify(before[k]) !== JSON.stringify(updated[k])) {
          changes[k] = { from: before[k], to: updated[k] };
        }
      });
      if (waList !== null) changes.assignedWaNumbers = waList;
      await auditLog({
        actor: req.user,
        action: changes.role ? 'user.role_change' : 'user.update',
        targetType: 'user', targetId: id, payload: changes,
      });

      const assignmentsMap = await loadAssignments([id]);
      res.json(shapeUser({ ...updated, workspace_role: newWorkspaceRole }, assignmentsMap.get(Number(id)) || [], workspace));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[users] update error:', err.message);
    if (err.code === '23505') return res.status(409).json({ error: 'Email or username already in use' });
    if (err.expose) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// ─── Reset password (admin-only, plaintext-once display) ──────────
router.post('/users/:id/reset-password', adminOnly, async (req, res) => {
  const workspace = requireWorkspace(req, res);
  if (!workspace) return;
  const id = req.params.id;
  try {
    // Workspace isolation: only members of the caller's own workspace.
    const { rows: existing } = await pool.query(
      `SELECT au.id, au.username
         FROM coexistence.akchat_users au
         JOIN coexistence.workspace_members wm
           ON wm.user_id = au.id AND wm.workspace_id = $1 AND wm.status = 'active'
        WHERE au.id = $2`,
      [workspace.id, id]
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Not found' });

    const password = req.body?.password?.trim() || generatePassword();
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      `UPDATE coexistence.akchat_users SET password = $1, updated_at = NOW() WHERE id = $2`,
      [hash, id]
    );
    await auditLog({
      actor: req.user, action: 'user.password_reset',
      targetType: 'user', targetId: id, payload: { byAdmin: req.user.username },
    });
    res.json({ password, generated: !req.body?.password });
  } catch (err) {
    console.error('[users] reset-password error:', err.message);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ─── Remove from workspace ──────────────────────────────────────────
// Phase 3A: this no longer hard-deletes the akchat_users row. Per the 3A
// brief, removing a user from a workspace must not destroy their underlying
// account or any historical data (contacts, messages, broadcast logs, CRM
// records, workflow data, WA assignments) tied to their user id. Instead this
// deactivates their membership in the CURRENT workspace only
// (workspace_members.status = 'inactive'). The akchat_users row, and any
// other workspace membership they might have, is left untouched. A route
// path/name change is avoided (kept as DELETE /users/:id) so the existing
// frontend call site keeps working; only the underlying semantics changed.
router.delete('/users/:id', adminOnly, async (req, res) => {
  const workspace = requireWorkspace(req, res);
  if (!workspace) return;
  const id = req.params.id;
  try {
    if (String(req.user.id) === String(id)) {
      return res.status(400).json({ error: 'You cannot remove your own account from the workspace' });
    }
    // Workspace isolation: can only remove members of the caller's own
    // workspace — never trust/accept a workspace_id from the client.
    const { rows: existing } = await pool.query(
      `SELECT au.username, au.role, wm.workspace_role
         FROM coexistence.akchat_users au
         JOIN coexistence.workspace_members wm
           ON wm.user_id = au.id AND wm.workspace_id = $1 AND wm.status = 'active'
        WHERE au.id = $2`,
      [workspace.id, id]
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Not found' });
    const target = existing[0];

    // Owner protection: never leave the workspace without an active OWNER.
    if (target.workspace_role === 'OWNER') {
      const { rows: ownerCount } = await pool.query(
        `SELECT COUNT(*)::int AS n
           FROM coexistence.workspace_members
          WHERE workspace_id = $1 AND workspace_role = 'OWNER' AND status = 'active' AND user_id <> $2`,
        [workspace.id, id]
      );
      if (ownerCount[0].n === 0) {
        return res.status(400).json({ error: 'Cannot remove the only owner of this workspace' });
      }
    }

    await pool.query(
      `UPDATE coexistence.workspace_members SET status = 'inactive', updated_at = NOW()
         WHERE workspace_id = $1 AND user_id = $2`,
      [workspace.id, id]
    );

    // This build supports one workspace per user in practice. If removing
    // this membership leaves the user with no other active workspace
    // membership, also flip is_active so existing auth.js login/session
    // behavior (which already checks is_active) blocks them immediately —
    // without touching any other row or table.
    const { rows: otherActive } = await pool.query(
      `SELECT 1 FROM coexistence.workspace_members WHERE user_id = $1 AND status = 'active' LIMIT 1`,
      [id]
    );
    if (otherActive.length === 0) {
      await pool.query(`UPDATE coexistence.akchat_users SET is_active = false, updated_at = NOW() WHERE id = $1`, [id]);
    }

    await auditLog({
      actor: req.user, action: 'user.remove_from_workspace',
      targetType: 'user', targetId: id,
      payload: { username: target.username, role: target.role, workspaceId: workspace.id },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[users] remove-from-workspace error:', err.message);
    res.status(500).json({ error: 'Failed to remove user from workspace' });
  }
});

// ─── Audit log (paginated) ────────────────────────────────────────
// Phase 7.14B fix: this must be Platform Admin ONLY (isPlatformAdmin(req.user)
// — the global legacy 'admin' role), NOT adminOnly/isAdmin(), which also
// passes a workspace-scoped OWNER/ADMIN (see middleware/access.js). The
// audit log is platform-wide (unscoped by workspace — see query below), so
// a workspace OWNER/ADMIN must not be able to read other workspaces' audit
// entries via this endpoint. Same inline-check pattern as
// routes/billing.js POST /workspaces/:id/billing/set-plan.
router.get('/audit-log', async (req, res) => {
  if (!isPlatformAdmin(req.user)) {
    return res.status(403).json({ error: 'Administrator access required' });
  }
  try {
    const limit = Math.min(parseInt(req.query.limit || 50, 10), 200);
    const offset = Math.max(parseInt(req.query.offset || 0, 10), 0);
    const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS total FROM coexistence.user_audit_log`);
    const { rows } = await pool.query(
      `SELECT id, actor_user_id AS "actorUserId", actor_username AS "actorUsername",
              action, target_type AS "targetType", target_id AS "targetId",
              payload, created_at AS "createdAt"
         FROM coexistence.user_audit_log
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ total: countRows[0].total, limit, offset, items: rows });
  } catch (err) {
    console.error('[users] audit-log error:', err.message);
    res.status(500).json({ error: 'Failed to load audit log' });
  }
});

// Phase 4D: export these existing helpers (unchanged) so routes/invitations.js
// can reuse the exact same validation / WA-assignment / password / audit
// patterns instead of duplicating them. No behavior here changes.
module.exports = {
  router,
  shapeUser,
  requireWorkspace,
  loadAssignments,
  validateRole,
  validatePermissions,
  resolveOwnedWaNumbers,
  generatePassword,
  badRequest,
};







