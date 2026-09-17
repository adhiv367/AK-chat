// Phase 4D — Team invitations.
//
//   POST /invitations              — admin-only, workspace-scoped. Creates a
//                                     pending akchat_users + workspace_members
//                                     row and returns a single-use token for
//                                     the admin to copy/share manually (no
//                                     email is sent — see Phase 4D scope).
//   POST /invitations/:token/accept — public (no session yet). Sets the
//                                     invitee's real password and activates
//                                     their membership.
//
// This intentionally does not introduce any new table, role system, or
// WhatsApp-assignment mechanism: it reuses akchat_users, workspace_members
// (via the invite_token / invite_expires_at columns added in
// db/workspaceSchema.js), user_wa_assignments, and the exact same
// validateRole / validatePermissions / resolveOwnedWaNumbers / bcrypt
// patterns already used by routes/users.js (imported from there, not
// duplicated).

const crypto = require('crypto');
const { Router } = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { adminOnly, auditLog } = require('../middleware/access');
const { sendWorkspaceInvitationEmail } = require('../services/emailService');
const { checkLimit, limitExceededResponse, LIMIT_TYPES } = require('../services/entitlementService');
const {
  shapeUser,
  requireWorkspace,
  loadAssignments,
  validateRole,
  validatePermissions,
  resolveOwnedWaNumbers,
  badRequest,
} = require('./users');

const router = Router();       // admin-only: create invitation
const publicRouter = Router(); // no auth: accept invitation

const INVITE_TOKEN_BYTES = 32;       // crypto-random, single-use
const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const FRONTEND_URL = (process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'http://localhost:5173').replace(/\/$/, '');

function generateInviteToken() {
  return crypto.randomBytes(INVITE_TOKEN_BYTES).toString('hex');
}

// ─── Create invitation ──────────────────────────────────────────────
// Mirrors POST /users in routes/users.js almost exactly, except:
//   - the akchat_users row gets an unusable random placeholder password
//     (never returned to the client) instead of a real one
//   - workspace_members is inserted with status='pending' plus a token/
//     expiry, instead of 'active'
// Role validation, WA-assignment ownership validation, and workspace
// resolution are all the exact same helpers routes/users.js uses — not
// reimplemented here.
router.post('/invitations', adminOnly, async (req, res) => {
  const workspace = requireWorkspace(req, res);
  if (!workspace) return;
  const { username, email, displayName, role = 'bda_sales', permissions = null, assignedWaNumbers = [] } = req.body || {};
  try {
    if (!username?.trim() || !email?.trim() || !displayName?.trim()) {
      return res.status(400).json({ error: 'username, email and displayName are required' });
    }
    validateRole(role);
    const cleanPerms = validatePermissions(permissions);

    // Phase 5B — server-side seat entitlement check. A pending invitation
    // already occupies a seat (counted by countActiveSeats, which includes
    // 'pending' status), so this blocks BEFORE the akchat_users/
    // workspace_members rows are created, not after — no seat is ever
    // provisionally created then rolled back.
    const seatCheck = await checkLimit(workspace.id, LIMIT_TYPES.SEATS);
    if (!seatCheck.allowed) {
      return res.status(403).json(limitExceededResponse(seatCheck));
    }

    // Never accept workspace_id from the client — always req.workspace.id,
    // resolved server-side, exactly as routes/users.js does.
    const waList = await resolveOwnedWaNumbers(assignedWaNumbers, workspace.id);

    // Placeholder password: cryptographically random, bcrypt-hashed, never
    // exposed anywhere. It cannot be used to log in (no one knows it) and
    // is overwritten for real when the invite is accepted below.
    const placeholder = crypto.randomBytes(24).toString('hex');
    const passwordHash = await bcrypt.hash(placeholder, 10);

    const token = generateInviteToken();
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_MS);

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
          passwordHash,
          displayName.trim(),
          role,
          cleanPerms ? JSON.stringify(cleanPerms) : null,
          req.user.id,
        ]
      );
      const user = rows[0];

      // Explicit workspace_id at invite time — never discovered later by a
      // catch-all sweep (see the documented backfill-bug fix in
      // db/workspaceSchema.js, which this deliberately does not reintroduce).
      const { ROLE_TO_WORKSPACE_ROLE } = require('../db/workspaceSchema');
      const workspaceRole = ROLE_TO_WORKSPACE_ROLE[role] || 'VIEWER';
      await client.query(
        `INSERT INTO coexistence.workspace_members
           (workspace_id, user_id, workspace_role, status, invite_token, invite_expires_at)
         VALUES ($1, $2, $3, 'pending', $4, $5)`,
        [workspace.id, user.id, workspaceRole, token, expiresAt]
      );

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
        actor: req.user, action: 'user.invite',
        targetType: 'user', targetId: user.id,
        payload: { username: user.username, role, waNumbers: waList },
      });

      const assignments = await loadAssignments([user.id]);
      const shape = shapeUser(
        { ...user, workspace_role: workspaceRole, membership_status: 'pending' },
        assignments.get(user.id) || [],
        workspace
      );

      // Send the invitation email. This happens AFTER commit, deliberately:
      // the pending membership + token are already durably created and
      // usable (via the manual copy/paste fallback below) regardless of
      // whether email delivery succeeds — a flaky mail provider must never
      // roll back a real, valid invitation. Failure is reported explicitly
      // via emailSent so the admin UI can tell the caller to copy the link
      // manually instead of claiming an email was sent when it wasn't.
      const acceptUrl = `${FRONTEND_URL}/#/accept-invite/${token}`;
      let emailSent = false;
      try {
        const result = await sendWorkspaceInvitationEmail({
          to: user.email,
          workspaceName: workspace.name,
          inviterName: req.user?.displayName || req.user?.username,
          acceptUrl,
          expiresAt,
        });
        emailSent = result.sent;
        if (!result.sent) {
          console.error(`[invitations] invite email delivery failed for user ${user.id}: ${result.error}`);
        }
      } catch (err) {
        console.error('[invitations] invite email send threw:', err.message);
      }

      // inviteToken/expiresAt are returned ONLY here, once, at creation time
      // — same one-time-display pattern as generatedPassword on POST /users.
      res.status(201).json({ ...shape, inviteToken: token, inviteExpiresAt: expiresAt, emailSent });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[invitations] create error:', err.message);
    if (err.code === '23505') return res.status(409).json({ error: 'Email or username already in use' });
    if (err.expose) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: 'Failed to create invitation' });
  }
});

