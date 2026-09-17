'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasPermission, roleLevel } = require('../src/permissions');

test('OWNER/ADMIN can access campaign-studio', () => {
  assert.equal(hasPermission({ role: 'OWNER' }, 'campaign-studio'), true);
  assert.equal(hasPermission({ role: 'ADMIN' }, 'campaign-studio'), true);
});

test('MANAGER can access campaign-studio', () => {
  assert.equal(hasPermission({ role: 'MANAGER' }, 'campaign-studio'), true);
});

test('AGENT cannot access campaign-studio by default', () => {
  assert.equal(hasPermission({ role: 'AGENT' }, 'campaign-studio'), false);
});

test('VIEWER cannot access campaign-studio by default', () => {
  assert.equal(hasPermission({ role: 'VIEWER' }, 'campaign-studio'), false);
});

test('a per-user grant override can add campaign-studio for an AGENT', () => {
  const user = { role: 'AGENT', permissions: { grant: ['campaign-studio'] } };
  assert.equal(hasPermission(user, 'campaign-studio'), true);
});

test('legacy admin role still passes (isAdmin short-circuit)', () => {
  assert.equal(hasPermission({ role: 'admin' }, 'campaign-studio'), true);
});

test('MANAGER role level is below OWNER (unaffected by this change)', () => {
  assert.ok(roleLevel('MANAGER') < roleLevel('OWNER'));
});
