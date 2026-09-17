// Phase 6.2 — WhatsApp Flows: Flow JSON builder.
//
// Converts the internal, stored flow definition (an array of screens with
// MVP field types — see flowValidation.js for the exact shape/limits) into
// a Meta Flow JSON document (the `flow_json` payload persisted on
// coexistence.flow_versions — see db/flowsSchema.js). This module ONLY
// builds the document; it never calls the Meta API, never publishes, and
// never sends a Flow — that is explicitly out of scope for Phase 6.2 (see
// routes/flows.js header comment).
//
// The generator always runs a definition through
// flowValidation.validateFlowDefinition() first and refuses to build JSON
// for an invalid definition — generated JSON must never be able to drift
// from what was actually validated and saved.
//
// Output shape follows Meta's published Flow JSON structure
// (https://developers.facebook.com/docs/whatsapp/flows/reference/flowjson)
// restricted to the MVP component set this phase supports:
//   TextInput, TextArea, Dropdown, RadioButtonsGroup, CheckboxGroup,
//   Footer (submit action), and basic screen-to-screen navigation via a
//   Footer's on-click-action "navigate" payload.
//
// version: fixed at "7.3" — Meta's current recommended/active Flow JSON
// schema version. Version "5.0" was frozen by Meta on 2025-09-10 and is no
// longer accepted for Upload JSON (INVALID_FLOW_JSON_VERSION); "7.3" is the
// latest active version per Meta's WhatsApp Flows changelog. Not
// user-configurable in this phase.

const { validateFlowDefinition } = require('./flowValidation');

const FLOW_JSON_VERSION = '7.3';

// Maps this app's internal field types to Meta Flow JSON component types.
const COMPONENT_TYPE_MAP = {
  text_input: 'TextInput',
  text_area: 'TextArea',
  dropdown: 'Dropdown',
  radio: 'RadioButtonsGroup',
  checkbox: 'CheckboxGroup',
};

function buildFieldComponent(field) {
  const component = {
    type: COMPONENT_TYPE_MAP[field.type],
    name: field.fieldId,
    label: field.label,
    required: field.required === true,
  };

  if (field.type === 'dropdown' || field.type === 'radio' || field.type === 'checkbox') {
    component['data-source'] = field.options.map((opt) => ({
      id: opt.id,
      title: opt.label,
    }));
  }

  return component;
}

// Builds a single screen's `layout.children`: the screen's fields in
// order, followed by a Footer carrying the navigation/submit action.
// `layout.type` MUST be the literal string "SingleColumnLayout" — that is
// the only layout identifier Meta's Flow JSON schema (v7.3, same as every
// version since) accepts. Sending anything else (e.g. a generic "layout")
// is rejected by Meta's Upload JSON validation with INVALID_PROPERTY_VALUE
// at `screens[n].layout.type`.
// MVP navigation only: a screen either
//   - navigates to another screen (nextScreenId present) -> Footer action
//     "navigate" targeting that screen, forwarding this screen's field
//     values as payload, or
//   - is terminal (no nextScreenId) -> Footer action "complete", which is
//     the Flow's submit action.
// `resolveTargetId` maps a screen's stored `nextScreenId` (an id from the
// saved definition, e.g. "START_new") to the effective id actually used
// in the generated JSON (e.g. "START", if that stored id happens to be
// whatever the first screen was named). Every other screen's effective id
// equals its stored id — only the first screen is ever renamed. Falls
// back to the original nextScreenId if for some reason it can't be
// resolved (should not happen for a definition that already passed
// validateFlowDefinition, which guarantees nextScreenId always matches an
// existing screen).
function buildScreenLayout(screen, effectiveScreenId, resolveTargetId) {
  const fieldComponents = screen.fields.map(buildFieldComponent);
  const fieldNames = screen.fields.map((f) => f.fieldId);

  const isTerminal = !screen.nextScreenId;
  const footer = {
    type: 'Footer',
    label: isTerminal ? 'Submit' : 'Next',
    'on-click-action': isTerminal
      ? {
          name: 'complete',
          payload: fieldNames.reduce((acc, name) => {
            acc[name] = `\${form.${name}}`;
            return acc;
          }, {}),
        }
      : {
          name: 'navigate',
          next: { type: 'screen', name: resolveTargetId(screen.nextScreenId) },
          payload: fieldNames.reduce((acc, name) => {
            acc[name] = `\${form.${name}}`;
            return acc;
          }, {}),
        },
  };

  return {
    type: 'SingleColumnLayout',
    children: [
      {
        type: 'Form',
        name: `${effectiveScreenId}_form`,
        children: [...fieldComponents, footer],
      },
    ],
  };
}

