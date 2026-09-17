// Phase 6 Part 1 — Campaign Studio: campaign foundation CRUD + audience
// preview. This file creates ZERO new sending logic — Part 2 will connect
// campaigns to the existing broadcast/queue/Meta-send pipeline the same
// way routes/targetMessage.js already does (create a DRAFT broadcast, then
// send through the existing /broadcasts/:id/send route).
//
// Every route is workspace-scoped via req.workspace.id (resolved
// server-side by middleware/workspaceContext.js's attachWorkspace — never
// taken from the client). Every campaign lookup goes through
// repositories/campaignRepository.js, which always includes workspace_id
// in its WHERE clause, so a campaign belonging to another workspace is
// indistinguishable from one that doesn't exist (404 either way).

const { Router } = require('express');
const pool = require('../db');
const { requirePermission } = require('../middleware/access');
const { getAccountByPhoneNumber } = require('./whatsappAccounts');
const { buildAudienceWhere, validateAudienceFilters, buildDedupedContactsSQL } = require('../services/audienceFilter');
const repo = require('../repositories/campaignRepository');
// Phase 6 Part 3A: Send Now delegates to the EXACT same send/queue/Meta
// pipeline the interactive POST /broadcasts/:id/send route uses — no new
// sender, queue, or Meta integration. sendBroadcastById is the body of that
// route, extracted so it can be called directly instead of only via HTTP.
// Required lazily (inside the route handler below), not at module load —
// routes/broadcasts.js pulls in queue/sendQueue.js, which opens a Redis
// connection as a module-load side effect. A top-level require here would
// mean simply requiring routes/campaigns.js (e.g. from any other test)
// opens a Redis connection, exactly like routes/broadcasts.js itself lazily
// requires ./mediaLibrary inside sendBroadcastById for the same reason.

const router = Router();

const EDITABLE_STATUSES = new Set(['draft']);
const MAX_AUDIENCE = 5000; // mirrors routes/targetMessage.js's existing cap

// ─── Audience resolution (server-side, never trusts frontend counts) ──────

