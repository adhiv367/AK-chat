'use strict';

// Billing-provider webhook signature verification (HMAC-SHA256 hex digest of
// the raw request body). Mirrors the verifyMetaSignature pattern in
// webhookSignature.js, adapted for the billing provider's header/format.
// Consumed by routes/billing.js's public /billing/webhook route.

const crypto = require('crypto');

const DEFAULT_HEADER = 'x-billing-signature';

// Constant-time string compare that never throws on length mismatch.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Verify the billing provider's webhook signature (hex HMAC-SHA256 of the
// raw body using BILLING_WEBHOOK_SECRET). Returns true if valid, false if
// invalid, and null when BILLING_WEBHOOK_SECRET is unset - the caller
// (routes/billing.js) fails closed on null rather than treating an
// unconfigured secret as "trusted".
function verifyBillingSignature(req, headerName = DEFAULT_HEADER) {
  const secret = process.env.BILLING_WEBHOOK_SECRET;
  if (!secret) return null; // not configured

  const header = req.get(headerName) || '';
  const raw = req.rawBody;
  if (!header || raw == null || !raw.length) return false;

  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return safeEqual(header, expected);
}

module.exports = { verifyBillingSignature, DEFAULT_HEADER };