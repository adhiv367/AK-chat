const { Router } = require('express');
const pool = require('../db');
const { encrypt, decrypt, maskSecret } = require('../util/crypto');
const { requirePermission } = require('../middleware/access');
const { markAccountHealth, classifyMetaError } = require('../services/accountHealth');
const { checkLimit, limitExceededResponse, LIMIT_TYPES } = require('../services/entitlementService');

const router = Router();

// Phase 2D: the permissions system (permissions.js) already defines a
// dedicated 'admin-settings:whatsapp-accounts' page key and every other
// admin-settings tab already gates its mutating routes on
// requirePermission(...) (see categories.js, contactFields.js, etc).
// whatsappAccounts.js was the one holdout still using a bare "is
// authenticated" check left over from before per-user roles/permissions
// existed. Section 11 of the Phase 2D brief asks the Account Center to
// respect the *existing* permission architecture rather than grant
// management rights to anyone who can merely see the account, so mutating
// routes below now use the same requirePermission(page) middleware as the
// rest of Admin Settings. No new permission key was added — this one
// already existed and simply wasn't wired up.
const manageAccounts = requirePermission('admin-settings:whatsapp-accounts');

/**
 * Look up a phone number's human-readable number + verified business name from
 * the Meta Graph API. The simplified connection form no longer asks the user to
 * type these, so we derive them from the Phone Number ID + access token. Also
 * doubles as a credential check. Throws on a non-2xx Meta response.
 */