// Resolves an audience definition against the CALLER'S workspace and
// returns { count, contacts, page, pageSize, totalPages, allMatchingContactIds }.
// This is the single choke point Part 2's send path will also call before
// creating recipient records, so "backend must resolve the audience again
// before execution" (from the roadmap) is guaranteed by construction: there
// is no other way to turn an audience definition into recipients.
// Phone-level dedup (see audienceFilter.js's buildDedupedContactsSQL doc
// comment for the full rule + rationale): the count, the paginated
// "Resolved Audience" contact list, and allMatchingContactIds are ALL built
// from the SAME deduped subquery as recipient resolution, so "187 customers
// match" and "the actual recipient list" can never drift apart — one
// normalized phone number is always exactly one row here, and there is no
// second dedup implementation.
//
// `contacts` is only fetched when pageSize > 0 (Step 4's "Resolved
// Audience" list) — Step 2's live count-only preview (called on every
// filter edit) never pays for this extra query. Each contact row carries
// its own real id/contact_number/name/wa_number/source/city/state — the
// audience COUNT is a separate number and is never substituted for any of
// these fields.
async function resolveAudience(workspaceId, audience, { page = 1, pageSize = 0, includeAllIds } = {}) {
  const { where, params } = buildAudienceWhere(workspaceId, audience);
  const dedupedSQL = buildDedupedContactsSQL(where);

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM (${dedupedSQL}) deduped`,
    params
  );
  const count = countRows[0]?.total || 0;

  let contacts = [];
  let totalPages = 0;
  let allMatchingContactIds = [];
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 0));
  // By default the id-only list is only fetched alongside the page of full
  // contact records (unchanged behavior from before this option existed).
  // Phase 6 Part 2 (selection persistence): callers that only need the
  // current set of matching ids — e.g. GET /campaigns/:id, to safely
  // restore a saved selection — can pass includeAllIds: true with
  // pageSize: 0 to get that id list WITHOUT paying for the full
  // name/phone/etc detail query.
  const shouldIncludeAllIds = includeAllIds !== undefined ? includeAllIds : pageSize > 0;

  if (pageSize > 0 && count > 0) {
    const offset = (safePage - 1) * safePageSize;
    const { rows } = await pool.query(
      `SELECT deduped.id, deduped.contact_number, deduped.name, deduped.wa_number,
              deduped.custom_fields->>'source' AS source,
              deduped.custom_fields->>'city' AS city,
              deduped.custom_fields->>'state' AS state
         FROM (${dedupedSQL}) deduped
        ORDER BY deduped.updated_at DESC, deduped.id DESC
        LIMIT ${safePageSize} OFFSET ${offset}`,
      params
    );
    // `deduped.id` is a BIGINT column, and node-postgres returns int8/BIGINT
    // values as STRINGS (not numbers) to avoid silent precision loss —
    // https://github.com/brianc/node-postgres/issues/45. Every other id in
    // this codebase (selected_contact_ids JSONB, sanitizeSelectedContactIds,
    // the frontend's checkbox/Set state) treats contact ids as JS numbers,
    // so leaving these as strings here is what caused the Phase 6 Part 2
    // "individual selection not persisted" bug: GET /campaigns/:id's
    // intersection (`matchingSet.has(Number(id))`) was comparing a NUMBER
    // against a Set built from STRINGS and always missed, silently
    // discarding every individually-selected id on reopen — while "Select
    // All Matching" was unaffected because that branch always returns []
    // unconditionally rather than intersecting. Normalizing to Number here,
    // once, at the single place ids leave the database, fixes both that
    // intersection AND the frontend's own restoration (previewAudience's
    // `allMatchingContactIds` / `contacts[].id` are serialized from this
    // same return value).
    contacts = rows.map((r) => ({ ...r, id: Number(r.id) }));
    totalPages = Math.ceil(count / safePageSize);
  }

  if (shouldIncludeAllIds && count > 0) {
    // Lightweight (id-only) list of every matching, deduplicated contact —
    // separate from the full per-row detail above — so "Select All" can
    // select every matching customer (not just the currently loaded page)
    // without ever fetching name/phone/etc for rows that aren't on screen.
    // Bounded by MAX_AUDIENCE, same cap the rest of Campaign Studio uses.
    const { rows: idRows } = await pool.query(
      `SELECT deduped.id FROM (${dedupedSQL}) deduped
        ORDER BY deduped.updated_at DESC, deduped.id DESC
        LIMIT ${MAX_AUDIENCE}`,
      params
    );
    // Same BIGINT-as-string normalization as `contacts` above — see comment
    // there. This is the array GET /campaigns/:id intersects saved
    // selections against, so leaving it as strings is what made every
    // individual selection look "stale" and get dropped.
    allMatchingContactIds = idRows.map((r) => Number(r.id));
  }

  return { count, contacts, page: safePage, pageSize: safePageSize, totalPages, allMatchingContactIds };
}

// ─── Send Now: FINAL recipient resolution (Phase 6 Part 3A) ───────────────
// Single choke point for "what does Send Now actually send to" — reuses
// buildAudienceWhere + buildDedupedContactsSQL, the SAME functions
// resolveAudience() above (and Target Message) use. No second audience-
// resolution or dedup implementation exists for the send path.
//
// NEVER uses audience_size_cached — always re-resolves against the CURRENT
// contacts table at the moment of Send Now.
//
//   audience_type='filters' + select_all_matching   -> current filter match
//   audience_type='filters' + individual selection  -> filter match ∩ selected_contact_ids
//   audience_type='filters' + no selection at all   -> selected_contact_ids
//       is [], so the intersection is empty — matches the Resolved Audience
//       UI, which shows 0 selected until the user explicitly checks
//       something or clicks "Select all matching" (see
//       ResolvedAudienceList in CampaignStudioPage.jsx). This file does not
//       invent a "send to everyone if nothing was explicitly chosen"
//       fallback; an empty final audience is rejected below with a clear
//       error instead.
//   audience_type='contacts' + select_all_matching  -> the full static list
//       (audience_contact_ids), never selected_contact_ids
//   audience_type='contacts' + individual selection -> static list ∩ selected_contact_ids
//
// One code path handles all cases: select_all_matching bypasses the id
// restriction entirely (never approximated by enumerating every id);
// otherwise the resolved audience is additionally restricted to
// `c.id = ANY(selected_contact_ids)`, which is exactly an intersection for
// a dynamic audience and exactly "only the checked static contacts" for a
// static one.
async function resolveFinalRecipients(workspaceId, campaign) {
  const { where, params } = buildAudienceWhere(workspaceId, toAudience(campaign));

  let finalWhere = where;
  let finalParams = params;
  if (!campaign.select_all_matching) {
    const selectedIds = Array.isArray(campaign.selected_contact_ids)
      ? campaign.selected_contact_ids.map(Number).filter(Number.isFinite)
      : [];
    finalParams = [...params, selectedIds];
    finalWhere = `${where} AND c.id = ANY($${finalParams.length}::bigint[])`;
  }

  const dedupedSQL = buildDedupedContactsSQL(finalWhere);
  const { rows } = await pool.query(
    `SELECT deduped.id, deduped.contact_number, deduped.name
       FROM (${dedupedSQL}) deduped
      ORDER BY deduped.updated_at DESC, deduped.id DESC
      LIMIT ${MAX_AUDIENCE}`,
    finalParams
  );
  // Same BIGINT-as-string normalization as resolveAudience() above — see
  // that function's comment for the full rationale.
  return rows.map((r) => ({ id: Number(r.id), contact_number: r.contact_number, name: r.name || '' }));
}

// Rejects a malformed audience definition before it ever reaches
// buildAudienceWhere/repo.createCampaign — never trust field/operator/
// combinator strings from the client. Returns null when valid.
function validateAudienceInput({ audienceType, filters, combinator }) {
  if (audienceType !== undefined && audienceType !== null && !['contacts', 'filters'].includes(audienceType)) {
    return 'audienceType must be "contacts" or "filters"';
  }
  if (audienceType !== 'contacts') {
    return validateAudienceFilters(filters, combinator);
  }
  return null;
}

function toAudience(campaign) {
  return {
    audienceType: campaign.audience_type,
    filters: campaign.audience_filters,
    combinator: campaign.audience_combinator,
    contactIds: campaign.audience_contact_ids,
  };
}

// Validates the CUSTOMER SELECTION (Step 4 checkboxes) — deliberately
// separate from validateAudienceInput above, which validates the audience
// DEFINITION. Never trust that `selectedContactIds` contains real ids at
// this point (that's checked again on read, against the currently resolved
// audience — see the intersection in GET /campaigns/:id below); this just
// rejects an obviously malformed payload (wrong type, the count mistakenly
// sent as if it were an id list, too many entries).
function validateSelectionInput({ selectedContactIds, selectAllMatching }) {
  if (selectedContactIds !== undefined && selectedContactIds !== null) {
    if (!Array.isArray(selectedContactIds)) return 'selectedContactIds must be an array of contact ids';
    if (selectedContactIds.length > MAX_AUDIENCE) return `selectedContactIds cannot exceed ${MAX_AUDIENCE} entries`;
    if (!selectedContactIds.every((v) => Number.isFinite(Number(v)))) {
      return 'selectedContactIds must contain only numeric contact ids';
    }
  }
  if (selectAllMatching !== undefined && selectAllMatching !== null && typeof selectAllMatching !== 'boolean') {
    return 'selectAllMatching must be a boolean';
  }
  return null;
}

// Deduplicates and normalizes a raw selectedContactIds array into a plain
// array of numbers, ready to persist — never the audience count, always
// real ids.
function sanitizeSelectedContactIds(selectedContactIds) {
  if (!Array.isArray(selectedContactIds)) return [];
  return [...new Set(selectedContactIds.map((v) => Number(v)))];
}

// ─── Part 3B: recipient delivery tracking + campaign status sync ──────────
//
// Root cause (see investigation notes in the PR/commit message): once Send
// Now flips a campaign to 'running' (routes/campaigns.js step 9, above),
// NOTHING ever moves it off 'running' again. Broadcast Studio never has
// this problem because it never persists a terminal status on
// coexistence.broadcasts either — GET /broadcasts and GET /broadcasts/:id
// (routes/broadcasts.js's computeDisplayStatus / the list endpoint's SQL
// CASE) derive SENDING/PARTIAL/FAILED/SENT *live* from coexistence.
// broadcast_logs on every read, so the raw 'SENDING' row never needs to be
// mutated. Campaigns Part 3A copied the "delegate to sendBroadcastById"
// half of that pattern but not the "derive status live from broadcast_logs"
// half — it stamps a one-time 'running' and stops looking.
//
// Fix: reuse the exact same broadcast_logs aggregate broadcasts.js already
// computes (recipient_count / pending_count / failed_count / success_count
// grouped by action='BROADCAST'), and — same as computeDisplayStatus —
// derive the campaign's terminal state live, here, at read time. No new
// table, no push-based webhook->campaigns wiring: the webhook already
// updates chat_history.status (and sendQueue's worker already updates
// broadcast_logs.status to 'sent'/'failed' once each recipient's send job
// finishes); this just asks that existing, already-idempotent data "is
// every recipient done, and did any of them succeed?" whenever a campaign
// is viewed.
//
// completed vs failed mirrors broadcasts.js's own FAILED rule (failed_count
// > 0 AND success_count === 0 -> FAILED): campaigns has no persisted
// "partial" status (CAMPAIGN_STATUSES has only completed/failed), so any
// recipient success is treated as a completed run; only a 100%-failure run
// is 'failed'. Still 'running' (untouched) while any recipient is PENDING,
// or before any broadcast_logs rows exist yet (send in flight).
async function getBroadcastAggregate(broadcastId) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int AS recipient_count,
       COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending_count,
       COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
       COUNT(*) FILTER (WHERE status IN ('sent','delivered','read'))::int AS success_count
     FROM coexistence.broadcast_logs
     WHERE broadcast_id = $1 AND action = 'BROADCAST'`,
    [broadcastId]
  );
  return rows[0] || { recipient_count: 0, pending_count: 0, failed_count: 0, success_count: 0 };
}

