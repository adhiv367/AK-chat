const { Router } = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const pool = require('./db');
const { effectivePages, isPlatformAdmin } = require('./permissions');
const { getWorkspacesForUser, getActiveWorkspaceById, setActiveWorkspaceCookie, clearActiveWorkspaceCookie, ACTIVE_WORKSPACE_COOKIE } = require('./middleware/workspaceContext');
const { sendPasswordResetEmail } = require('./services/emailService');

// Build the full session for a user: identity + role + the resolved page list
// + the WhatsApp numbers they're assigned to. The frontend uses `pages` to
// gate nav/routes and `role` to decide admin-only UI.
async function loadUserSession(userId, req = null) {
  const { rows } = await pool.query(
    `SELECT id, username, email, display_name, role, permissions, is_active, last_login_at
       FROM coexistence.akchat_users WHERE id = $1`,
    [userId]
  );
  const u = rows[0];
  if (!u) return null;
  const { rows: waRows } = await pool.query(
    `SELECT wa_number FROM coexistence.user_wa_assignments WHERE user_id = $1`,
    [userId]
  );
  // Resolved fresh from the DB on every session load, same as role/
  // permissions above — never cached in the JWT. Failure here must never
  // break login/session loading, so it's swallowed and workspace(s) are
  // simply reported as null/empty. `workspaces` is every membership the
  // user has; `workspace` is whichever one is currently active (honouring
  // the akchat_active_workspace cookie on `req` when one is supplied).
  let workspaces = [];
  let activeWorkspace = null;
  try {
    workspaces = await getWorkspacesForUser(userId);
    const requestedId = req?.cookies?.[ACTIVE_WORKSPACE_COOKIE];
    activeWorkspace = (requestedId && workspaces.find(w => String(w.id) === String(requestedId))) || null;

    // Phase 5C — Platform Admin. The active-workspace cookie may point at a
    // workspace the platform admin isn't a member of (they switched into it
    // for administration purposes — see routes/workspace.js switch handler
    // and middleware/workspaceContext.getActiveWorkspaceById). Re-validate
    // directly against the workspaces table rather than trusting the cookie.
    if (!activeWorkspace && requestedId && isPlatformAdmin(u)) {
      activeWorkspace = await getActiveWorkspaceById(requestedId);
    }
    if (!activeWorkspace) activeWorkspace = workspaces[0] || null;

    // The `workspaces` list returned to the client drives the NORMAL
    // workspace selector, which must show ONLY the caller's actual
    // workspace_members row(s) — for every user, including a Platform
    // Admin (see routes/workspace.js GET /workspaces and Phase 5C section
    // 8: "Do NOT put all workspaces back into the normal workspace
    // selector"). A Platform Admin's ability to reach every customer
    // workspace is a separate mechanism — see GET /platform-admin/workspaces
    // and the `isPlatformAdmin` flag below, which the frontend uses to show
    // a dedicated Platform Admin page/menu instead of expanding this list.
  } catch (err) {
    console.error('[auth] workspace lookup failed:', err.message);
  }
  // Phase 5C fix — page/nav visibility must follow WORKSPACE role, not the
  // global akchat_users.role, whenever the user has an active workspace.
  // Before this fix, effectivePages() was always computed from the global
  // role, so a customer whose global role is the legacy 'viewer' fallback
  // (e.g. SaaS Test User) collapsed to VIEWER's minimal legacy page set
  // (['home','about'] — "Insights Hub" only) regardless of their real
  // workspace_members.workspace_role (OWNER). Global role and workspace
  // role are separate concepts (see permissions.js) and must be resolved
  // separately here too:
  //   - Platform Admin (isPlatformAdmin(u)) always gets the full page set,
  //     both with no active workspace and while managing any customer
  //     workspace (their global 'admin' role already implies this via
  //     ROLE_PAGE_DEFAULTS.admin, so effectivePages({role:'admin', ...})
  //     already returns everything — no extra branch needed here).
  //   - A normal user's page set is driven by their CURRENT workspace's
  //     workspace_role (activeWorkspace.role) when they have one; only a
  //     user with zero workspace memberships (activeWorkspace === null)
  //     falls back to the legacy global-role-only behaviour.
  const pageRole = isPlatformAdmin(u)
    ? u.role
    : (activeWorkspace ? activeWorkspace.role : u.role);
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    displayName: u.display_name,
    role: u.role,
    isActive: u.is_active,
    permissions: u.permissions || null,
    // Phase 5C — lets the frontend show the dedicated Platform Admin
    // menu/page without re-deriving it from the literal role string.
    // Global/platform-level only — never true for a workspace-level
    // OWNER/ADMIN (see permissions.js isPlatformAdmin).
    isPlatformAdmin: isPlatformAdmin(u),
    pages: Array.from(effectivePages({ role: pageRole, permissions: u.permissions })),
    assignedWaNumbers: waRows.map(r => r.wa_number),
    workspace: activeWorkspace
      ? {
          id: activeWorkspace.id, name: activeWorkspace.name, slug: activeWorkspace.slug,
          role: activeWorkspace.role, onboardingCompleted: activeWorkspace.onboardingCompleted,
        }
      : null,
    workspaces: workspaces.map(w => ({
      id: w.id, name: w.name, slug: w.slug, role: w.role, isActive: activeWorkspace?.id === w.id,
      onboardingCompleted: w.onboardingCompleted,
    })),
  };
}

