// Uses "Instagram API with Instagram Login" (not Facebook Login for Business).
// Auth/token calls go to instagram.com / api.instagram.com / graph.instagram.com,
// NOT facebook.com / graph.facebook.com.

const GRAPH_VERSION = process.env.META_API_VERSION || 'v21.0';

function getAuthUrl(state) {
  const scopes = [
    'instagram_business_basic',
    'instagram_business_manage_messages',
    'instagram_business_manage_comments',
  ].join(',');

  const redirect = process.env.META_IG_REDIRECT_URI;

  return `https://www.instagram.com/oauth/authorize?client_id=${process.env.META_IG_APP_ID}&redirect_uri=${encodeURIComponent(redirect)}&scope=${scopes}&state=${state}&response_type=code`;
}

async function exchangeCodeForToken(code) {
  const url = 'https://api.instagram.com/oauth/access_token';

  const body = new URLSearchParams({
    client_id: process.env.META_IG_APP_ID,
    client_secret: process.env.META_IG_APP_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: process.env.META_IG_REDIRECT_URI,
    code,
  });

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error_message || data?.error?.message || 'Token exchange failed');

  return data;
}

async function getLongLivedToken(shortTokenData) {
  const shortToken = shortTokenData.access_token;

  const url = `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${process.env.META_IG_APP_SECRET}&access_token=${shortToken}`;

  const resp = await fetch(url);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message || 'Long-lived token exchange failed');

  return data;
}

async function getInstagramProfile(accessToken) {
  const url = `https://graph.instagram.com/${GRAPH_VERSION}/me?fields=id,username,name,profile_picture_url&access_token=${accessToken}`;

  const resp = await fetch(url);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message || 'Failed to fetch IG profile');

  return data;
}

module.exports = {
  getAuthUrl,
  exchangeCodeForToken,
  getLongLivedToken,
  getInstagramProfile,
};
