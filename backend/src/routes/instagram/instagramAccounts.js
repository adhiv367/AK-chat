const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const oauth = require('../../services/instagramOAuthService');
const accountService = require('../../services/instagramAccountService');
const webhookService = require('../../services/instagramWebhookService');

// req.workspace is attached by attachWorkspace (mounted ahead of this router
// in index.js, after authMiddleware) — never trust a workspace id supplied
// by the client for any route below.
function currentWorkspaceId(req) {
  return req.workspace?.id ?? null;
}

const pendingStates = new Map(); // state -> { timestamp, workspaceId }, swept below

function newState(workspaceId) {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, { timestamp: Date.now(), workspaceId });
  return state;
}
function consumeState(state) {
  const entry = pendingStates.get(state);
  pendingStates.delete(state);
  if (!entry) return null;
  if (Date.now() - entry.timestamp >= 10 * 60 * 1000) return null;
  return entry.workspaceId;
}

// NOTE: these two routes ('/instagram/oauth/start' and '/instagram/oauth/callback')
// are currently shadowed at runtime by the dedicated, publicly-mounted
// routes/instagram/instagramOAuth.js (see index.js — that router is
// registered on '/api/instagram/oauth' *before* this one, and Express takes
// the first middleware that responds). They're kept working and
// workspace-scoped anyway rather than left as a dead, unscoped path that
// could silently start creating workspace-less accounts if the mount order
// ever changes.
router.get('/instagram/oauth/start', (req, res) => {
  const workspaceId = currentWorkspaceId(req);
  if (!workspaceId) {
    return res.status(409).json({ error: 'No workspace found for this account. Please contact support.' });
  }
  res.redirect(oauth.getAuthUrl(newState(workspaceId)));
});

router.get('/instagram/oauth/callback', async (req, res) => {
  const frontendBase = process.env.CORS_ORIGIN || 'http://localhost:5173';
  try {
    const { code, state, error } = req.query;
    if (error) return res.redirect(`${frontendBase}/#/ig-accounts?error=${encodeURIComponent(error)}`);
    const workspaceId = consumeState(state);
    if (!workspaceId) return res.redirect(`${frontendBase}/#/ig-accounts?error=invalid_state`);

    const shortToken = await oauth.exchangeCodeForToken(code);
    const long = await oauth.getLongLivedToken(shortToken);
    const pages = await oauth.getPages(long.access_token);
    const linked = pages.filter(p => p.instagram_business_account);

    if (linked.length === 0) {
      return res.redirect(`${frontendBase}/#/ig-accounts?error=no_ig_linked`);
    }

    for (const page of linked) {
      const igId = page.instagram_business_account.id;
      const profile = await oauth.getInstagramProfile(igId, page.access_token);
      const expiresAt = new Date(Date.now() + (long.expires_in || 5184000) * 1000);

      const account = await accountService.upsertAccount({
        accountName: profile.name || page.name,
        igBusinessId: igId,
        pageId: page.id,
        username: profile.username,
        pageName: page.name,
        accessToken: page.access_token,
        expiresAt,
        profilePicture: profile.profile_picture_url,
        workspaceId,
      });

      try {
        await webhookService.subscribePage(page.id, page.access_token);
      } catch (e) {
        console.error('[instagram oauth] webhook subscribe failed:', e.message);
        await accountService.setStatus(account.id, 'webhook_error');
      }
    }

    res.redirect(`${frontendBase}/#/ig-accounts?connected=1`);
  } catch (err) {
    console.error('[instagram oauth] callback error:', err.message);
    res.redirect(`${frontendBase}/#/ig-accounts?error=${encodeURIComponent(err.message)}`);
  }
});

// List accounts for the current workspace only.
router.get('/instagram/accounts', async (req, res) => {
  try {
    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) return res.json([]);
    res.json(await accountService.listAccounts(workspaceId));
  } catch (err) {
    console.error('[instagram/accounts] list error:', err.message);
    res.status(500).json({ error: 'Failed to list Instagram accounts' });
  }
});

router.post('/instagram/accounts/:id/disconnect', async (req, res) => {
  try {
    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) return res.status(404).json({ error: 'Not found' });
    const acc = await accountService.getAccountRow(req.params.id, workspaceId);
    if (!acc) return res.status(404).json({ error: 'Not found' });
    const { decrypt } = require('../../util/crypto');
    await webhookService.unsubscribePage(acc.facebook_page_id, decrypt(acc.access_token_encrypted));
    await accountService.disconnectAccount(req.params.id, workspaceId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[instagram/accounts] disconnect error:', err.message);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

router.post('/instagram/accounts/:id/refresh-token', async (req, res) => {
  try {
    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) return res.status(404).json({ error: 'Not found' });
    const acc = await accountService.getAccountRow(req.params.id, workspaceId);
    if (!acc) return res.status(404).json({ error: 'Not found' });
    const { refreshIfNeeded } = require('../../services/instagramTokenService');
    await refreshIfNeeded(req.params.id);
    res.json(await accountService.publicShape(await accountService.getAccountRow(req.params.id, workspaceId)));
  } catch (err) {
    console.error('[instagram/accounts] refresh error:', err.message);
    res.status(500).json({ error: 'Failed to refresh token' });
  }
});

router.delete('/instagram/accounts/:id', async (req, res) => {
  try {
    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) return res.status(404).json({ error: 'Not found' });
    const ok = await accountService.deleteAccount(req.params.id, workspaceId);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[instagram/accounts] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

module.exports = { router };
