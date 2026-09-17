// Target Message: filter + select synchronized contacts (see
// services/sheetSyncScheduler.js for how they get here), then hand off to the
// EXISTING broadcast pipeline. This file creates zero new send logic — it only
// prepares a DRAFT row in coexistence.broadcasts, then the already-existing
// /broadcasts/:id/send and /broadcasts/:id/test routes do the actual sending.

const { Router } = require('express');
const pool = require('../db');
const { requirePermission } = require('../middleware/access');
const { getAccountByPhoneNumber } = require('./whatsappAccounts');
// Phase 6: filter-builder logic now lives in services/audienceFilter.js so
// Campaign Studio (routes/campaigns.js) resolves audiences through the exact
// same code path instead of a second implementation. Re-exported here
// unchanged so nothing else in this file has to change.
const { buildFilterSQL, validateAudienceFilters, buildDedupedContactsSQL } = require('../services/audienceFilter');

const router = Router();

// ─── Routes ──────────────────────────────────────────────────────────────

// GET /api/target/customers — list synced contacts, filtered/searched.
// No batchId anymore: Target Message reads the single, always-current
// contacts table (kept in sync by services/sheetSyncScheduler.js).
router.get('/target/customers', requirePermission('target-message'), async (req, res) => {
  try {
    // Phase 3C: workspace_id is always taken from req.workspace (server-
    // derived from the session), never from the client — Target Message
    // must only ever see the caller's own workspace's contacts.
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.json({ rows: [], total: 0 });

    const { search = '', combinator = 'AND', limit = 500 } = req.query;
    let filters = [];
    if (req.query.filters) {
      try { filters = JSON.parse(req.query.filters); }
      catch { return res.status(400).json({ error: 'Invalid filters JSON' }); }
    }
    const filterError = validateAudienceFilters(filters, combinator);
    if (filterError) return res.status(400).json({ error: filterError });

    const params = [workspaceId];
    let where = 'c.workspace_id = $1';
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (c.name ILIKE $${params.length} OR c.contact_number ILIKE $${params.length})`;
    }
    const filterSql = buildFilterSQL(filters, combinator, params);
    if (filterSql) where += ` AND ${filterSql}`;
    const capLimit = Math.min(parseInt(limit, 10) || 500, 2000);

    const { rows } = await pool.query(
      `SELECT c.id, c.contact_number, c.name, c.tags, c.custom_fields, c.created_at, c.updated_at
         FROM coexistence.contacts c WHERE ${where}
        ORDER BY c.updated_at DESC LIMIT ${capLimit}`,
      params
    );
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM coexistence.contacts c WHERE ${where}`,
      params
    );
    res.json({ rows, total: countRows[0]?.total || 0 });
  } catch (err) {
    console.error('[targetMessage] list customers error:', err.message);
    res.status(500).json({ error: 'Failed to list customers' });
  }
});

// POST /api/target/campaign — creates a DRAFT broadcast (source='target') from
// the filtered/selected contacts. Sending itself happens via the EXISTING
// /broadcasts/:id/send and /broadcasts/:id/test routes — no new sender code.
router.post('/target/campaign', requirePermission('target-message'), async (req, res) => {
  try {
    const workspaceId = req.workspace?.id ?? null;
    if (!workspaceId) return res.status(403).json({ error: 'No workspace found for this account' });

    const {
      filters = [], combinator = 'AND', customerIds,
      fromNumber, name, messageType, templateId, body, url,
      mediaLibraryId, caption, variableMapping = {},
    } = req.body;

    if (!fromNumber) return res.status(400).json({ error: 'fromNumber is required' });
    const filterError = validateAudienceFilters(filters, combinator);
    if (filterError) return res.status(400).json({ error: filterError });
    const msgType = messageType || 'template';
    if (msgType === 'template' && !templateId) {
      return res.status(400).json({ error: 'templateId required for template messages' });
    }

    // Ownership verification (Phase 3F-1): every asset the campaign
    // references must belong to req.workspace.id — never trust the client's
    // ids at face value. Reuses the same lookup helpers already used by
    // routes/broadcasts.js (getAccountByPhoneNumber) and the workspace-scoped
    // query pattern already used by routes/templates.js / mediaLibrary.js.
    // Reject the whole request rather than create a partially valid campaign.
    const account = await getAccountByPhoneNumber(fromNumber, workspaceId);
    if (!account) {
      return res.status(400).json({ error: 'fromNumber does not belong to a WhatsApp account in this workspace' });
    }

    if (templateId) {
      const { rows: tplRows } = await pool.query(
        'SELECT id FROM coexistence.message_templates WHERE id = $1 AND workspace_id = $2',
        [templateId, workspaceId]
      );
      if (!tplRows.length) {
        return res.status(403).json({ error: 'templateId does not belong to this workspace' });
      }
    }

    if (mediaLibraryId) {
      const { rows: mediaRows } = await pool.query(
        'SELECT id FROM coexistence.media_library WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL',
        [mediaLibraryId, workspaceId]
      );
      if (!mediaRows.length) {
        return res.status(403).json({ error: 'mediaLibraryId does not belong to this workspace' });
      }
    }

    // Never trust a workspace implied by the client — the audience is
    // always drawn from the caller's own workspace's contacts only.
    const params = [workspaceId];
    let where = 'c.workspace_id = $1';
    if (Array.isArray(customerIds) && customerIds.length > 0) {
      params.push(customerIds);
      where += ` AND c.id = ANY($${params.length}::bigint[])`;
    } else {
      const filterSql = buildFilterSQL(filters, combinator, params);
      if (filterSql) where += ` AND ${filterSql}`;
    }

    // Phone-level dedup (shared choke point with Campaign Studio — see
    // services/audienceFilter.js's buildDedupedContactsSQL doc comment):
    // a workspace can have more than one contact row for the same real
    // WhatsApp number (multiple connected WhatsApp accounts), so without
    // this the same phone could receive this campaign more than once.
    // One deterministic row per contact_number is selected before the
    // recipient list is built.
    const { rows: recipients } = await pool.query(
      `SELECT deduped.contact_number, deduped.name FROM (${buildDedupedContactsSQL(where)}) deduped`,
      params
    );
    if (recipients.length === 0) {
      return res.status(400).json({ error: 'No customers match the selected audience' });
    }
    if (recipients.length > 5000) {
      return res.status(400).json({ error: 'Audience exceeds 5000 — narrow your filters' });
    }

    const recipientNumbers = recipients.map((r) => ({ contact_number: r.contact_number, name: r.name || '' }));

    const { rows: inserted } = await pool.query(
      `INSERT INTO coexistence.broadcasts
         (workspace_id, from_number, recipient_numbers, template_id, status, name,
          variable_mapping, message_type, body, url, media_library_id, caption, source)
       VALUES ($1,$2,$3,$4,'DRAFT',$5,$6,$7,$8,$9,$10,$11,'target')
       RETURNING id`,
      [
        workspaceId, fromNumber, JSON.stringify(recipientNumbers), templateId || null,
        name || `Target Campaign ${new Date().toISOString()}`,
        JSON.stringify(variableMapping || {}), msgType,
        body || null, url || null, mediaLibraryId || null, caption || null,
      ]
    );

    res.json({ broadcastId: inserted[0].id, audienceCount: recipients.length });
  } catch (err) {
    console.error('[targetMessage] campaign create error:', err.message);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
});

module.exports = { router };


