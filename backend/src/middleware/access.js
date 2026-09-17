// Role / permission enforcement and audit logging.
//
// The JWT only carries { id, username, displayName, role } — for permission
// checks against the optional per-user overrides we re-load the row.

const pool = require('../db');
const { effectivePages, isAdmin, hasPermission, roleLevel } = require('../permissions');

// Phase 5C fix: the WA-assignment scoping helpers below (buildWaScope/
// assertWaAccess/assertContactAccess) historically only ever bypassed
// scoping for isAdmin(req.user) — i.e. the GLOBAL akchat_users.role. A
// workspace OWNER/ADMIN whose global role is the legacy 'viewer' fallback
// (e.g. a SaaS customer) would then be treated as an unassigned agent and
// see zero conversations/contacts. This helper folds in the caller's
// WORKSPACE role (req.workspace.role, resolved server-side by
// attachWorkspace — never client input) so a workspace OWNER/ADMIN always
// gets full, unscoped access within their own workspace, matching the
// unscoped access an OWNER/ADMIN is supposed to have.
function isEffectiveAdmin(req) {
  if (isAdmin(req.user)) return true;
  const workspaceRole = req.workspace?.role;
  return workspaceRole === 'OWNER' || workspaceRole === 'ADMIN';
}

// adminOnly: gate on admin-level access. Phase 5C fix: also accepts a
// workspace-scoped OWNER/ADMIN (req.workspace.role, resolved server-side by
// attachWorkspace — never client input), not just the global akchat_users
// role. This route is used for WORKSPACE user/member management (see
// routes/users.js — every query there is itself scoped to req.workspace.id),
// so a customer whose global role is the legacy 'viewer' fallback but whose
// workspace_members.workspace_role is OWNER/ADMIN must still pass. A
// Platform Admin (global 'admin') continues to pass via isAdmin(req.user)
// regardless of workspace context.
function adminOnly(req, res, next) {
  const workspaceRole = req.workspace?.role;
  const workspaceIsAdmin = workspaceRole === 'OWNER' || workspaceRole === 'ADMIN';
  if (!isAdmin(req.user) && !workspaceIsAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// requireRole(minRole): Phase 3B write-gate for endpoints that have no
// dedicated page key (e.g. deleting a contact) but must still block VIEWER
// (and, in principle, any role below minRole) at the API level — never rely
// on the frontend hiding the button. Uses the same role string already on
// req.user (refreshed from the DB by authMiddleware on every request), so
// nothing from the request body/query is ever trusted for this check.
//   requireRole('AGENT') -> VIEWER (level 0) is rejected; AGENT/MANAGER/
//   ADMIN/OWNER (and their legacy equivalents bda_sales/admin) pass.
// Phase 5C fix: prefer the caller's WORKSPACE role (req.workspace.role,
// resolved server-side by attachWorkspace) over their global akchat_users
// role, same rationale as requirePermission() above — a workspace OWNER
// whose global role is the legacy 'viewer' fallback must still clear an
// AGENT-level gate. Falls back to the global role for any caller with no
// active workspace (unchanged legacy behaviour).
function requireRole(minRole) {
  return (req, res, next) => {
    const effectiveRole = req.workspace?.role || req.user?.role;
    if (roleLevel(effectiveRole) < roleLevel(minRole)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action' });
    }
    next();
  };
}

// requireWorkspaceRole(minRole): Workspace Phase write-gate for
// workspace/member-management endpoints. Unlike requireRole(), this checks
// the caller's role WITHIN THE SPECIFIC WORKSPACE being acted on
// (req.membership, set by the route after resolving :id via
// workspaceContext.getMembership — see routes/workspace.js), never the
// global akchat_users.role and never req.workspace (which is only the
// user's currently-*active* workspace, not necessarily the one in the URL).
// This keeps workspace membership role and global user role from being
// conflated, per Workspace Phase section G.
function requireWorkspaceRole(minRole) {
  return (req, res, next) => {
    if (!req.membership) {
      return res.status(403).json({ error: 'You are not a member of this workspace' });
    }
    if (roleLevel(req.membership.role) < roleLevel(minRole)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action' });
    }
    next();
  };
}

// requirePermission(page): gates a route on whether the current user can
// reach `page`. Loads the user row fresh so per-user overrides are honoured.
//
// Phase 5C fix: same global-role-vs-workspace-role split as loadUserSession
// (see auth.js). isAdmin(req.user) still short-circuits for a Platform
// Admin or legacy/global admin. For everyone else, the role used against
// the page map is the caller's WORKSPACE role (req.workspace.role, resolved
// server-side by attachWorkspace — never client input) when they have an
// active workspace; only a user with no workspace membership at all falls
// back to their global akchat_users.role. Without this, a customer whose
// global role is the legacy 'viewer' fallback (e.g. a SaaS OWNER) would be
// 403'd on every admin-settings/API route despite being their workspace's
// Owner.
function requirePermission(page) {
  return async (req, res, next) => {
    try {
      if (isAdmin(req.user)) return next();
      const { rows } = await pool.query(
        `SELECT role, permissions FROM coexistence.akchat_users WHERE id = $1`,
        [req.user.id]
      );
      const u = rows[0];
      if (!u) return res.status(401).json({ error: 'User not found' });
      const effectiveRole = req.workspace?.role || u.role;
      if (!hasPermission({ role: effectiveRole, permissions: u.permissions }, page)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      next();
    } catch (err) {
      console.error('[access] requirePermission error:', err.message);
      res.status(500).json({ error: 'Permission check failed' });
    }
  };
}

// Phase 8F-3 — pilot plan-feature route gate.
//
// Purely additive to the existing role/permission model: this middleware
// answers "is this workspace's PLAN entitled to feature X", which is a
// different question from "does this USER's role allow page X"
// (requirePermission, above). It never replaces requirePermission — routes
// that adopt it keep their existing requirePermission(page) check and add
// this as an extra, independent gate.
//
// Fail-closed (req #6): missing workspace, entitlement-lookup failure, or
// the feature simply not being enabled on the plan all produce the same
// 403 `feature_unavailable` response — never a silent allow.
function requireFeature(featureKey) {
  return async (req, res, next) => {
    try {
      const workspaceId = req.workspace?.id ?? null;
      if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });
      const { hasFeature } = require('../services/entitlementService');
      const enabled = await hasFeature(workspaceId, featureKey);
      if (!enabled) {
        return res.status(403).json({ error: 'feature_unavailable', featureKey });
      }
      next();
    } catch (err) {
      console.error('[access] requireFeature error:', err.message);
      res.status(403).json({ error: 'feature_unavailable', featureKey });
    }
  };
}

// Look up the WA numbers a user is allowed to see. Admin gets null
// (meaning "no scoping needed"). Non-admins get the array — may be empty.
async function userWaNumbers(userId) {
  const { rows } = await pool.query(
    `SELECT wa_number FROM coexistence.user_wa_assignments WHERE user_id = $1`,
    [userId]
  );
  return rows.map(r => r.wa_number);
}

// Build a SQL fragment + params to scope a query to "rows visible to req.user".
// Used by read endpoints (messages, contacts, numbers). The fragment is a
// boolean expression; the caller injects it into their WHERE.
//
//   const scope = await buildWaScope(req, '{table_alias}', paramIndex);
//   if (scope.sql) { whereClauses.push(scope.sql); params.push(...scope.params); }
//
// `tableAlias.wa_number` and `tableAlias.contact_number` must exist on the
// table being scoped (true for chat_history, contacts, and the derived
// messages/numbers/contact-names queries).
//
// Returns { sql, params }. `sql` is empty string when scoping is unnecessary
// (admin, or non-scopable route).
async function buildWaScope(req, tableAlias, startParamIndex) {
  if (isEffectiveAdmin(req)) return { sql: '', params: [] };
  const waNumbers = await userWaNumbers(req.user.id);
  if (waNumbers.length === 0) {
    // BDA with no assignments → see nothing
    return { sql: 'FALSE', params: [] };
  }
  // Scope: row's wa_number is in the user's list,
  //   OR the contact has an explicit assigned_user_id matching this user
  //      (handled via subquery against the contacts table).
  const waParam = `$${startParamIndex}`;
  const userParam = `$${startParamIndex + 1}`;
  const sql = `(
    ${tableAlias}.wa_number = ANY(${waParam}::text[])
    OR EXISTS (
      SELECT 1 FROM coexistence.contacts c
       WHERE c.wa_number = ${tableAlias}.wa_number
         AND c.contact_number = ${tableAlias}.contact_number
         AND c.assigned_user_id = ${userParam}
    )
  )`;
  return { sql, params: [waNumbers, req.user.id] };
}

// Convenience: assert the current user has access to a specific wa_number.
// Admin always passes. Non-admin: must have at least one assigned contact on
// this wa_number (assigned_user_id = req.user.id). This is the *number-level*
// visibility check — to also gate a specific conversation, use
// `assertContactAccess(waNumber, contactNumber)` below.
async function assertWaAccess(req, res, waNumber) {
  if (isEffectiveAdmin(req)) return true;
  const clean = String(waNumber || '').replace(/\D/g, '');
  const { rows } = await pool.query(
    `SELECT 1 FROM coexistence.contacts
      WHERE wa_number = $1 AND assigned_user_id = $2 LIMIT 1`,
    [clean, req.user.id]
  );
  if (rows.length === 0) {
    res.status(403).json({ error: 'You do not have access to this WhatsApp number' });
    return false;
  }
  return true;
}

// Per-conversation access: the (wa_number, contact_number) pair must be a
// contact whose assigned_user_id matches the current user. Admin bypasses.
async function assertContactAccess(req, res, waNumber, contactNumber) {
  if (isEffectiveAdmin(req)) return true;
  const cleanWa = String(waNumber || '').replace(/\D/g, '');
  const cleanContact = String(contactNumber || '').replace(/\D/g, '');
  const { rows } = await pool.query(
    `SELECT 1 FROM coexistence.contacts
      WHERE wa_number = $1 AND contact_number = $2 AND assigned_user_id = $3 LIMIT 1`,
    [cleanWa, cleanContact, req.user.id]
  );
  if (rows.length === 0) {
    res.status(403).json({ error: 'You do not have access to this conversation' });
    return false;
  }
  return true;
}

// Append-only audit log of admin-sensitive actions.
async function auditLog({ actor, action, targetType = null, targetId = null, payload = null }) {
  try {
    await pool.query(
      `INSERT INTO coexistence.user_audit_log
         (actor_user_id, actor_username, action, target_type, target_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        actor?.id || null,
        actor?.username || null,
        action,
        targetType,
        targetId != null ? String(targetId) : null,
        payload ? JSON.stringify(payload) : null,
      ]
    );
  } catch (err) {
    // Audit logging must never break the calling request
    console.error('[audit] write failed:', err.message);
  }
}

module.exports = {
  adminOnly,
  requireRole,
  requireWorkspaceRole,
  requirePermission,
  requireFeature,
  isEffectiveAdmin,
  userWaNumbers,
  buildWaScope,
  assertWaAccess,
  assertContactAccess,
  auditLog,
};