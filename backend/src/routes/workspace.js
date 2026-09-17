// Workspace Phase — workspace + member management API.
//
//   GET    /workspace                      current ACTIVE workspace (legacy, kept
//                                           for back-compat with existing callers)
//   GET    /workspaces                     all workspaces the caller belongs to
//   POST   /workspaces                     create a new workspace (caller becomes OWNER)
//   PATCH  /workspaces/:id                 rename a workspace (ADMIN+ of that workspace)
//   POST   /workspaces/:id/switch          set the caller's active workspace
//   GET    /workspaces/:id/members         list a workspace's members
//   POST   /workspaces/:id/members         add an existing akchat_users account as a member
//   PATCH  /workspaces/:id/members/:userId change a member's workspace role
//   DELETE /workspaces/:id/members/:userId remove a member from the workspace
//
// Every :id-based route re-validates membership itself via getMembership()
// — a workspace_id is NEVER trusted from the URL/body alone. This is what
// prevents cross-workspace access via manually changed IDs (see item C/H in
// the Workspace Phase brief).

const { Router } = require('express');
const pool = require('../db');
const {
  getWorkspaceForUser,
  getWorkspacesForUser,
  getMembership,
  getAllActiveWorkspaces,
  getActiveWorkspaceById,
  setActiveWorkspaceCookie,
} = require('../middleware/workspaceContext');
const { requireWorkspaceRole } = require('../middleware/access');
const { checkLimit, limitExceededResponse, LIMIT_TYPES } = require('../services/entitlementService');
const { ensureBillingRowForNewWorkspace } = require('../db/plansSchema');
const { WORKSPACE_ROLES, isPlatformAdmin } = require('../permissions');
const { slugify } = require('../db/workspaceSchema');
const { ensureDefaultsRowForWorkspace, sanitizeCategory } = require('../db/workspaceDefaultsSchema');
const { getWorkspaceAiProfile, BUSINESS_TYPE_PRESETS, VALID_BUSINESS_TYPES } = require('../db/workspaceAiProfileSchema');

const router = Router();
const VALID_WORKSPACE_ROLES = new Set(WORKSPACE_ROLES.map(r => r.key));

// Middleware: resolve :id -> req.membership (the caller's own membership
// row for THAT workspace, not their currently-active one). 404s rather than
// 403s when the workspace doesn't exist or the user isn't a member, so an
// attacker probing IDs can't distinguish "wrong workspace" from "not a
// member of a real workspace" — both look identical.
async function loadMembership(req, res, next) {
  const workspaceId = parseInt(req.params.id, 10);
  if (!Number.isInteger(workspaceId)) {
    return res.status(400).json({ error: 'Invalid workspace id' });
  }
  try {
    req.membership = await getMembership(req.user.id, workspaceId);
    if (!req.membership) {
      return res.status(404).json({ error: 'Workspace not found' });
    }
    next();
  } catch (err) {
    console.error('[workspace] membership lookup error:', err.message);
    res.status(500).json({ error: 'Failed to resolve workspace' });
  }
}

// ─── GET /workspace — legacy single-workspace shape (active workspace) ──
router.get('/workspace', async (req, res) => {
  try {
    const workspace = req.workspace || (await getWorkspaceForUser(req.user.id));
    if (!workspace) return res.status(404).json({ error: 'No workspace found for this user' });
    res.json(workspace);
  } catch (err) {
    console.error('[workspace] get error:', err.message);
    res.status(500).json({ error: 'Failed to load workspace' });
  }
});

// ─── GET /workspaces ──────────────────────────────────────────────────────
// Platform Admin (global legacy role === 'admin' — see permissions.js
// This is the NORMAL workspace selector (Topbar) — it must show ONLY
// workspaces the caller has an actual workspace_members row for, for every
// caller, INCLUDING a Platform Admin. A Platform Admin's ability to reach
// every customer workspace is a *separate* mechanism (GET
// /platform-admin/workspaces + POST /workspaces/:id/switch's
// isPlatformAdmin branch below) and must never be folded back into this
// list — see Phase 5C section 8 ("Do NOT put all workspaces back into the
// normal workspace selector").
router.get('/workspaces', async (req, res) => {
  try {
    const workspaces = req.workspaces || (await getWorkspacesForUser(req.user.id));
    const activeId = req.workspace?.id ?? null;
    res.json(workspaces.map(w => ({ ...w, isActive: w.id === activeId })));
  } catch (err) {
    console.error('[workspaces] list error:', err.message);
    res.status(500).json({ error: 'Failed to load workspaces' });
  }
});

