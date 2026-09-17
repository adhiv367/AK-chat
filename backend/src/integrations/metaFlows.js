// Phase 6.3 — Meta WhatsApp Flow API integration.
//
// Same shape as integrations/metaTemplates.js: thin wrappers around the
// Graph API, each returning Meta's parsed JSON response on success and
// throwing an Error with .status / .metaError on failure (never the raw
// token, never logged). Callers (routes/flows.js) own all DB writes,
// workspace/account ownership checks, and status transitions — this file
// makes zero database calls and holds no state of its own.
//
// Endpoints used (Graph API — WhatsApp Flows):
//   POST   /{WABA_ID}/flows            — create a Flow (draft, unattached JSON)
//   POST   /{FLOW_ID}/assets           — upload/replace the Flow JSON asset
//   POST   /{FLOW_ID}/publish          — publish a Flow (irreversible on Meta's side)
//   GET    /{FLOW_ID}                  — fetch current status/validation errors
//   POST   /{FLOW_ID}/deprecate        — deprecate a previously published Flow
//
// Reference: https://developers.facebook.com/docs/whatsapp/flows/reference/flowsapi

const META_API_VERSION = process.env.META_API_VERSION || 'v21.0';

// Shared response handling — identical parse/error shape to metaTemplates.js
// (submitTemplate/editTemplate/listTemplates) so routes/flows.js can reuse
// the exact same err.status / err.metaError handling the template routes
// already use.
async function parseMetaResponse(res, label) {
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  if (!res.ok) {
    const err = new Error(`Meta ${label} ${res.status}: ${parsed?.error?.message || text.slice(0, 300)}`);
    err.status = res.status;
    err.metaError = parsed?.error || null;
    throw err;
  }
  return parsed;
}

/**
 * Create a new Flow shell on Meta under the given WABA. Meta assigns the
 * Flow's id; the Flow starts in Meta's DRAFT state with no JSON asset
 * attached yet — updateFlowJson() must be called separately to attach one.
 *
 * @param {string} wabaId
 * @param {string} accessToken
 * @param {object} opts — { name, categories } (categories is a required
 *   Meta enum array, e.g. ['SIGN_UP'], ['LEAD_GENERATION'], etc.)
 * @returns Meta response { id }
 */
async function createFlow(wabaId, accessToken, { name, categories }) {
  const url = `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(wabaId)}/flows`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, categories }),
  });
  return parseMetaResponse(res, 'createFlow');
}

/**
 * Upload/replace a Flow's JSON asset. Meta requires this as a multipart
 * file upload (asset_type=FLOW_JSON) rather than a plain JSON body — this
 * is the one call in this file that isn't a simple JSON POST, matching
 * Meta's documented Flow JSON upload contract.
 *
 * On success Meta returns any validation warnings/errors it found while
 * parsing the JSON (empty array if none) — this does NOT mean the Flow is
 * publishable; publishFlow() re-validates and is the authority on that.
 *
 * @param {string} metaFlowId
 * @param {string} accessToken
 * @param {object} flowJson — Meta-compatible Flow JSON document (from
 *   services/flowJsonBuilder.js's buildFlowJson())
 * @returns Meta response { success, validation_errors: [...] }
 */
async function updateFlowJson(metaFlowId, accessToken, flowJson) {
  const url = `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(metaFlowId)}/assets`;
  const form = new FormData();
  form.append('name', 'flow.json');
  form.append('asset_type', 'FLOW_JSON');
  form.append(
    'file',
    new Blob([JSON.stringify(flowJson)], { type: 'application/json' }),
    'flow.json'
  );
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}` }, // no Content-Type — fetch sets multipart boundary
    body: form,
  });
  return parseMetaResponse(res, 'updateFlowJson');
}

/**
 * Publish a Flow. Meta re-validates the currently-attached JSON asset at
 * publish time and rejects the call if it's invalid — a rejection here
 * must never be treated as success by the caller (see routes/flows.js:
 * a Meta failure must not flip the local flow to 'published').
 * Publishing is irreversible on Meta's side (a published Flow can only be
 * deprecated afterward, never un-published or edited in place).
 *
 * @param {string} metaFlowId
 * @param {string} accessToken
 * @returns Meta response { success: true }
 */
async function publishFlow(metaFlowId, accessToken) {
  const url = `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(metaFlowId)}/publish`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  return parseMetaResponse(res, 'publishFlow');
}

/**
 * Fetch a Flow's current Meta-side state: status, validation_errors,
 * json_version, health status. Used both for on-demand status checks and
 * for reconciling meta_status stored on coexistence.flow_versions.
 *
 * @param {string} metaFlowId
 * @param {string} accessToken
 * @param {string} [fields]
 * @returns Meta response { id, name, status, categories, validation_errors, json_version }
 */
async function getFlowStatus(metaFlowId, accessToken, fields) {
  const f = fields || 'id,name,status,categories,validation_errors,json_version,health_status,whatsapp_business_account';
  const url = `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(metaFlowId)}?fields=${encodeURIComponent(f)}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  return parseMetaResponse(res, 'getFlowStatus');
}

/**
 * Deprecate a published Flow. Only valid on a Flow Meta considers
 * PUBLISHED — deprecating a draft is rejected by Meta. Deprecation is
 * also irreversible on Meta's side.
 *
 * @param {string} metaFlowId
 * @param {string} accessToken
 * @returns Meta response { success: true }
 */
async function deprecateFlow(metaFlowId, accessToken) {
  const url = `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(metaFlowId)}/deprecate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  return parseMetaResponse(res, 'deprecateFlow');
}

module.exports = {
  createFlow,
  updateFlowJson,
  publishFlow,
  getFlowStatus,
  deprecateFlow,
};


