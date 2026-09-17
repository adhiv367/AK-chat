'use strict';

// Phase 8C-1 — focused schema test only (invoice DB foundation).
// Mocks pool.query (same no-live-Postgres approach as
// test/trialSchema.test.js / test/planChangeRequests.test.js) and asserts:
//   1. workspace_invoices table + all required columns are created
//   2. workspace isolation: workspace_id FK -> workspaces(id) ON DELETE CASCADE
//   3. status check constraint includes valid statuses and excludes invalid ones
//   4. invoice_number has a unique index
//   5. schema creation is idempotent (CREATE TABLE IF NOT EXISTS / CREATE
//      INDEX IF NOT EXISTS throughout, no destructive statements)

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/db');

test('Phase 8C-1: workspace_invoices table is additive, isolated, constrained, and idempotent', async () => {
  const queries = [];
  const originalQuery = pool.query;
  pool.query = async (sql, params) => {
    queries.push(sql);
    return { rows: [] };
  };

  try {
    const { ensureInvoicesTable } = require('../src/db/invoicesSchema');
    await ensureInvoicesTable();
  } finally {
    pool.query = originalQuery;
  }

  const joined = queries.join('\n');

  // 1. Table + required columns
  const createStmt = queries.find(q => /CREATE TABLE IF NOT EXISTS coexistence\.workspace_invoices/.test(q));
  assert.ok(createStmt, 'expected idempotent CREATE TABLE IF NOT EXISTS for workspace_invoices');
  for (const col of [
    'workspace_id', 'invoice_number', 'status', 'currency',
    'subtotal', 'tax', 'total',
    'billing_period_start', 'billing_period_end',
    'issue_date', 'due_date', 'paid_date',
    'created_at', 'updated_at',
  ]) {
    assert.ok(createStmt.includes(col), `expected column '${col}' in workspace_invoices`);
  }

  // 2. Workspace isolation / FK with cascade delete
  assert.match(
    createStmt,
    /workspace_id\s+BIGINT NOT NULL REFERENCES coexistence\.workspaces\(id\) ON DELETE CASCADE/,
    'expected workspace_id FK with ON DELETE CASCADE'
  );

  // 3. Status constraint: valid statuses present, invalid ones absent
  assert.match(createStmt, /CONSTRAINT workspace_invoices_status_check/);
  for (const status of ['draft', 'issued', 'paid', 'overdue', 'void', 'refunded']) {
    assert.ok(createStmt.includes(`'${status}'`), `expected valid status '${status}' in constraint`);
  }
  for (const invalidStatus of ['pending', 'active', 'trialing', 'cancelled']) {
    assert.ok(!createStmt.includes(`'${invalidStatus}'`), `did not expect status '${invalidStatus}' in constraint`);
  }

  // 4. Unique invoice numbering
  const uniqueStmt = queries.find(q => /CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_invoices_invoice_number/.test(q));
  assert.ok(uniqueStmt, 'expected a unique index on invoice_number');
  assert.match(uniqueStmt, /ON coexistence\.workspace_invoices \(invoice_number\)/);

  // 5. Useful indexes present
  assert.match(joined, /CREATE INDEX IF NOT EXISTS idx_workspace_invoices_workspace\s*\n\s*ON coexistence\.workspace_invoices \(workspace_id, created_at DESC\)/);
  assert.match(joined, /CREATE INDEX IF NOT EXISTS idx_workspace_invoices_workspace_status/);
  assert.match(joined, /CREATE INDEX IF NOT EXISTS idx_workspace_invoices_due_date/);

  // 6. Idempotency: every CREATE is guarded, no destructive statements
  assert.doesNotMatch(joined, /CREATE TABLE(?! IF NOT EXISTS)/);
  assert.doesNotMatch(joined, /CREATE (UNIQUE )?INDEX(?! IF NOT EXISTS)/);
  assert.doesNotMatch(joined, /DROP TABLE/i);
  assert.doesNotMatch(joined, /DROP COLUMN/i);
  assert.doesNotMatch(joined, /\bDELETE FROM\b/i);
  assert.doesNotMatch(joined, /TRUNCATE/i);

  // 7. No other billing/trial/subscription tables touched by this migration
  assert.doesNotMatch(joined, /coexistence\.workspace_billing/);
  assert.doesNotMatch(joined, /coexistence\.plans\b/);
  assert.doesNotMatch(joined, /coexistence\.plan_change_requests/);
});