const JWT_SECRET = process.env.JWT_SECRET || 'AKchat-dev-secret-change-me';
// Values that must NEVER protect a production deployment: the dev fallback plus
// the placeholders shipped in .env.example / DEPLOY.md. The source is public, so
// anyone could akchat tokens if a self-hoster left these in place.
const WEAK_SECRETS = new Set([
  'Akchat-dev-secret-change-me',
  'change-this-to-a-random-string',
  'change-this-to-another-random-string',
]);
// In production, refuse to start with a missing, well-known, or low-entropy
// signing secret. Dev/test keep the convenient fallback.
if (process.env.NODE_ENV === 'production' &&
    (!process.env.JWT_SECRET ||
     WEAK_SECRETS.has(process.env.JWT_SECRET) ||
     process.env.JWT_SECRET.length < 32)) {
  console.error('[auth] FATAL: JWT_SECRET must be a strong, unique value (>=32 chars) in production. Generate one with: openssl rand -hex 32');
  process.exit(1);
}
const COOKIE_NAME = 'akchat_token';
const TOKEN_EXPIRY = '24h';

const router = Router();

// Ensure tables exist on startup
async function ensureTables() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS coexistence.akchat_users (
        id         BIGSERIAL PRIMARY KEY,
        username   TEXT NOT NULL UNIQUE,
        email      TEXT NOT NULL UNIQUE,
        password   TEXT NOT NULL,
        display_name TEXT,
        role       TEXT NOT NULL DEFAULT 'viewer',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Seed the first admin only when the users table is empty. The password
    // comes from ADMIN_PASSWORD; if that is unset we generate a random one and
    // print it once, so there is never a well-known default credential.
    const { rows } = await client.query('SELECT COUNT(*) FROM coexistence.akchat_users');
    if (parseInt(rows[0].count, 10) === 0) {
      const adminEmail = process.env.ADMIN_EMAIL || 'admin@akchat.space';
      // In production never auto-generate: a random password printed/written at
      // boot is easy to lose and risky to log. Require an explicit ADMIN_PASSWORD.
      if (!process.env.ADMIN_PASSWORD && process.env.NODE_ENV === 'production') {
        console.error('[auth] FATAL: set ADMIN_PASSWORD to seed the first admin in production.');
        process.exit(1);
      }
      const generated = !process.env.ADMIN_PASSWORD;
      const adminPassword = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
      const hash = await bcrypt.hash(adminPassword, 10);
      await client.query(
        `INSERT INTO coexistence.akchat_users (username, email, password, display_name, role)
         VALUES ('admin', $1, $2, 'Admin', 'admin')`,
        [adminEmail, hash]
      );
      if (generated) {
        // Never print the generated password to stdout — log aggregators would
        // capture it permanently. Write it to a 0600 file for one-time pickup.
        const fs = require('fs');
        const path = require('path');
        const credPath = path.join(process.cwd(), '.admin-password');
        fs.writeFileSync(credPath, `email: ${adminEmail}\npassword: ${adminPassword}\n`, { mode: 0o600 });
        console.log(`[auth] Created admin '${adminEmail}'. Generated password written to ${credPath} (chmod 600).`);
        console.log('[auth] Read it, log in, change the password, then delete that file — or set ADMIN_PASSWORD before first boot.');
      } else {
        console.log(`[auth] Created admin '${adminEmail}' from ADMIN_PASSWORD.`);
      }
    }
  } finally {
    client.release();
  }
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, displayName: user.display_name, role: user.role },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

