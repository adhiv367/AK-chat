// Phase 7.5 — Meta Commerce Catalog Integration: connection service.
//
// Owns coexistence.meta_catalog_connections (schema widened additively by
// db/metaCatalogSchema.js). Every function requires BOTH workspaceId and
// whatsappAccountId and every query filters on both — mirroring the
// zoho_connections isolation model (services/zohoConnectionService.js):
// an id belonging to another workspace/account always looks like "not
// found", never a permission error that would leak its existence.
//
// Token strategy: a Meta Catalog connection almost always reuses the
// WhatsApp account's OWN Graph API token (coexistence.whatsapp_accounts
// .access_token_encrypted) — the same system-user token already used for
// WhatsApp Cloud API calls typically also carries catalog_management
// scope once the catalog is shared with the WABA's Business Manager. This
// service NEVER reads/writes that column directly except to decrypt it
// for an outbound call — it is never copied into
// meta_catalog_connections and never re-encrypted/duplicated. A
// connection only gets its own access_token_encrypted when the caller
// explicitly supplies a distinct token (e.g. a System User token scoped
// only to Commerce Manager) — that is the one and only path that ever
// writes meta_catalog_connections.access_token_encrypted.

'use strict';

const pool = require('../db');
const { encrypt, decrypt } = require('../util/crypto');
const metaCatalog = require('../integrations/metaCatalog');

class ValidationError extends Error {
  constructor(message) { super(message); this.status = 400; }
}
class NotFoundError extends Error {
  constructor(message) { super(message); this.status = 404; }
}

function requireIds(workspaceId, whatsappAccountId) {
  if (!workspaceId) throw new ValidationError('workspaceId is required');
  if (!whatsappAccountId) throw new ValidationError('whatsappAccountId is required');
}

// Never returns access_token_encrypted/secret to any caller outside this
// file — callers get a boolean instead, same convention as
// routes/catalogConnections.js's serializeConnection().
function serializeConnection(row) {
  if (!row) return null;
  const { access_token_encrypted, ...rest } = row;
  return { ...rest, hasOwnToken: !!access_token_encrypted };
}

async function getWhatsappAccount(workspaceId, whatsappAccountId) {
  const { rows } = await pool.query(
    `SELECT id, workspace_id, waba_id, business_id, access_token_encrypted
       FROM coexistence.whatsapp_accounts
      WHERE id = $1 AND workspace_id = $2`,
    [whatsappAccountId, workspaceId]
  );
  return rows[0] || null;
}

/**
 * Resolve the access token to use for Graph calls on behalf of a
 * connection: the connection's own token if it has one, otherwise the
 * parent WhatsApp account's existing token. Never mutates either row.
 */
async function resolveAccessToken(workspaceId, whatsappAccountId, connection) {
  if (connection?.access_token_encrypted) {
    return decrypt(connection.access_token_encrypted);
  }
  const account = await getWhatsappAccount(workspaceId, whatsappAccountId);
  if (!account?.access_token_encrypted) {
    throw new ValidationError('No Meta access token available for this WhatsApp account');
  }
  return decrypt(account.access_token_encrypted);
}

async function getConnection(workspaceId, whatsappAccountId) {
  requireIds(workspaceId, whatsappAccountId);
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.meta_catalog_connections
      WHERE workspace_id = $1 AND whatsapp_account_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, whatsappAccountId]
  );
  return serializeConnection(rows[0] || null);
}

