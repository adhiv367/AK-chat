'use strict';

// Phase 5C fix — page/nav visibility (loadUserSession) and API write-gates
// (requireRole/requirePermission/adminOnly/buildWaScope family) must follow
// the caller's WORKSPACE role (workspace_members.workspace_role) rather
// than their global akchat_users.role whenever they have an active
// workspace. Regression coverage for:
//   "SaaS Test User only sees Insights Hub" (global role=viewer,
//   workspace_role=OWNER must still get full OWNER navigation/permissions).

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/db');
const { loadUserSession } = require('../src/auth');
const { adminOnly, requireRole, requirePermission } = require('../src/middleware/access');

function makeDb({ user, waRows = [], memberships = [] }) {
  async function dispatch(sql, params) {
    if (/FROM coexistence\.akchat_users WHERE id = \$1/.test(sql)) {
      return { rows: user ? [user] : [] };
    }
    if (/FROM coexistence\.user_wa_assignments WHERE user_id = \$1/.test(sql)) {
      return { rows: waRows };
    }
    if (/FROM coexistence\.workspace_members wm\s*\n\s*JOIN coexistence\.workspaces w/.test(sql) &&
        /ORDER BY wm\.id ASC/.test(sql)) {
      return { rows: memberships };
    }
    if (/FROM coexistence\.workspaces\s*\n\s*WHERE status = 'active'/.test(sql)) {
      return { rows: [] };
    }
    return { rows: [] };
  }
  return { query: dispatch };
}

function installDb(mockDb) {
  const originalQuery = pool.query;
  pool.query = mockDb.query;
  return () => { pool.query = originalQuery; };
}

const SAAS_MEMBERSHIP = {
  id: 2, name: 'SaaS Test Workspace', slug: 'saas-test-workspace', status: 'active',
  created_at: new Date(), onboarding_completed: true, business_name: null, business_phone: null,
  business_email: null, business_address: null, timezone: null, logo_url: null, website: null,
  currency: null, workspace_role: 'OWNER',
};

test('loadUserSession: global role=viewer + workspace_role=OWNER yields full OWNER page set, not the legacy viewer set', async () => {
  const restore = installDb(makeDb({
    user: { id: 20, username: 'saas_test', email: 'saas_test@example.com', display_name: 'SaaS Test', role: 'viewer', permissions: null, is_active: true, last_login_at: null },
    memberships: [SAAS_MEMBERSHIP],
  }));
  try {
    const session = await loadUserSession(20, { cookies: {} });
    assert.equal(session.role, 'viewer', 'global role is untouched');
    assert.ok(session.pages.includes('admin-settings:users'), 'OWNER workspace role must unlock admin-settings pages');
    assert.ok(session.pages.includes('template-builder'));
    assert.ok(!session.pages.includes('__never__'));
    assert.notDeepEqual(session.pages.sort(), ['about', 'home'], 'must not collapse to the legacy viewer-only set');
  } finally { restore(); }
});

test('loadUserSession: user with no workspace membership falls back to global role pages (unchanged legacy behavior)', async () => {
  const restore = installDb(makeDb({
    user: { id: 30, username: 'nomember', email: 'nomember@example.com', display_name: 'No Member', role: 'viewer', permissions: null, is_active: true, last_login_at: null },
    memberships: [],
  }));
  try {
    const session = await loadUserSession(30, { cookies: {} });
    assert.deepEqual(session.pages.sort(), ['about', 'home']);
  } finally { restore(); }
});

test('adminOnly: passes for a workspace OWNER whose global role is the legacy viewer fallback', () => {
  const req = { user: { id: 20, role: 'viewer' }, workspace: { role: 'OWNER' } };
  const res = { status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let nexted = false;
  adminOnly(req, res, () => { nexted = true; });
  assert.equal(nexted, true);
});

test('adminOnly: still rejects a workspace VIEWER with global role viewer', () => {
  const req = { user: { id: 21, role: 'viewer' }, workspace: { role: 'VIEWER' } };
  const res = { status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let nexted = false;
  adminOnly(req, res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
});

test('requireRole: workspace role is used over global role when a workspace is active', () => {
  const req = { user: { id: 20, role: 'viewer' }, workspace: { role: 'OWNER' } };
  const res = { status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let nexted = false;
  requireRole('AGENT')(req, res, () => { nexted = true; });
  assert.equal(nexted, true);
});

test('requirePermission: workspace OWNER with global role viewer can reach admin-settings:users', async () => {
  const restore = installDb(makeDb({
    user: { id: 20, role: 'viewer', permissions: null },
  }));
  try {
    const req = { user: { id: 20, role: 'viewer' }, workspace: { role: 'OWNER' } };
    const res = { status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let nexted = false;
    await requirePermission('admin-settings:users')(req, res, () => { nexted = true; });
    assert.equal(nexted, true, res.body && res.body.error);
  } finally { restore(); }
});

test('requirePermission: no active workspace falls back to global role (VIEWER rejected)', async () => {
  const restore = installDb(makeDb({
    user: { id: 21, role: 'viewer', permissions: null },
  }));
  try {
    const req = { user: { id: 21, role: 'viewer' }, workspace: null };
    const res = { status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let nexted = false;
    await requirePermission('admin-settings:users')(req, res, () => { nexted = true; });
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 403);
  } finally { restore(); }
});
