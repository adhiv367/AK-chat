// Phase 2B — Meta WhatsApp Embedded Signup: connection endpoints.
//
//   GET  /whatsapp-accounts/embedded-signup/config    — non-secret config
//        the frontend needs to launch Meta's Embedded Signup JS SDK flow.
//   POST /whatsapp-accounts/embedded-signup/complete  — server-side
//        completion: exchanges the code, validates the WABA/phone against
//        Meta, and stores the account against the CALLER'S workspace.
//
// This is additive on top of the existing whatsapp_accounts table/routes
// (routes/whatsappAccounts.js) — it does not change the manual
// paste-credentials form, its single-account cap, or any existing row.
// It reuses: crypto (encrypt), the db pool, getWorkspaceForUser (Phase 1),
// and fetchPhoneMeta/publicShape from routes/whatsappAccounts.js so the
// resulting account looks identical to a manually-added one everywhere
// else in the app (dashboard, templates, broadcasts, health checks).

const { Router } = require('express');
const pool = require('../db');
const { encrypt } = require('../util/crypto');
const { getWorkspaceForUser } = require('../middleware/workspaceContext'); // fallback only, see below
const { fetchPhoneMeta, publicShape } = require('./whatsappAccounts');
const {
  EmbeddedSignupError,
  assertConfigured,
  exchangeCodeForToken,
  fetchWabaInfo,
  verifyAndFetchPhoneNumber,
  GRAPH_VERSION,
} = require('../services/whatsappEmbeddedSignupService');
const { checkLimit, limitExceededResponse, LIMIT_TYPES } = require('../services/entitlementService');

const router = Router();

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Non-secret — safe to send to the browser. The JS SDK needs appId +
// configId to open the Embedded Signup dialog; it never sees the App Secret.
router.get('/whatsapp-accounts/embedded-signup/config', requireAuth, (req, res) => {
  try {
    assertConfigured();
    res.json({
      appId: process.env.META_APP_ID,
      configId: process.env.META_WHATSAPP_CONFIG_ID,
      graphApiVersion: GRAPH_VERSION,
    });
  } catch (err) {
    if (err instanceof EmbeddedSignupError) {
      return res.status(501).json({ error: err.message, cause: err.cause });
    }
    console.error('[embedded-signup] config error:', err.message);
    res.status(500).json({ error: 'Failed to load Embedded Signup configuration' });
  }
});

router.post('/whatsapp-accounts/embedded-signup/complete', requireAuth, async (req, res) => {
  const { code, wabaId, phoneNumberId } = req.body || {};
  try {
    assertConfigured();

    if (!code || !wabaId || !phoneNumberId) {
      return res.status(400).json({
        error: 'Missing authorization data from Meta. Please try connecting again.',
      });
    }

    // Section 7/14: never trust a workspace id from the browser. The only
    // workspace this account can join is the caller's currently ACTIVE
    // workspace (req.workspace, resolved server-side by attachWorkspace from
    // the session's validated active-workspace cookie/membership) — never
    // their oldest membership. A user who belongs to more than one workspace
    // and has switched to workspace B must have the number attach to B, not
    // silently fall back to A. getWorkspaceForUser() is kept only as a
    // last-resort fallback for the (should-be-impossible) case where
    // attachWorkspace didn't run.
    const workspace = req.workspace || (await getWorkspaceForUser(req.user.id));
    if (!workspace) {
      return res.status(403).json({ error: 'No workspace found for your account.' });
    }

    // 1. Exchange the code server-side. Token is never sent back to the client.
    const accessToken = await exchangeCodeForToken(code);

    // 2. Confirm the WABA is real and this token can see it.
    const waba = await fetchWabaInfo(wabaId, accessToken);

    // 3. Confirm the phone number genuinely belongs to that WABA under this
    //    token — never trust the frontend's (wabaId, phoneNumberId) pairing
    //    on its own.
    await verifyAndFetchPhoneNumber(wabaId, phoneNumberId, accessToken);

    // 4. Reuse the same lookup the manual form uses, so display fields are
    //    derived identically either way.
    const meta = await fetchPhoneMeta(phoneNumberId, accessToken);
    const displayName = meta.verified_name || waba.name || `WhatsApp ${phoneNumberId}`;
    const displayPhoneNumber = meta.display_phone_number
      ? String(meta.display_phone_number).replace(/\D/g, '')
      : '';

    // 5. Duplicate handling (section 9): this Phone Number ID may already be
    //    connected — reconnecting a token to the same workspace's existing
    //    account is a legitimate re-auth; connecting to a DIFFERENT
    //    workspace's number is rejected rather than silently reassigned.
    const { rows: existingRows } = await pool.query(
      `SELECT id, workspace_id FROM coexistence.whatsapp_accounts WHERE phone_number_id = $1`,
      [phoneNumberId]
    );

    let savedRow;
    if (existingRows.length > 0) {
      const existing = existingRows[0];
      if (existing.workspace_id != null && String(existing.workspace_id) !== String(workspace.id)) {
        return res.status(409).json({
          error: 'This WhatsApp number is already connected to a different workspace.',
        });
      }
      const { rows } = await pool.query(
        `UPDATE coexistence.whatsapp_accounts
            SET display_name = $1,
                display_phone_number = $2,
                waba_id = $3,
                business_id = $4,
                access_token_encrypted = $5,
                connected_via = 'embedded_signup',
                workspace_id = $6,
                health_status = 'unknown',
                last_error_message = NULL,
                is_active = TRUE,
                updated_at = NOW()
          WHERE id = $7
          RETURNING *`,
        [displayName, displayPhoneNumber, wabaId, waba.businessId, encrypt(accessToken), workspace.id, existing.id]
      );
      savedRow = rows[0];
    } else {
      // Phase 5B — server-side WhatsApp-account entitlement check. Only on
      // this branch: reconnecting an existing account to the same workspace
      // (the `if` branch above) is not a new account and must not be
      // blocked by the limit, but genuinely connecting a NEW number is.
      const acctCheck = await checkLimit(workspace.id, LIMIT_TYPES.WHATSAPP_ACCOUNTS);
      if (!acctCheck.allowed) {
        return res.status(403).json(limitExceededResponse(acctCheck));
      }

      const { rows } = await pool.query(
        `INSERT INTO coexistence.whatsapp_accounts
           (display_name, display_phone_number, phone_number_id, waba_id, business_id,
            access_token_encrypted, verify_token_encrypted, connected_via,
            workspace_id, is_default, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'embedded_signup',$8,FALSE,TRUE)
         RETURNING *`,
        [
          displayName, displayPhoneNumber, phoneNumberId, wabaId, waba.businessId,
          encrypt(accessToken), encrypt(''), // no manual verify token for embedded-signup accounts;
                                              // all numbers share the one app-level webhook callback.
          workspace.id,
        ]
      );
      savedRow = rows[0];
    }

    res.status(201).json(publicShape(savedRow));
  } catch (err) {
    if (err instanceof EmbeddedSignupError) {
      const status = err.cause === 'not_configured' ? 501 : 400;
      return res.status(status).json({ error: err.message, cause: err.cause });
    }
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This WhatsApp number is already connected.' });
    }
    // Never log the code or any token — err.message from EmbeddedSignupError
    // is already scrubbed; anything else is an unexpected internal error.
    console.error('[embedded-signup] complete error:', err.message);
    res.status(500).json({ error: 'Failed to complete WhatsApp connection. Please try again.' });
  }
});
module.exports = { router };