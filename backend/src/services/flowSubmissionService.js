// Phase 6.5 — WhatsApp Flow nfm_reply submission handling.
//
// Focused ONLY on:
//   1. safely extracting a Flow response out of Meta's nfm_reply webhook
//      block,
//   2. resolving it back to the Flow/workspace it actually belongs to, and
//   3. persisting it idempotently into coexistence.flow_submissions
//      (schema unchanged — see db/flowsSchema.js, added in Phase 6.1).
//
// Called additively from routes/webhook.js for incoming
// interactive.type === "nfm_reply" messages only. Does not touch
// Automation Builder, Campaign Studio, CRM, or Zoho — those stay
// completely untouched by this file. Phase 6.6 added one additional step
// after a successful (non-duplicate) insert: mapping the submission into
// existing Contact / Business Field storage via
// services/flowFieldMappingService.js, when the Flow has a field_mapping
// configured — see that file for the mapping logic itself. Phase 6.11
// added one further additive step after that mapping: a best-effort
// Flow -> Lead creation/update via services/flowLeadService.js, which
// reuses the EXISTING Lead process (zohoLeadService.js) end to end. Its
// failure can never fail the (already-stored) Flow submission — see the
// isolated try/catch around that call below.
//
// ── workspace-safety (see spec section H) ─────────────────────────────
// The workspace a submission is filed under NEVER comes from anything in
// the inbound webhook payload's own claims (there is no such field to
// trust anyway). It is derived exclusively from:
//   inbound phone_number_id
//     → coexistence.whatsapp_accounts (via the EXISTING
//       resolveAccount()/getAccountByPhoneNumber() used everywhere else
//       in this codebase — see services/messageSender.js)
//     → that account's workspace_id
// and the flow_token is then looked up ONLY among THIS SAME
// phone_number_id's own outgoing chat_history rows (Phase 6.4 always
// writes the flow_token into template_meta on the account that actually
// sent the Flow) — so a token can never resolve across workspaces/accounts.
//
// If any step of that chain can't be resolved, no submission row is
// created (coexistence.flow_submissions.flow_id is NOT NULL — there is no
// schema-legal way to store a submission without a resolved flow anyway),
// the failure is logged, and the webhook keeps processing normally.

const pool = require('../db');
// Required as whole module objects (not destructured) so tests can
// monkey-patch individual exports on these modules — the same pattern
// flowLeadService.js uses for zohoLeadService (see its header comment).
// Destructuring here would bind these names to the functions that existed
// at require-time, silently breaking that monkey-patch approach.
const messageSender = require('./messageSender');
const flowFieldMappingService = require('./flowFieldMappingService');
const { attemptFlowToLead } = require('./flowLeadService');

/**
 * Safely parses Meta's nfm_reply block into a structured shape. Never
 * throws — returns null if there's no block at all, or an object with
 * parseError:true if response_json couldn't be parsed / carried no
 * flow_token.
 *
 * Meta's actual shape (interactive.type === 'nfm_reply'):
 *   interactive.nfm_reply = {
 *     name: 'flow',
 *     body: 'Sent' | <string>,
 *     response_json: '{"flow_token":"...","field1":"value1",...}'
 *   }
 * response_json is normally a JSON-encoded STRING; some transports may
 * already hand back a parsed object, so both are supported.
 */
function extractNfmReply(nfmReply) {
  if (!nfmReply || typeof nfmReply !== 'object') return null;

  const result = {
    name: nfmReply.name || null,
    bodyText: nfmReply.body || null,
    responseData: null,
    flowToken: null,
    parseError: false,
  };
  const raw = nfmReply.response_json;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      result.responseData = JSON.parse(raw);
    } catch (err) {
      result.parseError = true;
    }
  } else if (raw && typeof raw === 'object') {
    result.responseData = raw;
  } else {
    result.parseError = true;
  }

  if (result.responseData && typeof result.responseData === 'object') {
    result.flowToken = result.responseData.flow_token || null;
  }
  if (!result.parseError && !result.flowToken) {
    // Parsed fine but carried no flow_token — still unresolvable.
    result.parseError = true;
  }

  return result;
}
/**
 * Resolves { workspaceId, account } for an inbound phone_number_id using
 * the EXISTING resolveAccount() helper (services/messageSender.js) —
 * never a bespoke lookup. Returns null if unresolvable.
 */
async function resolveWorkspaceForPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  const { account, error } = await messageSender.resolveAccount({ fromPhoneNumber: phoneNumberId });
  if (error || !account || !account.workspaceId) return null;
  return { workspaceId: account.workspaceId, account };
}
/**
 * Finds the ORIGINAL outgoing Flow send that produced this flow_token,
 * scoped to the same phone_number_id the reply arrived on — see the
 * workspace-safety note at the top of this file for why that scoping is
 * what makes this safe.
 */