// ─── GET /platform-admin/workspaces — Platform Admin ONLY ────────────────
// Every ACTIVE workspace on the platform, regardless of membership. This is
// the dedicated Platform Admin page's data source (Kavin managing customer
// workspaces) — completely separate from the normal workspace selector
// above. 403s for anyone who is not isPlatformAdmin(req.user) (the global
// legacy 'admin' role) — never a workspace-level OWNER/ADMIN.
router.get('/platform-admin/workspaces', async (req, res) => {
  if (!isPlatformAdmin(req.user)) {
    return res.status(403).json({ error: 'Platform admin access required' });
  }
  try {
    const workspaces = await getAllActiveWorkspaces();
    const activeId = req.workspace?.id ?? null;
    res.json(workspaces.map(w => ({ ...w, isActive: w.id === activeId })));
  } catch (err) {
    console.error('[platform-admin] workspaces list error:', err.message);
    res.status(500).json({ error: 'Failed to load workspaces' });
  }
});

// ─── POST /workspaces — create a new workspace ───────────────────────────
// Any authenticated, active user may create a workspace (this is how a
// brand-new SaaS customer bootstraps their first workspace, and matches
// "OWNER/authorized ADMIN should be able to create a workspace" — a user
// creating their own new workspace is, by definition, about to become its
// OWNER). Existing workspaces/memberships are never touched.
router.post('/workspaces', async (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Workspace name is required' });
  if (name.length > 120) return res.status(400).json({ error: 'Workspace name is too long' });

  let slug = slugify(name);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: clash } = await client.query(
      'SELECT 1 FROM coexistence.workspaces WHERE slug = $1',
      [slug]
    );
    if (clash.length > 0) slug = `${slug}-${Date.now().toString(36)}`;

    const { rows: inserted } = await client.query(
      `INSERT INTO coexistence.workspaces (name, slug, status)
       VALUES ($1, $2, 'active')
       RETURNING id, name, slug, status, created_at`,
      [name, slug]
    );
    const workspace = inserted[0];

    await client.query(
      `INSERT INTO coexistence.workspace_members (workspace_id, user_id, workspace_role, status)
       VALUES ($1, $2, 'OWNER', 'active')`,
      [workspace.id, req.user.id]
    );

    // Phase 4H STEP 11 — a brand-new workspace gets its own safe-default
    // workspace_defaults row immediately, in the same transaction as its
    // creation. It never depends on Invi Creation's (or any other
    // workspace's) defaults, and never waits for a server restart.
    await ensureDefaultsRowForWorkspace(client, workspace.id);

    // Phase 5B — new workspace gets a billing row (default Free plan)
    // synchronously, in the same transaction, so it's never in a state
    // without one (the grandfathering backfill in plansSchema.js only
    // catches workspaces that predate Phase 5B).
    await ensureBillingRowForNewWorkspace(client, workspace.id);

    await client.query('COMMIT');

    // New workspace immediately becomes the caller's active one — matches
    // the expectation that "creating a workspace" switches you into it.
    setActiveWorkspaceCookie(res, workspace.id);

    res.status(201).json({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      status: workspace.status,
      createdAt: workspace.created_at,
      role: 'OWNER',
      isActive: true,
      // New workspaces start onboarding-incomplete by column default
      // (see ensureOnboardingColumns) — not overridden here.
      onboardingCompleted: false,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[workspaces] create error:', err.message);
    if (err.code === '23505') return res.status(409).json({ error: 'A workspace with that name already exists' });
    res.status(500).json({ error: 'Failed to create workspace' });
  } finally {
    client.release();
  }
});

