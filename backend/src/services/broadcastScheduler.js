/**
 * broadcastScheduler.js
 *
 * FILE LOCATION: your-project/services/broadcastScheduler.js
 *
 * This is the background scheduler that automatically fires scheduled broadcasts.
 * It checks the database every 60 seconds for any broadcast where:
 *   - status = 'SCHEDULED'
 *   - scheduled_at <= NOW()  (the scheduled time has arrived)
 *
 * When it finds one, it calls executeBroadcast() which sends all messages.
 *
 * SERVER RESTART SAFETY:
 *   All scheduled broadcasts are stored in Postgres with status='SCHEDULED'.
 *   If your server restarts, this scheduler starts again and immediately checks
 *   the database. Any broadcasts that were due while the server was down are
 *   sent within 60 seconds of the server coming back online.
 *
 * MULTIPLE SERVERS:
 *   Uses "SELECT FOR UPDATE SKIP LOCKED" which means if you run two server
 *   instances, each broadcast is only sent once — no duplicates.
 */

const pool = require('../db');
const { executeBroadcast } = require('../routes/broadcasts');

// Phase 6 Part 3C — Campaign Scheduling integration.
//
// Campaign Studio's POST /campaigns/:id/schedule creates a normal
// coexistence.broadcasts row with status='SCHEDULED' (source='campaign')
// and links coexistence.campaigns.broadcast_id to it — it does NOT touch
// this scheduler's tick logic at all. This scheduler still only ever
// queries/locks/fires coexistence.broadcasts exactly as it always has.
//
// The ONE thing a scheduled CAMPAIGN needs beyond what a scheduled
// (Broadcast Studio) broadcast needs is for coexistence.campaigns.status to
// track along: 'scheduled' -> 'running' when this scheduler fires the
// linked broadcast, and 'scheduled' -> 'failed' if firing it errors. This
// helper is the single, additive seam for that — called right after the
// existing fire/fail branches below, never in the tick/lock logic itself.
//
// Conditional + idempotent by construction:
//   - `WHERE broadcast_id = $1 AND status = 'scheduled'` means a plain
//     Broadcast Studio broadcast (no campaign ever points at it) always
//     matches zero rows here — completely inert for non-campaign sends.
//   - A campaign already moved off 'scheduled' (e.g. cancelled via
//     POST /campaigns/:id/cancel-schedule racing this same tick) is a
//     no-op rowcount=0 UPDATE, never overwritten back to 'running'/'failed'.
//   - Calling this twice for the same broadcastId is harmless: the second
//     call's WHERE no longer matches (status is no longer 'scheduled'), so
//     it cannot double-transition or re-fire anything — no campaign-level
//     send/enqueue happens here, only a status label sync onto a broadcast
//     that executeBroadcast() (or its failure path) already fired exactly
//     once, per the SKIP LOCKED guarantee below.
async function syncLinkedCampaignStatus(broadcastId, { failed = false } = {}) {
  try {
    if (failed) {
      await pool.query(
        `UPDATE coexistence.campaigns
            SET status = 'failed'
          WHERE broadcast_id = $1 AND status = 'scheduled'`,
        [broadcastId]
      );
    } else {
      await pool.query(
        `UPDATE coexistence.campaigns
            SET status = 'running', started_at = COALESCE(started_at, NOW())
          WHERE broadcast_id = $1 AND status = 'scheduled'`,
        [broadcastId]
      );
    }
  } catch (err) {
    // Never let a campaign-status sync failure affect the broadcast send
    // itself (already completed/failed by this point) or crash the
    // scheduler tick — just log it, same posture as the existing
    // FAILED-marking catch below.
    console.error(`[scheduler] Could not sync campaign status for broadcast ${broadcastId}:`, err.message);
  }
}

// Check every 60 seconds
const POLL_INTERVAL_MS = 60 * 1000;

// Track which broadcast IDs are currently being processed
// so we don't fire the same one twice in the same process
const inProgress = new Set();

/**
 * One scheduler tick: find all due broadcasts and fire them.
 */