// Idempotent: calling this any number of times (concurrent reads, duplicate
// webhooks already resolved into broadcast_logs, page refreshes) always
// recomputes the same aggregate from broadcast_logs and only writes when
// the campaign is still 'running' with a linked broadcast whose recipients
// are all resolved — a campaign already 'completed'/'failed' is a no-op.
async function reconcileCampaignStatus(workspaceId, campaign) {
  if (!campaign || campaign.status !== 'running' || !campaign.broadcast_id) return campaign;

  const agg = await getBroadcastAggregate(campaign.broadcast_id);
  if (agg.recipient_count === 0 || agg.pending_count > 0) return campaign; // still in flight

  const finalStatus = (agg.failed_count > 0 && agg.success_count === 0) ? 'failed' : 'completed';
  const updated = await repo.updateStatus(workspaceId, campaign.id, finalStatus, {
    completed_at: new Date().toISOString(),
  });
  return updated || campaign;
}

// Batched sibling for list views — only touches rows that are actually
// 'running' with a linked broadcast, so a normal list page (mostly draft/
// completed/failed rows) does no extra queries at all.
async function reconcileCampaignRows(workspaceId, rows) {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].status === 'running' && rows[i].broadcast_id) {
      rows[i] = await reconcileCampaignStatus(workspaceId, rows[i]);
    }
  }
  return rows;
}

// ─── List / stats ──────────────────────────────────────────────────────────

router.get('/campaigns', requirePermission('campaign-studio'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.json({ rows: [], total: 0 });

    const { search = '', status = '', channel = '', limit = 50, offset = 0 } = req.query;
    const result = await repo.listCampaigns(workspaceId, { search, status, channel, limit, offset });
    result.rows = await reconcileCampaignRows(workspaceId, result.rows);
    res.json(result);
  } catch (err) {
    console.error('[campaigns] list error:', err.message);
    res.status(500).json({ error: 'Failed to list campaigns' });
  }
});

router.get('/campaigns/stats', requirePermission('campaign-studio'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.json({ total: 0 });
    const stats = await repo.getCampaignStats(workspaceId);
    res.json(stats);
  } catch (err) {
    console.error('[campaigns] stats error:', err.message);
    res.status(500).json({ error: 'Failed to load campaign stats' });
  }
});

// POST /campaigns/audience/preview — resolve an audience definition against
// the caller's workspace WITHOUT creating a campaign. Used by the "Audience"
// step of the campaign wizard for the live estimated-size display. The
// count returned here is a preview only — see the "never trust frontend
// recipient counts" note in resolveAudience() above.
router.post('/campaigns/audience/preview', requirePermission('campaign-studio'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const { audienceType, filters, combinator, contactIds, page, pageSize } = req.body || {};
    const validationError = validateAudienceInput({ audienceType, filters, combinator });
    if (validationError) return res.status(400).json({ error: validationError });

    // pageSize is only sent by Step 4's "Resolved Audience" list — Step 2's
    // live filter-editing preview omits it and gets count-only (no extra
    // query), exactly as before this change.
    const { count, contacts, page: resolvedPage, pageSize: resolvedPageSize, totalPages, allMatchingContactIds } = await resolveAudience(
      workspaceId,
      { audienceType, filters, combinator, contactIds },
      { page: page || 1, pageSize: pageSize || 0 }
    );
    res.json({
      count,
      contacts,
      page: resolvedPage,
      pageSize: resolvedPageSize,
      totalPages,
      allMatchingContactIds,
      exceedsLimit: count > MAX_AUDIENCE,
      limit: MAX_AUDIENCE,
    });
  } catch (err) {
    console.error('[campaigns] audience preview error:', err.message);
    res.status(500).json({ error: 'Failed to resolve audience' });
  }
});