// ─── POST /workspaces/:id/switch — change the caller's active workspace ─
// Platform Admin path (item E): validates the target workspace exists and
// is active directly (getActiveWorkspaceById), with NO membership
// requirement and NO fake workspace_members row ever created for them.
// Every other (normal) user keeps the exact original membership-required
// behaviour via loadMembership, unchanged.
router.post('/workspaces/:id/switch', async (req, res) => {
  const workspaceId = parseInt(req.params.id, 10);
  if (!Number.isInteger(workspaceId)) {
    return res.status(400).json({ error: 'Invalid workspace id' });
  }
  try {
    if (isPlatformAdmin(req.user)) {
      const target = await getActiveWorkspaceById(workspaceId);
      if (!target) return res.status(404).json({ error: 'Workspace not found' });
      setActiveWorkspaceCookie(res, target.id);
      return res.json({ ...target, isActive: true });
    }
    const membership = await getMembership(req.user.id, workspaceId);
    if (!membership) return res.status(404).json({ error: 'Workspace not found' });
    setActiveWorkspaceCookie(res, membership.id);
    res.json({ ...membership, isActive: true });
  } catch (err) {
    console.error('[workspace] switch error:', err.message);
    res.status(500).json({ error: 'Failed to switch workspace' });
  }
});

// ─── Phase 4A/4B — Workspace onboarding + Business Settings ──────────────
// GET  /workspaces/:id/onboarding         current onboarding + business config
//                                          (Phase 4A fields + Phase 4B website/currency)
// PUT  /workspaces/:id/onboarding         save business config + optionally
//                                          mark onboarding complete. Reused
//                                          as-is by the Phase 4B "Business
//                                          Settings" UI for ongoing edits —
//                                          no separate route added, since the
//                                          shape and validation are identical
//                                          and `complete` simply stays
//                                          false/omitted on a settings-page save.
//
// Both routes go through loadMembership (never trusts :id alone — 404s if
// the caller isn't an active member of that workspace) and
// requireWorkspaceRole('ADMIN') (ADMIN and OWNER only; the higher role,
// OWNER, satisfies an ADMIN-level gate under the existing roleLevel()
// hierarchy — same pattern already used by PATCH /workspaces/:id).

router.get('/workspaces/:id/onboarding', loadMembership, requireWorkspaceRole('ADMIN'), (req, res) => {
  const m = req.membership;
  res.json({
    onboardingCompleted: m.onboardingCompleted,
    businessName: m.businessName,
    businessPhone: m.businessPhone,
    businessEmail: m.businessEmail,
    businessAddress: m.businessAddress,
    timezone: m.timezone,
    logoUrl: m.logoUrl,
    website: m.website,
    currency: m.currency,
  });
});

const MAX_TEXT_FIELD = 255;
const MAX_ADDRESS_FIELD = 500;