async function listConnections(workspaceId) {
  if (!workspaceId) throw new ValidationError('workspaceId is required');
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.meta_catalog_connections
      WHERE workspace_id = $1
      ORDER BY created_at DESC`,
    [workspaceId]
  );
  return rows.map(serializeConnection);
}

/**
 * List catalogs available to connect for a given workspace + WhatsApp
 * account, by resolving the account's Business Manager id and calling the
 * Meta Graph client. Never hardcodes a business/catalog id — both come
 * from the account row / Graph response.
 */
async function listAvailableCatalogs(workspaceId, whatsappAccountId) {
  requireIds(workspaceId, whatsappAccountId);
  const account = await getWhatsappAccount(workspaceId, whatsappAccountId);
  if (!account) throw new NotFoundError('WhatsApp account not found');
  if (!account.business_id) {
    throw new ValidationError('This WhatsApp account has no linked Meta Business Manager id yet');
  }
  const accessToken = await resolveAccessToken(workspaceId, whatsappAccountId, null);
  return metaCatalog.listOwnedCatalogs({ accessToken, businessId: account.business_id });
}

/**
 * Connect (or re-select) a catalog for a workspace + WhatsApp account.
 * `token` is optional — only pass it when a token distinct from the
 * WhatsApp account's own token is required; otherwise the existing
 * WhatsApp account token is reused at sync time, never duplicated here.
 */
async function connectCatalog(workspaceId, whatsappAccountId, { catalogId, businessId, token } = {}) {
  requireIds(workspaceId, whatsappAccountId);
  if (!catalogId) throw new ValidationError('catalogId is required');

  const account = await getWhatsappAccount(workspaceId, whatsappAccountId);
  if (!account) throw new NotFoundError('WhatsApp account not found');

  const accessTokenEncrypted = token ? encrypt(token) : null;

  const { rows } = await pool.query(
    `INSERT INTO coexistence.meta_catalog_connections
        (workspace_id, whatsapp_account_id, catalog_id, business_id, access_token_encrypted, status, connected_at)
     VALUES ($1, $2, $3, $4, $5, 'connected', NOW())
     ON CONFLICT (workspace_id, whatsapp_account_id, catalog_id) DO UPDATE
       SET status = 'connected',
           business_id = COALESCE(EXCLUDED.business_id, coexistence.meta_catalog_connections.business_id),
           access_token_encrypted = COALESCE(EXCLUDED.access_token_encrypted, coexistence.meta_catalog_connections.access_token_encrypted),
           connected_at = NOW(),
           last_error = NULL, last_error_at = NULL,
           updated_at = NOW()
     RETURNING *`,
    [workspaceId, whatsappAccountId, catalogId, businessId || account.business_id || null, accessTokenEncrypted]
  );

  // Best-effort: also associate the catalog with the WABA on Meta's side so
  // WhatsApp catalog messaging picks it up. A failure here doesn't block
  // the local connection — it's recorded as a non-fatal warning on the row.
  try {
    const accessToken = await resolveAccessToken(workspaceId, whatsappAccountId, rows[0]);
    if (account.waba_id) {
      await metaCatalog.associateCatalogWithWaba({ accessToken, wabaId: account.waba_id, catalogId });
    }
  } catch (err) {
    await pool.query(
      `UPDATE coexistence.meta_catalog_connections SET last_error = $2, last_error_at = NOW() WHERE id = $1`,
      [rows[0].id, `Connected locally, but WABA association failed: ${err.message}`]
    );
  }

  return getConnection(workspaceId, whatsappAccountId);
}

async function disconnectCatalog(workspaceId, whatsappAccountId, catalogId) {
  requireIds(workspaceId, whatsappAccountId);
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.meta_catalog_connections
      WHERE workspace_id = $1 AND whatsapp_account_id = $2 ${catalogId ? 'AND catalog_id = $3' : ''}`,
    catalogId ? [workspaceId, whatsappAccountId, catalogId] : [workspaceId, whatsappAccountId]
  );
  if (!rows[0]) throw new NotFoundError('Meta catalog connection not found');

  await pool.query(
    `UPDATE coexistence.meta_catalog_connections
        SET status = 'disconnected', updated_at = NOW()
      WHERE id = $1`,
    [rows[0].id]
  );
  return { ok: true };
}

module.exports = {
  ValidationError,
  NotFoundError,
  getConnection,
  listConnections,
  listAvailableCatalogs,
  connectCatalog,
  disconnectCatalog,
  resolveAccessToken,
  serializeConnection,
};








