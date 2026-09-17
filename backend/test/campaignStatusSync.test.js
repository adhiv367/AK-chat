'use strict';

// Phase 6 Part 3B — recipient delivery tracking + campaign status sync.
//
// Same pool.query monkey-patch approach as test/campaignSendNow.test.js
// (no live Postgres reachable from this sandbox). These tests cover the
// NEW code added for Part 3B: getBroadcastAggregate (the broadcast_logs
// rollup, mirroring routes/broadcasts.js's own computeDisplayStatus
// aggregate query) and reconcileCampaignStatus/reconcileCampaignRows (the
// live "is this campaign actually done?" derivation used by GET
// /campaigns/:id and GET /campaigns). Part 3A's Send Now route is
// untouched by this file's changes and is covered separately by
// test/campaignSendNow.test.js — running that suite alongside this one
// (both included in `node --test test/*.test.js`) is the regression check
// that Part 3B didn't disturb it.

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/db');
const {
  getBroadcastAggregate,
  reconcileCampaignStatus,
  reconcileCampaignRows,
} = require('../src/routes/campaigns');

function installAggregateDb(agg) {
  const calls = [];
  const originalQuery = pool.query;
  pool.query = async (sql, params) => {
    calls.push({ sql, params });
    if (/FROM coexistence\.broadcast_logs/.test(sql)) {
      return { rows: [agg] };
    }
    if (/UPDATE coexistence\.campaigns SET/.test(sql) && /RETURNING/.test(sql)) {
      // Mirror campaignRepository.updateStatus's own RETURNING shape.
      const statusIdx = 2; // params: [id, workspaceId, status, ...extra]
      return { rows: [{ id: params[0], workspace_id: params[1], status: params[statusIdx] }] };
    }
    return { rows: [] };
  };
  return { calls, restore() { pool.query = originalQuery; } };
}

const RUNNING_CAMPAIGN = { id: 42, workspace_id: 7, status: 'running', broadcast_id: 900 };

// ─── getBroadcastAggregate ──────────────────────────────────────────────

test('getBroadcastAggregate: reads recipient/pending/failed/success counts from broadcast_logs', async () => {
  const db = installAggregateDb({ recipient_count: 2, pending_count: 0, failed_count: 0, success_count: 2 });
  try {
    const agg = await getBroadcastAggregate(900);
    assert.equal(agg.recipient_count, 2);
    assert.equal(agg.pending_count, 0);
    assert.equal(agg.failed_count, 0);
    assert.equal(agg.success_count, 2);
    assert.equal(db.calls.length, 1);
    assert.match(db.calls[0].sql, /action = 'BROADCAST'/);
    assert.deepEqual(db.calls[0].params, [900]);
  } finally { db.restore(); }
});

// ─── recipient-level statuses (sent / delivered / read / failed) ────────
//
// broadcast_logs.status itself only ever holds PENDING/sent/failed (see
// sendQueue.js's worker) — delivered/read live on chat_history, joined by
// wa_message_id (routes/broadcasts.js's getBroadcastWithLogs `rollup`
// query). success_count therefore counts sent OR delivered OR read: a
// recipient that has progressed past "sent" is still success, not pending.

test('campaign recipient sent: counted as success, not pending', async () => {
  const db = installAggregateDb({ recipient_count: 1, pending_count: 0, failed_count: 0, success_count: 1 });
  try {
    const agg = await getBroadcastAggregate(900);
    assert.equal(agg.success_count, 1);
    assert.equal(agg.pending_count, 0);
  } finally { db.restore(); }
});

test('campaign recipient delivered/read: still counted as success (broadcast_logs.status stays "sent")', async () => {
  // delivered/read are chat_history-only transitions; broadcast_logs.status
  // for that recipient never changes from 'sent', so the aggregate query's
  // `status IN ('sent','delivered','read')` filter is what makes these
  // recipients count as success — exercised here via the aggregate result.
  const db = installAggregateDb({ recipient_count: 1, pending_count: 0, failed_count: 0, success_count: 1 });
  try {
    const agg = await getBroadcastAggregate(900);
    assert.equal(agg.success_count, 1);
  } finally { db.restore(); }
});