router.put('/workspaces/:id/onboarding', loadMembership, requireWorkspaceRole('ADMIN'), async (req, res) => {
  const body = req.body || {};
  const businessName = body.businessName != null ? String(body.businessName).trim() : null;
  const businessPhone = body.businessPhone != null ? String(body.businessPhone).trim() : null;
  const businessEmail = body.businessEmail != null ? String(body.businessEmail).trim() : null;
  const businessAddress = body.businessAddress != null ? String(body.businessAddress).trim() : null;
  const timezone = body.timezone != null ? String(body.timezone).trim() : null;
  // logo_url: foundation only — accept an already-hosted URL string (e.g. from
  // the existing media upload/library system) rather than building new file
  // upload handling here, per the "logo/branding foundation only if it can be
  // implemented safely using the existing architecture" instruction.
  const logoUrl = body.logoUrl != null ? String(body.logoUrl).trim() : null;
  const website = body.website != null ? String(body.website).trim() : null;
  const currency = body.currency != null ? String(body.currency).trim() : null;
  const complete = body.complete === true;

  if (businessName && businessName.length > MAX_TEXT_FIELD) {
    return res.status(400).json({ error: 'businessName is too long' });
  }
  if (businessPhone && businessPhone.length > MAX_TEXT_FIELD) {
    return res.status(400).json({ error: 'businessPhone is too long' });
  }
  if (businessEmail && businessEmail.length > MAX_TEXT_FIELD) {
    return res.status(400).json({ error: 'businessEmail is too long' });
  }
  if (businessAddress && businessAddress.length > MAX_ADDRESS_FIELD) {
    return res.status(400).json({ error: 'businessAddress is too long' });
  }
  if (timezone && timezone.length > MAX_TEXT_FIELD) {
    return res.status(400).json({ error: 'timezone is too long' });
  }
  if (logoUrl && logoUrl.length > 2048) {
    return res.status(400).json({ error: 'logoUrl is too long' });
  }
  if (website && website.length > 2048) {
    return res.status(400).json({ error: 'website is too long' });
  }
  if (currency && currency.length > 10) {
    return res.status(400).json({ error: 'currency is too long' });
  }

  // Required only when the caller is asking to mark onboarding complete —
  // lets the frontend save a partial draft (complete: false / omitted)
  // without forcing every field up front, while still requiring the core
  // fields before the workspace can actually leave the setup screen.
  if (complete) {
    if (!businessName) return res.status(400).json({ error: 'businessName is required to complete onboarding' });
    if (!timezone) return res.status(400).json({ error: 'timezone is required to complete onboarding' });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE coexistence.workspaces
          SET business_name    = COALESCE($1, business_name),
              business_phone   = COALESCE($2, business_phone),
              business_email   = COALESCE($3, business_email),
              business_address = COALESCE($4, business_address),
              timezone         = COALESCE($5, timezone),
              logo_url         = COALESCE($6, logo_url),
              website          = COALESCE($7, website),
              currency         = COALESCE($8, currency),
              onboarding_completed = onboarding_completed OR $9::boolean,
              updated_at = NOW()
        WHERE id = $10
        RETURNING onboarding_completed, business_name, business_phone,
                  business_email, business_address, timezone, logo_url,
                  website, currency`,
      [
        businessName || null, businessPhone || null, businessEmail || null,
        businessAddress || null, timezone || null, logoUrl || null,
        website || null, currency || null,
        complete, req.membership.id,
      ]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'Workspace not found' });
    res.json({
      onboardingCompleted: row.onboarding_completed,
      businessName: row.business_name,
      businessPhone: row.business_phone,
      businessEmail: row.business_email,
      businessAddress: row.business_address,
      timezone: row.timezone,
      logoUrl: row.logo_url,
      website: row.website,
      currency: row.currency,
    });
  } catch (err) {
    console.error('[workspaces] onboarding save error:', err.message);
    res.status(500).json({ error: 'Failed to save onboarding' });
  }
});

// ─── Phase 4H — Workspace-Level Defaults ─────────────────────────────────
// GET  /workspaces/:id/defaults   current workspace defaults (any active
//                                  member of the workspace may view)
// PUT  /workspaces/:id/defaults   update campaign/automation/contact/
//                                  notification defaults (ADMIN+ only)
//
// Both go through loadMembership (never trusts :id alone) exactly like the
// onboarding routes above. Timezone and the default WhatsApp account are
// NOT stored again here — they are read back from their existing sources
// (coexistence.workspaces.timezone, and coexistence.whatsapp_accounts
// is_default) so there is exactly one place each can be changed:
//   - timezone: PUT /workspaces/:id/onboarding (existing Business
//     Information panel)
//   - default WhatsApp account: POST /whatsapp-accounts/:id/set-default
//     (new in Phase 4H — see routes/whatsappAccounts.js)

router.get('/workspaces/:id/defaults', loadMembership, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT campaign_defaults, automation_defaults, contact_defaults, notification_defaults
         FROM coexistence.workspace_defaults WHERE workspace_id = $1`,
      [req.membership.id]
    );
    // Should always exist (backfilled on boot / created with the workspace),
    // but never 500 on a race — fall back to empty objects rather than fail.
    const row = rows[0] || {};

    const { rows: waRows } = await pool.query(
      `SELECT id, display_name, display_phone_number
         FROM coexistence.whatsapp_accounts
        WHERE workspace_id = $1 AND is_default = TRUE
        LIMIT 1`,
      [req.membership.id]
    );
    const defaultAccount = waRows[0] || null;

    res.json({
      timezone: req.membership.timezone,
      defaultWhatsappAccount: defaultAccount ? {
        id: defaultAccount.id,
        displayName: defaultAccount.display_name,
        displayPhoneNumber: defaultAccount.display_phone_number,
      } : null,
      campaignDefaults: row.campaign_defaults || {},
      automationDefaults: row.automation_defaults || {},
      contactDefaults: row.contact_defaults || {},
      notificationDefaults: row.notification_defaults || {},
    });
  } catch (err) {
    console.error('[workspace-defaults] get error:', err.message);
    res.status(500).json({ error: 'Failed to load workspace defaults' });
  }
});

