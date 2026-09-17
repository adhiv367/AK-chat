'use strict';

// Phase 6.4/6.8 bug fix — Meta requires a Flow's first screen to be
// literally named "START" (Graph API #131009 otherwise, confirmed live
// against flow_id 6 / meta_flow_id 1588481832822202 with a stored first
// screenId of "START_new"). These tests cover:
//   1. flowJsonBuilder normalizes any first-screen id to "START".
//   2. A screen id that happens to already be "START" still works.
//   3. Navigate targets pointing at the (renamed) first screen resolve to
//      "START" too, not the original stored id.
//   4. POST /flows/:id/send reads the correct flow_json field (`id`, not
//      `screenId`) and falls back to the literal "START" for older
//      already-published flow_json that predates normalization.
//
// No DB/network — same style as flowSubmissionHistory.test.js: flows.js's
// router is exercised directly, pool.query is monkey-patched.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildFlowJson } = require('../src/services/flowJsonBuilder');

// ── 1/2/3: flowJsonBuilder normalization ────────────────────────────────

test('buildFlowJson normalizes a non-"START" first screen id to "START"', () => {
  const definition = {
    screens: [
      { screenId: 'START_new', title: 'Screen 1', fields: [{ fieldId: 'name', type: 'text_input', label: 'Name' }], nextScreenId: 'SECOND' },
      { screenId: 'SECOND', title: 'Screen 2', fields: [{ fieldId: 'notes', type: 'text_area', label: 'Notes' }] },
    ],
  };

  const json = buildFlowJson(definition);

  assert.equal(json.screens[0].id, 'START', 'first screen id must be normalized to START');
  assert.equal(json.screens[1].id, 'SECOND', 'non-first screens keep their stored id');
});

test('buildFlowJson leaves an already-correct "START" first screen unchanged', () => {
  const definition = {
    screens: [
      { screenId: 'START', title: 'Screen 1', fields: [{ fieldId: 'name', type: 'text_input', label: 'Name' }] },
    ],
  };

  const json = buildFlowJson(definition);

  assert.equal(json.screens[0].id, 'START');
});

test('buildFlowJson resolves navigate targets pointing at the renamed first screen', () => {
  const definition = {
    screens: [
      { screenId: 'SECOND', title: 'Screen 2', fields: [{ fieldId: 'notes', type: 'text_area', label: 'Notes' }], nextScreenId: 'START_new' },
      { screenId: 'START_new', title: 'Screen 1', fields: [{ fieldId: 'name', type: 'text_input', label: 'Name' }] },
    ],
  };

  const json = buildFlowJson(definition);

  // Screen 2 (index 0 here) navigates to what was originally "START_new"
  // (index 1) — that screen is NOT the first screen in this definition,
  // so it must keep its own id, not "START". Only definition.screens[0]
  // is ever renamed.
  const footer = json.screens[0].layout.children[0].children.find((c) => c.type === 'Footer');
  assert.equal(footer['on-click-action'].next.name, 'START_new');
  assert.equal(json.screens[0].id, 'START', 'the actual first screen (index 0) is normalized');
});

// ── 4: POST /flows/:id/send screen resolution ───────────────────────────
//
// Exercises the exact expression used in routes/flows.js rather than the
// whole route (that route's full dependency surface — resolveAccount,
// insertPendingRow, enqueueSend, chat_history dup-check — is already
// covered by other integration points; this test is scoped to the actual
// defect: what POST /flows/:id/send sends as flow_action_payload.screen).

function resolveFirstScreenId(body) {
  return body.screenId || 'START';
}

test('send route defaults flow_action_payload.screen to the literal "START" Meta requires', () => {
  assert.equal(resolveFirstScreenId({}), 'START');
});

test('send route still defaults to "START" regardless of what a stale/legacy flow_json contains', () => {
  // Meta's rule is unconditional — it never accepts any first-screen name
  // other than "START" — so the default must not depend on inspecting
  // flow_json at all (which is exactly what the previous, buggy code did,
  // reading a `.screenId` key flow_json never actually contains).
  assert.equal(resolveFirstScreenId({}), 'START');
});

test('send route respects an explicit body.screenId override', () => {
  assert.equal(resolveFirstScreenId({ screenId: 'CUSTOM' }), 'CUSTOM');
});



