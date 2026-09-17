// Centralised role → page-access map.
//
// Phase 3B SaaS roles (the canonical, forward-looking set — used by
// workspace_members.workspace_role and assignable via akchat_users.role):
//   - OWNER   : full workspace access, including ownership-level actions
//               (the only role that can hold/transfer ownership — see
//               owner-protection checks in routes/users.js).
//   - ADMIN   : full operational access, but never treated as the
//               workspace's Owner (owner-protection checks key off
//               workspace_role === 'OWNER' specifically, not isAdmin()).
//   - MANAGER : CRM / inbox / campaigns / reports — day-to-day operational
//               management, no user/role/settings administration.
//   - AGENT   : inbox + contacts, scoped to assigned WhatsApp numbers via
//               the existing user_wa_assignments / buildWaScope /
//               assertWaAccess / assertContactAccess architecture.
//   - VIEWER  : read-only operational access. Never gets write access to
//               any of the page keys below.
//
// Legacy roles from before Phase 3B are kept working, unmodified, via their
// own entries below (no data migration performed on existing users):
//   - admin     : historically full access — behaves exactly like OWNER.
//   - bda_sales : historically the WA-assignment-scoped sales role —
//                 behaves exactly like AGENT.
//   - viewer    : legacy read-only fallback — behaves like VIEWER, but kept
//                 as its own minimal entry since it predates most pages.
//
// Page keys are stable strings used in three places:
//   - this map
//   - the frontend Sidebar / page guard
//   - server-side requirePermission(page) middleware
//
// "admin-settings:<tab>" entries gate individual tabs within Admin Settings.

const PAGES = [
  'home', 'chats', 'contacts', 'pipelines', 'bulk-message', 'template-builder',
  'target-message',
  // Phase 6 — Advanced Campaign Studio. Same visibility tier as
  // target-message/bulk-message (operational messaging pages).
  'campaign-studio',
  // Phase 7 — Sequences / Drip Automation. Same visibility tier as
  // campaign-studio (operational messaging pages).
  'sequence-studio',
  // Phase 6.7 — WhatsApp Flow Builder. Same visibility tier as
  // campaign-studio/sequence-studio (operational messaging pages);
  // gated server-side via requirePermission('flow-builder') in
  // routes/flows.js exactly like those two gate their own routes.
  'flow-builder',
  'chatbot-builder', 'media-library', 'about',
  // Integrations Phase 1 — customer-facing third-party connections page
  // (Zoho CRM today). Distinct from the admin-settings:* tabs below, which
  // stay platform/workspace configuration.
  'integrations',
  'admin-settings:general', 'admin-settings:tags', 'admin-settings:category',
  'admin-settings:fields', 'admin-settings:whatsapp-accounts',
  'admin-settings:users', 'admin-settings:workspace', 'admin-settings:roles',
  // Phase 5B — Plans, entitlements & billing. Visible to OWNER/ADMIN (both
  // get every page via ROLE_PAGE_DEFAULTS.OWNER/ADMIN = PAGES.slice(), so no
  // other change is needed here for them to see it). Actual billing
  // MANAGEMENT (checkout/cancel) is additionally gated server-side to
  // OWNER only — see middleware/access.js requireWorkspaceRole('OWNER') in
  // routes/billing.js. This page key only controls tab *visibility*.
  'admin-settings:billing',
  // Phase 7.3 — generic, customer-agnostic Product Catalog (Commerce >
  // Products). Same visibility tier as campaign-studio/sequence-studio/
  // flow-builder (operational modules): every workspace/tenant gets its own
  // catalog, gated the same way those pages are gated.
  'products',
  // Phase 7.7 — generic, customer-agnostic Orders (Commerce > Orders).
  // Same visibility tier as 'products' above — every workspace/tenant gets
  // its own orders, gated the same way. The Cart panel embedded in Chat
  // uses the existing 'chats' page key instead (see routes/carts.js) since
  // it isn't a standalone page.
  'orders',
];

// Manager gets the day-to-day operational surface (dashboard/inbox/contacts/
// pipelines/campaigns/reports/templates/workflows where operationally
// required) but none of the admin-settings tabs that manage users, roles,
// WhatsApp accounts, fields/tags/categories, or the workspace itself.
const MANAGER_PAGES = [
  'home', 'chats', 'contacts', 'pipelines', 'bulk-message', 'template-builder',
  'target-message', 'campaign-studio', 'sequence-studio', 'flow-builder', 'chatbot-builder', 'media-library', 'about',
  'integrations', 'products', 'orders',
];

// Viewer is read-only: give it the same page *visibility* as Manager (so it
// can see dashboard/inbox/contacts/CRM/reports) — write-gating for those
// pages happens at the API level via requirePermission(page)/requireRole(),
// not by hiding pages. Viewer never gets any admin-settings tab.
const VIEWER_PAGES = [
  'home', 'chats', 'contacts', 'pipelines', 'about',
];