router.put('/workspaces/:id/defaults', loadMembership, requireWorkspaceRole('ADMIN'), async (req, res) => {
  const body = req.body || {};
  try {
    const { rows: currentRows } = await pool.query(
      `SELECT campaign_defaults, automation_defaults, contact_defaults, notification_defaults
         FROM coexistence.workspace_defaults WHERE workspace_id = $1`,
      [req.membership.id]
    );
    const current = currentRows[0] || {};

    const campaignDefaults = sanitizeCategory('campaign', body.campaignDefaults, current.campaign_defaults);
    const automationDefaults = sanitizeCategory('automation', body.automationDefaults, current.automation_defaults);
    const contactDefaults = sanitizeCategory('contact', body.contactDefaults, current.contact_defaults);
    const notificationDefaults = sanitizeCategory('notification', body.notificationDefaults, current.notification_defaults);

    const { rows } = await pool.query(
      `INSERT INTO coexistence.workspace_defaults
         (workspace_id, campaign_defaults, automation_defaults, contact_defaults, notification_defaults)
       VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb)
       ON CONFLICT (workspace_id) DO UPDATE SET
         campaign_defaults     = EXCLUDED.campaign_defaults,
         automation_defaults   = EXCLUDED.automation_defaults,
         contact_defaults      = EXCLUDED.contact_defaults,
         notification_defaults = EXCLUDED.notification_defaults,
         updated_at = NOW()
       RETURNING campaign_defaults, automation_defaults, contact_defaults, notification_defaults`,
      [
        req.membership.id,
        JSON.stringify(campaignDefaults),
        JSON.stringify(automationDefaults),
        JSON.stringify(contactDefaults),
        JSON.stringify(notificationDefaults),
      ]
    );
    const row = rows[0];
    res.json({
      timezone: req.membership.timezone,
      campaignDefaults: row.campaign_defaults,
      automationDefaults: row.automation_defaults,
      contactDefaults: row.contact_defaults,
      notificationDefaults: row.notification_defaults,
    });
  } catch (err) {
    console.error('[workspace-defaults] save error:', err.message);
    res.status(500).json({ error: 'Failed to save workspace defaults' });
  }
});

// ─── PATCH /workspaces/:id — rename ──────────────────────────────────────

// GET  /workspaces/:id/ai-profile   current business-type + system instructions
// PUT  /workspaces/:id/ai-profile   update business-type/instructions/model (ADMIN+ only)

