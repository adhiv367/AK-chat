const express = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const {
  getAuthUrl,
  exchangeCodeForToken,
  getLongLivedToken,
  getInstagramProfile,
} = require("../../services/instagramOAuthService");

const {
  upsertAccount,
} = require("../../services/instagramAccountService");

const { authMiddleware } = require("../../auth");
const { attachWorkspace } = require("../../middleware/workspaceContext");

const router = express.Router();

// This whole router is mounted PUBLICLY (see index.js — Meta redirects the
// user's raw browser back to /callback with no AKChat session cookie
// attached, since the login cookie is SameSite=strict and this is a
// cross-site top-level redirect). That means /callback can never trust
// req.user/req.workspace.
//
// /start is different: the frontend hits it via a same-origin top-level
// navigation initiated from inside the logged-in app
// (window.location.href = '/api/instagram/oauth/start'), so the session
// cookie *is* present there. /start uses that to resolve the requesting
// workspace, then carries it forward to /callback inside a short-lived,
// signed `state` token — never trusting a workspace id from the client, and
// never relying on a cookie surviving the redirect round-trip to Meta.
const JWT_SECRET = process.env.JWT_SECRET || 'AKchat-dev-secret-change-me';
const STATE_PURPOSE = 'ig_oauth_state';

router.get("/start", authMiddleware, attachWorkspace, (req, res) => {
  try {
    if (!req.workspace) {
      return res.status(409).json({ success: false, error: 'No workspace found for this account. Please contact support.' });
    }
    const state = jwt.sign(
      { purpose: STATE_PURPOSE, wsId: req.workspace.id, nonce: crypto.randomBytes(8).toString('hex') },
      JWT_SECRET,
      { expiresIn: '10m' }
    );
    const url = getAuthUrl(state);
    return res.redirect(url);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code) {
      return res.status(400).json({ success: false, error: "Missing authorization code" });
    }
    if (!state) {
      return res.status(400).json({ success: false, error: "Missing state" });
    }

    let workspaceId;
    try {
      const decoded = jwt.verify(state, JWT_SECRET);
      if (decoded.purpose !== STATE_PURPOSE || !decoded.wsId) throw new Error('bad state payload');
      workspaceId = decoded.wsId;
    } catch (e) {
      return res.status(400).json({ success: false, error: "Invalid or expired state" });
    }

    const shortTokenData = await exchangeCodeForToken(code);
    const longLivedData = await getLongLivedToken(shortTokenData);

    const accessToken = longLivedData.access_token;
    const expiresAt = new Date(Date.now() + (longLivedData.expires_in || 0) * 1000);

    const profile = await getInstagramProfile(accessToken);

    await upsertAccount({
      accountName: profile.username,
      igBusinessId: profile.id,
      pageId: null,
      username: profile.username,
      pageName: null,
      accessToken,
      expiresAt,
      profilePicture: profile.profile_picture_url || null,
      workspaceId,
    });

    return res.redirect("http://localhost:3000/#/ig-accounts");
  } catch (err) {
    console.error(err);
    const status = err.status || 500;
    return res.status(status).json({ success: false, error: err.message });
  }
});

module.exports = { router };
