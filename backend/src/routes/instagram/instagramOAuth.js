const express = require("express");
const crypto = require("crypto");

const {
  getAuthUrl,
  exchangeCodeForToken,
  getLongLivedToken,
  getInstagramProfile,
} = require("../../services/instagramOAuthService");

const {
  upsertAccount,
} = require("../../services/instagramAccountService");

const router = express.Router();

router.get("/start", (req, res) => {
  try {
    const state = crypto.randomBytes(16).toString("hex");
    const url = getAuthUrl(state);
    return res.redirect(url);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/callback", async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res.status(400).json({ success: false, error: "Missing authorization code" });
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
    });

    return res.redirect("http://localhost:3000/#/ig-accounts");
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = { router };
