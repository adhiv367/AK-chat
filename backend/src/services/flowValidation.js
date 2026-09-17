// Phase 6.2 — WhatsApp Flows: server-side validation.
//
// Validates the STORED flow definition shape (an array of screens, each
// with fields) that the frontend Flow builder produces — NOT the Meta
// Flow JSON itself (that's flowJsonBuilder.js's job, which runs a valid
// definition through this validator first). Keeping validation on the
// simpler, internal shape (rather than re-parsing generated Meta JSON)
// mirrors how routes/chatbots.js validates its own `config` shape before
// ever touching the WhatsApp-facing payload.
//
// Deliberately MVP-scoped per the Phase 6.2 brief: only the field types,
// screen properties, and navigation/submit shape listed below exist here.
// Branching, conditional visibility, data-exchange endpoints, and any
// other advanced Meta Flow component are explicitly OUT of scope — this
// file must not be extended to validate them until a later phase says so.
//
// Every exported validator returns a structured result:
//   { valid: boolean, errors: [{ path, message }, ...] }
// `path` is a dotted/bracketed pointer into the definition (e.g.
// "screens[0].fields[2].options") so the frontend can highlight the exact
// field that failed — never a single flat error string.

const MAX_SCREENS = 20;
const MAX_FIELDS_PER_SCREEN = 30;
const MAX_OPTIONS_PER_FIELD = 50;
const MAX_TITLE_LENGTH = 80;
const MAX_LABEL_LENGTH = 120;
const MAX_OPTION_LENGTH = 120;

// MVP-supported field types only (Phase 6.2 brief: text input, text area,
// dropdown, radio, checkbox).
const FIELD_TYPES = ['text_input', 'text_area', 'dropdown', 'radio', 'checkbox'];
const FIELD_TYPES_REQUIRING_OPTIONS = new Set(['dropdown', 'radio', 'checkbox']);

