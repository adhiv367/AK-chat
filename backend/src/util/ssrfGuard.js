// SSRF protection for outbound automation HTTP calls (dynamic_api node).
//
// Responsibilities:
//   - allow only http/https, reject embedded credentials
//   - resolve the hostname's DNS (ALL records, v4+v6) and reject if any
//     resolved address is loopback / private / link-local / metadata /
//     multicast / reserved
//   - re-run the exact same check on every redirect hop (redirect: 'manual'
//     is enforced by safeFetch, not left to the caller), which is what
//     actually closes the DNS-rebinding gap: rebinding relies on a second
//     DNS lookup happening after validation passed once, so every hop and
//     every fetch gets its own fresh lookup+check right before connecting.
//
// This module intentionally does not know about workspaces, execution ids,
// or logging — it only ever throws a plain Error with a message safe to
// surface via the existing dynamic_api onError/logStep flow.

const dns = require('dns').promises;
const net = require('net');
const { URL } = require('url');

const MAX_REDIRECTS = 5;

// ─── IP range checks ──────────────────────────────────────────────────

function ipv4ToLong(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function ipv4InCidr(ip, cidr) {
  const [range, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToLong(ip) & mask) === (ipv4ToLong(range) & mask);
}

const BLOCKED_V4_CIDRS = [
  '0.0.0.0/8',       // "this" network
  '10.0.0.0/8',      // RFC1918
  '100.64.0.0/10',   // carrier-grade NAT
  '127.0.0.0/8',     // loopback
  '169.254.0.0/16',  // link-local (includes 169.254.169.254 metadata)
  '172.16.0.0/12',   // RFC1918
  '192.0.0.0/24',    // IETF protocol assignments
  '192.0.2.0/24',    // TEST-NET-1
  '192.168.0.0/16',  // RFC1918
  '198.18.0.0/15',   // benchmarking
  '198.51.100.0/24', // TEST-NET-2
  '203.0.113.0/24',  // TEST-NET-3
  '224.0.0.0/4',     // multicast
  '240.0.0.0/4',     // reserved
];

function isBlockedIPv4(ip) {
  return BLOCKED_V4_CIDRS.some(cidr => ipv4InCidr(ip, cidr));
}

// Normalize an IPv6 address into its full 8-group hextet array for prefix
// comparisons. Handles "::" compression.
function expandIPv6(ip) {
  // Strip zone id if present (fe80::1%eth0)
  const clean = ip.split('%')[0];
  if (clean.includes('.')) {
    // IPv4-mapped/compatible form, e.g. ::ffff:127.0.0.1 — handled separately.
    return null;
  }
  const parts = clean.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':').filter(Boolean) : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':').filter(Boolean) : [];
  const missing = 8 - (head.length + tail.length);
  if (missing < 0) return null;
  const full = [...head, ...Array(missing).fill('0'), ...tail];
  if (full.length !== 8) return null;
  return full.map(h => parseInt(h, 16));
}

function isBlockedIPv6(ip) {
  const lower = ip.toLowerCase();

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) addresses —
  // check the embedded IPv4 against the same v4 rules.
  const v4Embedded = lower.match(/(?:::ffff:|::)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (v4Embedded) {
    return isBlockedIPv4(v4Embedded[1]);
  }

  if (lower === '::1') return true; // loopback
  if (lower === '::') return true;  // unspecified

  const groups = expandIPv6(lower);
  if (!groups) return true; // unparseable → fail closed

  const first = groups[0];
  // fc00::/7 — unique local addresses (first byte 0xfc or 0xfd)
  if ((first & 0xfe00) === 0xfc00) return true;
  // fe80::/10 — link-local
  if ((first & 0xffc0) === 0xfe80) return true;
  // ff00::/8 — multicast
  if ((first & 0xff00) === 0xff00) return true;

  return false;
}

function isBlockedIp(ip) {
  if (net.isIP(ip) === 4) return isBlockedIPv4(ip);
  if (net.isIP(ip) === 6) return isBlockedIPv6(ip);
  return true; // not a recognizable IP → fail closed
}

// ─── URL-level validation ──────────────────────────────────────────────

function assertSafeProtocolAndCredentials(parsed) {
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`SSRF guard: protocol "${parsed.protocol}" is not allowed (only http/https)`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('SSRF guard: URLs with embedded credentials are not allowed');
  }
}

// Resolves the hostname to every address (v4+v6) and throws if any of them
// land in a blocked range. If the hostname IS already a literal IP, that
// literal is checked directly (no DNS lookup needed/possible).
async function assertSafeHostname(hostname) {
  const literalKind = net.isIP(hostname);
  if (literalKind) {
    if (isBlockedIp(hostname)) {
      throw new Error(`SSRF guard: blocked request to internal/reserved address ${hostname}`);
    }
    return;
  }

  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new Error(`SSRF guard: DNS resolution failed for "${hostname}" — ${err.message}`);
  }
  if (!records || records.length === 0) {
    throw new Error(`SSRF guard: DNS resolution returned no addresses for "${hostname}"`);
  }
  for (const rec of records) {
    if (isBlockedIp(rec.address)) {
      throw new Error(`SSRF guard: "${hostname}" resolves to blocked internal/reserved address ${rec.address}`);
    }
  }
}

// Validates a URL string end-to-end: protocol, credentials, and every DNS
// record the hostname currently resolves to. Called fresh before the
// initial request AND before following each redirect hop, so a hostname
// that resolves safely now but differently a moment later (DNS rebinding)
// is re-checked at the moment it's actually about to be connected to.
async function assertSafeUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch (err) {
    throw new Error(`SSRF guard: invalid URL — ${err.message}`);
  }
  assertSafeProtocolAndCredentials(parsed);
  await assertSafeHostname(parsed.hostname);
  return parsed;
}

// ─── Safe fetch wrapper ─────────────────────────────────────────────────

// Performs the validated fetch, manually following redirects (up to
// MAX_REDIRECTS) and re-validating each redirect target before following
// it. `signal`/timeout handling is left entirely to the caller (passed
// straight through in `options`), so the existing AbortController/timeout
// in automationEngine.js is preserved unchanged.
async function safeFetch(urlString, options = {}) {
  let currentUrl = urlString;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeUrl(currentUrl);
    const res = await fetch(currentUrl, { ...options, redirect: 'manual' });

    // A "manual" redirect response — Meta-standard fetch surfaces this as
    // an opaqueredirect Response in browsers, but Node's fetch (undici)
    // returns a normal Response with status 3xx and a Location header, so
    // we detect it that way.
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop === MAX_REDIRECTS) {
        throw new Error('SSRF guard: too many redirects');
      }
      const nextUrl = new URL(res.headers.get('location'), currentUrl).toString();
      currentUrl = nextUrl;
      continue;
    }

    return res;
  }
  throw new Error('SSRF guard: too many redirects');
}

module.exports = {
  assertSafeUrl,
  safeFetch,
  // exported for targeted unit testing
  isBlockedIPv4,
  isBlockedIPv6,
  isBlockedIp,
};