// Phase 8H Part 1 — Zoho CRM Reconciliation SCHEDULER.
//
// Thin interval-loop wrapper around zohoReconciliationService, following
// the EXACT same shape as sequenceScheduler.js's own
// tick/start/stop functions (see that file's header): Postgres is the
// source of truth (no in-memory queue), the claim step is what makes
// concurrent ticks/processes safe, and a tick's rows are processed
// independently so one conversation's failure can never affect another's.

const zohoReconciliationService = require('./zohoReconciliationService');
const safeLog = require('./zohoSafeLogger');

// Poll every 60s. Zoho sync retries are backoff-gated (30s-1hr, see
// zohoRetryClassifier.js) so this does not need sequenceScheduler's
// tighter 20s cadence — most ticks will find nothing due once the queue is
// caught up.
const POLL_INTERVAL_MS = parseInt(process.env.ZOHO_RECONCILIATION_POLL_MS || '60000', 10);

/**
 * One scheduler tick: claim due sync-state rows, then process each
 * independently. Mirrors sequenceScheduler.runSequenceSchedulerTick.
 */
async function runReconciliationTick() {
  let ids;
  try {
    ids = await zohoReconciliationService.claimDueSyncStateRows();
  } catch (err) {
    safeLog.error('claim error', err);
    return;
  }
  if (ids.length === 0) return;

  safeLog.info(`${ids.length} sync-state row(s) due`);

  await Promise.all(
    ids.map((id) =>
      zohoReconciliationService.processSyncStateRow(id).catch((err) => {
        safeLog.error(`row ${id} failed`, err);
      })
    )
  );
}

let schedulerInterval = null;

/**
 * Start the Zoho reconciliation scheduler. Call once at server startup,
 * alongside startSequenceScheduler()/startSheetSyncScheduler() (see
 * index.js). Safe to call repeatedly.
 */
function startZohoReconciliationScheduler() {
  if (schedulerInterval) {
    safeLog.info('Already running — skipping duplicate start');
    return;
  }
  safeLog.info(`Started — checking every ${POLL_INTERVAL_MS / 1000}s for due Zoho sync retries`);

  runReconciliationTick().catch((err) => safeLog.error('Startup tick error', err));

  schedulerInterval = setInterval(() => {
    runReconciliationTick().catch((err) => safeLog.error('Tick error', err));
  }, POLL_INTERVAL_MS);

  if (schedulerInterval.unref) schedulerInterval.unref();
}

function stopZohoReconciliationScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    safeLog.info('Stopped');
  }
}

module.exports = {
  startZohoReconciliationScheduler,
  stopZohoReconciliationScheduler,
  runReconciliationTick,
};