// Meta webhook signature + constant-time comparison helpers.
//
// Extracted from routes/webhook.js so they can be unit-tested in isolation —
// requiring the route module pulls in the BullMQ/Redis queue side-effects,
// which we don't want in a unit test.

const crypto = require('crypto');

// Constant-time string compare that never throws on length mismatch.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Verify Meta's X-Hub-Signature-256 (HMAC-SHA256 of the raw body with the App
// Secret). Returns true if valid, false if invalid, and null when
// META_APP_SECRET is unset (the caller decides how to handle "cannot verify").
function verifyMetaSignature(req) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return null; // not configured
  const header = req.get('x-hub-signature-256') || '';
  const raw = req.rawBody;
  if (!header.startsWith('sha256=') || !raw || !raw.length) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Verify a forwarded-webhook-mirror request (see routes/webhook.js's
// LOCAL_WEBHOOK_FORWARD_URL / LOCAL_WEBHOOK_FORWARD_SECRET bridge). A
// forwarded copy is re-serialized by fetch() before it's sent, so it can
// never carry a byte-identical Meta HMAC over its own body — this checks a
// separate shared secret instead. Returns false (never throws) whenever the
// receiving instance hasn't configured a secret, or the header is absent/
// mismatched — i.e. "not a forwarded copy" and "misconfigured" look
// identical to the caller, which is the safe default.
function verifyForwardSecret(req, secret) {
  if (!secret) return false;
  const header = req.get('x-akchat-forward-secret');
  if (!header) return false;
  return safeEqual(secret, header);
}

module.exports = { safeEqual, verifyMetaSignature, verifyForwardSecret };
