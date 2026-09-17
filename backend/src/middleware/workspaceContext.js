// Workspace Phase — reusable workspace-context resolution.
//
// Extends the Phase 1 single-workspace assumption to real multi-workspace
// support: a user can belong to more than one workspace, and picks which
// one is "active" via POST /api/workspaces/:id/switch. The active choice is
// stored in a small, server-validated cookie — the cookie is never trusted
// on its own; every read re-checks that the user is still an active member
// of that workspace before using it, and falls back to their oldest
// membership otherwise. This means a stale/forged cookie value can never
// grant access to a workspace the user isn't a member of.
//
// Conceptual chain implemented here:
//   Authenticated Request -> User -> Workspace Membership(s) -> Active Workspace -> Role

const pool = require('../db');
const { isPlatformAdmin } = require('../permissions');

const ACTIVE_WORKSPACE_COOKIE = 'akchat_active_workspace';

// All active memberships for a user, oldest first (oldest = the original
// default workspace for users created before multi-workspace existed).
async function getWorkspacesForUser(userId) {
  const { rows } = await pool.query(
    `SELECT w.id, w.name, w.slug, w.status, w.created_at, w.onboarding_completed,
            w.business_name, w.business_phone, w.business_email, w.business_address,
            w.timezone, w.logo_url, w.website, w.currency, wm.workspace_role
       FROM coexistence.workspace_members wm
       JOIN coexistence.workspaces w ON w.id = wm.workspace_id
      WHERE wm.user_id = $1 AND wm.status = 'active' AND w.status = 'active'
      ORDER BY wm.id ASC`,
    [userId]
  );
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    createdAt: row.created_at,
    role: row.workspace_role,
    onboardingCompleted: row.onboarding_completed,
    businessName: row.business_name,
    businessPhone: row.business_phone,
    businessEmail: row.business_email,
    businessAddress: row.business_address,
    timezone: row.timezone,
    logoUrl: row.logo_url,
    website: row.website,
    currency: row.currency,
  }));
}

// Single membership lookup — used by write endpoints (rename, member
// management) that operate on a workspace by :id rather than "whichever is
// active". Never trusts a workspace_id supplied by the client without this
// check: no row back means the user is not authorized for that workspace.
async function getMembership(userId, workspaceId) {
  const { rows } = await pool.query(
    `SELECT w.id, w.name, w.slug, w.status, w.created_at, w.onboarding_completed,
            w.business_name, w.business_phone, w.business_email, w.business_address,
            w.timezone, w.logo_url, w.website, w.currency, wm.workspace_role
       FROM coexistence.workspace_members wm
       JOIN coexistence.workspaces w ON w.id = wm.workspace_id
      WHERE wm.user_id = $1 AND wm.workspace_id = $2 AND wm.status = 'active'`,
    [userId, workspaceId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    createdAt: row.created_at,
    role: row.workspace_role,
    onboardingCompleted: row.onboarding_completed,
    businessName: row.business_name,
    businessPhone: row.business_phone,
    businessEmail: row.business_email,
    businessAddress: row.business_address,
    timezone: row.timezone,
    logoUrl: row.logo_url,
    website: row.website,
    currency: row.currency,
  };
}

// Backward-compatible single-workspace resolver (oldest membership). Kept
// for any caller that only ever dealt with "the" workspace.
async function getWorkspaceForUser(userId) {
  const list = await getWorkspacesForUser(userId);
  return list[0] || null;
}

// Phase 5C — Platform Admin support.
//
// Every ACTIVE workspace on the platform, regardless of membership. Used
// ONLY behind an isPlatformAdmin(req.user) check (routes/workspace.js GET
// /workspaces) — never exposed to normal customers. Returns the same
// summary shape as getWorkspacesForUser()/getMembership() so the frontend
// workspace selector needs no special-casing; `role` is the synthetic
// 'PLATFORM_ADMIN' marker (see permissions.js ROLE_LEVEL) rather than a
// real workspace_members row, since none is created for the platform
// admin (no fake membership rows — see routes/workspace.js).
async function getAllActiveWorkspaces() {
  const { rows } = await pool.query(
    `SELECT id, name, slug, status, created_at, onboarding_completed,
            business_name, business_phone, business_email, business_address,
            timezone, logo_url, website, currency
       FROM coexistence.workspaces
      WHERE status = 'active'
      ORDER BY id ASC`
  );
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    createdAt: row.created_at,
    role: 'PLATFORM_ADMIN',
    onboardingCompleted: row.onboarding_completed,
    businessName: row.business_name,
    businessPhone: row.business_phone,
    businessEmail: row.business_email,
    businessAddress: row.business_address,
    timezone: row.timezone,
    logoUrl: row.logo_url,
    website: row.website,
    currency: row.currency,
  }));
}