async function findOutgoingFlowSend(phoneNumberId, flowToken) {
  if (!phoneNumberId || !flowToken) return null;
  const { rows } = await pool.query(
    `SELECT message_id, template_meta
       FROM coexistence.chat_history
      WHERE phone_number_id = $1
        AND direction = 'outgoing'
        AND message_type = 'flow'
        AND template_meta->>'flowToken' = $2
      ORDER BY timestamp DESC
      LIMIT 1`,
    [phoneNumberId, flowToken]
  );
  return rows[0] || null;
}
/**
 * Best-effort resolution of the specific flow_versions row used for the
 * original send, so flow_submissions can carry flow_version_id "where
 * available" (spec section C/D). Not fatal if unresolvable — the
 * submission is still stored either way with flow_version_id = null.
 */
async function resolveFlowVersionId(flowId, metaFlowId) {
  if (!flowId || !metaFlowId) return null;
  const { rows } = await pool.query(
    `SELECT id FROM coexistence.flow_versions
      WHERE flow_id = $1 AND meta_flow_id = $2
      ORDER BY version_number DESC
      LIMIT 1`,
    [flowId, metaFlowId]
  );
  return rows[0]?.id || null;
}
/**
 * Main entry point — called once per incoming nfm_reply record by
 * webhook.js. Never throws: every failure mode is caught internally and
 * returned as { ok:false, reason }, exactly so a malformed/unresolvable
 * Flow reply can never crash or abort the webhook's processing of other
 * records (spec section K).
 *
 * @param {object} params
 * @param {object} params.nfmReply - the raw interactive.nfm_reply block
 * @param {string} params.messageId - msg.id (inbound wamid) — this is the
 *   flow_submissions idempotency key (UNIQUE constraint already on the
 *   column, added in Phase 6.1 — no schema change needed here)
 * @param {string} params.phoneNumberId - value.metadata.phone_number_id
 * @param {string} params.contactNumber - normalized contact_number
 * @param {string} [params.timestamp] - ISO timestamp of the inbound message
 * @param {string} [params.waNumber] - Phase 6.6: the SAME normalized
 *   business wa_number already computed for this inbound record's own
 *   chat_history row (routes/webhook.js's normalizePhone(displayPhoneNumber),
 *   taken live from this webhook delivery's metadata.display_phone_number).
 *   Passed through unchanged to mapFlowSubmissionToContact's contact
 *   lookup so it keys off the EXACT SAME wa_number every other
 *   contact-creating path in this codebase uses for this same business
 *   number — see the "contact resolution consistency" note below for why
 *   this matters. Optional only for backward compatibility with any other
 *   caller; when omitted, falls back to the previous (DB-derived) value.
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function recordFlowSubmission({ nfmReply, messageId, phoneNumberId, contactNumber, timestamp, waNumber: inboundWaNumber }) {
  try {
    if (!messageId) return { ok: false, reason: 'missing message_id' };

    const extracted = extractNfmReply(nfmReply);
    if (!extracted) return { ok: false, reason: 'no nfm_reply block' };

    if (extracted.parseError || !extracted.flowToken) {
      // Do not fabricate a submission linked to the wrong (or no) flow —
      // just log a useful diagnostic and leave it unstored.
      console.warn(
        `[flowSubmissionService] Unresolvable nfm_reply for message_id=${messageId}: ` +
        (extracted.parseError ? 'response_json missing/unparseable or carried no flow_token' : 'no flow_token')
      );
      return { ok: false, reason: 'response not resolvable to a flow_token' };
    }

    const resolved = await resolveWorkspaceForPhoneNumberId(phoneNumberId);
    if (!resolved) {
      console.warn(`[flowSubmissionService] Could not resolve a workspace for phone_number_id=${phoneNumberId} — dropping nfm_reply message_id=${messageId}`);
      return { ok: false, reason: 'workspace not resolvable' };
    }
    const { workspaceId } = resolved;

    const outgoing = await findOutgoingFlowSend(phoneNumberId, extracted.flowToken);
    if (!outgoing) {
      console.warn(`[flowSubmissionService] No matching outgoing Flow send found for this flow_token — dropping nfm_reply message_id=${messageId}`);
      return { ok: false, reason: 'flow_token not found among outgoing sends' };
    }

    let outgoingMeta = null;
    try {
      outgoingMeta = typeof outgoing.template_meta === 'string' ? JSON.parse(outgoing.template_meta) : outgoing.template_meta;
    } catch (err) {
      outgoingMeta = null;
    }

    const flowId = outgoingMeta?.flowId || null;
    if (!flowId) {
      console.warn(`[flowSubmissionService] Matched outgoing Flow send has no flowId in template_meta — dropping nfm_reply message_id=${messageId}`);
      return { ok: false, reason: 'flow_id not resolvable from outgoing send' };
    }

    const flowVersionId = await resolveFlowVersionId(flowId, outgoingMeta?.metaFlowId);
    // Idempotent insert — flow_submissions.message_id is UNIQUE (Phase 6.1
    // schema). A duplicate nfm_reply delivery (Meta retry) is a harmless
    // no-op; the webhook still returns success either way. RETURNING id
    // comes back empty on a conflict (rowCount === 0), which is also what
    // gates Phase 6.6's contact/business-field mapping below — a retried
    // delivery of an already-processed submission must not re-run mapping
    // (spec §G).
    const insertResult = await pool.query(
      `INSERT INTO coexistence.flow_submissions
         (flow_id, flow_version_id, workspace_id, contact_number, message_id,
          flow_token, response_json, parse_error, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz, NOW()))
       ON CONFLICT (message_id) DO NOTHING
       RETURNING id`,
      [
        flowId,
        flowVersionId,
        workspaceId,
        contactNumber || null,
        messageId,
        extracted.flowToken,
        JSON.stringify(extracted.responseData || {}),
        false,
        timestamp || null,
      ]
    );

    if (insertResult.rowCount === 0) {
      return { ok: true, duplicate: true };
    }
    const submissionId = insertResult.rows[0].id;

    // Phase 6.6 — map the submission into Contact / Business Fields where
    // the Flow has a valid field_mapping configured. This can never fail
    // the submission itself (already durably stored above) — any error
    // here is caught internally by mapFlowSubmissionToContact and, as a
    // final safety net, here too.
    try {
      // Contact-resolution consistency (Phase 6.6 audit finding): every
      // OTHER path that creates/matches a coexistence.contacts row for
      // this business number (webhook.js's own auto-create on this same
      // delivery, routes/messages.js send/reply paths, etc.) keys off
      // normalizePhone(metadata.display_phone_number) taken LIVE from the
      // inbound Meta webhook payload for that specific delivery. Deriving
      // wa_number instead from whatsapp_accounts.display_phone_number (the
      // DB-cached value on the account row) is a second, independent
      // source for "the same" number that can silently drift out of sync
      // with the live value — any such drift makes resolveOrCreateContact's
      // ON CONFLICT (wa_number, contact_number) miss the existing contact
      // and insert a fresh, blank one instead of updating it. Preferring
      // the caller-supplied inboundWaNumber (webhook.js passes the exact
      // wa_number it just used for this record's own chat_history row)
      // closes that gap. The DB-derived value is kept only as a fallback
      // for any other/future caller that doesn't supply it.
      const waNumber = inboundWaNumber
        || (resolved.account.displayPhoneNumber
          ? String(resolved.account.displayPhoneNumber).replace(/\D/g, '')
          : null);
      const mappingSummary = await flowFieldMappingService.mapFlowSubmissionToContact({
        flowId,
        workspaceId,
        waNumber,
        contactNumber,
        responseData: extracted.responseData,
      });

      if (mappingSummary?.attempted) {
        // Reuse the existing parse_error column as the "processing wasn't
        // fully clean" signal for a partial mapping failure — spec §F
        // explicitly asks to reuse an existing error representation
        // rather than add a new column. A field simply absent from this
        // particular submission ('missing') is normal, not a failure.
        const hadFailures = mappingSummary.skipped.some((s) => s.type === 'error' || s.type === 'config');
        await pool.query(
          `UPDATE coexistence.flow_submissions SET mapped_at = NOW(), parse_error = $2 WHERE id = $1`,
          [submissionId, hadFailures]
        );
      }
      // mappingSummary.attempted === false (empty mapping, or nothing to
      // map) -> leave mapped_at null, parse_error untouched (already
      // false) — spec §E: "no mapping work" is a fully successful outcome.
    } catch (mapErr) {
      console.error('[flowSubmissionService] Flow field mapping error:', mapErr.message);
    }

    // Phase 6.11 — Flow -> Lead creation/update, reusing the EXISTING Lead
    // process (see services/flowLeadService.js). Runs only after the Flow
    // submission insert above has already succeeded (this line is
    // unreachable on a duplicate — see the `insertResult.rowCount === 0`
    // early return above) and after Contact/Business Field mapping has
    // run, exactly per spec. Isolated try/catch: any failure here (missing
    // Zoho connection, Lead create/update failure, malformed field, etc.)
    // is logged only — it can never fail or roll back the Flow submission,
    // which is already durably stored by this point.
    try {
      const { rows: flowRows } = await pool.query(
        `SELECT name, field_mapping FROM coexistence.flows WHERE id = $1 AND workspace_id = $2`,
        [flowId, workspaceId]
      );
      const flowRow = flowRows[0];
      if (flowRow) {
        const leadResult = await attemptFlowToLead({
          flowId,
          flowName: flowRow.name,
          fieldMapping: flowRow.field_mapping,
          workspaceId,
          whatsappAccountId: resolved.account.id,
          contactNumber,
          responseData: extracted.responseData,
        });
        if (leadResult && leadResult.attempted && !leadResult.ok) {
          console.warn(`[flowSubmissionService] Flow -> Lead attempt did not succeed for message_id=${messageId}: ${leadResult.reason}`);
        }
      }
    } catch (leadErr) {
      console.error('[flowSubmissionService] Flow -> Lead error:', leadErr.message);
    }

    return { ok: true };
  } catch (err) {
    // Never let a Flow-submission failure take down webhook processing.
    console.error('[flowSubmissionService] recordFlowSubmission error:', err.message);
    return { ok: false, reason: 'internal error' };
  }
}
module.exports = {
  extractNfmReply,
  resolveWorkspaceForPhoneNumberId,
  findOutgoingFlowSend,
  resolveFlowVersionId,
  recordFlowSubmission,
};