// ─── Accept invitation ──────────────────────────────────────────────
// Public: the invitee has no session yet. Scoped strictly by the unguessable
// token (never by user id or email) so no other request parameter can be
// used to target a different membership. Single-use: invite_token is
// cleared in the same transaction that activates the membership, so the
// same link can never be replayed.
publicRouter.post('/invitations/:token/accept', async (req, res) => {
  const { token } = req.params;
  const { password } = req.body || {};
  try {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
      return res.status(400).json({ error: 'Invalid invitation link' });
    }
    if (!password || String(password).trim().length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const { rows } = await pool.query(
      `SELECT wm.id AS membership_id, wm.user_id, wm.workspace_id, wm.invite_expires_at,
              au.username
         FROM coexistence.workspace_members wm
         JOIN coexistence.akchat_users au ON au.id = wm.user_id
        WHERE wm.invite_token = $1 AND wm.status = 'pending'`,
      [token]
    );
    if (rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or already-used invitation link' });
    }
    const invite = rows[0];
    if (invite.invite_expires_at && new Date(invite.invite_expires_at) < new Date()) {
      return res.status(400).json({ error: 'This invitation link has expired' });
    }

    const hash = await bcrypt.hash(String(password).trim(), 10);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE coexistence.akchat_users SET password = $1, updated_at = NOW() WHERE id = $2`,
        [hash, invite.user_id]
      );
      // Activate the membership and burn the token in the same statement —
      // this row can never match a second accept request afterward.
      await client.query(
        `UPDATE coexistence.workspace_members
            SET status = 'active', invite_token = NULL, invite_expires_at = NULL, updated_at = NOW()
          WHERE id = $1 AND status = 'pending'`,
        [invite.membership_id]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await auditLog({
      actor: { id: invite.user_id, username: invite.username },
      action: 'user.invite_accepted',
      targetType: 'user', targetId: invite.user_id,
      payload: { workspaceId: invite.workspace_id },
    });

    res.json({ success: true, username: invite.username });
  } catch (err) {
    console.error('[invitations] accept error:', err.message);
    res.status(500).json({ error: 'Failed to accept invitation' });
  }
});

module.exports = { router, publicRouter };
