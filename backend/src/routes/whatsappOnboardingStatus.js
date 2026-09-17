// Phase 4C — WhatsApp onboarding status (read-only).
//
// Thin wrapper around the EXISTING workspace-scoped WhatsApp account lookup
// (getAccountsForWorkspace / publicShape from routes/whatsappAccounts.js).
// This file adds no new WhatsApp connection logic, no new Meta calls, and
// no new database columns — it only shapes the already-existing per-account
// data into a single summary the onboarding wizard can poll after a
// connect attempt (manual or Embedded Signup, both unchanged elsewhere).
//
// Workspace scoping: identical rule to every other customer-facing route in
// whatsappAccounts.js — the workspace id is taken ONLY from req.workspace,
// which attachWorkspace (middleware/workspaceContext.js) resolves
// server-side from the authenticated session's active membership. A
// workspace id is never accepted from the client for this purpose.

const { Router } = require('express');
const { publicShape } = require('./whatsappAccounts');
const pool = require('../db');

const router = Router();

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// GET /whatsapp-accounts/onboarding-status
//
// Returns:
//   {
//     hasAccount: boolean,        // workspace has >=1 active WhatsApp account
//     defaultAccount: {...} | null, // publicShape() of the default/first account, or null
//     connectionState: string     // same connectionState publicShape() already derives;
//                                  // 'none' when there is no account yet
//   }
router.get('/whatsapp-accounts/onboarding-status', requireAuth, async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) {
      return res.json({ hasAccount: false, defaultAccount: null, connectionState: 'none' });
    }

    // getAccountsForWorkspace/rowToCreds (whatsappAccounts.js) already
    // decrypts the token for internal callers, which this endpoint doesn't
    // need to expose. Re-query with publicShape() directly (same query
    // whatsappAccounts.js's GET /whatsapp-accounts list route uses) so the
    // response here matches exactly what the Admin Settings list already
    // returns, minus nothing extra invented.
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.whatsapp_accounts
        WHERE workspace_id = $1 AND is_active = TRUE
        ORDER BY is_default DESC, id ASC
        LIMIT 1`,
      [workspaceId]
    );

    if (rows.length === 0) {
      return res.json({ hasAccount: false, defaultAccount: null, connectionState: 'none' });
    }

    const shaped = publicShape(rows[0]);
    res.json({
      hasAccount: true,
      defaultAccount: shaped,
      connectionState: shaped.connectionState,
    });
  } catch (err) {
    console.error('[whatsapp-onboarding-status] error:', err.message);
    res.status(500).json({ error: 'Failed to load WhatsApp connection status' });
  }
});

module.exports = { router };