async function authMiddleware(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
  // Legacy tokens (issued by the single-user build) carry no role. Force a
  // clean re-login so every session has a role for permission checks.
  if (!payload.role) {
    res.clearCookie(COOKIE_NAME);
    return res.status(401).json({ error: 'Session expired, please sign in again' });
  }
  try {
    // Re-check the live account on every request so a deactivated or demoted
    // user loses access immediately, instead of keeping their old privileges
    // until the 24h token expires. The fresh role also overrides any stale role
    // embedded in the JWT (an admin who demotes a user takes effect at once).
    const { rows } = await pool.query(
      'SELECT role, is_active FROM coexistence.akchat_users WHERE id = $1',
      [payload.id]
    );
    const u = rows[0];
    if (!u) {
      res.clearCookie(COOKIE_NAME);
      return res.status(401).json({ error: 'User not found' });
    }
    if (u.is_active === false) {
      res.clearCookie(COOKIE_NAME);
      return res.status(403).json({ error: 'Account disabled' });
    }
    req.user = { ...payload, role: u.role };
    next();
  } catch (err) {
    console.error('[auth] authMiddleware account check failed:', err.message);
    res.status(500).json({ error: 'Authentication check failed' });
  }
}

// POST /api/auth/login
router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT * FROM coexistence.akchat_users WHERE email = $1',
      [email.trim().toLowerCase()]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (user.is_active === false) {
      return res.status(403).json({ error: 'Account is disabled. Contact an administrator.' });
    }
    const token = signToken(user);
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 24 * 60 * 60 * 1000,
    });
    // Best-effort: stamp last_login_at; don't fail login if this errors.
    pool.query(`UPDATE coexistence.akchat_users SET last_login_at = NOW() WHERE id = $1`, [user.id]).catch(() => {});
    const session = await loadUserSession(user.id, req);
    // First login (or a stale/foreign cookie): pin the active-workspace
    // cookie to whichever workspace loadUserSession resolved as active, so
    // subsequent requests are consistent without a client round-trip.
    if (session.workspace) setActiveWorkspaceCookie(res, session.workspace.id);
    res.json({ user: session });
  } catch (err) {
    console.error('[auth] login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me
router.get('/auth/me', authMiddleware, async (req, res) => {
  try {
    const session = await loadUserSession(req.user.id, req);
    if (!session) {
      res.clearCookie(COOKIE_NAME);
      return res.status(401).json({ error: 'User not found' });
    }
    if (session.isActive === false) {
      res.clearCookie(COOKIE_NAME);
      return res.status(403).json({ error: 'Account disabled' });
    }
    res.json({ user: session });
  } catch (err) {
    console.error('[auth] me error:', err.message);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// POST /api/auth/logout
router.post('/auth/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  clearActiveWorkspaceCookie(res);
  res.json({ ok: true });
});

// ─── Self-service password recovery (Phase 5A) ───────────────────────
//
//   POST /auth/forgot-password       — public, rate-limited. Always
//                                       returns the same generic response
//                                       regardless of whether the email
//                                       exists (no account enumeration).
//   POST /auth/reset-password/:token — public. Consumes a single-use,
//                                       time-limited reset token and sets
//                                       a new password via the existing
//                                       bcrypt hashing used everywhere else.
//
// Tokens are cryptographically random (32 bytes), and only a SHA-256 hash
// of the token is ever persisted — see db/passwordResetSchema.js. The raw
// token exists only in the emailed link and briefly in memory here.

const RESET_TOKEN_BYTES = 32;
const RESET_EXPIRY_MS = 60 * 60 * 1000; // 1 hour — short-lived, unlike the 7-day invite link
const FRONTEND_URL = (process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'http://localhost:5173').replace(/\/$/, '');

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Dedicated, tighter limiter for the two password-recovery endpoints: these
// are exactly the endpoints an attacker would hammer to enumerate accounts
// or brute-force tokens, so they get a much lower ceiling than the general
// apiLimiter already applied to every /api route in index.js.
const passwordRecoveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${(req.body?.email || '').trim().toLowerCase()}`,
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many requests, please try again later' });
  },
});

// Generic response used for every outcome of forgot-password (known email,
// unknown email, email-send failure) so the response itself never reveals
// whether an account exists.
const FORGOT_PASSWORD_GENERIC_RESPONSE = {
  message: 'If an account exists for that email, a password reset link has been sent.',
};

// POST /api/auth/forgot-password
router.post('/auth/forgot-password', passwordRecoveryLimiter, async (req, res) => {
  const email = (req.body?.email || '').trim().toLowerCase();
  if (!email) {
    // Still generic — don't confirm/deny anything about the address itself.
    return res.json(FORGOT_PASSWORD_GENERIC_RESPONSE);
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, email, is_active FROM coexistence.akchat_users WHERE email = $1`,
      [email]
    );
    const user = rows[0];
    // Only proceed to generate/send a token for a real, active account.
    // Every branch below still converges on the same JSON response.
    if (user && user.is_active !== false) {
      const rawToken = crypto.randomBytes(RESET_TOKEN_BYTES).toString('hex');
      const tokenHash = hashResetToken(rawToken);
      const expiresAt = new Date(Date.now() + RESET_EXPIRY_MS);

      // Invalidate any previous outstanding tokens for this user first, so
      // only the most recently requested link can ever be used.
      await pool.query(
        `DELETE FROM coexistence.password_reset_tokens WHERE user_id = $1 AND used_at IS NULL`,
        [user.id]
      );
      await pool.query(
        `INSERT INTO coexistence.password_reset_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [user.id, tokenHash, expiresAt]
      );

      const resetUrl = `${FRONTEND_URL}/#/reset-password/${rawToken}`;
      // Delivery result is intentionally not reflected in the API response
      // (would leak account existence); it's only logged server-side.
      const result = await sendPasswordResetEmail({ to: user.email, resetUrl, expiresAt });
      if (!result.sent) {
        console.error(`[auth] forgot-password: email delivery failed for user ${user.id}: ${result.error}`);
      }
    }
  } catch (err) {
    console.error('[auth] forgot-password error:', err.message);
    // Fall through to the same generic response even on unexpected errors.
  }
  res.json(FORGOT_PASSWORD_GENERIC_RESPONSE);
});

// POST /api/auth/reset-password/:token
router.post('/auth/reset-password/:token', passwordRecoveryLimiter, async (req, res) => {
  const { token } = req.params;
  const password = req.body?.password;
  // TEMP DIAGNOSTIC (Phase 5A debug — safe: no raw token/hash/secret printed)
  const regexOk = !!token && /^[a-f0-9]{64}$/.test(token);
  console.log('[reset-diag] tokenLen=%s regexOk=%s', token ? token.length : 0, regexOk);
  if (!token || !regexOk) {
    console.log('[reset-diag] REJECTED at regex/format check');
    return res.status(400).json({ error: 'Invalid or expired reset link' });
  }
  if (!password || String(password).trim().length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  try {
    const tokenHash = hashResetToken(token);
    const { rows } = await pool.query(
      `SELECT id, user_id, expires_at, used_at
         FROM coexistence.password_reset_tokens
        WHERE token_hash = $1`,
      [tokenHash]
    );
    const record = rows[0];
    // TEMP DIAGNOSTIC (Phase 5A debug — safe metadata only)
    console.log(
      '[reset-diag] hashLen=%s dbRowFound=%s userId=%s usedAtNull=%s',
      tokenHash.length, !!record, record ? record.user_id : null, record ? record.used_at === null : null
    );
    if (!record || record.used_at) {
      console.log('[reset-diag] REJECTED: no matching token_hash in DB, or already used');
      return res.status(400).json({ error: 'Invalid or expired reset link' });
    }
    const expiresInFuture = new Date(record.expires_at) >= new Date();
    console.log('[reset-diag] expiresInFuture=%s expiresAt=%s now=%s', expiresInFuture, record.expires_at, new Date().toISOString());
    if (!expiresInFuture) {
      console.log('[reset-diag] REJECTED: token expired');
      return res.status(400).json({ error: 'This reset link has expired' });
    }

    const hash = await bcrypt.hash(String(password).trim(), 10);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Re-check + mark used atomically inside the transaction so a raced
      // second request against the same token can never both succeed.
      const { rowCount } = await client.query(
        `UPDATE coexistence.password_reset_tokens
            SET used_at = NOW()
          WHERE id = $1 AND used_at IS NULL`,
        [record.id]
      );
      if (rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Invalid or expired reset link' });
      }
      await client.query(
        `UPDATE coexistence.akchat_users SET password = $1, updated_at = NOW() WHERE id = $2`,
        [hash, record.user_id]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[auth] reset-password error:', err.message);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});
module.exports = { router, authMiddleware, ensureTables, COOKIE_NAME, loadUserSession };