'use strict';

// Regression tests for services/messageSender.js's markFailed()/formatSendError().
//
// Bug: sendQueue.js's worker 'failed' handler passes the actual Error object
// (not a string) so Meta's structured error details aren't lost. markFailed()
// used to call `.slice()` directly on that Error, which doesn't have a
// .slice() method, throwing a TypeError that got swallowed by the caller's
// `.catch(() => {})` — silently discarding the failure update entirely.
//
// No real Postgres is used — pool.query is monkey-patched, same approach as
// the other tests in this suite.

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/db');
const { markFailed, formatSendError } = require('../src/services/messageSender');

function installDb() {
  const calls = [];
  const originalQuery = pool.query;
  pool.query = async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [] };
  };
  return { calls, restore() { pool.query = originalQuery; } };
}

test('markFailed accepts a plain Error object without throwing', async () => {
  const db = installDb();
  try {
    await assert.doesNotReject(markFailed('local-1', new Error('network timeout')));
    assert.equal(db.calls.length, 1);
    assert.match(db.calls[0].params[0], /network timeout/);
  } finally { db.restore(); }
});

test('markFailed accepts a plain string (back-compat)', async () => {
  const db = installDb();
  try {
    await markFailed('local-2', 'send failed: bad request');
    assert.equal(db.calls[0].params[0], 'send failed: bad request');
  } finally { db.restore(); }
});

test('markFailed accepts null/undefined without throwing', async () => {
  const db = installDb();
  try {
    await markFailed('local-3', undefined);
    assert.equal(db.calls[0].params[0], 'send failed');
  } finally { db.restore(); }
});

test('markFailed preserves Meta structured error details (code/error_subcode/message/error_data/fbtrace_id)', async () => {
  const db = installDb();
  try {
    const err = new Error('Meta 400: Number of parameters does not match the expected number of params');
    err.metaError = {
      message: 'Number of parameters does not match the expected number of params',
      type: 'OAuthException',
      code: 132000,
      error_subcode: 2494010,
      error_data: { details: 'template variable count mismatch' },
      fbtrace_id: 'AbCdEfGhIjKl',
    };
    await markFailed('local-4', err);
    const stored = db.calls[0].params[0];
    assert.match(stored, /Number of parameters does not match/);
    assert.match(stored, /code=132000/);
    assert.match(stored, /subcode=2494010/);
    assert.match(stored, /template variable count mismatch/);
    assert.match(stored, /fbtrace_id=AbCdEfGhIjKl/);
  } finally { db.restore(); }
});

test('markFailed truncates very long messages to 500 chars', async () => {
  const db = installDb();
  try {
    await markFailed('local-5', 'x'.repeat(1000));
    assert.equal(db.calls[0].params[0].length, 500);
  } finally { db.restore(); }
});

test('formatSendError mirrors the same structured extraction for broadcast_logs writers', () => {
  const err = new Error('Meta 401: Error validating access token');
  err.metaError = { message: 'Error validating access token', code: 190, fbtrace_id: 'ZzYyXx' };
  const formatted = formatSendError(err);
  assert.match(formatted, /Error validating access token/);
  assert.match(formatted, /code=190/);
  assert.match(formatted, /fbtrace_id=ZzYyXx/);
});

test('formatSendError falls back gracefully for a plain Error with no metaError', () => {
  const formatted = formatSendError(new Error('ECONNRESET'));
  assert.equal(formatted, 'ECONNRESET');
});

test('formatSendError never throws on null/undefined', () => {
  assert.equal(formatSendError(null), 'send failed');
  assert.equal(formatSendError(undefined), 'send failed');
});