// GET /campaigns/audience/sources — returns the ACTUAL distinct
// custom_fields.source values present in this workspace's contacts, each
// with its live count, plus a separate count of contacts with no source
// recorded at all. This exists so the "Customer source" filter in the UI
// never shows an option (e.g. "Manual import", "CSV import") that isn't
// backed by real data in this workspace — see Part 1 follow-up: those two
// were previously hardcoded in the frontend regardless of whether any
// contact actually had that source, which is misleading. The frontend maps
// each raw value to a friendly label (e.g. shopify_sheet_sync -> "Shopify");
// this endpoint intentionally returns the raw stored value, never a label,
// since that raw value is what audience filters actually match against.
//
// Phase 6 Part 2.5 follow-up (source-count/audience-count mismatch): this
// used to GROUP BY directly over coexistence.contacts, i.e. RAW rows —
// e.g. Shopify showed (264) — while /campaigns/audience/preview (and every
// other audience count) counts over buildDedupedContactsSQL's one-row-per-
// contact_number result, e.g. Shopify audience = 187. Same underlying data,
// two different populations, so the dropdown and the preview disagreed.
// Fix: group over the SAME deduped subquery used everywhere else (single
// source of truth stays in audienceFilter.js — no second dedup algorithm
// here or in the frontend), so both counts are always the deduplicated
// customer-phone-number count.
router.get('/campaigns/audience/sources', requirePermission('campaign-studio'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.json({ sources: [], unknownCount: 0 });

    const { where, params } = buildAudienceWhere(workspaceId, {});
    const dedupedSQL = buildDedupedContactsSQL(where);

    const { rows } = await pool.query(
      `SELECT NULLIF(deduped.custom_fields->>'source', '') AS source, COUNT(*)::int AS count
         FROM (${dedupedSQL}) deduped
        GROUP BY 1`,
      params
    );

    const sources = rows.filter((r) => r.source).map((r) => ({ value: r.source, count: r.count }));
    const unknownCount = rows.filter((r) => !r.source).reduce((sum, r) => sum + r.count, 0);
    res.json({ sources, unknownCount });
  } catch (err) {
    console.error('[campaigns] audience sources error:', err.message);
    res.status(500).json({ error: 'Failed to load customer sources' });
  }
});

// ─── Detail ─────────────────────────────────────────────────────────────

router.get('/campaigns/:id', requirePermission('campaign-studio'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    let campaign = await repo.getCampaignById(workspaceId, req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Part 3B: a 'running' campaign is only ever a snapshot from the moment
    // Send Now enqueued it — see reconcileCampaignStatus's doc comment above
    // for why this has to be re-derived live rather than pushed.
    campaign = await reconcileCampaignStatus(workspaceId, campaign);

    // Refresh the cached audience size on every detail view — cheap, and
    // keeps the UI honest without requiring a separate "recount" action.
    // includeAllIds: true (with the default pageSize: 0) also gets us the
    // current set of matching ids WITHOUT paying for the full contacts-page
    // query, purely so the persisted selection below can be safety-checked.
    const { count, allMatchingContactIds } = await resolveAudience(workspaceId, toAudience(campaign), { includeAllIds: true });
    await repo.updateAudienceCache(workspaceId, campaign.id, count);
    campaign.audience_size_cached = count;

    // Phase 6 Part 2 — customer SELECTION persistence safety check: a saved
    // selection must never resurrect an id that no longer belongs to the
    // CURRENT resolved audience (the audience definition may have changed,
    // or matching contacts may have changed, since Save Draft). Intersect
    // against allMatchingContactIds rather than trusting the stored array
    // as-is. When select_all_matching was saved, the explicit id list is
    // not authoritative (the frontend re-derives "select all" against the
    // live resolved audience), so it's returned empty to avoid the
    // frontend accidentally treating it as a partial selection.
    const matchingSet = new Set(allMatchingContactIds);
    const savedSelected = Array.isArray(campaign.selected_contact_ids) ? campaign.selected_contact_ids : [];
    campaign.selected_contact_ids = campaign.select_all_matching
      ? []
      : savedSelected.filter((id) => matchingSet.has(Number(id)));

    res.json(campaign);
  } catch (err) {
    console.error('[campaigns] get error:', err.message);
    res.status(500).json({ error: 'Failed to load campaign' });
  }
});

// ─── Create ─────────────────────────────────────────────────────────────

async function validateReferences(workspaceId, { fromNumber, templateId, mediaLibraryId }) {
  if (fromNumber) {
    const account = await getAccountByPhoneNumber(fromNumber, workspaceId);
    if (!account) return 'fromNumber does not belong to a WhatsApp account in this workspace';
  }
  if (templateId) {
    const { rows } = await pool.query(
      'SELECT id FROM coexistence.message_templates WHERE id = $1 AND workspace_id = $2',
      [templateId, workspaceId]
    );
    if (!rows.length) return 'templateId does not belong to this workspace';
  }
  if (mediaLibraryId) {
    const { rows } = await pool.query(
      'SELECT id FROM coexistence.media_library WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL',
      [mediaLibraryId, workspaceId]
    );
    if (!rows.length) return 'mediaLibraryId does not belong to this workspace';
  }
  return null;
}