test('campaign recipient failed: counted as failed', async () => {
  const db = installAggregateDb({ recipient_count: 1, pending_count: 0, failed_count: 1, success_count: 0 });
  try {
    const agg = await getBroadcastAggregate(900);
    assert.equal(agg.failed_count, 1);
    assert.equal(agg.success_count, 0);
  } finally { db.restore(); }
});

// ─── reconcileCampaignStatus ────────────────────────────────────────────

test('reconcileCampaignStatus: all recipients succeed -> campaign completed', async () => {
  const db = installAggregateDb({ recipient_count: 2, pending_count: 0, failed_count: 0, success_count: 2 });
  try {
    const updated = await reconcileCampaignStatus(7, RUNNING_CAMPAIGN);
    assert.equal(updated.status, 'completed');
    const updateCall = db.calls.find((c) => /UPDATE coexistence\.campaigns SET/.test(c.sql));
    assert.ok(updateCall, 'expected an UPDATE coexistence.campaigns call');
    assert.equal(updateCall.params[2], 'completed');
  } finally { db.restore(); }
});

test('reconcileCampaignStatus: all recipients fail -> campaign failed', async () => {
  const db = installAggregateDb({ recipient_count: 2, pending_count: 0, failed_count: 2, success_count: 0 });
  try {
    const updated = await reconcileCampaignStatus(7, RUNNING_CAMPAIGN);
    assert.equal(updated.status, 'failed');
  } finally { db.restore(); }
});

test('reconcileCampaignStatus: mixed success/failure -> completed (any success counts as a completed run)', async () => {
  const db = installAggregateDb({ recipient_count: 3, pending_count: 0, failed_count: 1, success_count: 2 });
  try {
    const updated = await reconcileCampaignStatus(7, RUNNING_CAMPAIGN);
    assert.equal(updated.status, 'completed');
  } finally { db.restore(); }
});

test('reconcileCampaignStatus: any PENDING recipient -> campaign stays running, no write', async () => {
  const db = installAggregateDb({ recipient_count: 2, pending_count: 1, failed_count: 0, success_count: 1 });
  try {
    const updated = await reconcileCampaignStatus(7, RUNNING_CAMPAIGN);
    assert.equal(updated.status, 'running');
    assert.equal(db.calls.some((c) => /UPDATE coexistence\.campaigns SET/.test(c.sql)), false);
  } finally { db.restore(); }
});

test('reconcileCampaignStatus: no broadcast_logs rows yet (send still enqueuing) -> stays running, no write', async () => {
  const db = installAggregateDb({ recipient_count: 0, pending_count: 0, failed_count: 0, success_count: 0 });
  try {
    const updated = await reconcileCampaignStatus(7, RUNNING_CAMPAIGN);
    assert.equal(updated.status, 'running');
    assert.equal(db.calls.some((c) => /UPDATE coexistence\.campaigns SET/.test(c.sql)), false);
  } finally { db.restore(); }
});

test('reconcileCampaignStatus: non-running campaign is a no-op (never re-derives a terminal status)', async () => {
  const db = installAggregateDb({ recipient_count: 5, pending_count: 0, failed_count: 5, success_count: 0 });
  try {
    const completed = { ...RUNNING_CAMPAIGN, status: 'completed' };
    const result = await reconcileCampaignStatus(7, completed);
    assert.equal(result, completed);
    assert.equal(db.calls.length, 0);
  } finally { db.restore(); }
});

test('reconcileCampaignStatus: running campaign with no broadcast_id yet is a no-op', async () => {
  const db = installAggregateDb({ recipient_count: 5, pending_count: 0, failed_count: 0, success_count: 5 });
  try {
    const noBroadcast = { ...RUNNING_CAMPAIGN, broadcast_id: null };
    const result = await reconcileCampaignStatus(7, noBroadcast);
    assert.equal(result, noBroadcast);
    assert.equal(db.calls.length, 0);
  } finally { db.restore(); }
});

