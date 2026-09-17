// Phase 7E — Exit Conditions: rule evaluation.
//
// Deliberately split out of services/sequenceScheduler.js (same reasoning
// as util/sequenceDelay.js's own header) so this logic can be unit-tested
// with a fake `pool` object, without pulling in sequenceScheduler.js's
// Redis/BullMQ requires (services/messageSender.js -> queue/sendQueue.js).
//
// Only the three approved condition types exist. No new tables, no event
// bus — everything here reads coexistence.contacts.tags (JSONB array,
// existing column) and coexistence.chat_history (existing table, existing
// direction/timestamp columns), the two data sources the Phase 7E
// investigation confirmed as reliable.

const EXIT_RULE_TYPES = ['has_tag', 'not_has_tag', 'replied_since_enrollment'];

/**
 * Does this contact currently carry `tag`? Reuses the exact
 * (workspace_id, contact_number) lookup shape already used elsewhere in
 * sequenceScheduler.js (e.g. the message-step contact lookup).
 */
async function contactHasTag(pool, workspaceId, contactNumber, tag) {
  const { rows } = await pool.query(
    `SELECT tags FROM coexistence.contacts
      WHERE workspace_id = $1 AND contact_number = $2
      LIMIT 1`,
    [workspaceId, contactNumber]
  );
  const tags = rows[0] ? rows[0].tags : null;
  if (!Array.isArray(tags)) return false;
  return tags.includes(tag);
}

/**
 * Has this contact sent an inbound WhatsApp message since `enrolledAt`?
 * `waNumber` is the workspace's own WhatsApp display number (digits-only),
 * the same identifier chat_history.wa_number already stores — chat_history
 * has no workspace_id column of its own (see routes/messages.js), so
 * wa_number is how this stays workspace-scoped. If no account/waNumber
 * could be resolved for this workspace, this condition simply cannot match
 * (not an error — the caller may still evaluate other rules).
 */
async function repliedSinceEnrollment(pool, waNumber, contactNumber, enrolledAt) {
  if (!waNumber) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM coexistence.chat_history
      WHERE wa_number = $1 AND contact_number = $2
        AND direction = 'incoming' AND timestamp > $3
      LIMIT 1`,
    [waNumber, contactNumber, enrolledAt]
  );
  return rows.length > 0;
}

/**
 * Evaluate `exitRules` (the sequence's exit_rules JSONB array) against one
 * enrollment, OR semantics — the first matching rule wins and is returned.
 * Returns null if nothing matched (including when exitRules is empty).
 *
 * Unknown/malformed entries (missing/unrecognized `type`, missing `tag`
 * for a tag rule) are silently skipped — they never throw and never stop
 * evaluation of the remaining rules.
 *
 * Throws only on a genuine DB error from pool.query — callers must decide
 * how to handle that (Phase 7E: leave the enrollment active, log, let the
 * next scheduler tick retry).
 */
async function evaluateExitRules({ pool, workspaceId, contactNumber, enrolledAt, waNumber, exitRules }) {
  if (!Array.isArray(exitRules) || exitRules.length === 0) return null;

  for (const rule of exitRules) {
    if (!rule || typeof rule !== 'object' || !EXIT_RULE_TYPES.includes(rule.type)) {
      continue; // unknown/malformed — ignore, keep going
    }

    if (rule.type === 'has_tag') {
      if (!rule.tag) continue; // malformed: has_tag with no tag
      if (await contactHasTag(pool, workspaceId, contactNumber, rule.tag)) return rule;
    } else if (rule.type === 'not_has_tag') {
      if (!rule.tag) continue;
      if (!(await contactHasTag(pool, workspaceId, contactNumber, rule.tag))) return rule;
    } else if (rule.type === 'replied_since_enrollment') {
      if (await repliedSinceEnrollment(pool, waNumber, contactNumber, enrolledAt)) return rule;
    }
  }

  return null;
}

/**
 * Human-readable exit_reason string persisted onto
 * sequence_enrollments.exit_reason when `rule` (as returned by
 * evaluateExitRules) matched.
 */
function formatExitReason(rule) {
  if (rule.type === 'has_tag' || rule.type === 'not_has_tag') return `${rule.type}:${rule.tag}`;
  return rule.type;
}

module.exports = {
  EXIT_RULE_TYPES,
  contactHasTag,
  repliedSinceEnrollment,
  evaluateExitRules,
  formatExitReason,
};




