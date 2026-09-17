'use strict';

// Phase 5B — seat-limit enforcement for POST /users (Admin Settings -> Users
// -> Add user). This is the SECOND, older direct-creation path that sits
// alongside POST /invitations; the Phase 5B seat check was originally wired
// into invitations.js only, so this endpoint let a Free-plan workspace add
// unlimited members through the "Add user" button. See routes/users.js.
//
// No real Postgres is used. pool.query / pool.connect are monkey-patched on
// the shared '../db' singleton (safe: pg's Pool connects lazily, same
// approach as test/entitlementService.test.js) so we can exercise the full
// route handler chain (adminOnly -> POST /users handler) against canned
// query results, and assert exactly which queries did/didn't run.

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/db');
const { router } = require('../src/routes/users');

// ─── query-dispatch mock ────────────────────────────────────────────
// Every scenario configures: planKey, limits (entitlementService shape),
// status, and currentSeats (what countActiveSeats should report). Calls are
// recorded so tests can assert no partial write happened on a 403.
function makeDb(scenario) {
  const calls = [];
  async function dispatch(sql, params) {
    calls.push({ sql, params });
    if (/FROM coexistence\.workspace_billing/.test(sql)) {
      if (scenario.noBillingRow) return { rows: [] };
      return {
        rows: [{
          status: scenario.status || 'active',
          plan_id: 1,
          current_period_end: null,
          cancel_at_period_end: false,
          plan_key: scenario.planKey,
          plan_name: scenario.planKey,
          limits: scenario.limits,
        }],
      };
    }
    if (/FROM coexistence\.workspace_members/.test(sql) && /COUNT/i.test(sql)) {
      return { rows: [{ n: scenario.currentSeats }] };
    }
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(sql)) {
      return { rows: [] };
    }
    if (/INSERT INTO coexistence\.akchat_users/.test(sql)) {
      if (scenario.duplicate) {
        const err = new Error('duplicate key value violates unique constraint "akchat_users_username_key"');
        err.code = '23505';
        throw err;
      }
      const [username, email, , displayName, role] = params;
      return {
        rows: [{
          id: 999, username, email, display_name: displayName, role,
          permissions: null, is_active: true, last_login_at: null,
          created_at: new Date(), updated_at: new Date(), created_by: 1,
        }],
      };
    }
    if (/INSERT INTO coexistence\.workspace_members/.test(sql)) {
      return { rows: [] };
    }
    if (/SELECT user_id, wa_number FROM coexistence\.user_wa_assignments/.test(sql)) {
      return { rows: [] };
    }
    if (/INSERT INTO coexistence\.user_audit_log/.test(sql)) {
      return { rows: [] };
    }
    return { rows: [] };
  }

  return {
    calls,
    query: dispatch,
    connect: async () => ({ query: dispatch, release: () => {} }),
  };
}

function installDb(scenario) {
  const mock = makeDb(scenario);
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  pool.query = mock.query;
  pool.connect = mock.connect;
  return {
    calls: mock.calls,
    restore() { pool.query = originalQuery; pool.connect = originalConnect; },
  };
}

// ─── minimal Express route-chain runner (no supertest/http needed) ─────
function callRoute(routerToUse, method, path, req) {
  const layer = routerToUse.stack.find(l => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      body: undefined,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; resolve(this); return this; },
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

function makeReq(body) {
  return {
    user: { id: 1, username: 'kavin', role: 'OWNER' },
    workspace: { id: 42, name: 'Phase5B Verification Test Workspace' },
    body,
  };
}

const NEW_USER_BODY = {
  username: 'mani', email: 'mani@example.com', displayName: 'Mani',
  role: 'bda_sales', password: 'Str0ngPassw0rd!',
};

test('POST /users — Free plan, 1/2 seats used: second member succeeds', async () => {
  const db = installDb({ planKey: 'free', limits: { max_seats: 2 }, currentSeats: 1 });
  try {
    const res = await callRoute(router, 'post', '/users', makeReq(NEW_USER_BODY));
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.username, 'mani');
    assert.ok(db.calls.some(c => /INSERT INTO coexistence\.akchat_users/.test(c.sql)));
  } finally {
    db.restore();
  }
});

test('POST /users — Free plan, 2/2 seats used: third member is rejected with 403 limit_reached', async () => {
  const db = installDb({ planKey: 'free', limits: { max_seats: 2 }, currentSeats: 2 });
  try {
    const res = await callRoute(router, 'post', '/users', makeReq(NEW_USER_BODY));
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'limit_reached');
    assert.equal(res.body.limitType, 'max_seats');
    assert.equal(res.body.current, 2);
    assert.equal(res.body.max, 2);
    // No partial write: the seat check must reject BEFORE any insert.
    assert.ok(!db.calls.some(c => /INSERT INTO coexistence\.akchat_users/.test(c.sql)),
      'akchat_users insert must not run when the seat limit is already reached');
    assert.ok(!db.calls.some(c => /INSERT INTO coexistence\.workspace_members/.test(c.sql)),
      'workspace_members insert must not run when the seat limit is already reached');
  } finally {
    db.restore();
  }
});

test('POST /users — legacy_unlimited plan: member creation stays allowed regardless of seat count', async () => {
  // max_seats explicitly null == unlimited, per entitlementService.checkLimit.
  const db = installDb({ planKey: 'legacy_unlimited', limits: { max_seats: null }, currentSeats: 50 });
  try {
    const res = await callRoute(router, 'post', '/users', makeReq(NEW_USER_BODY));
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.username, 'mani');
    assert.ok(db.calls.some(c => /INSERT INTO coexistence\.akchat_users/.test(c.sql)));
  } finally {
    db.restore();
  }
});

test('POST /users — duplicate username/email still returns 409 (existing behavior preserved)', async () => {
  const db = installDb({ planKey: 'free', limits: { max_seats: 2 }, currentSeats: 1, duplicate: true });
  try {
    const res = await callRoute(router, 'post', '/users', makeReq(NEW_USER_BODY));
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, 'Email or username already in use');
  } finally {
    db.restore();
  }
});

test('POST /users — seat check runs before the transaction is even opened (no BEGIN on rejection)', async () => {
  const db = installDb({ planKey: 'free', limits: { max_seats: 2 }, currentSeats: 2 });
  try {
    const res = await callRoute(router, 'post', '/users', makeReq(NEW_USER_BODY));
    assert.equal(res.statusCode, 403);
    assert.ok(!db.calls.some(c => /^\s*BEGIN\s*$/i.test(c.sql)),
      'no transaction should be opened when the seat limit already blocks creation');
  } finally {
    db.restore();
  }
});