// Phase 8F-4A: the Phase 8F-3 pilot requireFeature(SAMPLE_FEATURE_A) gate
// below was removed — no plan granted that feature, so it blocked campaign
// creation for every workspace. Restored to pre-8F-3 behavior: only the
// existing requirePermission('campaign-studio') role check applies. The
// hasFeature()/requireFeature() foundation itself is untouched; this route
// simply no longer uses it.
router.post('/campaigns', requirePermission('campaign-studio'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const body = req.body || {};
    if (!body.name || !String(body.name).trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const audienceError = validateAudienceInput({
      audienceType: body.audienceType, filters: body.audienceFilters, combinator: body.audienceCombinator,
    });
    if (audienceError) return res.status(400).json({ error: audienceError });

    const selectionError = validateSelectionInput({
      selectedContactIds: body.selectedContactIds, selectAllMatching: body.selectAllMatching,
    });
    if (selectionError) return res.status(400).json({ error: selectionError });

    const refError = await validateReferences(workspaceId, body);
    if (refError) return res.status(403).json({ error: refError });

    const campaign = await repo.createCampaign(
      workspaceId,
      { ...body, selectedContactIds: sanitizeSelectedContactIds(body.selectedContactIds), selectAllMatching: !!body.selectAllMatching },
      req.user?.id ?? null
    );
    res.json(campaign);
  } catch (err) {
    console.error('[campaigns] create error:', err.message);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
});

// ─── Update (draft only) ───────────────────────────────────────────────

router.put('/campaigns/:id', requirePermission('campaign-studio'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const existing = await repo.getCampaignById(workspaceId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Campaign not found' });
    if (!EDITABLE_STATUSES.has(existing.status)) {
      return res.status(409).json({ error: `Campaign in status "${existing.status}" can no longer be edited` });
    }

    const body = req.body || {};

    // Partial-update fix (Phase 6 Part 1 bugfix): the frontend wizard only
    // sends the fields relevant to whichever step the user is saving from
    // (e.g. saving after just editing the audience step does not resend
    // campaign_type, channel, message fields, etc). Previously this file
    // forwarded req.body straight to repo.updateCampaign(), which did a
    // full-column SET — any field missing from the request body became
    // undefined -> NULL, which then violated NOT NULL constraints (this is
    // exactly how "campaign_type" ended up NULL). Fix: merge the incoming
    // body over the existing row so any field the client didn't send keeps
    // its current value. A field is only changed when the client explicitly
    // includes it (even `null` is respected as an explicit clear for
    // nullable columns) — only `undefined` (key absent) falls back to the
    // existing value.
    const merged = {
      name: body.name !== undefined ? body.name : existing.name,
      description: body.description !== undefined ? body.description : existing.description,
      channel: body.channel !== undefined ? body.channel : existing.channel,
      campaignType: body.campaignType !== undefined ? body.campaignType : existing.campaign_type,
      audienceType: body.audienceType !== undefined ? body.audienceType : existing.audience_type,
      audienceFilters: body.audienceFilters !== undefined ? body.audienceFilters : existing.audience_filters,
      audienceCombinator: body.audienceCombinator !== undefined ? body.audienceCombinator : existing.audience_combinator,
      audienceContactIds: body.audienceContactIds !== undefined ? body.audienceContactIds : existing.audience_contact_ids,
      selectedContactIds: body.selectedContactIds !== undefined ? body.selectedContactIds : existing.selected_contact_ids,
      selectAllMatching: body.selectAllMatching !== undefined ? body.selectAllMatching : existing.select_all_matching,
      fromNumber: body.fromNumber !== undefined ? body.fromNumber : existing.from_number,
      templateId: body.templateId !== undefined ? body.templateId : existing.template_id,
      messageType: body.messageType !== undefined ? body.messageType : existing.message_type,
      body: body.body !== undefined ? body.body : existing.body,
      variableMapping: body.variableMapping !== undefined ? body.variableMapping : existing.variable_mapping,
      mediaLibraryId: body.mediaLibraryId !== undefined ? body.mediaLibraryId : existing.media_library_id,
      caption: body.caption !== undefined ? body.caption : existing.caption,
    };

    if (!merged.name || !String(merged.name).trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const audienceError = validateAudienceInput({
      audienceType: merged.audienceType, filters: merged.audienceFilters, combinator: merged.audienceCombinator,
    });
    if (audienceError) return res.status(400).json({ error: audienceError });

    const selectionError = validateSelectionInput({
      selectedContactIds: merged.selectedContactIds, selectAllMatching: merged.selectAllMatching,
    });
    if (selectionError) return res.status(400).json({ error: selectionError });
    merged.selectedContactIds = sanitizeSelectedContactIds(merged.selectedContactIds);
    merged.selectAllMatching = !!merged.selectAllMatching;

    const refError = await validateReferences(workspaceId, merged);
    if (refError) return res.status(403).json({ error: refError });

    const updated = await repo.updateCampaign(workspaceId, req.params.id, merged);
    res.json(updated);
  } catch (err) {
    console.error('[campaigns] update error:', err.message);
    res.status(500).json({ error: 'Failed to update campaign' });
  }
});

// ─── Send Now (Phase 6 Part 3A) ────────────────────────────────────────────
// Only 'draft' campaigns may be sent here. Scheduling (which would introduce
// a 'scheduled' -> send transition) is explicitly out of scope for this
// prompt — see campaignsSchema.js's CAMPAIGN_STATUSES for the full set this
// file deliberately does not expand.
const SENDABLE_STATUSES = new Set(['draft']);

router.post('/campaigns/:id/send', requirePermission('campaign-studio'), async (req, res) => {
  const workspaceId = req.workspace?.id ?? null;
  if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

  try {
    // 1) Load + ownership (getCampaignById's WHERE clause already scopes to
    // workspaceId — a campaign in another workspace is indistinguishable
    // from a non-existent one, i.e. 404 either way).
    const campaign = await repo.getCampaignById(workspaceId, req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!SENDABLE_STATUSES.has(campaign.status)) {
      return res.status(409).json({ error: `Campaign in status "${campaign.status}" cannot be sent` });
    }

    // 2) Verify the WhatsApp account / from number.
    if (!campaign.from_number) {
      return res.status(400).json({ error: 'Campaign has no from_number set' });
    }
    const account = await getAccountByPhoneNumber(campaign.from_number, workspaceId);
    if (!account) {
      return res.status(400).json({ error: 'from_number does not belong to a WhatsApp account in this workspace' });
    }

    // 3) Verify the selected template/message.
    const msgType = campaign.message_type || 'template';
    if (msgType === 'template') {
      if (!campaign.template_id) return res.status(400).json({ error: 'Campaign has no template selected' });
      const { rows: tplRows } = await pool.query(
        'SELECT id FROM coexistence.message_templates WHERE id = $1 AND workspace_id = $2',
        [campaign.template_id, workspaceId]
      );
      if (!tplRows.length) return res.status(403).json({ error: 'templateId does not belong to this workspace' });
    }
    if (campaign.media_library_id) {
      const { rows: mediaRows } = await pool.query(
        'SELECT id FROM coexistence.media_library WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL',
        [campaign.media_library_id, workspaceId]
      );
      if (!mediaRows.length) return res.status(403).json({ error: 'mediaLibraryId does not belong to this workspace' });
    }

    // 4) Resolve the FINAL recipients — never audience_size_cached. See
    // resolveFinalRecipients' doc comment above for the exact per-case
    // rules (Select All Matching / individual selection / static list).
    const recipients = await resolveFinalRecipients(workspaceId, campaign);
    if (recipients.length === 0) {
      return res.status(400).json({ error: 'No customers match the final selection — nothing to send' });
    }
    if (recipients.length > MAX_AUDIENCE) {
      return res.status(400).json({ error: `Final audience exceeds ${MAX_AUDIENCE} — narrow your filters/selection` });
    }

    // Lazy require — see the top-of-file comment on why sendBroadcastById
    // is not imported at module load time.
    const { sendBroadcastById } = require('./broadcasts');

    // 5) Double-send protection: atomically claim the campaign by flipping
    // its status away from 'draft' inside a row-locked transaction.
    // Two concurrent POSTs (double-click, browser retry, two backend
    // processes, a scheduler/manual race) both reach this point; only the
    // request holding the row lock when it re-checks status still sees
    // 'draft' — the other sees whatever the winner just committed and is
    // rejected with 409. This is Postgres row locking, not an in-memory
    // flag, so it holds across concurrent requests AND across multiple
    // backend processes.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: lockRows } = await client.query(
        `SELECT status FROM coexistence.campaigns WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
        [campaign.id, workspaceId]
      );
      if (lockRows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Campaign not found' });
      }
      if (!SENDABLE_STATUSES.has(lockRows[0].status)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `Campaign in status "${lockRows[0].status}" cannot be sent` });
      }
      await client.query(
        `UPDATE coexistence.campaigns
            SET status = 'queued', started_at = COALESCE(started_at, NOW())
          WHERE id = $1 AND workspace_id = $2`,
        [campaign.id, workspaceId]
      );
      await client.query('COMMIT');
    } catch (lockErr) {
      await client.query('ROLLBACK');
      throw lockErr;
    } finally {
      client.release();
    }

    // From here on the campaign is claimed ('queued'); any failure below
    // must flip it to 'failed' rather than leave it stuck on 'queued' or
    // silently report success for a failed execution.
    try {
      // 6) Recipients are already deduplicated by phone number
      // (resolveFinalRecipients' buildDedupedContactsSQL — one row per
      // contact_number). Create exactly ONE broadcast execution.
      const recipientNumbers = recipients.map((r) => ({ contact_number: r.contact_number, name: r.name || '' }));
      const { rows: inserted } = await pool.query(
        `INSERT INTO coexistence.broadcasts
           (workspace_id, from_number, recipient_numbers, template_id, status, name,
            variable_mapping, message_type, body, url, media_library_id, caption, source, updated_at)
         VALUES ($1,$2,$3,$4,'DRAFT',$5,$6,$7,$8,$9,$10,$11,'campaign',NOW())
         RETURNING id`,
        [
          workspaceId, campaign.from_number, JSON.stringify(recipientNumbers), campaign.template_id || null,
          campaign.name,
          JSON.stringify(campaign.variable_mapping || {}), msgType,
          campaign.body || null, null, campaign.media_library_id || null, campaign.caption || null,
        ]
      );
      const broadcastId = inserted[0].id;

      // 7) Link campaigns.broadcast_id BEFORE delegating to send, so a
      // crash mid-send still leaves the campaign -> broadcast linkage
      // intact for inspection.
      await repo.updateStatus(workspaceId, campaign.id, 'queued', { broadcast_id: broadcastId });

      // 8) Delegate to the EXISTING broadcast/queue/Meta pipeline — the
      // exact function the interactive POST /broadcasts/:id/send route
      // calls. No second sender, queue, or Meta integration is created.
      const { statusCode, body } = await sendBroadcastById(workspaceId, broadcastId);
      if (statusCode >= 400) {
        await repo.updateStatus(workspaceId, campaign.id, 'failed');
        return res.status(statusCode).json({ error: body.error || 'Failed to send broadcast', broadcastId });
      }

      // 9) Update campaign status. 'running' mirrors the broadcast's own
      // 'SENDING' status (see computeDisplayStatus in routes/broadcasts.js).
      // Auto-transition to 'completed' from recipient-level outcomes is
      // analytics/later-phase territory — explicitly out of scope here.
      const finalCampaign = await repo.updateStatus(workspaceId, campaign.id, 'running');

      res.json({
        campaign: finalCampaign,
        broadcastId,
        recipientCount: recipients.length,
        enqueued: body.enqueued,
      });
    } catch (execErr) {
      console.error('[campaigns] send execution error:', execErr.message, execErr.stack);
      await repo.updateStatus(workspaceId, campaign.id, 'failed').catch(() => {});
      res.status(500).json({ error: 'Failed to send campaign' });
    }
  } catch (err) {
    console.error('[campaigns] send error:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to send campaign' });
  }
});

// ─── Schedule (Phase 6 Part 3C) ────────────────────────────────────────────
// Reuses the EXISTING broadcastScheduler.js infrastructure (poll
// coexistence.broadcasts every 60s for status='SCHEDULED' AND scheduled_at
// <= NOW(), using SELECT ... FOR UPDATE SKIP LOCKED so a broadcast can never
// fire twice — see services/broadcastScheduler.js). No second scheduler is
// created here.
//
// Mirrors Send Now's own validation + broadcast-creation shape exactly
// (same recipient resolution, same account/template checks, same atomic
// draft-claim transaction) with two differences:
//   1. the new broadcast row is inserted as status='SCHEDULED' with
//      scheduled_at=<value> instead of status='DRAFT', and
//      sendBroadcastById is never called here — broadcastScheduler.js
//      calls executeBroadcast() itself once scheduled_at arrives.
//   2. the campaign is claimed into 'scheduled' (not 'queued'/'running').
//
// Timezone handling: the client sends a full ISO-8601 string (already
// converted from the browser's local wall-clock reading via
// `new Date(localDateStr).toISOString()` — the same approach
// BulkMessagePage.jsx/routes/broadcasts.js's PUT route already use for
// Broadcast Studio). This route only re-validates that string; it never
// re-interprets or reformats the wall-clock value itself, so there is no
// second timezone-conversion implementation to drift from the existing one.
const SCHEDULABLE_STATUSES = new Set(['draft']);
// Same 60-second buffer PUT /broadcasts/:id already uses (routes/
// broadcasts.js) — protects against clock skew between browser and server
// rejecting a schedule time the user picked a moment ago.
const SCHEDULE_MIN_LEAD_MS = 60 * 1000;

function parseScheduledAt(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { error: 'scheduledAt is required' };
  }
  const d = new Date(raw);
  if (isNaN(d.getTime())) {
    return { error: 'scheduledAt must be a valid ISO date string' };
  }
  if (d.getTime() < Date.now() - SCHEDULE_MIN_LEAD_MS) {
    return { error: 'scheduledAt must be in the future' };
  }
  return { value: d };
}

router.post('/campaigns/:id/schedule', requirePermission('campaign-studio'), async (req, res) => {
  const workspaceId = req.workspace?.id ?? null;
  if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

  try {
    const { error: scheduleErr, value: scheduledAt } = parseScheduledAt(req.body?.scheduledAt);
    if (scheduleErr) return res.status(400).json({ error: scheduleErr });

    // 1) Load + ownership — identical shape to Send Now step 1.
    const campaign = await repo.getCampaignById(workspaceId, req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!SCHEDULABLE_STATUSES.has(campaign.status)) {
      return res.status(409).json({ error: `Campaign in status "${campaign.status}" cannot be scheduled` });
    }

    // 2) Verify the WhatsApp account / from number — identical to Send Now.
    if (!campaign.from_number) {
      return res.status(400).json({ error: 'Campaign has no from_number set' });
    }
    const account = await getAccountByPhoneNumber(campaign.from_number, workspaceId);
    if (!account) {
      return res.status(400).json({ error: 'from_number does not belong to a WhatsApp account in this workspace' });
    }

    // 3) Verify the selected template/message — identical to Send Now.
    const msgType = campaign.message_type || 'template';
    if (msgType === 'template') {
      if (!campaign.template_id) return res.status(400).json({ error: 'Campaign has no template selected' });
      const { rows: tplRows } = await pool.query(
        'SELECT id FROM coexistence.message_templates WHERE id = $1 AND workspace_id = $2',
        [campaign.template_id, workspaceId]
      );
      if (!tplRows.length) return res.status(403).json({ error: 'templateId does not belong to this workspace' });
    }
    if (campaign.media_library_id) {
      const { rows: mediaRows } = await pool.query(
        'SELECT id FROM coexistence.media_library WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL',
        [campaign.media_library_id, workspaceId]
      );
      if (!mediaRows.length) return res.status(403).json({ error: 'mediaLibraryId does not belong to this workspace' });
    }

    // 4) Resolve the FINAL recipients NOW, same as Send Now — a schedule
    // with zero recipients is rejected up front rather than silently firing
    // to nobody later. (The scheduler/executeBroadcast will re-derive
    // status live from broadcast_logs same as any other broadcast; the
    // recipient LIST itself is frozen into the broadcast row at schedule
    // time, exactly like Send Now freezes it at send time — Part 3C does
    // not add a second "re-resolve audience at fire time" behavior.)
    const recipients = await resolveFinalRecipients(workspaceId, campaign);
    if (recipients.length === 0) {
      return res.status(400).json({ error: 'No customers match the final selection — nothing to schedule' });
    }
    if (recipients.length > MAX_AUDIENCE) {
      return res.status(400).json({ error: `Final audience exceeds ${MAX_AUDIENCE} — narrow your filters/selection` });
    }

    // 5) Duplicate-scheduling protection: identical row-locked atomic claim
    // pattern as Send Now step 5 — two concurrent "Schedule" clicks (double
    // click, retry) both reach here; only the request holding the row lock
    // when it re-checks status still sees 'draft'.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: lockRows } = await client.query(
        `SELECT status FROM coexistence.campaigns WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
        [campaign.id, workspaceId]
      );
      if (lockRows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Campaign not found' });
      }
      if (!SCHEDULABLE_STATUSES.has(lockRows[0].status)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `Campaign in status "${lockRows[0].status}" cannot be scheduled` });
      }
      await client.query(
        `UPDATE coexistence.campaigns
            SET status = 'scheduled', scheduled_at = $3
          WHERE id = $1 AND workspace_id = $2`,
        [campaign.id, workspaceId, scheduledAt.toISOString()]
      );
      await client.query('COMMIT');
    } catch (lockErr) {
      await client.query('ROLLBACK');
      throw lockErr;
    } finally {
      client.release();
    }

    // From here on the campaign is claimed ('scheduled'); any failure below
    // must roll it back to 'draft' rather than leave it stuck 'scheduled'
    // with no broadcast behind it.
    try {
      // 6) Create the broadcast ALREADY as SCHEDULED — this is the seam
      // broadcastScheduler.js's existing poll picks up; no new scheduler.
      const recipientNumbers = recipients.map((r) => ({ contact_number: r.contact_number, name: r.name || '' }));
      const { rows: inserted } = await pool.query(
        `INSERT INTO coexistence.broadcasts
           (workspace_id, from_number, recipient_numbers, template_id, status, name,
            variable_mapping, message_type, body, url, media_library_id, caption, source,
            scheduled_at, updated_at)
         VALUES ($1,$2,$3,$4,'SCHEDULED',$5,$6,$7,$8,$9,$10,$11,'campaign',$12,NOW())
         RETURNING id`,
        [
          workspaceId, campaign.from_number, JSON.stringify(recipientNumbers), campaign.template_id || null,
          campaign.name,
          JSON.stringify(campaign.variable_mapping || {}), msgType,
          campaign.body || null, null, campaign.media_library_id || null, campaign.caption || null,
          scheduledAt.toISOString(),
        ]
      );
      const broadcastId = inserted[0].id;

      // 7) Link campaigns.broadcast_id — same as Send Now step 7. A crash
      // here still leaves the campaign's 'scheduled' state pointing at a
      // real SCHEDULED broadcast for inspection/cancellation.
      const finalCampaign = await repo.updateStatus(workspaceId, campaign.id, 'scheduled', { broadcast_id: broadcastId });

      res.json({
        campaign: finalCampaign,
        broadcastId,
        recipientCount: recipients.length,
        scheduledAt: scheduledAt.toISOString(),
      });
    } catch (execErr) {
      console.error('[campaigns] schedule execution error:', execErr.message, execErr.stack);
      // Roll the claim back to 'draft' — no broadcast was successfully
      // linked, so there is nothing for the scheduler to (mis)fire.
      await repo.updateStatus(workspaceId, campaign.id, 'draft', { scheduled_at: null }).catch(() => {});
      res.status(500).json({ error: 'Failed to schedule campaign' });
    }
  } catch (err) {
    console.error('[campaigns] schedule error:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to schedule campaign' });
  }
});

