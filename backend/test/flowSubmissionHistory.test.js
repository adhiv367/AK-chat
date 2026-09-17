'use strict';

// Phase 6.7 — Flow Submission History / Management tests.
//
// Same no-real-Postgres approach as test/sequences.test.js /
// test/planChangeRequests.test.js: pool.query is monkey-patched on the
// shared '../src/db' singleton, and the two new routes
// (GET /flow-submissions, GET /flow-submissions/:id) are invoked directly
// against flows.js's router internal stack — no supertest/http.
//
// req.user.role = 'admin' is used throughout so requirePermission
// ('flow-builder')'s isAdmin() short-circuit applies and no akchat_users
// lookup query needs to be modeled — the same shortcut
// test/planChangeRequests.test.js relies on.

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/db');
const { router } = require('../src/routes/flows');

function installDb(seed = {}) {
  const submissions = (seed.flow_submissions || []).slice();
  const flows = (seed.flows || []).slice();
  const flowVersions = (seed.flow_versions || []).slice();

  const originalQuery = pool.query;

  pool.query = async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();

    // ── SELECT ... FROM coexistence.flow_submissions fs JOIN flows f ... (list) ──
    if (/FROM coexistence\.flow_submissions fs\s+JOIN coexistence\.flows f/.test(s) && /^SELECT fs\.id/.test(s)) {
      let rows = submissions.map((sub) => {
        const flow = flows.find((f) => f.id === sub.flow_id);
        const version = flowVersions.find((v) => v.id === sub.flow_version_id);
        return {
          id: sub.id,
          flow_id: sub.flow_id,
          flow_name: flow ? flow.name : null,
          flow_version_id: sub.flow_version_id,
          version_number: version ? version.version_number : null,
          contact_number: sub.contact_number,
          received_at: sub.received_at,
          mapped_at: sub.mapped_at,
          parse_error: sub.parse_error,
          response_json: sub.response_json,
          mapping_status: sub.mapped_at == null ? 'not_mapped' : (sub.parse_error ? 'mapping_error' : 'mapped'),
          workspace_id: sub.workspace_id,
        };
      });

      // WHERE fs.id = $1 AND fs.workspace_id = $2 (detail)
      if (/WHERE fs\.id = \$1 AND fs\.workspace_id = \$2/.test(s)) {
        const [id, workspaceId] = params;
        rows = rows.filter((r) => String(r.id) === String(id) && String(r.workspace_id) === String(workspaceId));
        return { rows };
      }

      // list: fs.workspace_id = $1 plus optional filters, in param order
      let paramIdx = 0;
      const workspaceId = params[paramIdx++];
      rows = rows.filter((r) => String(r.workspace_id) === String(workspaceId));

      if (/fs\.flow_id = \$\d+/.test(s)) {
        const flowId = params[paramIdx++];
        rows = rows.filter((r) => String(r.flow_id) === String(flowId));
      }
      if (/fs\.contact_number ILIKE \$\d+/.test(s)) {
        const like = String(params[paramIdx++]).replace(/%/g, '');
        rows = rows.filter((r) => (r.contact_number || '').includes(like));
      }
      if (/fs\.received_at >= \$\d+/.test(s)) {
        const from = params[paramIdx++];
        rows = rows.filter((r) => new Date(r.received_at) >= new Date(from));
      }
      if (/fs\.received_at <= \$\d+/.test(s)) {
        const to = params[paramIdx++];
        rows = rows.filter((r) => new Date(r.received_at) <= new Date(to));
      }
      if (/fs\.mapped_at IS NOT NULL AND fs\.parse_error = false/.test(s)) {
        rows = rows.filter((r) => r.mapped_at != null && !r.parse_error);
      } else if (/fs\.mapped_at IS NOT NULL AND fs\.parse_error = true/.test(s)) {
        rows = rows.filter((r) => r.mapped_at != null && r.parse_error);
      } else if (/fs\.mapped_at IS NULL(?!\s+THEN)/.test(s) && !/fs\.id = \$1/.test(s)) {
        rows = rows.filter((r) => r.mapped_at == null);
      }

      rows = rows.slice().sort((a, b) => new Date(b.received_at) - new Date(a.received_at));

      // LIMIT/OFFSET are interpolated directly into the SQL (safe ints),
      // not passed as params — parse them back out.
      const limitMatch = s.match(/LIMIT (\d+) OFFSET (\d+)/);
      if (limitMatch) {
        const limit = parseInt(limitMatch[1], 10);
        const offset = parseInt(limitMatch[2], 10);
        rows = rows.slice(offset, offset + limit);
      }

      return { rows };
    }

    // ── COUNT(*) FROM coexistence.flow_submissions fs WHERE ... (list total) ──
    if (/SELECT COUNT\(\*\)::int AS total FROM coexistence\.flow_submissions fs WHERE/.test(s)) {
      let rows = submissions.slice();
      let paramIdx = 0;
      const workspaceId = params[paramIdx++];
      rows = rows.filter((r) => String(r.workspace_id) === String(workspaceId));

      if (/fs\.flow_id = \$\d+/.test(s)) {
        const flowId = params[paramIdx++];
        rows = rows.filter((r) => String(r.flow_id) === String(flowId));
      }
      if (/fs\.contact_number ILIKE \$\d+/.test(s)) {
        const like = String(params[paramIdx++]).replace(/%/g, '');
        rows = rows.filter((r) => (r.contact_number || '').includes(like));
      }
      if (/fs\.received_at >= \$\d+/.test(s)) {
        const from = params[paramIdx++];
        rows = rows.filter((r) => new Date(r.received_at) >= new Date(from));
      }
      if (/fs\.received_at <= \$\d+/.test(s)) {
        const to = params[paramIdx++];
        rows = rows.filter((r) => new Date(r.received_at) <= new Date(to));
      }
      if (/fs\.mapped_at IS NOT NULL AND fs\.parse_error = false/.test(s)) {
        rows = rows.filter((r) => r.mapped_at != null && !r.parse_error);
      } else if (/fs\.mapped_at IS NOT NULL AND fs\.parse_error = true/.test(s)) {
        rows = rows.filter((r) => r.mapped_at != null && r.parse_error);
      } else if (/fs\.mapped_at IS NULL(?!\s+THEN)/.test(s)) {
        rows = rows.filter((r) => r.mapped_at == null);
      }

      return { rows: [{ total: rows.length }] };
    }

    throw new Error(`Unmocked query in flowSubmissionHistory.test.js: ${s}`);
  };

  return { restore() { pool.query = originalQuery; } };
}