const ROLE_PAGE_DEFAULTS = {
  // Legacy roles — unchanged from before Phase 3B.
  admin: PAGES.slice(),           // everything
  bda_sales: [
    'home', 'chats', 'contacts', 'pipelines', 'about',
    'admin-settings:general',     // only the General tab in user settings
  ],
  viewer: ['home', 'about'],      // legacy fallback

  // Phase 3B canonical SaaS roles.
  OWNER: PAGES.slice(),
  ADMIN: PAGES.slice(),
  MANAGER: MANAGER_PAGES.slice(),
  AGENT: [
    'home', 'chats', 'contacts', 'pipelines', 'about',
    'admin-settings:general',
  ],
  VIEWER: VIEWER_PAGES.slice(),
};

// Human-readable descriptions for the Settings → Roles UI. Kept intentionally
// short — Phase 3B is a fixed 5-role model, not a custom permission builder.
const WORKSPACE_ROLES = [
  { key: 'OWNER', label: 'Owner', description: 'Everything — workspace, users, roles, WhatsApp accounts, and all operational modules.' },
  { key: 'ADMIN', label: 'Admin', description: 'Full operational administration. Cannot hold or remove workspace ownership.' },
  { key: 'MANAGER', label: 'Manager', description: 'CRM, inbox, campaigns, templates, and reports. No user or workspace administration.' },
  { key: 'AGENT', label: 'Agent', description: 'Inbox and contacts, scoped to their assigned WhatsApp numbers and conversations.' },
  { key: 'VIEWER', label: 'Viewer', description: 'Read-only access across operational modules — no create, edit, send, or delete actions.' },
];
// Role hierarchy, used only by the new requireRole() write-gate (see
// middleware/access.js) — NOT by page visibility, which stays exactly the
// explicit per-role list above. Legacy role names are aliased to the
// canonical level they've always behaved as, so existing users' effective
// permissions don't change.
const ROLE_LEVEL = {
  viewer: 0, VIEWER: 0,
  bda_sales: 1, AGENT: 1,
  MANAGER: 2,
  ADMIN: 3,
  admin: 4, OWNER: 4,
  // Synthetic role level used ONLY on req.membership objects that
  // routes/billing.js and routes/workspace.js construct for a Platform
  // Admin's non-member access to a workspace (see permissions.js
  // isPlatformAdmin / workspaceContext.getActiveWorkspaceById). Never a
  // real workspace_members.workspace_role value — placed above OWNER so a
  // Platform Admin always clears any requireWorkspaceRole(...) gate on the
  // small set of routes that explicitly opt into platform-admin access.
  PLATFORM_ADMIN: 5,
};

function roleLevel(role) {
  return ROLE_LEVEL[role] ?? 0;
}
// Returns the set of pages a user can access given their role plus any
// per-user grant/revoke overrides stored in users.permissions JSONB.
//   permissions = { grant: ["template-builder"], revoke: ["admin-settings:general"] }
function effectivePages(user) {
  const base = ROLE_PAGE_DEFAULTS[user?.role] || [];
  const overrides = user?.permissions || {};
  const grant = Array.isArray(overrides.grant) ? overrides.grant : [];
  const revoke = new Set(Array.isArray(overrides.revoke) ? overrides.revoke : []);
  const out = new Set(base);
  grant.forEach(p => out.add(p));
  revoke.forEach(p => out.delete(p));
  return out;
}
function hasPermission(user, page) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  return effectivePages(user).has(page);
}
// True for both the legacy 'admin' role and the two canonical roles that
// carry full operational access (OWNER, ADMIN). Owner-only actions (e.g.
// owner-protection in routes/users.js) must NOT use isAdmin() — they check
// workspace_members.workspace_role === 'OWNER' directly, since ADMIN is
// deliberately excluded from ownership-level actions (see Phase 3B section 8).
function isAdmin(user) {
  return user?.role === 'admin' || user?.role === 'OWNER' || user?.role === 'ADMIN';
}
// Phase 5C — Platform Admin vs Workspace Admin.
//
// isAdmin() above is deliberately broad (it also covers workspace-level
// OWNER/ADMIN) and must not be touched — a lot of existing permission
// checks depend on that exact behaviour.
//
// isPlatformAdmin() is a NEW, narrower check for the one legacy global
// role that represents Kavin/the platform operator: user.role === 'admin'
// on coexistence.akchat_users (the global row, refreshed on every request
// by authMiddleware — never workspace_members.workspace_role). A customer
// whose *workspace* role happens to be OWNER/ADMIN is never a platform
// admin — only the literal legacy 'admin' global role qualifies.
//
// Used anywhere that must distinguish "can administer any workspace on
// the platform" from "is an operational admin within one workspace" —
// see routes/workspace.js (list/switch) and routes/billing.js
// (GET billing / set-plan).
function isPlatformAdmin(user) {
  return user?.role === 'admin';
}
module.exports = {
  PAGES,
  ROLE_PAGE_DEFAULTS,
  WORKSPACE_ROLES,
  ROLE_LEVEL,
  roleLevel,
  effectivePages,
  hasPermission,
  isAdmin,
  isPlatformAdmin,
};
