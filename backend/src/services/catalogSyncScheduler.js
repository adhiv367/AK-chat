// Phase 7.4 — Catalog Connection Layer: background scheduler.
//
// Mirrors services/sheetSyncScheduler.js exactly: a single setInterval,
// safe to call startCatalogSyncScheduler() once at boot, one Postgres
// advisory lock per (workspace_id, source) so two server instances never
// double-run the same workspace's catalog sync, and a directly-exported
// runSyncTickForConnection() that routes/catalogConnections.js's "Sync Now"
// button calls too — same dual-caller shape as runSyncTickForWorkspace().
//
// Only polls pollable sources (shopify, website, google_sheet) — csv has no
// persistent config to re-fetch (each run is a one-off upload, triggered
// only from the route) and manual never has a connection row at all.

const pool = require('../db');
const { runImport } = require('./catalogImportService');

const POLL_INTERVAL_MS = parseInt(process.env.CATALOG_SYNC_INTERVAL_MS || '', 10) || 5 * 60 * 1000;
const ADVISORY_LOCK_BASE_KEY = 91177;
const POLLABLE_SOURCES = ['shopify', 'website', 'google_sheet'];

function lockKeyFor(connectionId) {
  return ADVISORY_LOCK_BASE_KEY * 1_000_000 + Number(connectionId);
}

/**
 * Run one sync tick for a single catalog_connections row.
 * @param {object} connection - a row from coexistence.catalog_connections
 *   (must include workspace_id, id, source, config, secret_encrypted).
 */
async function runSyncTickForConnection(connection, triggeredBy = 'scheduler') {
  const client = await pool.connect();
  let locked = false;
  try {
    const { rows: lockRows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [lockKeyFor(connection.id)]);
    locked = lockRows[0].locked;
    if (!locked) return; // another process/tick already syncing this connection

    await client.query(`UPDATE coexistence.catalog_connections SET status = 'syncing' WHERE id = $1`, [connection.id]);
    await runImport(connection.workspace_id, connection, { triggeredBy });
  } catch (err) {
    // runImport() already records the error on the connection + sync log;
    // swallow here so one workspace's failure never stops the scheduler tick.
    console.error(`[catalogSyncScheduler] connection ${connection.id} (${connection.source}) failed:`, err.message);
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [lockKeyFor(connection.id)]);
    client.release();
  }
}

async function tick() {
  const { rows: connections } = await pool.query(
    `SELECT * FROM coexistence.catalog_connections
      WHERE source = ANY($1) AND status IN ('connected', 'error')`,
    [POLLABLE_SOURCES]
  );
  for (const connection of connections) {
    await runSyncTickForConnection(connection, 'scheduler');
  }
}

let intervalHandle = null;

function startCatalogSyncScheduler() {
  if (intervalHandle) return; // already started
  intervalHandle = setInterval(() => {
    tick().catch((err) => console.error('[catalogSyncScheduler] tick error:', err.message));
  }, POLL_INTERVAL_MS);
}

function stopCatalogSyncScheduler() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = { startCatalogSyncScheduler, stopCatalogSyncScheduler, runSyncTickForConnection };