function callRoute(routerToUse, method, path, req) {
  const layer = routerToUse.stack.find(l => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      body: undefined,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; this.statusCode = this.statusCode || 200; resolve(this); return this; },
    };
    let idx = 0;
    function next(err) {
      if (err) return reject(err);
      idx += 1;
      if (idx >= stack.length) return;
      Promise.resolve(stack[idx].handle(req, res, next)).catch(reject);
    }
    Promise.resolve(stack[0].handle(req, res, next)).catch(reject);
  });
}

function makeReq({ workspaceId = 1, query = {}, params = {} } = {}) {
  return {
    user: { id: 1, role: 'admin' },
    workspace: workspaceId != null ? { id: workspaceId, role: 'OWNER' } : null,
    query,
    params,
  };
}

const SEED = {
  flows: [
    { id: 10, name: 'Lead Intake', workspace_id: 1 },
    { id: 11, name: 'Support Form', workspace_id: 1 },
    { id: 99, name: 'Other Workspace Flow', workspace_id: 2 },
  ],
  flow_versions: [
    { id: 100, flow_id: 10, version_number: 3 },
  ],
  flow_submissions: [
    { id: 1, flow_id: 10, flow_version_id: 100, workspace_id: 1, contact_number: '919812345678', received_at: '2026-09-01T10:00:00Z', mapped_at: '2026-09-01T10:00:05Z', parse_error: false, response_json: { name: 'Asha', email: 'asha@example.com', flow_token: 'secret-token-1' } },
    { id: 2, flow_id: 11, flow_version_id: null, workspace_id: 1, contact_number: '919800000000', received_at: '2026-09-02T10:00:00Z', mapped_at: '2026-09-02T10:00:05Z', parse_error: true, response_json: { roof_type: 'metal' } },
    { id: 3, flow_id: 10, flow_version_id: 100, workspace_id: 1, contact_number: '919811111111', received_at: '2026-09-03T10:00:00Z', mapped_at: null, parse_error: false, response_json: { name: 'Ravi' } },
    { id: 4, flow_id: 99, flow_version_id: null, workspace_id: 2, contact_number: '919899999999', received_at: '2026-09-04T10:00:00Z', mapped_at: '2026-09-04T10:00:05Z', parse_error: false, response_json: { name: 'Other Workspace User' } },
  ],
};