// A single ACTIVE workspace by id, with NO membership requirement. Used
// ONLY behind an isPlatformAdmin(req.user) check — this is what lets a
// Platform Admin switch into / read billing for a workspace they don't
// belong to, without ever creating a workspace_members row for them (see
// routes/workspace.js POST /workspaces/:id/switch and routes/billing.js
// loadMembershipOrPlatformAdmin). A non-active (e.g. suspended/deleted)
// workspace resolves to null, same as a nonexistent id — the caller 404s.
async function getActiveWorkspaceById(workspaceId) {
  const { rows } = await pool.query(
    `SELECT id, name, slug, status, created_at, onboarding_completed,
            business_name, business_phone, business_email, business_address,
            timezone, logo_url, website, currency
       FROM coexistence.workspaces
      WHERE id = $1 AND status = 'active'`,
    [workspaceId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    createdAt: row.created_at,
    role: 'PLATFORM_ADMIN',
    onboardingCompleted: row.onboarding_completed,
    businessName: row.business_name,
    businessPhone: row.business_phone,
    businessEmail: row.business_email,
    businessAddress: row.business_address,
    timezone: row.timezone,
    logoUrl: row.logo_url,
    website: row.website,
    currency: row.currency,
  };
}

// Resolve which workspace is "active" for this request: prefer the
// validated cookie, otherwise the user's oldest membership. Returns both
// the active workspace and the full membership list so callers (e.g.
// loadUserSession) don't have to query twice.
//
// `platformAdmin` (bool, default false): when true, a cookie value that
// doesn't match any of the caller's own memberships is NOT discarded —
// it's re-validated directly against the workspaces table (never trusted
// blindly) via getActiveWorkspaceById. This is what lets GET /workspace,
// the Billing tab, and every other req.workspace-scoped route keep working
// correctly after a Platform Admin switches into a customer workspace
// they don't belong to (see routes/workspace.js switch handler). Normal
// (non-platform-admin) callers are completely unaffected — their fallback
// behaviour (oldest membership) is unchanged byte-for-byte.
async function resolveActiveWorkspace(req, userId, platformAdmin = false) {
  const memberships = await getWorkspacesForUser(userId);
  const requestedId = req?.cookies?.[ACTIVE_WORKSPACE_COOKIE];

  if (requestedId) {
    const match = memberships.find(w => String(w.id) === String(requestedId));
    if (match) return { workspace: match, workspaces: memberships };

    if (platformAdmin) {
      const adminTarget = await getActiveWorkspaceById(requestedId);
      if (adminTarget) return { workspace: adminTarget, workspaces: memberships };
    }
  }

  if (memberships.length > 0) return { workspace: memberships[0], workspaces: memberships };
  return { workspace: null, workspaces: [] };
}

// Express middleware: attaches req.workspace (active workspace) and
// req.workspaces (full membership list) after authMiddleware has set
// req.user. Never blocks the request itself — routes that require a
// workspace check `req.workspace` themselves and 403/404 as appropriate
// (see contacts.js, broadcasts.js, etc.) so a user with zero memberships
// can still hit account-level endpoints like GET /api/workspaces.
async function attachWorkspace(req, res, next) {
  if (!req.user) return next();
  try {
    const { workspace, workspaces } = await resolveActiveWorkspace(req, req.user.id, isPlatformAdmin(req.user));
    req.workspace = workspace;
    req.workspaces = workspaces;
  } catch (err) {
    console.error('[workspaceContext] failed to resolve workspace:', err.message);
    req.workspace = null;
    req.workspaces = [];
  }
  next();
}

function setActiveWorkspaceCookie(res, workspaceId) {
  res.cookie(ACTIVE_WORKSPACE_COOKIE, String(workspaceId), {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 365 * 24 * 60 * 60 * 1000,
  });
}
function clearActiveWorkspaceCookie(res) {
  res.clearCookie(ACTIVE_WORKSPACE_COOKIE);
}
module.exports = {
  ACTIVE_WORKSPACE_COOKIE,
  attachWorkspace,
  getWorkspaceForUser,
  getWorkspacesForUser,
  getMembership,
  getAllActiveWorkspaces,
  getActiveWorkspaceById,
  resolveActiveWorkspace,
  setActiveWorkspaceCookie,
  clearActiveWorkspaceCookie,
};