// ─── Cancel Schedule (Phase 6 Part 3C) ─────────────────────────────────────
// Only 'scheduled' campaigns. Cancels the linked SCHEDULED broadcast FIRST
// (flips it back to DRAFT with scheduled_at cleared, via the same update
// shape as POST /broadcasts/:id/cancel-schedule) so broadcastScheduler.js's
// poll can never pick it up after this returns, THEN reverts the campaign
// to 'draft' so it's editable/re-schedulable again. Row-locked so this
// cannot race with the scheduler's own SKIP LOCKED claim: if the scheduler
// has already locked+flipped the broadcast to SENDING in this same instant,
// the UPDATE ... WHERE status = 'SCHEDULED' below simply matches zero rows
// (the broadcast is no longer SCHEDULED) and cancellation is correctly
// rejected as "already firing" rather than corrupting an in-flight send.
router.post('/campaigns/:id/cancel-schedule', requirePermission('campaign-studio'), async (req, res) => {
  const workspaceId = req.workspace?.id ?? null;
  if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

  try {
    const campaign = await repo.getCampaignById(workspaceId, req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.status !== 'scheduled') {
      return res.status(409).json({ error: `Campaign in status "${campaign.status}" is not scheduled` });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: lockRows } = await client.query(
        `SELECT status, broadcast_id FROM coexistence.campaigns WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
        [campaign.id, workspaceId]
      );
      if (lockRows.length === 0 || lockRows[0].status !== 'scheduled') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Campaign is not scheduled' });
      }
      const broadcastId = lockRows[0].broadcast_id;

      if (broadcastId) {
        // Only clears the broadcast if it is STILL SCHEDULED — if the
        // scheduler already claimed it (SCHEDULED -> SENDING) this matches
        // zero rows, which is exactly the "too late to cancel" case.
        const { rowCount } = await client.query(
          `UPDATE coexistence.broadcasts
              SET status = 'DRAFT', scheduled_at = NULL, updated_at = NOW()
            WHERE id = $1 AND status = 'SCHEDULED' AND workspace_id = $2`,
          [broadcastId, workspaceId]
        );
        if (rowCount === 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Campaign has already started sending and cannot be cancelled' });
        }
      }

      await client.query(
        `UPDATE coexistence.campaigns
            SET status = 'draft', scheduled_at = NULL, broadcast_id = NULL
          WHERE id = $1 AND workspace_id = $2`,
        [campaign.id, workspaceId]
      );
      await client.query('COMMIT');
    } catch (lockErr) {
      await client.query('ROLLBACK');
      throw lockErr;
    } finally {
      client.release();
    }

    const updated = await repo.getCampaignById(workspaceId, campaign.id);
    res.json(updated);
  } catch (err) {
    console.error('[campaigns] cancel-schedule error:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to cancel schedule' });
  }
});

// ─── Duplicate ──────────────────────────────────────────────────────────

router.post('/campaigns/:id/duplicate', requirePermission('campaign-studio'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const existing = await repo.getCampaignById(workspaceId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Campaign not found' });

    const copy = await repo.createCampaign(
      workspaceId,
      {
        name: `${existing.name} (copy)`,
        description: existing.description,
        channel: existing.channel,
        campaignType: existing.campaign_type,
        audienceType: existing.audience_type,
        audienceFilters: existing.audience_filters,
        audienceCombinator: existing.audience_combinator,
        audienceContactIds: existing.audience_contact_ids,
        fromNumber: existing.from_number,
        templateId: existing.template_id,
        messageType: existing.message_type,
        body: existing.body,
        variableMapping: existing.variable_mapping,
        mediaLibraryId: existing.media_library_id,
        caption: existing.caption,
      },
      req.user?.id ?? null
    );
    res.json(copy);
  } catch (err) {
    console.error('[campaigns] duplicate error:', err.message);
    res.status(500).json({ error: 'Failed to duplicate campaign' });
  }
});

// ─── Cancel (draft/scheduled only in Part 1 — running-campaign cancel with
// queue interaction is implemented in Part 2 alongside pause/resume) ──────
router.post('/campaigns/:id/cancel', requirePermission('campaign-studio'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const existing = await repo.getCampaignById(workspaceId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Campaign not found' });
    if (!['draft', 'scheduled'].includes(existing.status)) {
      return res.status(409).json({
        error: `Campaign in status "${existing.status}" cannot be cancelled here — pause/cancel-during-run ships in Part 2`,
      });
    }

    // Phase 6 Part 3C: a 'scheduled' campaign has a real SCHEDULED broadcast
    // linked (broadcast_id) that broadcastScheduler.js's existing poll will
    // otherwise still fire on schedule — cancelling the CAMPAIGN must also
    // pull that broadcast out of SCHEDULED, or the send happens anyway with
    // no campaign left in 'scheduled' to show it. Same "only clears if
    // still SCHEDULED" guard as POST /campaigns/:id/cancel-schedule: if the
    // scheduler already claimed it (SCHEDULED -> SENDING) between this
    // load and now, the campaign is left as-is (not cancelled) rather than
    // cancelling a campaign whose message already started sending.
    if (existing.status === 'scheduled' && existing.broadcast_id) {
      const { rowCount } = await pool.query(
        `UPDATE coexistence.broadcasts
            SET status = 'DRAFT', scheduled_at = NULL, updated_at = NOW()
          WHERE id = $1 AND status = 'SCHEDULED' AND workspace_id = $2`,
        [existing.broadcast_id, workspaceId]
      );
      if (rowCount === 0) {
        return res.status(409).json({ error: 'Campaign has already started sending and cannot be cancelled' });
      }
    }

    const updated = await repo.updateStatus(workspaceId, existing.id, 'cancelled');
    res.json(updated);
  } catch (err) {
    console.error('[campaigns] cancel error:', err.message);
    res.status(500).json({ error: 'Failed to cancel campaign' });
  }
});
// ─── Delete (draft/cancelled only) ──────────────────────────────────────
router.delete('/campaigns/:id', requirePermission('campaign-studio'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const existing = await repo.getCampaignById(workspaceId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Campaign not found' });
    if (!['draft', 'cancelled'].includes(existing.status)) {
      return res.status(409).json({ error: `Campaign in status "${existing.status}" cannot be deleted` });
    }

    await repo.deleteCampaign(workspaceId, existing.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[campaigns] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete campaign' });
  }
});
module.exports = {
  router, resolveAudience, resolveFinalRecipients, validateSelectionInput, sanitizeSelectedContactIds, MAX_AUDIENCE,
  getBroadcastAggregate, reconcileCampaignStatus, reconcileCampaignRows,
  parseScheduledAt,
};