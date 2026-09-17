// Background job: every 60s (configurable), read only NEW rows from the
// configured Google Sheet and upsert them into coexistence.contacts.
// Mirrors the existing services/broadcastScheduler.js pattern: a single
// setInterval, safe to call startSheetSyncScheduler() once at boot.
//
// Phase 3E fix: this job used to read the single "active" settings row
// globally (no workspace concept) and resolve the WhatsApp account via
// resolveSyncWaNumber() with no workspaceId — which silently picked an
// arbitrary workspace's account (see contactSyncService.js) and wrote every
// workspace's synced contacts into that one workspace. google_sheet_settings
// now carries workspace_id (db/googleSheetWorkspaceSchema.js), so each tick
// iterates every active settings row — one per workspace — and resolves
// state (advisory lock, waNumber, cursor, log) scoped to that row's own
// workspace_id. A background job must NEVER use a caller's request
// workspace; it derives workspace strictly from the stored settings row
// being processed.
//
// Uses a Postgres advisory lock per workspace_id (not SKIP LOCKED, since
// each workspace only ever has a single settings row) so two server
// instances never run the same workspace's sync at the same moment and
// double-count purchases. Different workspaces' locks are independent.
//
// Phase 3E verification fix: runSyncTickForWorkspace() is called directly
// by routes/googleSheetSettings.js (the "Sync Now" button, scoped to the
// caller's own workspace) — it must be exported alongside the scheduler
// controls below, or that route's require() silently resolves it to
// undefined (no error until the button is actually clicked).

const pool = require('../db');
const { fetchNewRows } = require('./googleSheetService');
const { upsertCustomerFromRow, resolveSyncWaNumber } = require('./contactSyncService');

const POLL_INTERVAL_MS = parseInt(process.env.SHEET_SYNC_INTERVAL_MS || '', 10) || 60 * 1000;
// Fixed base key; the actual advisory lock key is derived per workspace_id
// below so workspaces never block each other.
const ADVISORY_LOCK_BASE_KEY = 84371;

function lockKeyFor(workspaceId) {
  // pg_try_advisory_lock takes a single bigint; combine the fixed base with
  // the workspace id so each workspace gets its own lock, deterministically.
  return ADVISORY_LOCK_BASE_KEY * 1_000_000 + Number(workspaceId);
}

/**
 * Run one sync tick for a single workspace's settings row.
 * @param {object} settings - a row from coexistence.google_sheet_settings
 *   (must include workspace_id — the only source of workspace truth here).
 */
async function runSyncTickForWorkspace(settings, triggeredBy = 'scheduler') {
  const workspaceId = settings.workspace_id;
  const client = await pool.connect();
  let logId = null;
  let locked = false;
  try {
    const { rows: lockRows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [lockKeyFor(workspaceId)]);
    locked = lockRows[0].locked;
    if (!locked) return; // another process/tick already syncing this workspace

    const { rows: logRows } = await client.query(
      `INSERT INTO coexistence.contact_sync_log (workspace_id, triggered_by) VALUES ($1, $2) RETURNING id`,
      [workspaceId, triggeredBy]
    );
    logId = logRows[0].id;

    const waNumber = await resolveSyncWaNumber(workspaceId);
    const { newRows, totalDataRows } = await fetchNewRows(settings.sheet_url, settings.last_synced_row);

    let created = 0, updated = 0, skipped = 0;
    for (const row of newRows) {
      const r = await upsertCustomerFromRow(row, waNumber, workspaceId);
      if (r.skipped) skipped++;
      else if (r.created) created++;
      else if (r.updated) updated++;
    }

    await client.query(
      `UPDATE coexistence.google_sheet_settings
          SET last_synced_row = $1, last_synced_at = NOW(),
              last_error_at = NULL, last_error_message = NULL, updated_at = NOW()
        WHERE id = $2 AND workspace_id = $3`,
      [totalDataRows, settings.id, workspaceId]
    );
    await client.query(
      `UPDATE coexistence.contact_sync_log
          SET finished_at = NOW(), rows_read = $1, contacts_created = $2,
              contacts_updated = $3, rows_skipped = $4, status = 'success'
        WHERE id = $5 AND workspace_id = $6`,
      [newRows.length, created, updated, skipped, logId, workspaceId]
    );

    if (newRows.length > 0) {
      console.log(`[sheetSync] workspace=${workspaceId} +${newRows.length} rows -> ${created} created, ${updated} updated, ${skipped} skipped`);
    }
  } catch (err) {
    console.error(`[sheetSync] workspace=${workspaceId} tick error:`, err.message);
    try {
      await pool.query(
        `UPDATE coexistence.google_sheet_settings
            SET last_error_at = NOW(), last_error_message = $1
          WHERE workspace_id = $2 AND is_active = TRUE`,
        [err.message.slice(0, 500), workspaceId]
      );
      if (logId) {
        await pool.query(
          `UPDATE coexistence.contact_sync_log
              SET finished_at = NOW(), status = 'error', error_message = $1
            WHERE id = $2 AND workspace_id = $3`,
          [err.message.slice(0, 500), logId, workspaceId]
        );
      }
    } catch (_) { /* best-effort error logging */ }
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [lockKeyFor(workspaceId)]).catch(() => {});
    client.release();
  }
}

/**
 * One scheduler tick: find every workspace's active settings row and sync
 * each independently. One workspace's failure never blocks another's.
 */
async function runSyncTick(triggeredBy = 'scheduler') {
  const { rows: settingsRows } = await pool.query(
    `SELECT * FROM coexistence.google_sheet_settings WHERE is_active = TRUE AND workspace_id IS NOT NULL`
  );
  if (settingsRows.length === 0) return; // nothing configured yet

  for (const settings of settingsRows) {
    await runSyncTickForWorkspace(settings, triggeredBy);
  }
}

let schedulerInterval = null;

function startSheetSyncScheduler() {
  if (schedulerInterval) {
    console.log('[sheetSync] Already running — skipping duplicate start');
    return;
  }
  console.log(`[sheetSync] ✓ Started — checking every ${POLL_INTERVAL_MS / 1000}s`);

  runSyncTick().catch((err) => console.error('[sheetSync] startup tick error:', err.message));

  schedulerInterval = setInterval(() => {
    runSyncTick().catch((err) => console.error('[sheetSync] tick error:', err.message));
  }, POLL_INTERVAL_MS);

  if (schedulerInterval.unref) schedulerInterval.unref();
}

function stopSheetSyncScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[sheetSync] Stopped');
  }
}

module.exports = { startSheetSyncScheduler, stopSheetSyncScheduler, runSyncTick, runSyncTickForWorkspace };










