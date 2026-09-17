// Media object storage backed by PostgreSQL.
//
// Files are stored as bytea rows in coexistence.media_objects, one row per
// object keyed by `object_key`. This is the project's only object store — there
// is no external object-storage service. The API (ensureBucket / putObject /
// getObjectBuffer / removeObject / bucketName) is intentionally storage-agnostic
// so callers don't care about the backend.
//
// coexistence.media_objects.workspace_id is NOT NULL in the database (added
// by the SaaS Phase 1 migration, akchat_saas_phase1_db_migration.sql) —
// every write MUST supply it or Postgres rejects the insert outright. This
// is why every media-library upload was failing regardless of file size
// (see routes/mediaLibrary.js).
//
// node-postgres returns bytea columns as Node Buffers, so getObjectBuffer can
// hand the value straight back to res.send / Meta upload / disk mirror.

const pool = require('../db');

const BACKEND = 'postgres';

// Defensive: create the storage table if it doesn't exist yet (mirrors the
// ensureTables() pattern used elsewhere). The migrations also create it.
async function ensureBucket() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.media_objects (
      object_key  TEXT PRIMARY KEY,
      data        BYTEA NOT NULL,
      mime_type   TEXT,
      size_bytes  BIGINT,
      workspace_id BIGINT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function putObject(objectKey, buffer, mimeType, workspaceId) {
  if (workspaceId == null) {
    // Fail loudly and specifically here rather than letting Postgres throw
    // an opaque NOT NULL violation two layers down.
    throw new Error('putObject: workspaceId is required (coexistence.media_objects.workspace_id is NOT NULL)');
  }
  await pool.query(
    `INSERT INTO coexistence.media_objects (object_key, data, mime_type, size_bytes, workspace_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (object_key) DO UPDATE
       SET data = EXCLUDED.data,
           mime_type = EXCLUDED.mime_type,
           size_bytes = EXCLUDED.size_bytes`,
    [objectKey, buffer, mimeType || null, buffer.length, workspaceId]
  );
}

async function getObjectBuffer(objectKey) {
  const { rows } = await pool.query(
    `SELECT data FROM coexistence.media_objects WHERE object_key = $1`,
    [objectKey]
  );
  if (!rows.length) throw new Error(`Media object not found: ${objectKey}`);
  return rows[0].data; // bytea -> Buffer
}

async function removeObject(objectKey) {
  await pool.query(
    `DELETE FROM coexistence.media_objects WHERE object_key = $1`,
    [objectKey]
  ).catch(() => {});
}

function bucketName() { return BACKEND; }

module.exports = {
  ensureBucket,
  putObject,
  getObjectBuffer,
  removeObject,
  bucketName,
};

