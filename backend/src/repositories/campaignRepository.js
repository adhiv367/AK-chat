// Workspace-scoped CRUD for coexistence.campaigns. Every query here takes
// workspaceId as an explicit, required argument and includes it in the
// WHERE clause — callers (routes/campaigns.js) must always pass
// req.workspace.id (server-derived), never a client-supplied id.

const pool = require('../db');

const LIST_COLUMNS = `
  id, workspace_id, name, description, channel, campaign_type, status,
  audience_type, audience_filters, audience_combinator, audience_contact_ids,
  selected_contact_ids, select_all_matching,
  audience_size_cached, audience_resolved_at,
  from_number, template_id, message_type, body, variable_mapping,
  media_library_id, caption, broadcast_id,
  created_by, created_at, updated_at, scheduled_at, started_at, completed_at
`;

async function listCampaigns(workspaceId, { search = '', status = '', channel = '', limit = 50, offset = 0 } = {}) {
  const params = [workspaceId];
  let where = 'workspace_id = $1';

  if (search) {
    params.push(`%${search}%`);
    where += ` AND name ILIKE $${params.length}`;
  }
  if (status) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  if (channel) {
    params.push(channel);
    where += ` AND channel = $${params.length}`;
  }

  const capLimit = Math.min(parseInt(limit, 10) || 50, 200);
  const capOffset = Math.max(parseInt(offset, 10) || 0, 0);

  const { rows } = await pool.query(
    `SELECT ${LIST_COLUMNS} FROM coexistence.campaigns
      WHERE ${where}
      ORDER BY updated_at DESC
      LIMIT ${capLimit} OFFSET ${capOffset}`,
    params
  );
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM coexistence.campaigns WHERE ${where}`,
    params
  );
  return { rows, total: countRows[0]?.total || 0 };
}

async function getCampaignStats(workspaceId) {
  const { rows } = await pool.query(
    `SELECT status, COUNT(*)::int AS count
       FROM coexistence.campaigns
      WHERE workspace_id = $1
      GROUP BY status`,
    [workspaceId]
  );
  const stats = { total: 0 };
  for (const r of rows) {
    stats[r.status] = r.count;
    stats.total += r.count;
  }
  return stats;
}

// Fetches a campaign by id, STRICTLY scoped to workspaceId. Returns
// undefined if the campaign doesn't exist OR belongs to a different
// workspace — callers must treat both cases identically (404), never
// leaking whether the id exists elsewhere.
async function getCampaignById(workspaceId, id) {
  const { rows } = await pool.query(
    `SELECT ${LIST_COLUMNS} FROM coexistence.campaigns WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId]
  );
  return rows[0];
}

async function createCampaign(workspaceId, data, createdBy) {
  const {
    name, description = null, channel = 'whatsapp', campaignType = 'broadcast',
    audienceType = 'filters', audienceFilters = [], audienceCombinator = 'AND', audienceContactIds = [],
    selectedContactIds = [], selectAllMatching = false,
    fromNumber = null, templateId = null, messageType = 'template', body = null,
    variableMapping = {}, mediaLibraryId = null, caption = null,
  } = data;

  const { rows } = await pool.query(
    `INSERT INTO coexistence.campaigns
       (workspace_id, name, description, channel, campaign_type, status,
        audience_type, audience_filters, audience_combinator, audience_contact_ids,
        selected_contact_ids, select_all_matching,
        from_number, template_id, message_type, body, variable_mapping,
        media_library_id, caption, created_by)
     VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING ${LIST_COLUMNS}`,
    [
      workspaceId, name, description, channel, campaignType,
      audienceType, JSON.stringify(audienceFilters), audienceCombinator, JSON.stringify(audienceContactIds),
      JSON.stringify(selectedContactIds), !!selectAllMatching,
      fromNumber, templateId, messageType, body, JSON.stringify(variableMapping),
      mediaLibraryId, caption, createdBy,
    ]
  );
  return rows[0];
}

// Full-replace update of the editable fields on a DRAFT campaign. Callers
// (routes/campaigns.js) are responsible for rejecting edits to non-draft
// campaigns before calling this.
async function updateCampaign(workspaceId, id, data) {
  const {
    name, description, channel, campaignType,
    audienceType, audienceFilters, audienceCombinator, audienceContactIds,
    selectedContactIds, selectAllMatching,
    fromNumber, templateId, messageType, body,
    variableMapping, mediaLibraryId, caption,
  } = data;

  // Defensive fallback: routes/campaigns.js merges the incoming body with
  // the existing row before calling this function, so `channel` and
  // `campaignType` should never actually be undefined here. But this
  // function backs a NOT NULL column, so it also guards with COALESCE
  // against the existing DB value directly, in case any future caller
  // (a script, a different route) calls updateCampaign with a partial
  // payload — this is what actually prevents the NULL-constraint crash
  // regardless of what the caller passes.
  const { rows } = await pool.query(
    `UPDATE coexistence.campaigns SET
       name = $3, description = $4,
       channel = COALESCE($5, channel),
       campaign_type = COALESCE($6, campaign_type),
       audience_type = $7, audience_filters = $8, audience_combinator = $9, audience_contact_ids = $10,
       selected_contact_ids = $11, select_all_matching = $12,
       from_number = $13, template_id = $14, message_type = $15, body = $16,
       variable_mapping = $17, media_library_id = $18, caption = $19
     WHERE id = $1 AND workspace_id = $2
     RETURNING ${LIST_COLUMNS}`,
    [
      id, workspaceId,
      name, description, channel, campaignType,
      audienceType, JSON.stringify(audienceFilters || []), audienceCombinator || 'AND', JSON.stringify(audienceContactIds || []),
      JSON.stringify(selectedContactIds || []), !!selectAllMatching,
      fromNumber, templateId, messageType, body,
      JSON.stringify(variableMapping || {}), mediaLibraryId, caption,
    ]
  );
  return rows[0];
}

async function updateAudienceCache(workspaceId, id, size) {
  await pool.query(
    `UPDATE coexistence.campaigns
        SET audience_size_cached = $3, audience_resolved_at = NOW()
      WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId, size]
  );
}

async function updateStatus(workspaceId, id, status, extra = {}) {
  const setClauses = ['status = $3'];
  const params = [id, workspaceId, status];
  for (const [col, val] of Object.entries(extra)) {
    params.push(val);
    setClauses.push(`${col} = $${params.length}`);
  }
  const { rows } = await pool.query(
    `UPDATE coexistence.campaigns SET ${setClauses.join(', ')}
      WHERE id = $1 AND workspace_id = $2
      RETURNING ${LIST_COLUMNS}`,
    params
  );
  return rows[0];
}
async function deleteCampaign(workspaceId, id) {
  const { rowCount } = await pool.query(
    `DELETE FROM coexistence.campaigns WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId]
  );
  return rowCount > 0;
}
module.exports = {
  listCampaigns, getCampaignStats, getCampaignById, createCampaign,
  updateCampaign, updateAudienceCache, updateStatus, deleteCampaign,
};