/* ══════════════════════════════════════════════════════════════════════
   Automation Guard — single source of truth for "Manual Reply" blocking.

   When a contact has the "Manual Reply" tag, a human agent has taken over
   the conversation. Every inbound automation entry point (AI reply,
   keyword trigger, workflow engine — including resumed/paused workflows,
   and any future automation) MUST call this guard before executing.

   Outbound/manual actions (dashboard send, template, bulk, broadcast,
   campaign, scheduled message, manually-started workflow test) do NOT go
   through this guard — they are human-initiated and must always work.

   No caching: tags are always read live from coexistence.contacts, so the
   moment the tag is removed, the very next inbound event resumes
   automation with no restart / no cache clear / no delay.
   ══════════════════════════════════════════════════════════════════════ */

const MANUAL_REPLY_TAG_NAME = 'manual reply';
const SKIP_REASON = 'Manual Reply tag active';

/**
 * Pure check: does this tags array contain the Manual Reply tag?
 * @param {Array<{name?: string}>} tags
 * @returns {boolean}
 */
function hasManualReplyTag(tags) {
  return Array.isArray(tags) && tags.some(
    t => typeof t?.name === 'string' && t.name.trim().toLowerCase() === MANUAL_REPLY_TAG_NAME
  );
}

/**
 * Central guard every inbound automation entry point must call before
 * executing anything (AI reply, keyword trigger, workflow start/resume).
 * @param {Array<{name?: string}>} tags - the contact's current tags
 * @returns {boolean} true => automation MUST NOT run for this contact
 */
function isAutomationBlocked(tags) {
  return hasManualReplyTag(tags);
}

module.exports = {
  MANUAL_REPLY_TAG_NAME,
  SKIP_REASON,
  hasManualReplyTag,
  isAutomationBlocked,
};


