// Phase 6.2/6.3/6.4 — WhatsApp Flows: Flow CRUD, JSON Builder/Validation,
// Meta registration/publish, and manual Flow sending.
//
// Builds on Phase 6.1's schema-only foundation (coexistence.flows /
// flow_versions / flow_submissions — see db/flowsSchema.js). Flow DRAFT
// CRUD, server-side generation/validation of Meta-compatible Flow JSON,
// registering/publishing a Flow with Meta (see the "Send (Phase 6.4)"
// section below for manual sending) all live here. nfm_reply handling
// (mapping a contact's Flow submission back to flow_submissions) remains
// out of scope — Phase 6.5.
//
// Conventions reused unchanged from routes/sequences.js / routes/chatbots.js:
//   - every route is workspace-scoped via req.workspace.id (resolved
//     server-side by middleware/workspaceContext.js's attachWorkspace —
//     never taken from the client)
//   - requirePermission('flow-builder') gates every route the same way
//     requirePermission('sequence-studio') gates routes/sequences.js
//   - a flow belonging to another workspace is indistinguishable from one
//     that doesn't exist (404 either way) — WHERE workspace_id = $2 is
//     never omitted from a flows lookup
//   - only a DRAFT flow may be edited/deleted (EDITABLE_STATUSES), same
//     "status flag over row deletion" shape sequences.js/campaigns.js use
//   - structured validation errors ({ error, details: [{ path, message }] })
//     rather than a single flat string, so the frontend Flow builder can
//     highlight the exact field/screen that failed

const crypto = require('crypto');
const { Router } = require('express');
const pool = require('../db');
const { requirePermission } = require('../middleware/access');
const { validateFlowDefinition } = require('../services/flowValidation');
const { buildFlowJson } = require('../services/flowJsonBuilder');
const { getAccountWithToken } = require('./whatsappAccounts');
const { markAccountHealth } = require('../services/accountHealth');
const {
  createFlow: metaCreateFlow,
  updateFlowJson: metaUpdateFlowJson,
  publishFlow: metaPublishFlow,
  getFlowStatus: metaGetFlowStatus,
  deprecateFlow: metaDeprecateFlow,
} = require('../integrations/metaFlows');
const { resolveAccount, insertPendingRow } = require('../services/messageSender');
const { enqueueSend } = require('../queue/sendQueue');

const router = Router();

const MAX_NAME_LENGTH = 255;

// A flow's structural definition (name/whatsappAccountId/screens) may
// normally only be changed while it is still a draft — once published,
// editing draft content in place would silently invalidate whatever was
// already registered with Meta. Mirrors sequences.js's EDITABLE_STATUSES.
// The one addition (Phase 6.8 fix — "Edit Flow" on a published flow):
// PUT is also allowed for a 'published' flow once POST
// /flows/:id/draft-version has opened a new, not-yet-published version on
// top of it — see isEditableFlow() below, which every editability check
// in this file now goes through instead of testing EDITABLE_STATUSES
// directly. EDITABLE_STATUSES itself is unchanged and still governs
// DELETE (a published flow may never be deleted, draft-version or not).
const EDITABLE_STATUSES = new Set(['draft']);

// ─── Helpers ─────────────────────────────────────────────────────────────

function currentWorkspaceId(req) {
  return req.workspace?.id ?? null;
}

// Verifies whatsappAccountId (if provided) belongs to this workspace.
// Never trusts the client's claim that an account is theirs — same
// pattern as services/businessFieldDefinitionService.js /
// services/zohoConnectionService.js's ownership checks.
async function assertAccountOwnership(workspaceId, whatsappAccountId) {
  if (whatsappAccountId === undefined || whatsappAccountId === null || whatsappAccountId === '') {
    return null; // no account scoping requested — allowed (workspace-wide flow)
  }
  const { rows } = await pool.query(
    `SELECT id FROM coexistence.whatsapp_accounts WHERE id = $1 AND workspace_id = $2`,
    [whatsappAccountId, workspaceId]
  );
  if (!rows.length) return 'whatsappAccountId does not belong to this workspace';
  return null;
}

function validateFlowInput({ name }) {
  if (!name || !String(name).trim()) return 'name is required';
  if (String(name).trim().length > MAX_NAME_LENGTH) return `name cannot exceed ${MAX_NAME_LENGTH} characters`;
  return null;
}

// Row-shape helper: fetch a flow scoped to this workspace, or null.
// Never omits workspace_id from the WHERE clause — see file header.
async function getFlowById(workspaceId, flowId) {
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.flows WHERE id = $1 AND workspace_id = $2`,
    [flowId, workspaceId]
  );
  return rows[0] || null;
}

// Latest version row for a flow (by version_number), or null if the flow
// has never had a definition saved (a freshly-created flow with no
// screens yet — see POST /flows).
async function getLatestVersion(flowId) {
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.flow_versions
      WHERE flow_id = $1
      ORDER BY version_number DESC
      LIMIT 1`,
    [flowId]
  );
  const latest = rows[0] || null;
  if (!latest) return null;

  // Version-linking fix (Phase 6.3): a flow_version saved before
  // createNextVersion carried meta_flow_id forward (see below) can be
  // missing it even though an earlier version of this same flow was
  // already registered with Meta. Without this fallback, every caller
  // (meta/create, meta/upload-json, meta/publish, meta/status,
  // meta/deprecate, and the flow detail/list responses) would treat an
  // already-registered flow as brand-new. This never mutates the stored
  // row or picks up flow_json from another version — only meta_flow_id /
  // meta_status are backfilled onto the object returned to callers. A
  // flow that has genuinely never been registered with Meta (no version
  // has ever had a meta_flow_id) still correctly resolves to none.
  if (!latest.meta_flow_id) {
    const { rows: linkedRows } = await pool.query(
      `SELECT meta_flow_id, meta_status FROM coexistence.flow_versions
        WHERE flow_id = $1 AND meta_flow_id IS NOT NULL
        ORDER BY version_number DESC
        LIMIT 1`,
      [flowId]
    );
    const linked = linkedRows[0];
    if (linked) {
      return { ...latest, meta_flow_id: linked.meta_flow_id, meta_status: linked.meta_status };
    }
  }

  return latest;
}