async function runSchedulerTick() {
  let client;
  try {
    client = await pool.connect();

    // Find broadcasts that are due RIGHT NOW.
    // FOR UPDATE SKIP LOCKED = only one server instance processes each row.
    const { rows } = await client.query(
      `SELECT id, name, scheduled_at
         FROM coexistence.broadcasts
        WHERE status = 'SCHEDULED'
          AND scheduled_at IS NOT NULL
          AND scheduled_at <= NOW()
        ORDER BY scheduled_at ASC
        FOR UPDATE SKIP LOCKED`
    );

    if (rows.length === 0) {
      client.release();
      return; // Nothing to do this tick
    }

    console.log(
      `[scheduler] ${rows.length} broadcast(s) due to fire:`,
      rows.map(r => `"${r.name || r.id}"`).join(', ')
    );

    // Immediately mark all of them as SENDING while we still hold the lock.
    // This prevents another server instance from picking them up.
    for (const b of rows) {
      if (!inProgress.has(b.id)) {
        await client.query(
          `UPDATE coexistence.broadcasts
              SET status = 'SENDING', updated_at = NOW()
            WHERE id = $1`,
          [b.id]
        );
        inProgress.add(b.id);
      }
    }

    client.release();
    client = null;

    // Fire each broadcast AFTER releasing the lock (send can be slow for large lists)
    for (const b of rows) {
      // Run each broadcast send independently — one failing does not stop others
      (async () => {
        try {
          console.log(`[scheduler] Firing broadcast ${b.id} — "${b.name || 'unnamed'}" (was scheduled for ${b.scheduled_at})`);
          const enqueued = await executeBroadcast(b.id);
          console.log(`[scheduler] ✓ Broadcast "${b.name || b.id}" sent — ${enqueued} recipients enqueued`);
          // Phase 6 Part 3C: no-op for plain Broadcast Studio broadcasts —
          // see syncLinkedCampaignStatus's doc comment above.
          await syncLinkedCampaignStatus(b.id, { failed: false });
        } catch (err) {
          console.error(`[scheduler] ✗ Broadcast "${b.name || b.id}" FAILED:`, err.message);
          // Mark as FAILED in DB so the UI shows an error badge
          try {
            await pool.query(
              `UPDATE coexistence.broadcasts
                  SET status = 'FAILED', updated_at = NOW()
                WHERE id = $1`,
              [b.id]
            );
          } catch (dbErr) {
            console.error(`[scheduler] Could not mark broadcast ${b.id} as FAILED:`, dbErr.message);
          }
          await syncLinkedCampaignStatus(b.id, { failed: true });
        } finally {
          inProgress.delete(b.id);
        }
      })();
    }
  } catch (err) {
    console.error('[scheduler] Tick error:', err.message);
    if (client) {
      try { client.release(); } catch (_) {}
    }
  }
}

// Reference to the interval so we can stop it cleanly
let schedulerInterval = null;

/**
 * Start the broadcast scheduler.
 * Call this ONCE when your server starts.
 * Safe to call multiple times — won't create duplicate intervals.
 */
function startBroadcastScheduler() {
  if (schedulerInterval) {
    console.log('[scheduler] Already running — skipping duplicate start');
    return;
  }

  console.log(`[scheduler] ✓ Started — checking every ${POLL_INTERVAL_MS / 1000}s for scheduled broadcasts`);

  // Run IMMEDIATELY on startup (catches any broadcasts missed during downtime)
  runSchedulerTick().catch(err =>
    console.error('[scheduler] Startup tick error:', err.message)
  );

  // Then repeat every 60 seconds
  schedulerInterval = setInterval(() => {
    runSchedulerTick().catch(err =>
      console.error('[scheduler] Tick error:', err.message)
    );
  }, POLL_INTERVAL_MS);

  // .unref() means the scheduler interval won't prevent Node.js from exiting
  // during graceful shutdown (pm2 stop, ctrl+c, etc.)
  if (schedulerInterval.unref) {
    schedulerInterval.unref();
  }
}

/**
 * Stop the scheduler cleanly (used for graceful shutdown or testing).
 */
function stopBroadcastScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[scheduler] Stopped');
  }
}

module.exports = { startBroadcastScheduler, stopBroadcastScheduler, runSchedulerTick, syncLinkedCampaignStatus };