router.get('/workspaces/:id/ai-profile', loadMembership, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT business_type, system_instructions, default_model
         FROM coexistence.workspace_ai_profile WHERE workspace_id = $1`,
      [req.params.id]
    );
    const row = rows[0] || { business_type: 'general', system_instructions: '', default_model: null };
    res.json({
      businessType: row.business_type,
      systemInstructions: row.system_instructions,
      defaultModel: row.default_model,
      presets: BUSINESS_TYPE_PRESETS,
    });
  } catch (err) {
    console.error('[ai-profile] get error:', err.message);
    res.status(500).json({ error: 'Failed to load AI profile' });
  }
});

router.put('/workspaces/:id/ai-profile', loadMembership, requireWorkspaceRole('ADMIN'), async (req, res) => {
  try {
    const body = req.body || {};
    const businessType = VALID_BUSINESS_TYPES.has(body.businessType) ? body.businessType : 'general';
    const systemInstructions = typeof body.systemInstructions === 'string'
      ? body.systemInstructions.slice(0, 2000)
      : '';
    const defaultModel = typeof body.defaultModel === 'string' && body.defaultModel.trim()
      ? body.defaultModel.trim()
      : null;

    const { rows } = await pool.query(
      `INSERT INTO coexistence.workspace_ai_profile
         (workspace_id, business_type, system_instructions, default_model)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id) DO UPDATE SET
         business_type       = EXCLUDED.business_type,
         system_instructions = EXCLUDED.system_instructions,
         default_model       = EXCLUDED.default_model,
         updated_at           = NOW()
       RETURNING business_type, system_instructions, default_model`,
      [req.params.id, businessType, systemInstructions, defaultModel]
    );
    const row = rows[0];
    res.json({
      businessType: row.business_type,
      systemInstructions: row.system_instructions,
      defaultModel: row.default_model,
    });
  } catch (err) {
    console.error('[ai-profile] put error:', err.message);
    res.status(500).json({ error: 'Failed to update AI profile' });
  }
});
router.patch('/workspaces/:id', loadMembership, requireWorkspaceRole('ADMIN'), async (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Workspace name is required' });
  if (name.length > 120) return res.status(400).json({ error: 'Workspace name is too long' });
  try {
    const { rows } = await pool.query(
      `UPDATE coexistence.workspaces SET name = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING id, name, slug, status, created_at`,
      [name, req.membership.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Workspace not found' });
    res.json({ ...rows[0], role: req.membership.role });
  } catch (err) {
    console.error('[workspaces] rename error:', err.message);
    res.status(500).json({ error: 'Failed to update workspace' });
  }
});

// ─── GET /workspaces/:id/members ─────────────────────────────────────────
router.get('/workspaces/:id/members', loadMembership, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT au.id, au.username, au.email, au.display_name, wm.workspace_role, wm.status, wm.created_at
         FROM coexistence.workspace_members wm
         JOIN coexistence.akchat_users au ON au.id = wm.user_id
        WHERE wm.workspace_id = $1
        ORDER BY wm.id ASC`,
      [req.membership.id]
    );
    res.json(rows.map(r => ({
      id: r.id,
      username: r.username,
      email: r.email,
      displayName: r.display_name,
      role: r.workspace_role,
      status: r.status,
      memberSince: r.created_at,
    })));
  } catch (err) {
    console.error('[workspaces] members list error:', err.message);
    res.status(500).json({ error: 'Failed to load members' });
  }
});

// ─── POST /workspaces/:id/members — add an existing user by email ───────
// Reuses the existing akchat_users table (global identity) rather than
// creating a second parallel user system — a workspace membership is just
// an additional row in workspace_members. The target account must already
// exist (this mirrors the existing architecture: user accounts are created
// via POST /users, membership is a separate, additive concern).
router.post('/workspaces/:id/members', loadMembership, requireWorkspaceRole('ADMIN'), async (req, res) => {
  const email = (req.body?.email || '').trim().toLowerCase();
  const role = req.body?.role || 'VIEWER';
  if (!email) return res.status(400).json({ error: 'email is required' });
  if (!VALID_WORKSPACE_ROLES.has(role)) {
    return res.status(400).json({ error: `role must be one of: ${[...VALID_WORKSPACE_ROLES].join(', ')}` });
  }
  // Only an OWNER can grant OWNER — prevents an ADMIN from creating a peer
  // owner and escaping the ownership-level protections in this same file.
  if (role === 'OWNER' && req.membership.role !== 'OWNER') {
    return res.status(403).json({ error: 'Only an existing OWNER can grant OWNER' });
  }
  try {
    // Phase 5B — server-side seat entitlement check, before touching any
    // row. Reactivating/re-adding an already-active-or-pending member is a
    // no-op for the seat count (countActiveSeats already counts them), so
    // this never wrongly blocks that case — it only blocks a genuinely new
    // seat being occupied.
    const seatCheck = await checkLimit(req.membership.id, LIMIT_TYPES.SEATS);
    if (!seatCheck.allowed) {
      return res.status(403).json(limitExceededResponse(seatCheck));
    }

    const { rows: userRows } = await pool.query(
      `SELECT id, username, display_name FROM coexistence.akchat_users WHERE email = $1`,
      [email]
    );
    const user = userRows[0];
    if (!user) return res.status(404).json({ error: 'No user account found with that email. They must sign up / be created first.' });

    const { rows } = await pool.query(
      `INSERT INTO coexistence.workspace_members (workspace_id, user_id, workspace_role, status)
       VALUES ($1, $2, $3, 'active')
       ON CONFLICT (workspace_id, user_id)
         DO UPDATE SET status = 'active', workspace_role = EXCLUDED.workspace_role, updated_at = NOW()
       RETURNING workspace_role, status, created_at`,
      [req.membership.id, user.id, role]
    );
    res.status(201).json({
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      email,
      role: rows[0].workspace_role,
      status: rows[0].status,
      memberSince: rows[0].created_at,
    });
  } catch (err) {
    console.error('[workspaces] add member error:', err.message);
    res.status(500).json({ error: 'Failed to add member' });
  }
});