// The version currently LIVE on Meta — distinct from getLatestVersion(),
// which returns the highest version_number regardless of publish state.
// Once a flow is published, meta/publish (below) stamps that exact
// version row's meta_status = 'PUBLISHED'. Everything that must reflect
// what's actually running on Meta right now (rather than whatever is
// being edited on top of it) should read this, not getLatestVersion().
async function getPublishedVersion(flowId) {
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.flow_versions
      WHERE flow_id = $1 AND meta_status = 'PUBLISHED'
      ORDER BY version_number DESC
      LIMIT 1`,
    [flowId]
  );
  return rows[0] || null;
}

// True when `latestVersion` is a not-yet-published edit sitting on top of
// a published flow (i.e. the "Edit Flow" draft-version flow below has
// already been used to open one) — the one extra case, alongside a
// genuinely 'draft' flow, where PUT/meta-publish should be allowed to
// proceed. A published flow with no such version on top (latestVersion
// IS the published one, or there is none) stays fully read-only/blocked,
// exactly like today.
function isEditableFlow(flow, latestVersion) {
  if (flow.status === 'draft') return true;
  if (flow.status === 'published') {
    return !!latestVersion && latestVersion.meta_status !== 'PUBLISHED';
  }
  return false;
}

// Creates the next version row for a flow inside an existing client/
// transaction, storing the RAW definition the client sent under
// flow_json — draft versions store the definition as authored (whatever
// the builder is currently working on), not the Meta-generated document.
// The Meta-compatible document is generated on demand (see
// POST /flows/:id/generate-json) rather than duplicated into every draft
// version row, so there is exactly one place (flowJsonBuilder.js) that
// ever produces it.
async function createNextVersion(client, flowId, definition) {
  // PostgreSQL disallows FOR UPDATE together with an aggregate function
  // (MAX(version_number)), so we can't lock the flow_versions rows directly
  // while computing the next version number. Instead, lock the parent flow
  // row first — every version-creation call for this flow within a
  // transaction serializes on that lock — then compute the next version
  // number as a plain (non-locking) aggregate query.
  await client.query(
    `SELECT id FROM coexistence.flows WHERE id = $1 FOR UPDATE`,
    [flowId]
  );

  // Duplicate-request guard (Phase 6.8.1): a double-submitted Save (double
  // click, a re-clicked "Edit Flow", a replayed/retried request, etc.) ends
  // up here twice with the exact same `definition` and no real edit in
  // between. Since the FOR UPDATE lock above serializes every
  // version-creation call for this flow, we can safely look at the current
  // latest row here and, if it is (a) not yet published/registered as the
  // live Meta Flow version (meta_status IS NULL — a plain in-progress
  // draft) and (b) byte-for-byte the same JSON as what we're about to
  // write, treat this call as a no-op and hand back that row instead of
  // inserting an identical sibling. A real edit always produces different
  // flow_json, so normal draft saving is unaffected; the published version
  // (meta_status = 'PUBLISHED') is never eligible for this shortcut, so it
  // is never a candidate for being silently reused.
  const { rows: latestRows } = await client.query(
    `SELECT * FROM coexistence.flow_versions
      WHERE flow_id = $1
      ORDER BY version_number DESC
      LIMIT 1`,
    [flowId]
  );
  const latest = latestRows[0] || null;
  if (latest && latest.meta_status === null) {
    const { rows: sameRows } = await client.query(
      `SELECT 1 FROM coexistence.flow_versions
        WHERE id = $1 AND flow_json = $2::jsonb`,
      [latest.id, JSON.stringify(definition)]
    );
    if (sameRows.length > 0) {
      return latest;
    }
  }

  const { rows: maxRows } = await client.query(
    `SELECT COALESCE(MAX(version_number), 0)::int AS max_version
       FROM coexistence.flow_versions WHERE flow_id = $1`,
    [flowId]
  );
  const nextVersion = (maxRows[0]?.max_version || 0) + 1;

  // Version-linking fix (Phase 6.3): once any version of this flow has
  // been registered with Meta (has a meta_flow_id), every subsequently
  // saved version must keep pointing at that same Meta Flow — a Meta Flow
  // is registered once per flow, not once per local draft version.
  // Without this, each edit+save orphaned meta_flow_id on a fresh,
  // unregistered version, making the UI think no Meta Flow existed and
  // offer "Create on Meta", which then correctly failed because a Flow
  // with this name already exists on Meta's side.
  const { rows: linkedRows } = await client.query(
    `SELECT meta_flow_id FROM coexistence.flow_versions
      WHERE flow_id = $1 AND meta_flow_id IS NOT NULL
      ORDER BY version_number DESC
      LIMIT 1`,
    [flowId]
  );
  const linked = linkedRows[0] || null;

  // Bug 7 / Bug 4 fix (Phase 6.8.3): meta_status is deliberately NEVER
  // carried forward here, even when meta_flow_id is. meta_status describes
  // whether THIS specific row is the one actually live on Meta right now —
  // that is only ever true for a row explicitly stamped by a confirmed
  // meta/publish success (see that route). A brand-new version created
  // here — whether from a normal Save, or from "Edit Flow" opening a draft
  // on top of a published flow — is always a fresh, unpublished local edit
  // and must always start as meta_status = NULL, regardless of what the
  // version it was cloned from or linked to was marked as. Previously this
  // inherited the linked row's meta_status too, which meant a new version
  // could be inserted already marked 'PUBLISHED' purely because the most
  // recent Meta-registered row happened to carry that status — the exact
  // shape of the "a draft becomes PUBLISHED on its own" bug class. The one
  // caller that used to need a published-on-clone value (POST
  // /flows/:id/draft-version) immediately forced it back to NULL anyway,
  // so removing the inheritance here is a pure simplification, not a
  // behavior change for that route.
  const { rows } = await client.query(
    `INSERT INTO coexistence.flow_versions (flow_id, version_number, flow_json, meta_flow_id, meta_status)
     VALUES ($1, $2, $3, $4, NULL)
     RETURNING *`,
    [flowId, nextVersion, JSON.stringify(definition), linked?.meta_flow_id || null]
  );
  return rows[0];
}

// ─── Flow CRUD ───────────────────────────────────────────────────────────

router.get('/flows', requirePermission('flow-builder'), async (req, res) => {
  try {
    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) return res.json({ rows: [], total: 0 });

    const { search = '', status = '', whatsappAccountId = '', limit = 50, offset = 0 } = req.query;
    const params = [workspaceId];
    const conditions = ['workspace_id = $1'];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`name ILIKE $${params.length}`);
    }
    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }
    if (whatsappAccountId) {
      params.push(whatsappAccountId);
      conditions.push(`whatsapp_account_id = $${params.length}`);
    }

    const whereClause = conditions.join(' AND ');
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

    const { rows } = await pool.query(
      `SELECT * FROM coexistence.flows WHERE ${whereClause}
        ORDER BY updated_at DESC
        LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      params
    );
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM coexistence.flows WHERE ${whereClause}`,
      params
    );

    res.json({ rows, total: countRows[0]?.total || 0 });
  } catch (err) {
    console.error('[flows] list error:', err.message);
    res.status(500).json({ error: 'Failed to list flows' });
  }
});

router.post('/flows', requirePermission('flow-builder'), async (req, res) => {
  try {
    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const body = req.body || {};
    const validationError = validateFlowInput(body);
    if (validationError) return res.status(400).json({ error: validationError });

    const accountError = await assertAccountOwnership(workspaceId, body.whatsappAccountId);
    if (accountError) return res.status(403).json({ error: accountError });

    // A flow's `definition` (screens/fields) is optional at creation time
    // — the builder is expected to POST an empty flow, then PUT the
    // definition in as the user builds it. If a definition IS provided up
    // front, it's still validated the same way PUT does.
    let definitionErrors = null;
    if (body.definition !== undefined) {
      const { valid, errors } = validateFlowDefinition(body.definition);
      if (!valid) definitionErrors = errors;
    }
    if (definitionErrors) {
      return res.status(400).json({ error: 'Invalid flow definition', details: definitionErrors });
    }

    const client = await pool.connect();
    let flow;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO coexistence.flows
           (workspace_id, whatsapp_account_id, name, status, field_mapping, created_by)
         VALUES ($1, $2, $3, 'draft', $4, $5)
         RETURNING *`,
        [
          workspaceId,
          body.whatsappAccountId || null,
          String(body.name).trim(),
          JSON.stringify(body.fieldMapping || {}),
          req.user?.id ?? null,
        ]
      );
      flow = rows[0];

      if (body.definition !== undefined) {
        await createNextVersion(client, flow.id, body.definition);
      }

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    const latestVersion = await getLatestVersion(flow.id);
    res.json({ ...flow, latestVersion: latestVersion || null });
  } catch (err) {
    console.error('[flows] create error:', err.message);
    res.status(500).json({ error: 'Failed to create flow' });
  }
});