async function fetchPhoneMeta(phoneNumberId, accessToken) {
  const version = process.env.META_API_VERSION || 'v21.0';
  const apiUrl = `https://graph.facebook.com/${version}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`;
  const resp = await fetch(apiUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  const text = await resp.text();
  let body = {};
  try { body = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!resp.ok) {
    const err = new Error(body?.error?.message || text || `HTTP ${resp.status}`);
    // Attach the same shape accountHealth.classifyMetaError already expects
    // (status + metaError.code) so any caller — not just the send
    // queue/templates routes — can classify a Meta failure without a second
    // parsing implementation.
    err.status = resp.status;
    err.metaError = body?.error || null;
    throw err;
  }
  return body; // { display_phone_number, verified_name, id }
}

// Derive a coarse, UI-facing connection state purely from columns that
// already exist on the row — never invented. See Phase 2D brief section 6:
// only surface health the backend can actually determine.
//   - 'disconnected'            : is_active = false (safe/reversible state
//                                  from the Disconnect action, see below)
//   - 'action_required'         : last known health is an auth failure
//                                  (expired/invalid token) — matches what
//                                  accountHealth.classifyMetaError already
//                                  reports as 'invalid_token'
//   - 'rate_limited'/'unknown_error' : passthrough of the same health values
//   - 'configuration_required'  : manual (non-embedded-signup) account with
//                                  no webhook verify token set yet, so Meta
//                                  webhook delivery cannot be verified
//   - 'healthy'                 : most recent send/template/refresh attempt
//                                  against Meta succeeded
//   - 'unverified'               : active, configured, but no successful or
//                                  failed Meta call has been recorded yet
function deriveConnectionState(row) {
  if (!row.is_active) return 'disconnected';
  const health = row.health_status || 'unknown';
  if (health === 'invalid_token') return 'action_required';
  if (health === 'rate_limited') return 'rate_limited';
  if (health === 'unknown_error') return 'unknown_error';
  if (health === 'healthy') return 'healthy';
  const hasVerifyToken = !!(row.verify_token_encrypted && decrypt(row.verify_token_encrypted));
  if (row.connected_via === 'manual' && !hasVerifyToken) return 'configuration_required';
  return 'unverified';
}

function publicShape(row, { reveal = false } = {}) {
  if (!row) return null;
  const token = decrypt(row.access_token_encrypted);
  return {
    id: row.id,
    displayName: row.display_name,
    displayPhoneNumber: row.display_phone_number,
    phoneNumberId: row.phone_number_id,
    wabaId: row.waba_id,
    businessId: row.business_id || null,
    metaAppId: row.meta_app_id,
    accessTokenMasked: maskSecret(token),
    accessToken: reveal ? token : undefined,
    verifyToken: row.verify_token_encrypted ? decrypt(row.verify_token_encrypted) : '',
    isDefault: row.is_default,
    isActive: row.is_active,
    connectedVia: row.connected_via || 'manual',
    healthStatus: row.health_status || 'unknown',
    connectionState: deriveConnectionState(row),
    lastErrorAt: row.last_error_at,
    lastErrorMessage: row.last_error_message,
    lastSuccessAt: row.last_success_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Resolve the current request's workspace id. Every customer-facing route in
// this file must scope by this — never trust a workspace_id from the client.
// Returns null if the authenticated user has no workspace yet (shouldn't
// happen post-Phase-1-backfill, but fail closed rather than leak).
function currentWorkspaceId(req) {
  return req.workspace?.id ?? null;
}

// List accounts for the current workspace only (any authenticated user —
// needed for template/broadcast pickers). A workspace must never see another
// workspace's WhatsApp accounts.
router.get('/whatsapp-accounts', async (req, res) => {
  try {
    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) return res.json([]);
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.whatsapp_accounts
        WHERE workspace_id = $1
          AND ($2::boolean IS NULL OR is_active = $2)
        ORDER BY is_default DESC, display_name ASC`,
      [workspaceId, req.query.activeOnly === 'true' ? true : null]
    );
    res.json(rows.map(r => publicShape(r)));
  } catch (err) {
    console.error('[whatsapp-accounts] list error:', err.message);
    res.status(500).json({ error: 'Failed to list WhatsApp Business accounts' });
  }
});

// Resolve account by phone (must be registered before :id so it doesn't match :id=by-phone)
// Scoped to the current workspace when one is known — a workspace must never
// be able to probe another workspace's phone numbers through this endpoint.
router.get('/whatsapp-accounts/by-phone/:phone', async (req, res) => {
  try {
    const acc = await getAccountByPhoneNumber(req.params.phone, currentWorkspaceId(req));
    if (!acc) return res.status(404).json({ error: 'No WhatsApp Business account registered for this phone' });
    res.json({
      id: acc.id,
      displayName: acc.displayName,
      displayPhoneNumber: acc.displayPhoneNumber,
      phoneNumberId: acc.phoneNumberId,
      wabaId: acc.wabaId,
      isActive: acc.isActive,
    });
  } catch (err) {
    console.error('[whatsapp-accounts] by-phone error:', err.message);
    res.status(500).json({ error: 'Failed to resolve account' });
  }
});

// Get one — admins see the decrypted token (?reveal=1). Scoped to workspace.
router.get('/whatsapp-accounts/:id', manageAccounts, async (req, res) => {
  try {
    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) return res.status(404).json({ error: 'Not found' });
    const { rows } = await pool.query(
      'SELECT * FROM coexistence.whatsapp_accounts WHERE id = $1 AND workspace_id = $2',
      [req.params.id, workspaceId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(publicShape(rows[0], { reveal: req.query.reveal === '1' }));
  } catch (err) {
    console.error('[whatsapp-accounts] get error:', err.message);
    res.status(500).json({ error: 'Failed to fetch WhatsApp Business account' });
  }
});

router.post('/whatsapp-accounts', manageAccounts, async (req, res) => {
  try {
    const { phoneNumberId, wabaId, accessToken, verifyToken, metaAppId } = req.body || {};
    if (!phoneNumberId || !wabaId || !accessToken) {
      return res.status(400).json({ error: 'Phone Number ID, WhatsApp Business Account ID and Permanent Access Token are required' });
    }

    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) {
      return res.status(409).json({ error: 'No workspace found for this account. Please contact support.' });
    }

    // Phase 5B — server-side WhatsApp-account entitlement check, before any
    // Meta lookup or DB write. Uses the centralized entitlement service —
    // NOT the isFirstForWorkspace count query below, which exists for a
    // different purpose (deciding is_default) and is unrelated to limits.
    const acctCheck = await checkLimit(workspaceId, LIMIT_TYPES.WHATSAPP_ACCOUNTS);
    if (!acctCheck.allowed) {
      return res.status(403).json(limitExceededResponse(acctCheck));
    }

    // Multi-account system: a workspace may connect several WhatsApp Business
    // accounts. What must still never happen is the SAME Phone Number ID
    // being registered twice — that's enforced by the DB unique constraint
    // below (23505), not by an account-count cap.
    const { rows: existingInWorkspace } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM coexistence.whatsapp_accounts WHERE workspace_id = $1',
      [workspaceId]
    );
    const isFirstForWorkspace = existingInWorkspace[0].n === 0;

    // Best-effort: resolve the human-readable number + verified business name
    // from Meta so chat threading and display still work without the user
    // typing them. Saving proceeds even if the lookup fails (logged).
    let displayName = `WhatsApp ${wabaId.trim()}`;
    let displayPhoneNumber = '';
    try {
      const meta = await fetchPhoneMeta(phoneNumberId.trim(), accessToken.trim());
      if (meta.verified_name) displayName = meta.verified_name;
      if (meta.display_phone_number) displayPhoneNumber = String(meta.display_phone_number).replace(/\D/g, '');
    } catch (e) {
      console.warn('[whatsapp-accounts] Meta phone lookup failed (saving anyway):', e.message);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The first account connected to a workspace becomes its default;
      // later accounts in the same workspace are added as non-default.
      const { rows } = await client.query(
        `INSERT INTO coexistence.whatsapp_accounts
          (workspace_id, display_name, display_phone_number, phone_number_id, waba_id, meta_app_id,
           access_token_encrypted, verify_token_encrypted, is_default, is_active, connected_via)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,'manual')
         RETURNING *`,
        [
          workspaceId, displayName, displayPhoneNumber, phoneNumberId.trim(), wabaId.trim(),
          metaAppId?.trim() || null,
          encrypt(accessToken.trim()), encrypt((verifyToken || '').trim()),
          isFirstForWorkspace,
        ]
      );
      await client.query('COMMIT');
      res.status(201).json(publicShape(rows[0]));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This Phone Number ID is already connected' });
    console.error('[whatsapp-accounts] create error:', err.message);
    res.status(500).json({ error: 'Failed to create WhatsApp Business account' });
  }
});

router.put('/whatsapp-accounts/:id', manageAccounts, async (req, res) => {
  try {
    const { phoneNumberId, wabaId, accessToken, verifyToken, metaAppId, isActive } = req.body || {};
    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) return res.status(404).json({ error: 'Not found' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: existingRows } = await client.query(
        'SELECT * FROM coexistence.whatsapp_accounts WHERE id = $1 AND workspace_id = $2',
        [req.params.id, workspaceId]
      );
      if (existingRows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Not found' });
      }
      const ex = existingRows[0];

      const newPhoneId = phoneNumberId != null ? phoneNumberId.trim() : ex.phone_number_id;
      const newWaba = wabaId != null ? wabaId.trim() : ex.waba_id;
      const tokenChanged = !!(accessToken && accessToken.trim());
      const effectiveToken = tokenChanged ? accessToken.trim() : decrypt(ex.access_token_encrypted);

      // Re-derive the display fields from Meta when the number or token changes.
      let displayName = ex.display_name;
      let displayPhoneNumber = ex.display_phone_number;
      if ((phoneNumberId != null && newPhoneId !== ex.phone_number_id) || tokenChanged) {
        try {
          const meta = await fetchPhoneMeta(newPhoneId, effectiveToken);
          if (meta.verified_name) displayName = meta.verified_name;
          if (meta.display_phone_number) displayPhoneNumber = String(meta.display_phone_number).replace(/\D/g, '');
        } catch (e) {
          console.warn('[whatsapp-accounts] Meta phone lookup failed on update (keeping previous):', e.message);
        }
      }

      const sets = ['updated_at = NOW()'];
      const params = [];
      let i = 1;
      const push = (col, val) => { sets.push(`${col} = $${i++}`); params.push(val); };
      push('display_name', displayName);
      push('display_phone_number', displayPhoneNumber);
      push('phone_number_id', newPhoneId);
      push('waba_id', newWaba);
      if (metaAppId !== undefined) push('meta_app_id', metaAppId?.trim() || null);
      if (tokenChanged) {
        push('access_token_encrypted', encrypt(effectiveToken));
        // Reset health on token update so the UI banner clears.
        push('health_status', 'unknown');
        push('last_error_message', null);
      }
      if (verifyToken !== undefined) push('verify_token_encrypted', encrypt((verifyToken || '').trim()));
      if (isActive != null) push('is_active', !!isActive);
      params.push(req.params.id, workspaceId);
      const { rows } = await client.query(
        `UPDATE coexistence.whatsapp_accounts SET ${sets.join(', ')} WHERE id = $${i} AND workspace_id = $${i + 1} RETURNING *`,
        params
      );
      await client.query('COMMIT');
      res.json(publicShape(rows[0]));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This Phone Number ID is already connected' });
    console.error('[whatsapp-accounts] update error:', err.message);
    res.status(500).json({ error: 'Failed to update WhatsApp Business account' });
  }
});

// Active health check ("Refresh status" in the Account Center). Reuses the
// same fetchPhoneMeta credential check the create/update routes already use
// and the same markAccountHealth/classifyMetaError writer the send
// queue/templates routes use — no second health system. This is the one
// genuinely new capability Phase 2D needs: today health is only ever
// updated as a side-effect of a send/template call, so a freshly-connected
// or long-idle account can sit at "unknown" indefinitely with no way for
// the user to ask "is this still working?" on demand.
router.post('/whatsapp-accounts/:id/refresh-status', manageAccounts, async (req, res) => {
  try {
    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) return res.status(404).json({ error: 'Not found' });
    const { rows } = await pool.query(
      'SELECT * FROM coexistence.whatsapp_accounts WHERE id = $1 AND workspace_id = $2',
      [req.params.id, workspaceId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const account = rows[0];

    try {
      await fetchPhoneMeta(account.phone_number_id, decrypt(account.access_token_encrypted));
      await markAccountHealth(account.id, 'healthy');
    } catch (err) {
      await markAccountHealth(account.id, classifyMetaError(err), err.message);
    }

    const { rows: fresh } = await pool.query(
      'SELECT * FROM coexistence.whatsapp_accounts WHERE id = $1',
      [account.id]
    );
    res.json(publicShape(fresh[0]));
  } catch (err) {
    console.error('[whatsapp-accounts] refresh-status error:', err.message);
    res.status(500).json({ error: 'Failed to refresh account status' });
  }
});

// Safe, reversible "Disconnect" — flips is_active to FALSE instead of
// deleting the row. Section 8/12 of the Phase 2D brief: destructive delete
// is not safe here because webhook routing, chat_history, broadcasts,
// templates, and user_wa_assignments all key off this account continuing to
// exist. Existing sends already treat is_active as the on/off switch
// (see getAccountsForWorkspace/getAccountByPhoneNumber callers), and the
// hard-delete endpoint below still exists for the already-guarded
// "remove a genuinely unwanted non-default account" case.
router.post('/whatsapp-accounts/:id/disconnect', manageAccounts, async (req, res) => {
  try {
    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) return res.status(404).json({ error: 'Not found' });
    const { rows } = await pool.query(
      `UPDATE coexistence.whatsapp_accounts
          SET is_active = FALSE, updated_at = NOW()
        WHERE id = $1 AND workspace_id = $2
        RETURNING *`,
      [req.params.id, workspaceId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(publicShape(rows[0]));
  } catch (err) {
    console.error('[whatsapp-accounts] disconnect error:', err.message);
    res.status(500).json({ error: 'Failed to disconnect account' });
  }
});

// Reverses Disconnect. Kept separate from PUT (which also accepts isActive)
// so the Account Center's Reconnect/Reactivate action doesn't need to also
// carry the full edit-credentials payload.
router.post('/whatsapp-accounts/:id/reactivate', manageAccounts, async (req, res) => {
  try {
    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) return res.status(404).json({ error: 'Not found' });
    const { rows } = await pool.query(
      `UPDATE coexistence.whatsapp_accounts
          SET is_active = TRUE, updated_at = NOW()
        WHERE id = $1 AND workspace_id = $2
        RETURNING *`,
      [req.params.id, workspaceId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(publicShape(rows[0]));
  } catch (err) {
    console.error('[whatsapp-accounts] reactivate error:', err.message);
    res.status(500).json({ error: 'Failed to reactivate account' });
  }
});

// Phase 4H STEP 3 — explicit "set as workspace default" action. Previously
// is_default could only change implicitly (first account created, or
// automatic promotion when the default is deleted — see below). This is the
// one new capability Phase 4H needs on top of the existing column: an
// admin choosing a different already-connected account as the default. The
// account must belong to the caller's active workspace (never trusts the
// :id alone) and must still be active — selecting a disconnected account as
// default would silently break sends that resolve "the workspace default"
// without any obvious errors elsewhere.
router.post('/whatsapp-accounts/:id/set-default', manageAccounts, async (req, res) => {
  try {
    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) return res.status(404).json({ error: 'Not found' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: target } = await client.query(
        'SELECT id, is_active, is_default FROM coexistence.whatsapp_accounts WHERE id = $1 AND workspace_id = $2',
        [req.params.id, workspaceId]
      );
      if (target.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Not found' });
      }
      if (!target[0].is_active) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Cannot set a disconnected account as the workspace default. Reactivate it first.' });
      }
      if (!target[0].is_default) {
        await client.query(
          'UPDATE coexistence.whatsapp_accounts SET is_default = FALSE, updated_at = NOW() WHERE workspace_id = $1 AND is_default = TRUE',
          [workspaceId]
        );
        await client.query(
          'UPDATE coexistence.whatsapp_accounts SET is_default = TRUE, updated_at = NOW() WHERE id = $1 AND workspace_id = $2',
          [req.params.id, workspaceId]
        );
      }
      const { rows } = await client.query(
        'SELECT * FROM coexistence.whatsapp_accounts WHERE id = $1 AND workspace_id = $2',
        [req.params.id, workspaceId]
      );
      await client.query('COMMIT');
      res.json(publicShape(rows[0]));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[whatsapp-accounts] set-default error:', err.message);
    res.status(500).json({ error: 'Failed to set default account' });
  }
});

router.delete('/whatsapp-accounts/:id', manageAccounts, async (req, res) => {
  try {
    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) return res.status(404).json({ error: 'Not found' });

    // Confirm the account belongs to this workspace before touching it.
    const { rows: target } = await pool.query(
      'SELECT id, is_default FROM coexistence.whatsapp_accounts WHERE id = $1 AND workspace_id = $2',
      [req.params.id, workspaceId]
    );
    if (target.length === 0) return res.status(404).json({ error: 'Not found' });

    // Never delete a workspace's last remaining WhatsApp Business account —
    // it would stop all sends for that workspace. To switch numbers, edit the
    // existing account instead. (Other workspaces' account counts are
    // irrelevant here — this is scoped per-workspace, not global.)
    const { rows: cnt } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM coexistence.whatsapp_accounts WHERE workspace_id = $1',
      [workspaceId]
    );
    if (cnt[0].n <= 1) {
      return res.status(409).json({ error: 'Cannot delete the only WhatsApp Business account for this workspace. Edit it to change the connected number.' });
    }

    // Disconnecting production data (message history, webhooks already
    // pointed at this Phone Number ID) is destructive — this phase only
    // implements deletion of accounts that are safe to remove (not the sole
    // account). See Phase 2C notes: full safe-disconnect handling (detaching
    // vs. hard-deleting history) is left for a later phase rather than
    // risking existing chat_history/broadcast/template data here.
    const wasDefault = target[0].is_default;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(
        'DELETE FROM coexistence.whatsapp_accounts WHERE id = $1 AND workspace_id = $2',
        [req.params.id, workspaceId]
      );
      if (rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Not found' });
      }
      // If the deleted account was the workspace's default, promote another
      // remaining account so the workspace always has exactly one default.
      if (wasDefault) {
        await client.query(
          `UPDATE coexistence.whatsapp_accounts SET is_default = TRUE
             WHERE id = (
               SELECT id FROM coexistence.whatsapp_accounts
                WHERE workspace_id = $1
                ORDER BY id ASC LIMIT 1
             )`,
          [workspaceId]
        );
      }
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[whatsapp-accounts] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete WhatsApp Business account' });
  }
});

// Normalise phone numbers for matching: strip everything but digits.
function normalizePhone(p) {
  return String(p || '').replace(/\D/g, '');
}

function rowToCreds(r) {
  if (!r) return null;
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    displayName: r.display_name,
    displayPhoneNumber: r.display_phone_number,
    phoneNumberId: r.phone_number_id,
    wabaId: r.waba_id,
    accessToken: decrypt(r.access_token_encrypted),
    isActive: r.is_active,
  };
}

/**
 * @param {number|string} accountId
 * @param {number|string|null} [workspaceId] - when provided, returns null if
 *   the account exists but belongs to a different workspace, so a caller can
 *   never accidentally send/read through another workspace's account by id.
 */
async function getAccountWithToken(accountId, workspaceId = null) {
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.whatsapp_accounts
      WHERE id = $1 AND ($2::bigint IS NULL OR workspace_id = $2)`,
    [accountId, workspaceId]
  );
  return rowToCreds(rows[0]);
}

/**
 * Return the default connected account, optionally scoped to a single
 * workspace. Historically this product supported exactly one account total;
 * with multi-account support this is now used as a fallback (e.g. legacy
 * callers, background jobs) when no explicit account/phone was given —
 * NOT as the "the" account. Prefer passing accountId/fromPhoneNumber (and a
 * workspaceId) wherever the caller has one.
 *
 * @param {number|string|null} [workspaceId] - when provided, only considers
 *   accounts belonging to that workspace. When omitted, falls back to the
 *   oldest/default account system-wide (legacy behaviour, used only by
 *   background jobs that predate workspaces — see Phase 2C known limitations).
 */
async function getSingleAccount(workspaceId = null) {
  const { rows } = workspaceId
    ? await pool.query(
        `SELECT * FROM coexistence.whatsapp_accounts
          WHERE workspace_id = $1
          ORDER BY is_default DESC, id ASC LIMIT 1`,
        [workspaceId]
      )
    : await pool.query(
        'SELECT * FROM coexistence.whatsapp_accounts ORDER BY is_default DESC, id ASC LIMIT 1'
      );
  return rowToCreds(rows[0]);
}

/**
 * Return every account belonging to a workspace (default first). Used for
 * dashboard aggregation and anywhere that must consider "all of this
 * workspace's numbers" rather than a single one.
 */
async function getAccountsForWorkspace(workspaceId) {
  if (!workspaceId) return [];
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.whatsapp_accounts
      WHERE workspace_id = $1
      ORDER BY is_default DESC, id ASC`,
    [workspaceId]
  );
  return rows.map(rowToCreds);
}

/**
 * Resolve the WhatsApp account that owns the given phone number. Used by
 * broadcasts and automation message nodes to derive credentials from a
 * "from" phone number, and by the webhook verify-token lookup. Matches by
 * digits-only normalisation so users can register the number as
 * "+919342245724" or "919342245724". Phone Number IDs are globally unique
 * (Meta-assigned), so no workspace scoping is required for correctness —
 * but when a workspaceId is supplied (customer-facing routes), results
 * outside that workspace are treated as not found, so one workspace can
 * never probe another's numbers through this lookup.
 */
async function getAccountByPhoneNumber(phoneOrId, workspaceId = null) {
  const norm = normalizePhone(phoneOrId);
  if (!norm) return null;
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.whatsapp_accounts
       WHERE (regexp_replace(display_phone_number, '\\D', '', 'g') = $1
          OR phone_number_id = $2)
         AND ($3::bigint IS NULL OR workspace_id = $3)
       LIMIT 1`,
    [norm, String(phoneOrId), workspaceId]
  );
  return rowToCreds(rows[0]);
}

module.exports = {
  router,
  getAccountWithToken,
  getAccountByPhoneNumber,
  getSingleAccount,
  getAccountsForWorkspace,
  fetchPhoneMeta,
  publicShape,
};