// 1. Workspace isolation — a caller in workspace 1 never sees workspace 2's submissions.
test('GET /flow-submissions — workspace isolation enforced server-side', async () => {
  const db = installDb(SEED);
  try {
    const res = await callRoute(router, 'get', '/flow-submissions', makeReq({ workspaceId: 1 }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.total, 3);
    assert.ok(res.body.rows.every((r) => r.flowId !== 99));

    const res2 = await callRoute(router, 'get', '/flow-submissions', makeReq({ workspaceId: 2 }));
    assert.equal(res2.body.total, 1);
    assert.equal(res2.body.rows[0].flowId, 99);
  } finally { db.restore(); }
});

// 2. No workspace resolved -> empty result, not an error, and never another workspace's data.
test('GET /flow-submissions — missing workspace returns empty, not another workspace\'s data', async () => {
  const db = installDb(SEED);
  try {
    const res = await callRoute(router, 'get', '/flow-submissions', makeReq({ workspaceId: null }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { rows: [], total: 0 });
  } finally { db.restore(); }
});

// 3. Sort newest first.
test('GET /flow-submissions — sorted newest first', async () => {
  const db = installDb(SEED);
  try {
    const res = await callRoute(router, 'get', '/flow-submissions', makeReq({ workspaceId: 1 }));
    const ids = res.body.rows.map((r) => r.id);
    assert.deepEqual(ids, [3, 2, 1]);
  } finally { db.restore(); }
});

// 4. Pagination.
test('GET /flow-submissions — pagination via limit/offset', async () => {
  const db = installDb(SEED);
  try {
    const page1 = await callRoute(router, 'get', '/flow-submissions', makeReq({ workspaceId: 1, query: { limit: '2', offset: '0' } }));
    assert.equal(page1.body.rows.length, 2);
    assert.equal(page1.body.total, 3);
    assert.deepEqual(page1.body.rows.map((r) => r.id), [3, 2]);

    const page2 = await callRoute(router, 'get', '/flow-submissions', makeReq({ workspaceId: 1, query: { limit: '2', offset: '2' } }));
    assert.equal(page2.body.rows.length, 1);
    assert.deepEqual(page2.body.rows.map((r) => r.id), [1]);
  } finally { db.restore(); }
});

// 5. flow_id filter.
test('GET /flow-submissions — filter by flowId', async () => {
  const db = installDb(SEED);
  try {
    const res = await callRoute(router, 'get', '/flow-submissions', makeReq({ workspaceId: 1, query: { flowId: '10' } }));
    assert.equal(res.body.total, 2);
    assert.ok(res.body.rows.every((r) => r.flowId === 10));
  } finally { db.restore(); }
});

// 6. contact_number filter.
test('GET /flow-submissions — filter by contactNumber', async () => {
  const db = installDb(SEED);
  try {
    const res = await callRoute(router, 'get', '/flow-submissions', makeReq({ workspaceId: 1, query: { contactNumber: '9198123' } }));
    assert.equal(res.body.total, 1);
    assert.equal(res.body.rows[0].id, 1);
  } finally { db.restore(); }
});

// 7. date range filter.
test('GET /flow-submissions — filter by date range', async () => {
  const db = installDb(SEED);
  try {
    const res = await callRoute(router, 'get', '/flow-submissions', makeReq({
      workspaceId: 1,
      query: { dateFrom: '2026-09-02T00:00:00Z', dateTo: '2026-09-02T23:59:59Z' },
    }));
    assert.equal(res.body.total, 1);
    assert.equal(res.body.rows[0].id, 2);
  } finally { db.restore(); }
});

// 8. mapping status derivation + filter — mapped / mapping_error / not_mapped.
test('GET /flow-submissions — mapping status derived and filterable', async () => {
  const db = installDb(SEED);
  try {
    const all = await callRoute(router, 'get', '/flow-submissions', makeReq({ workspaceId: 1 }));
    const byId = Object.fromEntries(all.body.rows.map((r) => [r.id, r.mappingStatus]));
    assert.equal(byId[1], 'mapped');
    assert.equal(byId[2], 'mapping_error');
    assert.equal(byId[3], 'not_mapped');

    const mappedOnly = await callRoute(router, 'get', '/flow-submissions', makeReq({ workspaceId: 1, query: { mappingStatus: 'mapped' } }));
    assert.deepEqual(mappedOnly.body.rows.map((r) => r.id), [1]);

    const errorOnly = await callRoute(router, 'get', '/flow-submissions', makeReq({ workspaceId: 1, query: { mappingStatus: 'mapping_error' } }));
    assert.deepEqual(errorOnly.body.rows.map((r) => r.id), [2]);

    const notMappedOnly = await callRoute(router, 'get', '/flow-submissions', makeReq({ workspaceId: 1, query: { mappingStatus: 'not_mapped' } }));
    assert.deepEqual(notMappedOnly.body.rows.map((r) => r.id), [3]);
  } finally { db.restore(); }
});

// 9. The flow_submissions.flow_token DB column is never selected/exposed
// as its own field (spec item 10). Note: response_json itself is stored
// and returned UNCHANGED (spec items 18/"existing response_json must
// remain unchanged") — Meta's raw nfm_reply payload happens to carry its
// own flow_token key inside that JSON blob, which is untouched data, not
// something this endpoint additionally exposes.
test('GET /flow-submissions — never exposes the flow_token column as its own field', async () => {
  const db = installDb(SEED);
  try {
    const res = await callRoute(router, 'get', '/flow-submissions', makeReq({ workspaceId: 1 }));
    for (const row of res.body.rows) {
      assert.equal(row.flowToken, undefined);
      assert.equal(row.flow_token, undefined);
      assert.equal(Object.prototype.hasOwnProperty.call(row, 'flowToken'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(row, 'flow_token'), false);
    }
  } finally { db.restore(); }
});

// 10. Detail endpoint — returns full response_json for field-by-field display.
test('GET /flow-submissions/:id — returns full submission detail', async () => {
  const db = installDb(SEED);
  try {
    const res = await callRoute(router, 'get', '/flow-submissions/:id', makeReq({ workspaceId: 1, params: { id: '1' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.id, 1);
    assert.equal(res.body.flowName, 'Lead Intake');
    assert.equal(res.body.flowVersionNumber, 3);
    assert.equal(res.body.mappingStatus, 'mapped');
    assert.deepEqual(res.body.responseJson, { name: 'Asha', email: 'asha@example.com', flow_token: 'secret-token-1' });
  } finally { db.restore(); }
});

// 11. Detail endpoint — workspace isolation: a submission in another workspace 404s, not leaks.
test('GET /flow-submissions/:id — 404s for a submission in another workspace', async () => {
  const db = installDb(SEED);
  try {
    const res = await callRoute(router, 'get', '/flow-submissions/:id', makeReq({ workspaceId: 1, params: { id: '4' } }));
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error, 'Submission not found');
  } finally { db.restore(); }
});

// 12. Detail endpoint — unknown id 404s.
test('GET /flow-submissions/:id — 404s for an unknown id', async () => {
  const db = installDb(SEED);
  try {
    const res = await callRoute(router, 'get', '/flow-submissions/:id', makeReq({ workspaceId: 1, params: { id: '999' } }));
    assert.equal(res.statusCode, 404);
  } finally { db.restore(); }
});