// ─── PATCH /workspaces/:id/members/:userId — change role ────────────────
router.patch('/workspaces/:id/members/:userId', loadMembership, requireWorkspaceRole('ADMIN'), async (req, res) => {
  const targetUserId = parseInt(req.params.userId, 10);
  const role = req.body?.role;
  if (!VALID_WORKSPACE_ROLES.has(role)) {
    return res.status(400).json({ error: `role must be one of: ${[...VALID_WORKSPACE_ROLES].join(', ')}` });
  }
  if (role === 'OWNER' && req.membership.role !== 'OWNER') {
    return res.status(403).json({ error: 'Only an existing OWNER can grant OWNER' });
  }
  try {
    // Owner-protection: never allow the last remaining OWNER to be demoted.
    const { rows: current } = await pool.query(
      `SELECT workspace_role FROM coexistence.workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [req.membership.id, targetUserId]
    );
    if (!current[0]) return res.status(404).json({ error: 'Member not found' });
    if (current[0].workspace_role === 'OWNER' && role !== 'OWNER') {
      const { rows: ownerCount } = await pool.query(
        `SELECT COUNT(*) FROM coexistence.workspace_members
          WHERE workspace_id = $1 AND workspace_role = 'OWNER' AND status = 'active'`,
        [req.membership.id]
      );
      if (parseInt(ownerCount[0].count, 10) <= 1) {
        return res.status(400).json({ error: 'A workspace must always have at least one OWNER' });
      }
    }

    const { rows } = await pool.query(
      `UPDATE coexistence.workspace_members
          SET workspace_role = $1, updated_at = NOW()
        WHERE workspace_id = $2 AND user_id = $3
        RETURNING workspace_role, status`,
      [role, req.membership.id, targetUserId]
    );
    res.json({ id: targetUserId, role: rows[0].workspace_role, status: rows[0].status });
  } catch (err) {
    console.error('[workspaces] member role update error:', err.message);
    res.status(500).json({ error: 'Failed to update member' });
  }
});

// ─── DELETE /workspaces/:id/members/:userId — remove ─────────────────────
router.delete('/workspaces/:id/members/:userId', loadMembership, requireWorkspaceRole('ADMIN'), async (req, res) => {
  const targetUserId = parseInt(req.params.userId, 10);
  try {
    const { rows: current } = await pool.query(
      `SELECT workspace_role FROM coexistence.workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [req.membership.id, targetUserId]
    );
    if (!current[0]) return res.status(404).json({ error: 'Member not found' });
    if (current[0].workspace_role === 'OWNER') {
      const { rows: ownerCount } = await pool.query(
        `SELECT COUNT(*) FROM coexistence.workspace_members
          WHERE workspace_id = $1 AND workspace_role = 'OWNER' AND status = 'active'`,
        [req.membership.id]
      );
      if (parseInt(ownerCount[0].count, 10) <= 1) {
        return res.status(400).json({ error: 'A workspace must always have at least one OWNER' });
      }
    }
    await pool.query(
      `DELETE FROM coexistence.workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [req.membership.id, targetUserId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[workspaces] remove member error:', err.message);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

module.exports = { router };
