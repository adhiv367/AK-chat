// Background job: every 60s (configurable), read only NEW rows from the
// configured Google Sheet and upsert them into coexistence.contacts.
// Mirrors the existing services/broadcastScheduler.js pattern: a single
// setInterval, safe to call startSheetSyncScheduler() once at boot.
//
// Uses a Postgres advisory lock (not SKIP LOCKED, since this job only ever
// touches a single settings row) so two server instances never run the sync
// at the same moment and double-count purchases.

const pool = require('../db');
const { fetchNewRows } = require('./googleSheetService');
const { upsertCustomerFromRow, resolveSyncWaNumber } = require('./contactSyncService');

const POLL_INTERVAL_MS = parseInt(process.env.SHEET_SYNC_INTERVAL_MS || '', 10) || 60 * 1000;
const ADVISORY_LOCK_KEY = 84371; // arbitrary fixed key for this job

async function runSyncTick(triggeredBy = 'scheduler') {
  const client = await pool.connect();
  let logId = null;
  let locked = false;
  try {
    const { rows: lockRows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [ADVISORY_LOCK_KEY]);
    locked = lockRows[0].locked;
    if (!locked) return; // another process/tick already running

    const { rows: settingsRows } = await client.query(
      `SELECT * FROM coexistence.google_sheet_settings WHERE is_active = TRUE ORDER BY id DESC LIMIT 1`
    );
    const settings = settingsRows[0];
    if (!settings) return; // not configured yet — nothing to do

    const { rows: logRows } = await client.query(
      `INSERT INTO coexistence.contact_sync_log (triggered_by) VALUES ($1) RETURNING id`,
      [triggeredBy]
    );
    logId = logRows[0].id;

    const waNumber = await resolveSyncWaNumber();
    const { newRows, totalDataRows } = await fetchNewRows(settings.sheet_url, settings.last_synced_row);

    let created = 0, updated = 0, skipped = 0;
    for (const row of newRows) {
      const r = await upsertCustomerFromRow(row, waNumber);
      if (r.skipped) skipped++;
      else if (r.created) created++;
      else if (r.updated) updated++;
    }

    await client.query(
      `UPDATE coexistence.google_sheet_settings
          SET last_synced_row = $1, last_synced_at = NOW(),
              last_error_at = NULL, last_error_message = NULL, updated_at = NOW()
        WHERE id = $2`,
      [totalDataRows, settings.id]
    );
    await client.query(
      `UPDATE coexistence.contact_sync_log
          SET finished_at = NOW(), rows_read = $1, contacts_created = $2,
              contacts_updated = $3, rows_skipped = $4, status = 'success'
        WHERE id = $5`,
      [newRows.length, created, updated, skipped, logId]
    );

    if (newRows.length > 0) {
      console.log(`[sheetSync] +${newRows.length} rows -> ${created} created, ${updated} updated, ${skipped} skipped`);
    }
  } catch (err) {
    console.error('[sheetSync] tick error:', err.message);
    try {
      await pool.query(
        `UPDATE coexistence.google_sheet_settings
            SET last_error_at = NOW(), last_error_message = $1
          WHERE is_active = TRUE`,
        [err.message.slice(0, 500)]
      );
      if (logId) {
        await pool.query(
          `UPDATE coexistence.contact_sync_log
              SET finished_at = NOW(), status = 'error', error_message = $1
            WHERE id = $2`,
          [err.message.slice(0, 500), logId]
        );
      }
    } catch (_) { /* best-effort error logging */ }
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
    client.release();
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

module.exports = { startSheetSyncScheduler, stopSheetSyncScheduler, runSyncTick };