// Meta requires the Flow's first screen to be named exactly "START"
// (Graph API error #131009, "Specified screen ... is not allowed as first
// screen of this flow. Allowed screen name is: START." — confirmed on a
// live send against flow_id 6 / meta_flow_id 1588481832822202). The Flow
// Builder does not constrain what a user names their first screen (e.g.
// "START_new"), so this generator normalizes ONLY the first screen's id
// to the literal string "START" when producing Meta-facing JSON. This is
// a display/output-id normalization only — it never touches the stored
// definition (screen.screenId as saved via PUT/POST stays whatever the
// user named it); it only affects the generated flow_json that gets
// uploaded to Meta and, in turn, what a manual send must reference.
const META_FIRST_SCREEN_ID = 'START';

function buildScreen(screen, effectiveScreenId, resolveTargetId) {
  const isTerminal = !screen.nextScreenId;
  return {
    id: effectiveScreenId,
    title: screen.title,
    terminal: isTerminal === true ? true : undefined,
    // Meta's schema wants only real/present keys, not `undefined` ones —
    // stripped in JSON.stringify already but kept out entirely for
    // programmatic consumers of the returned object too. See cleanup at
    // the bottom of buildFlowJson().
    data: {},
    layout: buildScreenLayout(screen, effectiveScreenId, resolveTargetId),
  };
}



// Builds a full Meta-compatible Flow JSON document from a stored
// definition. Throws with a structured `validationErrors` property if the
// definition is invalid — callers (routes/flows.js) are expected to run
// validateFlowDefinition() themselves first and surface those errors to
// the client with a 400 before ever reaching this function; this is a
// defense-in-depth guard, not the primary validation path.
function buildFlowJson(definition) {
  const { valid, errors } = validateFlowDefinition(definition);
  if (!valid) {
    const e = new Error('Cannot generate Flow JSON from an invalid flow definition');
    e.validationErrors = errors;
    throw e;
  }

  // Effective-id map: the first screen's stored screenId (whatever it is)
  // maps to the literal "START"; every other screen maps to itself. Built
  // once up front so navigate targets pointing at the (renamed) first
  // screen resolve correctly below.
  const firstStoredId = definition.screens[0].screenId;
  const idMap = new Map(definition.screens.map((s, i) => [
    s.screenId,
    i === 0 ? META_FIRST_SCREEN_ID : s.screenId,
  ]));
  const resolveTargetId = (storedId) => idMap.get(storedId) || storedId;

  const screens = definition.screens.map((screen, index) => {
    const effectiveScreenId = index === 0 ? META_FIRST_SCREEN_ID : screen.screenId;
    const built = buildScreen(screen, effectiveScreenId, resolveTargetId);
    // Drop the `terminal: undefined` key rather than serialize it.
    if (built.terminal === undefined) delete built.terminal;
    return built;
  });

  // Server-side guard (not just a frontend nicety): the generated JSON's
  // first screen must always literally be "START" — this is what Meta's
  // Upload JSON / manual send actually enforces (#131009 otherwise). If
  // this ever fails it means the normalization above has a bug, not that
  // the input definition was invalid, so it throws rather than silently
  // uploading a Flow Meta will reject.
  if (screens[0]?.id !== META_FIRST_SCREEN_ID) {
    throw new Error(`Flow JSON builder failed to normalize first screen id to "${META_FIRST_SCREEN_ID}" (stored screenId was "${firstStoredId}")`);
  }

  return {
    version: FLOW_JSON_VERSION,
    screens,
  };
}

module.exports = {
  FLOW_JSON_VERSION,
  COMPONENT_TYPE_MAP,
  buildFlowJson,
};
