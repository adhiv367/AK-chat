// Retarget module — Exit URL resolver.
// Single source of truth for "what URL should this phone number's Retarget
// reminder point to". Used by:
//   - Contacts UI (via retarget_exit_url, attached by routes/contacts.js)
//   - the Retarget send flow (routes/retarget.js → send-reminders)
//
// Resolution order (matches the Contacts <-> Retarget bridge contract):
//   1. coexistence.retarget_customers.exit_url, matched by normalized phone
//   2. contacts.custom_fields.retargetURL (already mirrored from #1, but
//      checked as a fallback in case the Retarget row was since deleted)
//   3. Invi Creation homepage
//
// A missing/empty URL at every step is NOT an error — it just means "send
// them to the homepage", per the product requirement that no Retarget
// customer is ever left without a destination.
//
// Phase 3C-4: resolveExitUrl/fetchExitUrlsForPhones now take workspaceId and
// scope the retarget_customers lookup to it, so one workspace's exit-URL
// data is never read while resolving another workspace's send/contact flow.
// A missing workspaceId falls straight to the homepage fallback (source
// 'homepage') rather than querying unscoped — "no workspace context" must
// never mean "read across all workspaces".

const pool = require('../db');
const { normalizePhone } = require('./contactSyncService');

const INVI_HOMEPAGE = 'https://www.invicreation.com/';

/**
 * Pure priority logic, shared by the single-phone and batch resolvers so
 * there is exactly one place that encodes the fallback order:
 *   1. coexistence.retarget_customers.exit_url
 *   2. contacts.custom_fields.retargetURL
 *   3. Invi Creation homepage
 */
function pickUrl(retargetExitUrl, contactRetargetUrl) {
  const retargetUrl = retargetExitUrl?.trim?.() || null;
  if (retargetUrl) return { url: retargetUrl, isFallback: false, source: 'retarget' };

  const contactUrl = contactRetargetUrl?.trim?.() || null;
  if (contactUrl) return { url: contactUrl, isFallback: false, source: 'contact' };

  return { url: INVI_HOMEPAGE, isFallback: true, source: 'homepage' };
}

/**
 * @param {string} phone - raw or normalized phone number
 * @param {object} [contact] - optional already-fetched contact row (avoids
 *   a second query when the caller already has it, e.g. from a JOIN)
 * @param {number|null} [workspaceId] - scopes the retarget_customers lookup;
 *   omit only when no workspace context exists (falls straight to homepage).
 * @returns {Promise<{url: string, isFallback: boolean, source: 'retarget'|'contact'|'homepage'}>}
 */
async function resolveExitUrl(phone, contact = null, workspaceId = null) {
  const normPhone = normalizePhone(phone);
  if (!normPhone) return { url: INVI_HOMEPAGE, isFallback: true, source: 'homepage' };

  // No workspace context -> skip the (would-be-unscoped) retarget_customers
  // lookup entirely rather than querying across every workspace; the
  // already-fetched contact's own mirrored URL is still a safe fallback
  // since it was itself written under a workspace-scoped bridge.
  if (!workspaceId) return pickUrl(null, contact?.custom_fields?.retargetURL);

  const { rows } = await pool.query(
    `SELECT exit_url FROM coexistence.retarget_customers
      WHERE phone = $1 AND workspace_id = $2
      ORDER BY updated_at DESC LIMIT 1`,
    [normPhone, workspaceId]
  );
  return pickUrl(rows[0]?.exit_url, contact?.custom_fields?.retargetURL);
}

/**
 * Batch version of resolveExitUrl — one query for any number of phones,
 * used by GET /contacts to avoid N+1 queries. Only phones that are actually
 * flagged as Retarget contacts need to be passed in.
 *
 * @param {string[]} phones - raw or normalized phone numbers (deduped/normalized internally)
 * @param {number|null} [workspaceId] - scopes the lookup; omit only when no
 *   workspace context exists (returns an empty map, same as no matches).
 * @returns {Promise<Map<string, string>>} normalized phone -> retarget_customers.exit_url (trimmed, non-empty only)
 */
async function fetchExitUrlsForPhones(phones, workspaceId = null) {
  const normPhones = Array.from(new Set((phones || []).map(normalizePhone).filter(Boolean)));
  if (normPhones.length === 0 || !workspaceId) return new Map();

  // DISTINCT ON picks one row per phone (most recently updated), same
  // tie-break as resolveExitUrl's ORDER BY ... LIMIT 1.
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (phone) phone, exit_url
       FROM coexistence.retarget_customers
      WHERE phone = ANY($1::text[]) AND workspace_id = $2
      ORDER BY phone, updated_at DESC`,
    [normPhones, workspaceId]
  );

  const map = new Map();
  for (const row of rows) {
    const url = row.exit_url?.trim();
    if (url) map.set(row.phone, url);
  }
  return map;
}

/**
 * Resolves the display Exit URL for a single contact row, given a
 * pre-fetched batch map (from fetchExitUrlsForPhones). Pure/no I/O.
 * @param {object} contact - a coexistence.contacts row
 * @param {Map<string,string>} exitUrlsByPhone
 * @returns {string}
 */
function resolveContactExitUrl(contact, exitUrlsByPhone) {
  const normPhone = normalizePhone(contact?.contact_number);
  const retargetUrl = normPhone ? exitUrlsByPhone.get(normPhone) : undefined;
  return pickUrl(retargetUrl, contact?.custom_fields?.retargetURL).url;
}

module.exports = { resolveExitUrl, fetchExitUrlsForPhones, resolveContactExitUrl, INVI_HOMEPAGE };