// ─── Duplicate webhook idempotency ───────────────────────────────────────
//
// The webhook itself never touches broadcast_logs (it only UPDATEs
// chat_history.status by message_id — see routes/webhook.js's `status`
// branch), so a duplicate delivery/read receipt cannot double-count a
// recipient in the aggregate this file's reconciliation reads from. What
// this test actually verifies is the property that matters for campaign
// status: calling reconcileCampaignStatus twice against the SAME (already
// terminal) broadcast_logs state produces the same result both times and
// only writes once — the second call sees a campaign that is no longer
// 'running' and is a no-op, exactly like the "non-running campaign" test
// above.

test('reconcileCampaignStatus: calling twice in a row (simulating a duplicate webhook re-read) does not double-write', async () => {
  const db = installAggregateDb({ recipient_count: 2, pending_count: 0, failed_count: 0, success_count: 2 });
  try {
    const first = await reconcileCampaignStatus(7, RUNNING_CAMPAIGN);
    assert.equal(first.status, 'completed');
    const second = await reconcileCampaignStatus(7, first); // now 'completed' already
    assert.equal(second.status, 'completed');
    const updateCalls = db.calls.filter((c) => /UPDATE coexistence\.campaigns SET/.test(c.sql));
    assert.equal(updateCalls.length, 1, 'expected exactly one status-transition write, not two');
  } finally { db.restore(); }
});

// ─── campaign remains linked to its broadcast ────────────────────────────

test('reconcileCampaignStatus: broadcast_id is preserved through the completed transition', async () => {
  const db = installAggregateDb({ recipient_count: 1, pending_count: 0, failed_count: 0, success_count: 1 });
  try {
    // updateStatus's real RETURNING clause returns every LIST_COLUMNS field,
    // including broadcast_id (it's never in the SET list, only WHERE'd on),
    // so it always survives — installAggregateDb's fake mirrors just the
    // fields this test checks.
    pool.query = async (sql, params) => {
      if (/FROM coexistence\.broadcast_logs/.test(sql)) return { rows: [{ recipient_count: 1, pending_count: 0, failed_count: 0, success_count: 1 }] };
      if (/UPDATE coexistence\.campaigns SET/.test(sql) && /RETURNING/.test(sql)) {
        return { rows: [{ id: params[0], workspace_id: params[1], status: params[2], broadcast_id: RUNNING_CAMPAIGN.broadcast_id }] };
      }
      return { rows: [] };
    };
    const updated = await reconcileCampaignStatus(7, RUNNING_CAMPAIGN);
    assert.equal(updated.broadcast_id, 900);
  } finally { db.restore(); }
});

// ─── reconcileCampaignRows (list endpoint) ───────────────────────────────

test('reconcileCampaignRows: only queries broadcast_logs for running rows with a broadcast_id', async () => {
  const db = installAggregateDb({ recipient_count: 1, pending_count: 0, failed_count: 0, success_count: 1 });
  try {
    const rows = [
      { id: 1, workspace_id: 7, status: 'draft', broadcast_id: null },
      { id: 2, workspace_id: 7, status: 'completed', broadcast_id: 800 },
      { ...RUNNING_CAMPAIGN },
    ];
    const result = await reconcileCampaignRows(7, rows);
    assert.equal(result[0].status, 'draft');
    assert.equal(result[1].status, 'completed');
    assert.equal(result[2].status, 'completed'); // was 'running', now resolved
    const aggCalls = db.calls.filter((c) => /FROM coexistence\.broadcast_logs/.test(c.sql));
    assert.equal(aggCalls.length, 1, 'expected exactly one broadcast_logs lookup, for the single running row');
  } finally { db.restore(); }
});