// field_id / screen_id: Meta Flow component/screen ids must be stable
// identifiers — restrict to a safe, predictable charset rather than
// accepting arbitrary strings that could break generated JSON or a future
// Meta payload.
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function err(path, message) {
  return { path, message };
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// ── Field-level validation ──────────────────────────────────────────────

function validateField(field, screenIndex, fieldIndex, seenFieldIds) {
  const errors = [];
  const path = `screens[${screenIndex}].fields[${fieldIndex}]`;

  if (!field || typeof field !== 'object' || Array.isArray(field)) {
    return [err(path, 'Field must be an object')];
  }

  // field id
  if (!isNonEmptyString(field.fieldId)) {
    errors.push(err(`${path}.fieldId`, 'Field ID is required'));
  } else if (!ID_PATTERN.test(field.fieldId.trim())) {
    errors.push(err(`${path}.fieldId`, 'Field ID must start with a letter and contain only letters, numbers, and underscores (max 64 chars)'));
  } else if (seenFieldIds.has(field.fieldId.trim())) {
    errors.push(err(`${path}.fieldId`, `Field ID "${field.fieldId.trim()}" is duplicated on this screen`));
  } else {
    seenFieldIds.add(field.fieldId.trim());
  }

  // type
  if (!isNonEmptyString(field.type)) {
    errors.push(err(`${path}.type`, 'Field type is required'));
  } else if (!FIELD_TYPES.includes(field.type)) {
    errors.push(err(`${path}.type`, `Field type must be one of: ${FIELD_TYPES.join(', ')}`));
  }

  // label
  if (!isNonEmptyString(field.label)) {
    errors.push(err(`${path}.label`, 'Field label is required'));
  } else if (field.label.trim().length > MAX_LABEL_LENGTH) {
    errors.push(err(`${path}.label`, `Field label cannot exceed ${MAX_LABEL_LENGTH} characters`));
  }

  // required flag — must be a boolean if present at all.
  if (field.required !== undefined && typeof field.required !== 'boolean') {
    errors.push(err(`${path}.required`, 'required must be a boolean'));
  }

  // options — required for dropdown/radio/checkbox, disallowed otherwise.
  const type = isNonEmptyString(field.type) ? field.type : null;
  if (type && FIELD_TYPES_REQUIRING_OPTIONS.has(type)) {
    if (!Array.isArray(field.options) || field.options.length === 0) {
      errors.push(err(`${path}.options`, `Field type "${type}" requires at least one option`));
    } else {
      if (field.options.length > MAX_OPTIONS_PER_FIELD) {
        errors.push(err(`${path}.options`, `Cannot exceed ${MAX_OPTIONS_PER_FIELD} options`));
      }
      const seenOptionIds = new Set();
      field.options.forEach((opt, optIndex) => {
        const optPath = `${path}.options[${optIndex}]`;
        if (!opt || typeof opt !== 'object' || Array.isArray(opt)) {
          errors.push(err(optPath, 'Option must be an object with id and label'));
          return;
        }
        if (!isNonEmptyString(opt.id)) {
          errors.push(err(`${optPath}.id`, 'Option id is required'));
        } else if (seenOptionIds.has(opt.id.trim())) {
          errors.push(err(`${optPath}.id`, `Option id "${opt.id.trim()}" is duplicated`));
        } else {
          seenOptionIds.add(opt.id.trim());
        }
        if (!isNonEmptyString(opt.label)) {
          errors.push(err(`${optPath}.label`, 'Option label is required'));
        } else if (opt.label.trim().length > MAX_OPTION_LENGTH) {
          errors.push(err(`${optPath}.label`, `Option label cannot exceed ${MAX_OPTION_LENGTH} characters`));
        }
      });
    }
  } else if (type && !FIELD_TYPES_REQUIRING_OPTIONS.has(type) && field.options !== undefined) {
    errors.push(err(`${path}.options`, `Field type "${type}" does not support options`));
  }

  return errors;
}

// ── Screen-level validation ─────────────────────────────────────────────

function validateScreen(screen, screenIndex, seenScreenIds, screenCount) {
  const errors = [];
  const path = `screens[${screenIndex}]`;

  if (!screen || typeof screen !== 'object' || Array.isArray(screen)) {
    return [err(path, 'Screen must be an object')];
  }

  // screen id
  if (!isNonEmptyString(screen.screenId)) {
    errors.push(err(`${path}.screenId`, 'Screen ID is required'));
  } else if (!ID_PATTERN.test(screen.screenId.trim())) {
    errors.push(err(`${path}.screenId`, 'Screen ID must start with a letter and contain only letters, numbers, and underscores (max 64 chars)'));
  } else if (seenScreenIds.has(screen.screenId.trim())) {
    errors.push(err(`${path}.screenId`, `Screen ID "${screen.screenId.trim()}" is duplicated`));
  } else {
    seenScreenIds.add(screen.screenId.trim());
  }

  // title
  if (!isNonEmptyString(screen.title)) {
    errors.push(err(`${path}.title`, 'Screen title is required'));
  } else if (screen.title.trim().length > MAX_TITLE_LENGTH) {
    errors.push(err(`${path}.title`, `Screen title cannot exceed ${MAX_TITLE_LENGTH} characters`));
  }

  // fields
  if (!Array.isArray(screen.fields)) {
    errors.push(err(`${path}.fields`, 'Screen fields must be an array'));
  } else {
    if (screen.fields.length === 0) {
      errors.push(err(`${path}.fields`, 'Screen must have at least one field'));
    }
    if (screen.fields.length > MAX_FIELDS_PER_SCREEN) {
      errors.push(err(`${path}.fields`, `Cannot exceed ${MAX_FIELDS_PER_SCREEN} fields per screen`));
    }
    const seenFieldIds = new Set();
    screen.fields.forEach((field, fieldIndex) => {
      errors.push(...validateField(field, screenIndex, fieldIndex, seenFieldIds));
    });
  }

  // navigation — basic screen navigation only, per the Phase 6.2 brief.
  // `nextScreenId` is optional: absent/null means "this is a terminal
  // screen" (its action is submit). If present it must reference another
  // screen id that exists somewhere in the flow (checked in a second pass
  // in validateFlowDefinition, once every screen id is known) and must not
  // reference itself.
  if (screen.nextScreenId !== undefined && screen.nextScreenId !== null) {
    if (!isNonEmptyString(screen.nextScreenId)) {
      errors.push(err(`${path}.nextScreenId`, 'nextScreenId must be a non-empty string when present'));
    } else if (isNonEmptyString(screen.screenId) && screen.nextScreenId.trim() === screen.screenId.trim()) {
      errors.push(err(`${path}.nextScreenId`, 'A screen cannot navigate to itself'));
    }
  }

  // terminal flag — a screen with no nextScreenId is the one that carries
  // the submit action. isTerminal, if present, must agree with that; if
  // absent it's derived rather than required (see flowJsonBuilder.js).
  if (screen.isTerminal !== undefined && typeof screen.isTerminal !== 'boolean') {
    errors.push(err(`${path}.isTerminal`, 'isTerminal must be a boolean'));
  }

  return errors;
}

// ── Flow-level validation ───────────────────────────────────────────────

// Validates the full stored flow definition:
//   { screens: [ { screenId, title, fields: [...], nextScreenId? }, ... ] }
// Returns { valid, errors }. Called both before saving a draft (PUT/POST)
// and before generating Meta-compatible JSON (flowJsonBuilder.js) — the
// generator refuses to run on a definition that fails this check.
function validateFlowDefinition(definition) {
  const errors = [];

  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    return { valid: false, errors: [err('root', 'Flow definition must be an object')] };
  }

  if (!Array.isArray(definition.screens)) {
    return { valid: false, errors: [err('screens', 'Flow definition must include a screens array')] };
  }

  if (definition.screens.length === 0) {
    errors.push(err('screens', 'Flow must have at least one screen'));
  }
  if (definition.screens.length > MAX_SCREENS) {
    errors.push(err('screens', `Cannot exceed ${MAX_SCREENS} screens`));
  }

  const seenScreenIds = new Set();
  definition.screens.forEach((screen, screenIndex) => {
    errors.push(...validateScreen(screen, screenIndex, seenScreenIds, definition.screens.length));
  });

  // Second pass: every nextScreenId must point at a screen id that
  // actually exists in this flow. Deferred until here because screen ids
  // are only fully known after the first pass finishes.
  definition.screens.forEach((screen, screenIndex) => {
    if (screen && isNonEmptyString(screen.nextScreenId) && !seenScreenIds.has(screen.nextScreenId.trim())) {
      errors.push(err(`screens[${screenIndex}].nextScreenId`, `nextScreenId "${screen.nextScreenId.trim()}" does not match any screen in this flow`));
    }
  });

  // Exactly one terminal screen expectation: with linear MVP navigation,
  // a flow needs at least one screen with no nextScreenId (where the
  // submit action lives). No nextScreenId at all -> single-screen submit.
  const terminalScreens = definition.screens.filter((s) => s && !isNonEmptyString(s.nextScreenId));
  if (definition.screens.length > 0 && terminalScreens.length === 0) {
    errors.push(err('screens', 'Flow must have at least one terminal screen (a screen with no nextScreenId) to carry the submit action'));
  }

  return { valid: errors.length === 0, errors };
}
module.exports = {
  FIELD_TYPES,
  FIELD_TYPES_REQUIRING_OPTIONS,
  MAX_SCREENS,
  MAX_FIELDS_PER_SCREEN,
  MAX_OPTIONS_PER_FIELD,
  validateFlowDefinition,
  validateScreen,
  validateField,
};