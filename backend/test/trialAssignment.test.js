'use strict';

// Phase 8B-4 — focused new-workspace trial assignment test only.
// No real Postgres: pool.query / the passed-in `client` are monkey-patched
// mocks, same approach as test/trialSchema.test.js.
//
// Asserts:
//   1. New workspace gets 'trialing' status via ensureBillingRowForNewWorkspace().
//   2. trial_started_at ~= now, trial_ends_at ~= now + TRIAL_DURATION_DAYS
//      (default 14, and respects the env var override).
//   3. Existing workspace (ON CONFLICT) is not overwritten — the INSERT
//      uses ON CONFLICT (workspace_id) DO NOTHING, never an UPDATE.
//   4. Legacy/grandfathered workspaces still go through
//      grandfatherPreExistingWorkspaces(), which is untouched: still
//      inserts 'active'/'none' with no trial fields.
//   5. Workspace isolation: the INSERT is parameterized to exactly the
//      workspace_id passed in.

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/db');

test('Phase 8B-4: new workspace gets trialing status with correct trial dates', async () => {
  delete process.env.TRIAL_DURATION_DAYS;
  const { ensureBillingRowForNewWorkspace } = require('../src/db/plansSchema');

  let insertSql = null;
  let insertParams = null;
  const fakeClient = {
    query: async (sql, params) => {
      if (/SELECT id FROM coexistence\.plans/.test(sql)) {
        return { rows: [{ id: 5 }] };
      }
      if (/INSERT INTO coexistence\.workspace_billing/.test(sql)) {
        insertSql = sql;
        insertParams = params;
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const planId = await ensureBillingRowForNewWorkspace(fakeClient, 101);
  assert.equal(planId, 5);
  assert.match(insertSql, /'trialing'/);
  assert.match(insertSql, /trial_started_at/);
  assert.match(insertSql, /trial_ends_at/);
  assert.match(insertSql, /NOW\(\) \+ \(\$3 \|\| ' days'\)::interval/);
  assert.match(insertSql, /ON CONFLICT \(workspace_id\) DO NOTHING/);
  assert.deepEqual(insertParams, [101, 5, '14']); // default trial duration
});

test('Phase 8B-4: TRIAL_DURATION_DAYS env var overrides default', async () => {
  process.env.TRIAL_DURATION_DAYS = '30';
  delete require.cache[require.resolve('../src/db/plansSchema')];
  const { ensureBillingRowForNewWorkspace, getTrialDurationDays } = require('../src/db/plansSchema');

  assert.equal(getTrialDurationDays(), 30);

  let insertParams = null;
  const fakeClient = {
    query: async (sql, params) => {
      if (/SELECT id FROM coexistence\.plans/.test(sql)) return { rows: [{ id: 5 }] };
      if (/INSERT INTO coexistence\.workspace_billing/.test(sql)) { insertParams = params; return { rows: [] }; }
      return { rows: [] };
    },
  };
  await ensureBillingRowForNewWorkspace(fakeClient, 202);
  assert.equal(insertParams[2], '30');

  delete process.env.TRIAL_DURATION_DAYS;
  delete require.cache[require.resolve('../src/db/plansSchema')];
});

test('Phase 8B-4: existing workspace row is not overwritten (ON CONFLICT DO NOTHING only)', async () => {
  const { ensureBillingRowForNewWorkspace } = require('../src/db/plansSchema');

  let sawUpdate = false;
  const fakeClient = {
    query: async (sql) => {
      if (/UPDATE coexistence\.workspace_billing/.test(sql)) { sawUpdate = true; return { rows: [] }; }
      if (/SELECT id FROM coexistence\.plans/.test(sql)) return { rows: [{ id: 5 }] };
      if (/INSERT INTO coexistence\.workspace_billing/.test(sql)) return { rows: [] }; // ON CONFLICT -> no-op
      return { rows: [] };
    },
  };
  await ensureBillingRowForNewWorkspace(fakeClient, 303);
  assert.equal(sawUpdate, false, 'ensureBillingRowForNewWorkspace must never UPDATE an existing row');
});

test('Phase 8B-4: legacy/grandfathered workspaces unaffected — still active/no trial fields', async () => {
  const { ensurePlansTables } = require('../src/db/plansSchema');

  const queries = [];
  const originalQuery = pool.query;
  pool.query = async (sql, params) => {
    queries.push({ sql, params });
    if (/SELECT w\.id FROM coexistence\.workspaces w/.test(sql)) {
      return { rows: [{ id: 999 }] }; // one orphaned legacy workspace
    }
    if (/SELECT \* FROM coexistence\.plans WHERE key/.test(sql)) {
      return { rows: [{ id: 1, key: 'legacy_unlimited' }] };
    }
    return { rows: [] };
  };

  try {
    await ensurePlansTables();
  } finally {
    pool.query = originalQuery;
  }

  const grandfatherInsert = queries.find(
    q => /INSERT INTO coexistence\.workspace_billing/.test(q.sql) && /'active'/.test(q.sql)
  );
  assert.ok(grandfatherInsert, 'expected the grandfathering INSERT for the legacy workspace');
  assert.doesNotMatch(grandfatherInsert.sql, /trial_started_at/);
  assert.doesNotMatch(grandfatherInsert.sql, /trial_ends_at/);
  assert.doesNotMatch(grandfatherInsert.sql, /'trialing'/);
});

test('Phase 8B-4: workspace isolation — INSERT parameterized to exact workspace_id', async () => {
  const { ensureBillingRowForNewWorkspace } = require('../src/db/plansSchema');

  let insertParams = null;
  const fakeClient = {
    query: async (sql, params) => {
      if (/SELECT id FROM coexistence\.plans/.test(sql)) return { rows: [{ id: 7 }] };
      if (/INSERT INTO coexistence\.workspace_billing/.test(sql)) { insertParams = params; return { rows: [] }; }
      return { rows: [] };
    },
  };
  await ensureBillingRowForNewWorkspace(fakeClient, 555);
  assert.equal(insertParams[0], 555);
});