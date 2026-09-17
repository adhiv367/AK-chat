const API_VERSION = process.env.META_API_VERSION || 'v21.0';

async function subscribePage(pageId, pageAccessToken) {
  const url = `https://graph.facebook.com/${API_VERSION}/${pageId}/subscribed_apps`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscribed_fields: 'messages,messaging_postbacks,message_reactions,message_reads,message_deliveries,comments',
      access_token: pageAccessToken,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message || 'Webhook subscription failed');
  return data;
}

async function unsubscribePage(pageId, pageAccessToken) {
  const url = `https://graph.facebook.com/${API_VERSION}/${pageId}/subscribed_apps?access_token=${pageAccessToken}`;
  await fetch(url, { method: 'DELETE' }).catch(() => {});
}

module.exports = { subscribePage, unsubscribePage };