router.get('/flows/:id', requirePermission('flow-builder'), async (req, res) => {
  try {
    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const flow = await getFlowById(workspaceId, req.params.id);
    if (!flow) return res.status(404).json({ error: 'Flow not found' });

    const latestVersion = await getLatestVersion(flow.id);
    // publishedVersion lets the frontend tell "what's actually live on
    // Meta" apart from "what's currently being edited" once a draft
    // version has been opened on top of a published flow (Phase 6.8 fix).
    // For a flow with no such draft-on-top, latestVersion IS the
    // published version, so this is simply redundant with it — cheap and
    // harmless for every flow that predates this feature.
    const publishedVersion = flow.status === 'published' ? await getPublishedVersion(flow.id) : null;
    res.json({ ...flow, latestVersion: latestVersion || null, publishedVersion: publishedVersion || null });
  } catch (err) {
    console.error('[flows] get error:', err.message);
    res.status(500).json({ error: 'Failed to load flow' });
  }
});

router.put('/flows/:id', requirePermission('flow-builder'), async (req, res) => {
  try {
    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const existing = await getFlowById(workspaceId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Flow not found' });
    const existingLatestVersion = await getLatestVersion(existing.id);
    if (!isEditableFlow(existing, existingLatestVersion)) {
      return res.status(409).json({ error: `Flow in status "${existing.status}" can no longer be edited` });
    }

    const body = req.body || {};
    // Same partial-update merge convention as sequences.js's PUT — only a
    // field the client explicitly sends (even a deliberate empty value)
    // is changed; an absent key keeps its current value.
    const merged = {
      name: body.name !== undefined ? body.name : existing.name,
      whatsappAccountId: body.whatsappAccountId !== undefined ? body.whatsappAccountId : existing.whatsapp_account_id,
      fieldMapping: body.fieldMapping !== undefined ? body.fieldMapping : existing.field_mapping,
    };

    const validationError = validateFlowInput(merged);
    if (validationError) return res.status(400).json({ error: validationError });

    const accountError = await assertAccountOwnership(workspaceId, merged.whatsappAccountId);
    if (accountError) return res.status(403).json({ error: accountError });

    if (merged.fieldMapping !== null && merged.fieldMapping !== undefined && typeof merged.fieldMapping !== 'object') {
      return res.status(400).json({ error: 'fieldMapping must be a JSON object' });
    }

    let definitionErrors = null;
    if (body.definition !== undefined) {
      const { valid, errors } = validateFlowDefinition(body.definition);
      if (!valid) definitionErrors = errors;
    }
    if (definitionErrors) {
      return res.status(400).json({ error: 'Invalid flow definition', details: definitionErrors });
    }

    const client = await pool.connect();
    let updated;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE coexistence.flows
            SET name = $3, whatsapp_account_id = $4, field_mapping = $5, updated_at = NOW()
          WHERE id = $1 AND workspace_id = $2
          RETURNING *`,
        [
          existing.id,
          workspaceId,
          String(merged.name).trim(),
          merged.whatsappAccountId || null,
          JSON.stringify(merged.fieldMapping || {}),
        ]
      );
      updated = rows[0];

      if (body.definition !== undefined) {
        await createNextVersion(client, existing.id, body.definition);
      }

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    const latestVersion = await getLatestVersion(existing.id);
    const publishedVersion = updated.status === 'published' ? await getPublishedVersion(existing.id) : null;
    res.json({ ...updated, latestVersion: latestVersion || null, publishedVersion: publishedVersion || null });
  } catch (err) {
    console.error('[flows] update error:', err.message);
    res.status(500).json({ error: 'Failed to update flow' });
  }
});

// POST /flows/:id/draft-version — Phase 6.8 fix: "Edit Flow" on a
// published flow. Opens a new, editable flow_versions row on top of the
// currently published one so the builder UI has something safe to edit,
// WITHOUT touching the published version row (never UPDATEd, never
// deleted) and WITHOUT flipping coexistence.flows.status away from
// 'published' — the flow stays visibly/functionally published (Send to
// Contact, submission history, field mapping, etc. all keep working
// exactly as before) until the user explicitly re-publishes this new
// version through the normal Upload JSON / Publish actions.
// Reuses createNextVersion() (same helper POST/PUT already use for every
// draft save) rather than a parallel versioning path — see that
// function's comment for the version-numbering/meta_flow_id-carry-forward
// behavior this relies on. createNextVersion() always inserts new rows
// with meta_status = NULL (Phase 6.8.3), so the cloned row here is
// correctly unpublished from the moment it's created — no separate
// clear-it-back-to-NULL step needed — while its meta_flow_id is still
// carried forward so Upload JSON/Publish keep targeting the SAME Meta
// Flow (no duplicate Flow on Meta's side).
// Idempotent: calling this again while an unpublished draft version
// already sits on top just returns that same version rather than
// creating another one.
router.post('/flows/:id/draft-version', requirePermission('flow-builder'), async (req, res) => {
  try {
    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const flow = await getFlowById(workspaceId, req.params.id);
    if (!flow) return res.status(404).json({ error: 'Flow not found' });
    if (flow.status !== 'published') {
      return res.status(409).json({ error: `Only a published flow can open a new draft version (this flow is "${flow.status}")` });
    }

    const latestVersion = await getLatestVersion(flow.id);
    if (!latestVersion) return res.status(400).json({ error: 'Flow has no saved definition yet' });

    // Already editing — hand back the existing draft-on-top version
    // instead of creating a duplicate.
    if (latestVersion.meta_status !== 'PUBLISHED') {
      return res.json({ ok: true, created: false, version: latestVersion });
    }

    const client = await pool.connect();
    let newVersion;
    try {
      await client.query('BEGIN');
      newVersion = await createNextVersion(client, flow.id, latestVersion.flow_json);
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    res.json({ ok: true, created: true, version: newVersion });
  } catch (err) {
    console.error('[flows] draft-version error:', err.message);
    res.status(500).json({ error: 'Failed to open a draft version for editing' });
  }
});

// Hard-delete. Unlike sequences.js's soft-archive convention (which exists
// because sequences accumulate enrollment history that must never be
// silently destroyed), a DRAFT flow that has never been published has no
// downstream history yet — flow_submissions FKs flow_id ON DELETE CASCADE
// (see db/flowsSchema.js) and a draft cannot have real submissions to lose.
// Only 'draft' flows may be deleted; a published/deprecated flow is kept
// (this phase has no publish path yet, so in practice every flow here is
// still a draft — the status check is future-proofing, not dead code).
router.delete('/flows/:id', requirePermission('flow-builder'), async (req, res) => {
  try {
    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const existing = await getFlowById(workspaceId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Flow not found' });
    if (!EDITABLE_STATUSES.has(existing.status)) {
      return res.status(409).json({ error: `Flow in status "${existing.status}" cannot be deleted` });
    }

    await pool.query(
      `DELETE FROM coexistence.flows WHERE id = $1 AND workspace_id = $2`,
      [existing.id, workspaceId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[flows] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete flow' });
  }
});

// ─── JSON generation / validation ────────────────────────────────────────

// Validates a definition WITHOUT saving it — lets the builder UI show
// inline errors as the user edits, before they hit save. Accepts either
// { definition } in the body, or falls back to the flow's latest saved
// version if no definition is supplied.
router.post('/flows/:id/validate', requirePermission('flow-builder'), async (req, res) => {
  try {
    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const flow = await getFlowById(workspaceId, req.params.id);
    if (!flow) return res.status(404).json({ error: 'Flow not found' });

    let definition = req.body?.definition;
    if (definition === undefined) {
      const latestVersion = await getLatestVersion(flow.id);
      definition = latestVersion ? latestVersion.flow_json : null;
    }

    if (!definition) {
      return res.status(400).json({ error: 'No flow definition to validate — supply one in the request body or save a draft first' });
    }

    const { valid, errors } = validateFlowDefinition(definition);
    res.json({ valid, errors });
  } catch (err) {
    console.error('[flows] validate error:', err.message);
    res.status(500).json({ error: 'Failed to validate flow definition' });
  }
});

// Generates Meta-compatible Flow JSON from the flow's latest saved
// definition (or a definition supplied directly in the body, for
// preview-before-save). Generation only — this never calls the Meta API
// and never changes the flow's status; that remains a later phase.
router.post('/flows/:id/generate-json', requirePermission('flow-builder'), async (req, res) => {
  try {
    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const flow = await getFlowById(workspaceId, req.params.id);
    if (!flow) return res.status(404).json({ error: 'Flow not found' });

    let definition = req.body?.definition;
    if (definition === undefined) {
      const latestVersion = await getLatestVersion(flow.id);
      definition = latestVersion ? latestVersion.flow_json : null;
    }

    if (!definition) {
      return res.status(400).json({ error: 'No flow definition to generate JSON from — supply one in the request body or save a draft first' });
    }

    try {
      const flowJson = buildFlowJson(definition);
      res.json({ flowJson });
    } catch (buildErr) {
      if (buildErr.validationErrors) {
        return res.status(400).json({ error: buildErr.message, details: buildErr.validationErrors });
      }
      throw buildErr;
    }
  } catch (err) {
    console.error('[flows] generate-json error:', err.message);
    res.status(500).json({ error: 'Failed to generate flow JSON' });
  }
});

// ─── Meta Flow API (Phase 6.3) ──────────────────────────────────────────
//
// Everything below calls the live Meta Graph API via
// integrations/metaFlows.js. Conventions reused unchanged from
// routes/templates.js's submit/edit routes:
//   - getAccountWithToken(accountId, workspaceId) resolves the bound
//     WhatsApp account's WABA id + access token, scoped to the caller's
//     workspace — never trusts a client-supplied account id as proof of
//     ownership (same as templates.js's submit/edit routes)
//   - markAccountHealth() flags the account unhealthy on auth failures
//     (401 / Meta error code 190), exactly like templates.js's submit route
//   - Meta's human-readable error_user_title/error_user_msg is preferred
//     over the generic error message when present
//   - a Meta call failing NEVER mutates local status — only a successful
//     Meta response does. Meta is always the source of truth for whether
//     a Flow actually published/deprecated.
//   - no access token is ever included in a log line or response body

// Latest version row for a flow, scoped to the flow (not just flow_id) so
// a caller can never read another flow's version by guessing an id —
// mirrors getFlowById's workspace-scoping discipline one level down.
async function getVersionForFlow(flowId, versionId) {
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.flow_versions WHERE id = $1 AND flow_id = $2`,
    [versionId, flowId]
  );
  return rows[0] || null;
}

// Resolves the workspace-owned WhatsApp account bound to a flow, or a
// structured { status, error } to send back verbatim. Centralizes the
// three checks every Meta-facing route below needs before it may touch
// the network: flow has an account, account belongs to this workspace,
// account has a usable token.
async function resolveBoundAccount(flow, workspaceId) {
  if (!flow.whatsapp_account_id) {
    return { error: { status: 400, body: { error: 'Flow has no WhatsApp Account bound. Edit the flow and pick an account first.' } } };
  }
  const account = await getAccountWithToken(flow.whatsapp_account_id, workspaceId);
  if (!account) {
    return { error: { status: 400, body: { error: 'Bound WhatsApp Account not found in this workspace' } } };
  }
  if (!account.accessToken || !account.wabaId) {
    return { error: { status: 400, body: { error: 'Bound WhatsApp Account is missing its access token or WABA id' } } };
  }
  return { account };
}

// Shared Meta-error → HTTP-response mapping, matching templates.js's
// submit route exactly (human-readable title/msg, account health flag,
// 401 passthrough for expired/invalid tokens).
async function respondMetaError(res, account, err) {
  const isAuth = err.status === 401 || err.metaError?.code === 190;
  await markAccountHealth(account.id, isAuth ? 'invalid_token' : 'unknown_error', err.message);
  const mErr = err.metaError || {};
  const human = mErr.error_user_title
    ? `${mErr.error_user_title}${mErr.error_user_msg ? ' — ' + mErr.error_user_msg : ''}`
    : (mErr.error_user_msg || mErr.message || err.message || 'Meta API error');
  res.status(err.status === 401 ? 401 : 400).json({
    error: human,
    metaCode: err.metaError?.code,
    metaErrorSubcode: err.metaError?.error_subcode,
    metaErrorData: err.metaError?.error_data,
  });
}

// POST /flows/:id/meta/create — registers a new Flow shell on Meta for
// this flow's latest version. Only valid once per version: if that
// version already has a meta_flow_id, the caller should be using
// upload-json / publish / status instead of creating a duplicate Flow on
// Meta's side (see "No duplicate API/send pipelines" scope note).
router.post('/flows/:id/meta/create', requirePermission('flow-builder'), async (req, res) => {
  try {
    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const flow = await getFlowById(workspaceId, req.params.id);
    if (!flow) return res.status(404).json({ error: 'Flow not found' });

    const latestVersion = await getLatestVersion(flow.id);
    if (!latestVersion) return res.status(400).json({ error: 'Flow has no saved definition yet — save a draft first' });
    if (latestVersion.meta_flow_id) {
      return res.status(409).json({ error: 'This flow version is already registered with Meta', metaFlowId: latestVersion.meta_flow_id });
    }

    const { account, error } = await resolveBoundAccount(flow, workspaceId);
    if (error) return res.status(error.status).json(error.body);

    const { valid, errors } = validateFlowDefinition(latestVersion.flow_json);
    if (!valid) return res.status(400).json({ error: 'Invalid flow definition — cannot register with Meta', details: errors });

    const categories = Array.isArray(req.body?.categories) && req.body.categories.length
      ? req.body.categories
      : ['OTHER'];

    let metaResponse;
    try {
      metaResponse = await metaCreateFlow(account.wabaId, account.accessToken, { name: flow.name, categories });
      await markAccountHealth(account.id, 'healthy');
    } catch (err) {
      return respondMetaError(res, account, err);
    }

    const { rows } = await pool.query(
      `UPDATE coexistence.flow_versions
          SET meta_flow_id = $2, meta_status = 'DRAFT'
        WHERE id = $1
        RETURNING *`,
      [latestVersion.id, metaResponse.id]
    );

    res.json({ metaFlowId: metaResponse.id, version: rows[0] });
  } catch (err) {
    console.error('[flows] meta/create error:', err.message);
    res.status(500).json({ error: 'Failed to create Meta Flow' });
  }
});

// POST /flows/:id/meta/upload-json — (re)generates Meta Flow JSON from
// this flow's latest saved definition and uploads it as that version's
// Flow JSON asset. Requires meta/create to have run first for this
// version (a meta_flow_id must already be stored).
router.post('/flows/:id/meta/upload-json', requirePermission('flow-builder'), async (req, res) => {
  try {
    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const flow = await getFlowById(workspaceId, req.params.id);
    if (!flow) return res.status(404).json({ error: 'Flow not found' });

    const latestVersion = await getLatestVersion(flow.id);
    if (!latestVersion) return res.status(400).json({ error: 'Flow has no saved definition yet — save a draft first' });
    if (!latestVersion.meta_flow_id) {
      return res.status(400).json({ error: 'This flow version is not yet registered with Meta — call meta/create first' });
    }

    const { account, error } = await resolveBoundAccount(flow, workspaceId);
    if (error) return res.status(error.status).json(error.body);

    let flowJson;
    try {
      flowJson = buildFlowJson(latestVersion.flow_json);
    } catch (buildErr) {
      if (buildErr.validationErrors) {
        return res.status(400).json({ error: buildErr.message, details: buildErr.validationErrors });
      }
      throw buildErr;
    }

    let metaResponse;
    try {
      metaResponse = await metaUpdateFlowJson(latestVersion.meta_flow_id, account.accessToken, flowJson);
      await markAccountHealth(account.id, 'healthy');
    } catch (err) {
      return respondMetaError(res, account, err);
    }

    // Meta may accept the upload but report non-fatal validation warnings
    // inside the response body — surface them, but this is not itself a
    // publish, so local status is untouched either way.
    res.json({ metaFlowId: latestVersion.meta_flow_id, validationErrors: metaResponse?.validation_errors || [] });
  } catch (err) {
    console.error('[flows] meta/upload-json error:', err.message);
    res.status(500).json({ error: 'Failed to upload flow JSON to Meta' });
  }
});

// POST /flows/:id/meta/publish — publishes the Flow on Meta. Local status
// only flips to 'published' after Meta itself confirms success; a Meta
// rejection (invalid JSON, missing required fields, etc.) leaves both the
// flow and its version exactly as they were.
router.post('/flows/:id/meta/publish', requirePermission('flow-builder'), async (req, res) => {
  try {
    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const flow = await getFlowById(workspaceId, req.params.id);
    if (!flow) return res.status(404).json({ error: 'Flow not found' });

    const latestVersion = await getLatestVersion(flow.id);
    // Allowed for a genuine draft flow, or for a published flow that has
    // an unpublished draft-on-top version open (Phase 6.8 fix — "Edit
    // Flow"/draft-version) — same isEditableFlow() gate PUT now uses.
    // A published flow with nothing edited on top is still refused.
    if (!isEditableFlow(flow, latestVersion)) {
      return res.status(409).json({ error: `Flow in status "${flow.status}" cannot be published` });
    }

    if (!latestVersion) return res.status(400).json({ error: 'Flow has no saved definition yet — save a draft first' });
    if (!latestVersion.meta_flow_id) {
      return res.status(400).json({ error: 'This flow version is not yet registered with Meta — call meta/create (and meta/upload-json) first' });
    }

    const { account, error } = await resolveBoundAccount(flow, workspaceId);
    if (error) return res.status(error.status).json(error.body);

    let metaResponse;
    try {
      metaResponse = await metaPublishFlow(latestVersion.meta_flow_id, account.accessToken);
      await markAccountHealth(account.id, 'healthy');
    } catch (err) {
      // Meta failure — flow/version status is left untouched. This is the
      // "Meta failures must NOT mark Flow as published" requirement.
      return respondMetaError(res, account, err);
    }

    if (!metaResponse || metaResponse.success !== true) {
      // Defensive: Meta responded 2xx but without an explicit success
      // flag — treat as not-published rather than assuming success.
      return res.status(502).json({ error: 'Meta did not confirm the Flow was published' });
    }

    const client = await pool.connect();
    let updatedFlow;
    try {
      await client.query('BEGIN');
      // Bug 5 fix (Phase 6.8.3): enforce "at most one PUBLISHED version
      // per flow" at the one place that's actually allowed to create a
      // PUBLISHED row — a confirmed Meta publish success. Any other row
      // for this flow still marked meta_status = 'PUBLISHED' (a stale
      // marker left over from before this version was published — old
      // published version, or a leftover from data written before this
      // invariant was enforced) is cleared in the same transaction as the
      // new one is stamped, so the two updates commit atomically together.
      // This never runs outside an explicit, Meta-confirmed Publish, so
      // Refresh Status is still the only place that must not touch this.
      await client.query(
        `UPDATE coexistence.flow_versions
            SET meta_status = NULL
          WHERE flow_id = $1 AND meta_status = 'PUBLISHED' AND id != $2`,
        [flow.id, latestVersion.id]
      );
      // Persistence fix: latestVersion.meta_flow_id may have come from
      // getLatestVersion()'s fallback (an older version of this same flow
      // carries the real meta_flow_id, but this version's own row is still
      // NULL — see getLatestVersion() above). That fallback is in-memory
      // only, so without writing it back here, the *actual* latest row
      // keeps meta_flow_id = NULL even after a successful publish, and the
      // UI then reads a published flow with no registered Meta Flow. Write
      // meta_flow_id back onto this row alongside meta_status so the
      // version-linking fix persists rather than being recomputed forever.
      await client.query(
        `UPDATE coexistence.flow_versions SET meta_status = 'PUBLISHED', meta_flow_id = $2 WHERE id = $1`,
        [latestVersion.id, latestVersion.meta_flow_id]
      );
      const { rows } = await client.query(
        `UPDATE coexistence.flows SET status = 'published', updated_at = NOW()
          WHERE id = $1 AND workspace_id = $2
          RETURNING *`,
        [flow.id, workspaceId]
      );
      updatedFlow = rows[0];
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    res.json({ ok: true, flow: updatedFlow, metaFlowId: latestVersion.meta_flow_id });
  } catch (err) {
    console.error('[flows] meta/publish error:', err.message);
    res.status(500).json({ error: 'Failed to publish flow' });
  }
});

// GET /flows/:id/meta/status — reads current status straight from Meta
// (source of truth) for the given version (defaults to latest), and
// mirrors it onto flow_versions.meta_status for local display. Does not
// change coexistence.flows.status — publish/deprecate are the only routes
// allowed to do that, and only on their own confirmed success.
router.get('/flows/:id/meta/status', requirePermission('flow-builder'), async (req, res) => {
  try {
    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const flow = await getFlowById(workspaceId, req.params.id);
    if (!flow) return res.status(404).json({ error: 'Flow not found' });

    // Root-cause fix (Phase 6.8.2): when no explicit versionId is given,
    // this used to default to getLatestVersion() — which, on a published
    // flow with an unpublished draft-on-top (Phase 6.8's "Edit Flow"),
    // resolves to that DRAFT row, not the flow's actual published one.
    // The Meta call below then legitimately reports the live (published)
    // Flow's status, e.g. 'PUBLISHED' — and the persistence step further
    // down used to write that status straight onto whatever row `version`
    // pointed at. That silently flipped the draft's own meta_status to
    // 'PUBLISHED', making it indistinguishable from a real published
    // version: getPublishedVersion() would then match the draft (higher
    // version_number) instead of the true published row, and the flow
    // would come back read-only with the draft's edits looking "live" —
    // exactly the "Refresh Status reverts to read-only" bug. Refresh
    // Status is conceptually about the currently PUBLISHED Meta version,
    // so default to that (falling back to latestVersion only when the
    // flow isn't published, e.g. a plain draft flow that was registered
    // with Meta before ever being published) — this never resolves to a
    // draft-on-top version unless the caller asks for it by id.
    let version = req.query.versionId
      ? await getVersionForFlow(flow.id, req.query.versionId)
      : (flow.status === 'published' ? await getPublishedVersion(flow.id) : null) || await getLatestVersion(flow.id);
    if (!version) return res.status(404).json({ error: 'Flow version not found' });
    if (!version.meta_flow_id) {
      return res.status(400).json({ error: 'This flow version is not registered with Meta yet' });
    }

    const { account, error } = await resolveBoundAccount(flow, workspaceId);
    if (error) return res.status(error.status).json(error.body);

    let metaResponse;
    try {
      metaResponse = await metaGetFlowStatus(version.meta_flow_id, account.accessToken);
      await markAccountHealth(account.id, 'healthy');
    } catch (err) {
      return respondMetaError(res, account, err);
    }

    if (metaResponse?.status) {
      // Bug 4/5/9 hard guard (Phase 6.8.3): even though `version` above
      // now defaults to the real published row, this is a second,
      // independent line of defense — belt-and-suspenders against any
      // future caller of this route (including an explicit ?versionId=
      // pointed at a draft) ever using a Refresh Status call to flip an
      // unpublished draft into looking published. Refresh Status is only
      // ever allowed to WRITE 'PUBLISHED' onto a row that is either (a)
      // already the flow's current published row, or (b) the only
      // Meta-registered row this flow has at all (the one legitimate
      // self-heal case: a flow published before the meta_flow_id/
      // meta_status persistence fix existed, with no draft-on-top to
      // confuse it with). Any other status value (DRAFT, DEPRECATED,
      // THROTTLED, etc.) is always safe to mirror as-is, since it can
      // never create a second locally-"published" row.
      const currentPublished = await getPublishedVersion(flow.id);
      const safeToPersist =
        metaResponse.status !== 'PUBLISHED' ||
        !currentPublished ||
        currentPublished.id === version.id;

      if (safeToPersist) {
        // Persistence/reconciliation fix: `version.meta_flow_id` may have
        // come from getLatestVersion()'s fallback (an older version of
        // this flow carries the real meta_flow_id while the actual latest
        // row is still NULL — see getLatestVersion() above). That
        // fallback is in-memory only. Since a successful Meta status call
        // just proved this meta_flow_id is the correct, live one for this
        // flow, write it back onto the row being updated here alongside
        // meta_status — the same "persist what was actually used" fix
        // already applied to publish, generalized to Refresh Status so
        // any flow left in this state before that fix existed self-heals
        // the next time its status is checked, with no manual DB changes
        // and no new Meta Flow.
        await pool.query(
          `UPDATE coexistence.flow_versions SET meta_status = $2, meta_flow_id = $3 WHERE id = $1`,
          [version.id, metaResponse.status, version.meta_flow_id]
        );
      } else {
        console.warn(`[flows] meta/status: refused to mark version ${version.id} PUBLISHED for flow ${flow.id} — a different version (${currentPublished.id}) is already the published one; a draft is never promoted by Refresh Status.`);
      }
    }

    res.json(metaResponse);
  } catch (err) {
    console.error('[flows] meta/status error:', err.message);
    res.status(500).json({ error: 'Failed to fetch flow status from Meta' });
  }
});

// POST /flows/:id/meta/deprecate — deprecates a published Flow on Meta.
// Only valid on a locally-published flow; a Meta rejection leaves local
// status as 'published' (mirrors publish's "Meta is the source of truth"
// rule in the other direction).
router.post('/flows/:id/meta/deprecate', requirePermission('flow-builder'), async (req, res) => {
  try {
    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const flow = await getFlowById(workspaceId, req.params.id);
    if (!flow) return res.status(404).json({ error: 'Flow not found' });
    if (flow.status !== 'published') {
      return res.status(409).json({ error: `Flow in status "${flow.status}" cannot be deprecated` });
    }

    const latestVersion = await getLatestVersion(flow.id);
    if (!latestVersion?.meta_flow_id) {
      return res.status(400).json({ error: 'Flow has no Meta Flow id on record — cannot deprecate' });
    }

    const { account, error } = await resolveBoundAccount(flow, workspaceId);
    if (error) return res.status(error.status).json(error.body);

    let metaResponse;
    try {
      metaResponse = await metaDeprecateFlow(latestVersion.meta_flow_id, account.accessToken);
      await markAccountHealth(account.id, 'healthy');
    } catch (err) {
      return respondMetaError(res, account, err);
    }

    if (!metaResponse || metaResponse.success !== true) {
      return res.status(502).json({ error: 'Meta did not confirm the Flow was deprecated' });
    }

    const client = await pool.connect();
    let updatedFlow;
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE coexistence.flow_versions SET meta_status = 'DEPRECATED' WHERE id = $1`,
        [latestVersion.id]
      );
      const { rows } = await client.query(
        `UPDATE coexistence.flows SET status = 'deprecated', updated_at = NOW()
          WHERE id = $1 AND workspace_id = $2
          RETURNING *`,
        [flow.id, workspaceId]
      );
      updatedFlow = rows[0];
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    res.json({ ok: true, flow: updatedFlow, metaFlowId: latestVersion.meta_flow_id });
  } catch (err) {
    console.error('[flows] meta/deprecate error:', err.message);
    res.status(500).json({ error: 'Failed to deprecate flow' });
  }
});

// ─── Submission History (Phase 6.7) ─────────────────────────────────────
//
// Read-only history/management for coexistence.flow_submissions, which is
// populated unchanged by Phase 6.5/6.6 (services/flowSubmissionService.js /
// flowFieldMappingService.js — neither file is touched by this phase).
// Reuses the exact same workspace-scoping discipline + requirePermission
// ('flow-builder') gate as every other route in this file. No new table,
// no schema change (db/flowsSchema.js untouched), no destructive
// deletion — GET only, exactly as spec'd.
//
// Mounted at the top level (/flow-submissions, not nested under
// /flows/:id) purely to avoid any Express route-matching ambiguity with
// the existing GET /flows/:id above — nothing about flow_submissions'
// workspace scoping or permission gating differs from the rest of this
// file.
//
// Mapping status is DERIVED (not stored — no schema change) from the
// existing columns, matching exactly how flowSubmissionService.js's
// recordFlowSubmission already writes them:
//   mapped_at IS NULL                        -> 'not_mapped' (no mapping
//                                                configured/attempted for
//                                                this flow — spec §E of
//                                                flowSubmissionService.js)
//   mapped_at IS NOT NULL AND parse_error     -> 'mapping_error' (Phase 6.6
//                                                reuses parse_error as the
//                                                "mapping had a failure"
//                                                signal once mapping was
//                                                attempted)
//   mapped_at IS NOT NULL AND NOT parse_error -> 'mapped'
// (parse_error is always inserted as `false` — see flowSubmissionService.js
// — a row whose nfm_reply itself failed to parse is never stored at all,
// so parse_error==true only ever co-occurs with mapped_at being set.)
//
// flow_token is intentionally NEVER included in either response below —
// nothing in the existing UI needs it (spec item 10 — "never expose
// flow_token unless genuinely required by existing UI").

const MAPPING_STATUS_SQL = `
  CASE
    WHEN fs.mapped_at IS NULL THEN 'not_mapped'
    WHEN fs.parse_error THEN 'mapping_error'
    ELSE 'mapped'
  END
`;

const SUBMISSION_SELECT = `
  SELECT fs.id, fs.flow_id, f.name AS flow_name, fs.flow_version_id,
         fv.version_number, fs.contact_number, fs.received_at,
         fs.mapped_at, fs.parse_error, fs.response_json,
         ${MAPPING_STATUS_SQL} AS mapping_status
    FROM coexistence.flow_submissions fs
    JOIN coexistence.flows f ON f.id = fs.flow_id
    LEFT JOIN coexistence.flow_versions fv ON fv.id = fs.flow_version_id
`;

// Shapes a submission row for the client. Never includes flow_token or any
// other secret/token — see note above.
function shapeSubmissionRow(row) {
  return {
    id: row.id,
    flowId: row.flow_id,
    flowName: row.flow_name,
    flowVersionId: row.flow_version_id,
    flowVersionNumber: row.version_number,
    contactNumber: row.contact_number,
    receivedAt: row.received_at,
    mappedAt: row.mapped_at,
    parseError: row.parse_error,
    mappingStatus: row.mapping_status, // 'mapped' | 'mapping_error' | 'not_mapped'
    responseJson: row.response_json,
  };
}

// GET /flow-submissions — paginated, filterable list, newest first.
// Optional filters: flowId, contactNumber (partial match), dateFrom/dateTo
// (received_at range), mappingStatus ('mapped' | 'mapping_error' |
// 'not_mapped'). Workspace isolation is mandatory and server-side only —
// fs.workspace_id = $1 is never omitted, and never taken from anything
// other than req.workspace.id (see currentWorkspaceId), same as every
// other list route in this file.
router.get('/flow-submissions', requirePermission('flow-builder'), async (req, res) => {
  try {
    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) return res.json({ rows: [], total: 0 });

    const {
      flowId = '', contactNumber = '', dateFrom = '', dateTo = '',
      mappingStatus = '', limit = 50, offset = 0,
    } = req.query;

    const params = [workspaceId];
    const conditions = ['fs.workspace_id = $1'];

    if (flowId) {
      params.push(flowId);
      conditions.push(`fs.flow_id = $${params.length}`);
    }
    if (contactNumber) {
      params.push(`%${String(contactNumber).replace(/\D/g, '') || contactNumber}%`);
      conditions.push(`fs.contact_number ILIKE $${params.length}`);
    }
    if (dateFrom) {
      params.push(dateFrom);
      conditions.push(`fs.received_at >= $${params.length}::timestamptz`);
    }
    if (dateTo) {
      params.push(dateTo);
      conditions.push(`fs.received_at <= $${params.length}::timestamptz`);
    }
    if (mappingStatus === 'mapped') {
      conditions.push(`fs.mapped_at IS NOT NULL AND fs.parse_error = false`);
    } else if (mappingStatus === 'mapping_error') {
      conditions.push(`fs.mapped_at IS NOT NULL AND fs.parse_error = true`);
    } else if (mappingStatus === 'not_mapped') {
      conditions.push(`fs.mapped_at IS NULL`);
    }

    const whereClause = conditions.join(' AND ');
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

    const { rows } = await pool.query(
      `${SUBMISSION_SELECT}
        WHERE ${whereClause}
        ORDER BY fs.received_at DESC
        LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      params
    );
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM coexistence.flow_submissions fs WHERE ${whereClause}`,
      params
    );

    res.json({ rows: rows.map(shapeSubmissionRow), total: countRows[0]?.total || 0 });
  } catch (err) {
    console.error('[flows] submissions list error:', err.message);
    res.status(500).json({ error: 'Failed to list flow submissions' });
  }
});

// GET /flow-submissions/:id — single submission detail, including the full
// response_json so the frontend can render each submitted field/value.
// Same workspace-scoping discipline as getFlowById: a submission belonging
// to another workspace is indistinguishable from one that doesn't exist.
router.get('/flow-submissions/:id', requirePermission('flow-builder'), async (req, res) => {
  try {
    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const { rows } = await pool.query(
      `${SUBMISSION_SELECT}
        WHERE fs.id = $1 AND fs.workspace_id = $2`,
      [req.params.id, workspaceId]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'Submission not found' });

    res.json(shapeSubmissionRow(row));
  } catch (err) {
    console.error('[flows] submission detail error:', err.message);
    res.status(500).json({ error: 'Failed to load flow submission' });
  }
});

// ─── Send (Phase 6.4) ────────────────────────────────────────────────────
//
// POST /flows/:id/send — sends a PUBLISHED Flow to one contact through the
// existing message-sending pipeline (messageSender.js insertPendingRow +
// queue/sendQueue.js enqueueSend), exactly like every other send origin
// (chat reply, broadcast, automation, template test). This route does NOT
// call Meta directly and does NOT write chat_history itself — it only
// resolves/validates, inserts the optimistic row, and enqueues a 'flow'
// job; queue/sendQueue.js's worker does the actual Graph API call and
// owns success/failure status handling, unchanged from every other kind.
//
// nfm_reply handling (mapping a contact's Flow submission back to
// flow_submissions) is explicitly out of scope here — Phase 6.5.

router.post('/flows/:id/send', requirePermission('flow-builder'), async (req, res) => {
  try {
    const workspaceId = currentWorkspaceId(req);
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    // Flow must belong to caller workspace (404s exactly like every other
    // flows.js lookup if it doesn't — see getFlowById).
    const flow = await getFlowById(workspaceId, req.params.id);
    if (!flow) return res.status(404).json({ error: 'Flow not found' });

    // Flow must be published.
    if (flow.status !== 'published') {
      return res.status(409).json({ error: `Flow in status "${flow.status}" cannot be sent — only a published flow can be sent` });
    }

    // Flow must have a meta_flow_id (registered + published on Meta's side).
    // Resolve against the PUBLISHED version specifically — not
    // getLatestVersion() — so an in-progress "Edit Flow" draft sitting on
    // top of this published flow (Phase 6.8 fix) can never change what
    // Send to Contact actually sends; only a completed Upload JSON +
    // Publish (which stamps a version meta_status = 'PUBLISHED') can do
    // that. flow.status === 'published' was just asserted above, so a
    // published version is guaranteed to exist.
    const latestVersion = await getPublishedVersion(flow.id);
    if (!latestVersion?.meta_flow_id) {
      return res.status(400).json({ error: 'This flow has no Meta Flow id on record — it cannot be sent' });
    }

    const body = req.body || {};
    const to = body.to || body.toNumber;
    // Contact/recipient validity: must be present and contain at least one digit.
    if (!to || !String(to).replace(/\D/g, '')) {
      return res.status(400).json({ error: 'to (recipient phone number) is required' });
    }
    if (!body.flowCta || !String(body.flowCta).trim()) {
      return res.status(400).json({ error: 'flowCta is required (the Flow button label)' });
    }
    if (!body.bodyText || !String(body.bodyText).trim()) {
      return res.status(400).json({ error: 'bodyText is required (the message body shown above the Flow button)' });
    }

    // Recipient must be a known contact in the CALLER'S workspace — never
    // trust a client-supplied number as-is (coexistence.contacts carries a
    // workspace_id column — see db/contactsWorkspaceSchema.js — so this is
    // a direct, no-schema-change scope check, same "never trust a
    // client-chosen id" discipline as assertWaWorkspace/assertContactAccess
    // in middleware/access.js and routes/messages.js use for chat sends).
    const toDigits = String(to).replace(/\D/g, '');
    const { rows: contactRows } = await pool.query(
      `SELECT 1 FROM coexistence.contacts WHERE contact_number = $1 AND workspace_id = $2 LIMIT 1`,
      [toDigits, workspaceId]
    );
    if (contactRows.length === 0) {
      return res.status(400).json({ error: 'Recipient is not a known contact in this workspace — add them as a contact first' });
    }

    // First screen id — needed for the default 'navigate' flow_action.
    // 'data_exchange' flows (server-driven first screen) skip this and the
    // caller must supply flowAction explicitly instead.
    //
    // Meta requires the first screen of a Flow to be named literally
    // "START" (Graph API #131009 "Specified screen ... is not allowed as
    // first screen of this flow. Allowed screen name is: START." —
    // confirmed live against flow_id 6 / meta_flow_id 1588481832822202,
    // whose stored first screen was "START_new"). This is Meta's rule,
    // not a property of any particular flow_json — Meta never accepts any
    // other literal first-screen name, no matter what our stored
    // definition or generated flow_json happens to call it. So "START" is
    // the correct default outright, not merely a fallback of last resort:
    // this also sidesteps needing to know whether a given published
    // version's flow_json was generated by the current builder (which now
    // normalizes screens[0].id to "START" server-side — see
    // services/flowJsonBuilder.js) or by an earlier version of it (the
    // previous code additionally had a latent bug here, reading a
    // `.screenId` key that flow_json never actually contains — the real
    // key is `.id` — so it read `undefined`, not "START_new"; whatever
    // the exact prior shape, "START" is unconditionally what Meta expects
    // and is what flow_json's first screen will always literally be for
    // every version built going forward). Only an explicit caller-supplied
    // body.screenId (e.g. a future non-linear/data_exchange use) overrides
    // it.
    const flowAction = body.flowAction === 'data_exchange' ? 'data_exchange' : 'navigate';
    let flowActionPayload;
    if (flowAction === 'navigate') {
      const firstScreenId = body.screenId || 'START';
      flowActionPayload = { screen: firstScreenId, data: body.flowActionData || undefined };
    }

    // WhatsApp account: caller may target a specific account explicitly, or
    // fall back to the account bound to the Flow. Either way this is scoped
    // to the caller's workspace by resolveAccount (never trusts the client's
    // claim that an account is theirs) — same helper every other send
    // origin (chat reply / broadcast / automation / template test) uses.
    const accountId = body.whatsappAccountId || flow.whatsapp_account_id || undefined;
    const { account, error: accountError } = await resolveAccount({
      accountId,
      workspaceId,
    });
    if (accountError) return res.status(400).json({ error: accountError });

    // Per-send flow_token — Meta requires a unique opaque token per Flow
    // send; mapping it back to a flow_submissions row on nfm_reply is
    // Phase 6.5's job, not this one.
    const flowToken = crypto.randomUUID();

    // Idempotency/double-send protection — reuses the existing
    // chat_history table (no new table/schema): if this same Flow was
    // already sent (or is still sending) to this exact contact on this
    // account within the last 10 seconds, treat a repeat call (double
    // click, retried request, accidental resubmit) as a no-op rather than
    // firing a second Meta send. A deliberate resend after that window
    // still works normally.
    const { rows: dupRows } = await pool.query(
      `SELECT 1 FROM coexistence.chat_history
         WHERE phone_number_id = $1
           AND contact_number = $2
           AND message_type = 'flow'
           AND status IN ('sending', 'sent')
           AND timestamp > NOW() - INTERVAL '10 seconds'
           AND template_meta->>'flowId' = $3
         LIMIT 1`,
      [account.phoneNumberId, toDigits, String(flow.id)]
    );
    if (dupRows.length > 0) {
      return res.status(409).json({ error: 'This Flow was just sent to this contact — please wait a few seconds before resending.' });
    }

    const localId = await insertPendingRow({
      account,
      toNumber: to,
      messageType: 'flow',
      messageBody: String(body.bodyText).trim(),
      templateMeta: {
        flowId: flow.id,
        metaFlowId: latestVersion.meta_flow_id,
        flowToken,
        flowCta: String(body.flowCta).trim(),
      },
    });

    await enqueueSend({
      kind: 'flow',
      accountId: account.id,
      to: String(to).replace(/\D/g, ''),
      localMessageId: localId,
      payload: {
        flowId: latestVersion.meta_flow_id,
        flowToken,
        flowCta: String(body.flowCta).trim(),
        bodyText: String(body.bodyText).trim(),
        headerText: body.headerText ? String(body.headerText).trim() : undefined,
        footerText: body.footerText ? String(body.footerText).trim() : undefined,
        flowAction,
        flowActionPayload,
      },
    });

    res.status(202).json({ ok: true, messageId: localId, status: 'sending', flowToken });
  } catch (err) {
    console.error('[flows] send error:', err.message);
    res.status(500).json({ error: 'Failed to enqueue flow send' });
  }
});

module.exports = { router, EDITABLE_STATUSES, validateFlowInput };
