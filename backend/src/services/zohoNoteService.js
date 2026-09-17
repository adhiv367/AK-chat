// Phase 8C Part 2 — Zoho CRM Note creation, attached to an ALREADY-LINKED
// Zoho Lead (coexistence.zoho_lead_links, created by zohoLeadService.js /
// Phase 8C Part 1).
//
// No AI extraction, no conversation-text analysis here — see zohoSchema.js
// header for the full phase plan. This service receives already-structured
// input (title/content) exactly like zohoLeadService.createLead/updateLead
// do, and turns it into a Zoho CRM Note, reusing every existing building
// block rather than duplicating it (spec §2, §13):
//
//   - zohoLeadService.resolveConnectionRow -> the SAME connection lookup +
//     status checks (disconnected/error/reauth_required) Lead operations
//     use, so a Note can never be created through a connection Lead
//     operations would themselves refuse to use.
//   - zohoLeadService.withAccessToken      -> the SAME
//     ensure-valid-token + one-retry-after-401 + reauth_required-marking
//     logic Lead operations use — no second token-refresh implementation.
//   - zohoLeadService.callZohoLeadsApi     -> the SAME generic
//     Zoho-v2-response-unwrapping + error-sanitizing HTTP call helper
//     (it takes an arbitrary `path`, so it works for /Notes exactly like
//     it works for /Leads).
//   - contactSyncService.normalizePhone    -> the SAME phone
//     normalization convention already used by zohoLeadService/contacts.js.
//   - coexistence.zoho_lead_links          -> resolved (read-only) to find
//     the Zoho Lead a Note must attach to. This service NEVER accepts an
//     arbitrary Zoho Lead id from a caller without it having come from this
//     lookup — see routes/integrations/zoho.js's Note route for the
//     workspace+account+contact ownership check performed before this
//     service is ever called.
//   - coexistence.zoho_lead_notes (NEW, zohoSchema.js Phase 8C Part 2) ->
//     the idempotency ledger for this file. See zohoSchema.js's table
//     comment for the identity/limitation design (same
//     atomic-INSERT-ON-CONFLICT pattern as zoho_lead_links).
//
// ── Unavoidable external-consistency limitation (mirrors zohoLeadService.js) ─
// This is a two-system write (AKChat DB + Zoho CRM) with no distributed
// transaction between them. If the Zoho Note create call succeeds but the
// immediately-following zoho_lead_notes UPDATE (writing zoho_note_id +
// status='synced') fails/crashes, the row is left claimed-but-unsynced
// (status='pending'). A retry with the SAME idempotency key will see that
// pending row and is rejected with a clear "already in progress" error
// rather than silently creating a second Zoho Note. Reconciling a truly
// stuck pending row is a retry-queue concern deferred to a later phase.

const crypto = require('crypto');

const pool = require('../db');
const zohoLeadService = require('./zohoLeadService');
const { normalizePhone } = require('./contactSyncService');

// ── Phase 8 ZOHO NOTE UPDATE FIX — per-Lead serialization ────────────────
// ROOT CAUSE of "later message doesn't update the Note": upsertConversationNote
// below does a plain (non-transactional) SELECT existing row -> merge in
// memory -> UPDATE. webhook.js fires syncConversationToZoho for EVERY
// incoming message in the background WITHOUT awaiting it (see webhook.js's
// "Fired in the background (not awaited)" comment), so two inbound
// WhatsApp messages arriving close together for the SAME contact (a very
// common real pattern — "Hi, I'm Subash" immediately followed by "I'm
// from Erode") can run this function concurrently for the SAME Zoho Lead.
// Both calls SELECT the same pre-update `note_fields`, both merge their
// own new field into that same stale snapshot, and whichever UPDATE
// commits last simply overwrites the other's merged result — the earlier
// call's newly-confirmed field is silently lost even though its own
// merge/compare logic (proven correct in isolation by
// zohoNoteConsolidation.test.js) never made a mistake. This is a classic
// lost-update race, invisible to that suite because every test there runs
// its two "syncs" sequentially, one full call at a time.
//
// Fix: serialize all upsertConversationNote calls for the same
// (workspace, whatsapp account, contact) with a simple in-process async
// mutex, so the SELECT-merge-UPDATE cycle for one message's sync always
// fully completes (including the Zoho HTTP call) before the next queued
// message's sync reads the row. This never blocks unrelated
// contacts/workspaces (keyed per contact) and adds no new DB schema, no
// new Zoho calls, and does not touch Lead creation, extraction, OAuth,
// retry classification, reconciliation, manual createNote(), or workspace
// isolation — it only wraps the existing conversation-Note read/merge/
// write critical section.
const contactLockQueues = new Map();
function withContactLock(key, fn) {
  const previous = contactLockQueues.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  // Keep the queue alive regardless of this call's outcome so the NEXT
  // call for this contact always waits for this one to finish, but never
  // let one failed call permanently wedge the queue for later callers.
  const next = run.catch(() => {});
  contactLockQueues.set(key, next);
  next.finally(() => {
    if (contactLockQueues.get(key) === next) contactLockQueues.delete(key);
  });
  return run;
}

// ── Idempotency key derivation ───────────────────────────────────────────
// Deterministic: the SAME (title, content) submitted twice for the SAME
// Lead always derives the SAME key, so a retried request never creates a
// second Zoho Note. A caller may instead pass an explicit idempotencyKey
// (e.g. a stable id from the event/message that triggered the Note) for
// precise control — see createNote() below.
function computeIdempotencyKey(title, content) {
  const normalized = `${(title || '').trim()}\n${(content || '').trim()}`;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// Safe result shape — never includes tokens or raw Zoho payloads.
function serializeNote(row, { created }) {
  return {
    zohoNoteId: row.zoho_note_id,
    status: row.status,
    zohoLeadId: row.zoho_lead_id,
    contactNumber: row.contact_number,
    workspaceId: row.workspace_id,
    whatsappAccountId: row.whatsapp_account_id,
    created: Boolean(created),
  };
}

// ── Zoho CRM Notes HTTP call ─────────────────────────────────────────────
// Zoho v2 Notes are created via POST /crm/v2/Leads/{lead_id}/Notes with the
// same { data: [ { ... } ] } request/response envelope Leads use —
// zohoLeadService.callZohoLeadsApi already unwraps/validates that envelope
// generically (it takes a `path`), so this file adds no new HTTP-call
// machinery, only the Note-specific field shape.
async function createZohoNote(connectionRow, accessToken, zohoLeadId, { title, content }) {
  const fields = { Note_Content: content };
  if (title) fields.Note_Title = title;

  const entry = await zohoLeadService.callZohoLeadsApi(connectionRow, accessToken, {
    method: 'POST',
    path: `/crm/v2/Leads/${encodeURIComponent(zohoLeadId)}/Notes`,
    body: { data: [fields] },
  });
  return entry.details?.id;
}

// ── CREATE (or return-existing) flow ─────────────────────────────────────
// input: { workspaceId, whatsappAccountId, contactNumber, title, content, idempotencyKey? }
async function createNote(input) {
  const { workspaceId, whatsappAccountId, contactNumber, title, content, idempotencyKey } = input;

  if (!workspaceId) throw new Error('workspaceId is required');
  if (!whatsappAccountId) throw new Error('whatsappAccountId is required');
  const normalizedNumber = normalizePhone(contactNumber);
  if (!normalizedNumber) throw new Error('A valid contactNumber is required');
  if (!content || !String(content).trim()) throw new Error('content is required');

  // Same connection resolution + status checks (disconnected/error/
  // reauth_required) Lead operations use — never a Note-specific bypass.
  const connectionRow = await zohoLeadService.resolveConnectionRow(workspaceId, whatsappAccountId);

  // Resolve the linked Zoho Lead through AKChat's own lead-link ledger —
  // NEVER trust a Zoho Lead id supplied directly to this service (spec §8).
  // The route layer (routes/integrations/zoho.js) additionally re-verifies
  // any client-supplied :leadId against this same row before calling here.
  const { rows: linkRows } = await pool.query(
    `SELECT * FROM coexistence.zoho_lead_links
      WHERE workspace_id = $1 AND whatsapp_account_id = $2 AND contact_number = $3`,
    [workspaceId, whatsappAccountId, normalizedNumber]
  );
  const link = linkRows[0];
  if (!link || !link.zoho_lead_id) {
    const err = new Error('No linked Zoho Lead found for this contact — create the Lead first');
    err.status = 404;
    throw err;
  }

  const key = idempotencyKey ? String(idempotencyKey).slice(0, 200) : computeIdempotencyKey(title, content);

  // Atomic claim — same pattern as zohoLeadService.createLead (spec §9B):
  // the UNIQUE(workspace_id, whatsapp_account_id, zoho_lead_id,
  // idempotency_key) constraint is the concurrency guard, not a
  // SELECT-then-INSERT race.
  const { rows: claimedRows } = await pool.query(
    `INSERT INTO coexistence.zoho_lead_notes
       (workspace_id, whatsapp_account_id, zoho_connection_id, zoho_lead_id, contact_number, idempotency_key, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')
     ON CONFLICT ON CONSTRAINT uq_zoho_lead_notes_identity DO NOTHING
     RETURNING *`,
    [workspaceId, whatsappAccountId, connectionRow.id, link.zoho_lead_id, normalizedNumber, key]
  );

  if (claimedRows.length === 0) {
    // Another request already owns this exact (Lead, idempotency key)
    // identity — never create a second Zoho Note for the same event.
    const { rows: existingRows } = await pool.query(
      `SELECT * FROM coexistence.zoho_lead_notes
        WHERE workspace_id = $1 AND whatsapp_account_id = $2 AND zoho_lead_id = $3 AND idempotency_key = $4`,
      [workspaceId, whatsappAccountId, link.zoho_lead_id, key]
    );
    const existing = existingRows[0];
    if (existing.zoho_note_id) {
      return serializeNote(existing, { created: false });
    }
    const err = new Error('A Note creation for this event is already in progress or previously failed before linking. Retry later.');
    err.status = 409;
    throw err;
  }

  const claimed = claimedRows[0];

  let zohoNoteId;
  try {
    zohoNoteId = await zohoLeadService.withAccessToken(workspaceId, whatsappAccountId, connectionRow, (accessToken) =>
      createZohoNote(connectionRow, accessToken, link.zoho_lead_id, { title, content })
    );
  } catch (err) {
    await pool.query(
      `UPDATE coexistence.zoho_lead_notes
          SET status = 'failed', last_error = $2, updated_at = NOW()
        WHERE id = $1`,
      [claimed.id, String(err.message || 'Zoho Note creation failed').slice(0, 500)]
    );
    throw err;
  }

  if (!zohoNoteId) {
    await pool.query(
      `UPDATE coexistence.zoho_lead_notes
          SET status = 'failed', last_error = $2, updated_at = NOW()
        WHERE id = $1`,
      [claimed.id, 'Zoho did not return a Note id']
    );
    throw new Error('Zoho CRM did not return a Note id');
  }

  const { rows: finalRows } = await pool.query(
    `UPDATE coexistence.zoho_lead_notes
        SET zoho_note_id = $2, status = 'synced', last_error = NULL, updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [claimed.id, zohoNoteId]
  );

  return serializeNote(finalRows[0], { created: true });
}

// ── Phase 8 ZOHO PHASE 8 — FINAL FIX: CONSOLIDATE NOTES ──────────────────
// ONE AKChat conversation Note per Zoho Lead, updated/merged in place on
// every successful sync, instead of createNote's one-Note-per-distinct-
// (title, content) behavior above (which is exactly why every new
// customer message was creating a brand-new Zoho Note — a different
// content hash means a different idempotency_key means a new row).
//
// Design (reuses everything above, adds nothing new structurally):
//   - Same coexistence.zoho_lead_notes table, same connection/link
//     resolution, same withAccessToken/callZohoLeadsApi HTTP plumbing.
//   - A FIXED idempotency_key ('akchat-conversation-sync') instead of a
//     content-derived hash — so uq_zoho_lead_notes_identity
//     (workspace, whatsapp_account, zoho_lead_id, idempotency_key) finds
//     (or atomically claims) exactly ONE row per Lead for this purpose,
//     with zero changes to that constraint.
//   - note_fields (additive column, zohoSchema.js) stores the current
//     merged structured fields for that one row, so each new sync merges
//     newly-confirmed info into what's already there — new information is
//     added, already-present information is never duplicated or blanked
//     out by a round that simply didn't mention it again — and only calls
//     Zoho again when the rendered content actually changed.
const CONVERSATION_NOTE_IDEMPOTENCY_KEY = 'akchat-conversation-sync';
const CONVERSATION_NOTE_TITLE = 'AKChat conversation sync';

function formatDynamicValue(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(formatDynamicValue).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).trim();
}

// Deterministic plain-text rendering of the merged fields — same field
// order every time so repeated renders of unchanged fields produce
// byte-identical content (needed for the no-op/"unchanged" short-circuit
// below). Dynamic (business) fields are sorted by key for the same reason.
function renderConsolidatedNoteContent(fields) {
  const f = fields || {};
  const lines = [];
  if (f.name) lines.push(`Name: ${f.name}`);
  if (f.location) lines.push(`Location: ${f.location}`);
  if (f.email) lines.push(`Email: ${f.email}`);
  if (f.phone) lines.push(`Phone: ${f.phone}`);
  if (f.interest) lines.push(`Interest: ${f.interest}`);
  const dynamic = f.dynamic || {};
  for (const key of Object.keys(dynamic).sort()) {
    const entry = dynamic[key];
    if (entry && entry.value) lines.push(`${entry.label || key}: ${entry.value}`);
  }
  return lines.join('\n');
}

// Merge new (incoming) confirmed info into the existing stored fields.
// A field is only overwritten when the incoming round actually supplies a
// non-empty value for it — a round that doesn't mention name/email/etc.
// again NEVER erases what a prior round already confirmed, and a round
// that repeats the SAME value produces the SAME merged fields (so
// renderConsolidatedNoteContent's output is unchanged and no duplicate
// line / no redundant Zoho call ever results — spec §5).
function mergeConversationFields(existingFields, incoming) {
  const existing = existingFields && typeof existingFields === 'object' ? existingFields : {};
  const inc = incoming || {};

  const mergedScalar = (key) => {
    const value = inc[key] !== undefined && inc[key] !== null ? String(inc[key]).trim() : '';
    return value || existing[key] || null;
  };

  const merged = {
    name: mergedScalar('name'),
    location: mergedScalar('location'),
    email: mergedScalar('email'),
    phone: mergedScalar('phone'),
    interest: mergedScalar('interest'),
    dynamic: { ...(existing.dynamic || {}) },
  };

  for (const entry of inc.dynamicFields || []) {
    if (!entry || !entry.fieldKey) continue;
    const value = formatDynamicValue(entry.value);
    if (!value) continue;
    merged.dynamic[entry.fieldKey] = { label: entry.fieldLabel || entry.fieldKey, value };
  }

  return merged;
}

function safeParseNoteFields(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw; // pg already parses JSONB columns
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function serializeConversationNote(row, { created, updated, unchanged }) {
  return {
    zohoNoteId: row.zoho_note_id,
    status: row.status,
    zohoLeadId: row.zoho_lead_id,
    contactNumber: row.contact_number,
    workspaceId: row.workspace_id,
    whatsappAccountId: row.whatsapp_account_id,
    created: Boolean(created),
    updated: Boolean(updated),
    unchanged: Boolean(unchanged),
  };
}

// Zoho v2 Note UPDATE — PUT /crm/v2/Leads/{lead_id}/Notes/{note_id}, same
// { data: [ { ... } ] } envelope as createZohoNote (spec §2, §7).
async function updateZohoNote(connectionRow, accessToken, zohoLeadId, zohoNoteId, { title, content }) {
  const fields = { id: zohoNoteId, Note_Content: content };
  if (title) fields.Note_Title = title;

  const entry = await zohoLeadService.callZohoLeadsApi(connectionRow, accessToken, {
    method: 'PUT',
    path: `/crm/v2/Leads/${encodeURIComponent(zohoLeadId)}/Notes/${encodeURIComponent(zohoNoteId)}`,
    body: { data: [fields] },
  });
  return (entry.details && entry.details.id) || zohoNoteId;
}

// input: { workspaceId, whatsappAccountId, contactNumber, name?, location?,
//          email?, phone?, interest?, dynamicFields?: [{fieldKey, fieldLabel, value}], title? }
//
// Returns { ...serialized note, created, updated, unchanged }. Throws the
// same categorized errors as createNote (404 no link, connection-status
// errors from resolveConnectionRow, sanitized Zoho HTTP errors) — callers
// (zohoSyncService's existing partial-success/retry handling) do not need
// to distinguish this from createNote's failure modes.
async function upsertConversationNote(input) {
  const { workspaceId, whatsappAccountId, contactNumber } = input || {};
  if (!workspaceId) throw new Error('workspaceId is required');
  if (!whatsappAccountId) throw new Error('whatsappAccountId is required');
  const normalizedForLock = normalizePhone(contactNumber);
  if (!normalizedForLock) throw new Error('A valid contactNumber is required');

  const lockKey = `${workspaceId}:${whatsappAccountId}:${normalizedForLock}`;
  return withContactLock(lockKey, () => upsertConversationNoteLocked(input));
}

// The actual body, unchanged in behavior — now only ever run one-at-a-time
// per (workspace, whatsapp account, contact) via the queue above.
async function upsertConversationNoteLocked(input) {
  const {
    workspaceId, whatsappAccountId, contactNumber,
    name, location, email, phone, interest, dynamicFields = [],
    title = CONVERSATION_NOTE_TITLE,
  } = input || {};

  if (!workspaceId) throw new Error('workspaceId is required');
  if (!whatsappAccountId) throw new Error('whatsappAccountId is required');
  const normalizedNumber = normalizePhone(contactNumber);
  if (!normalizedNumber) throw new Error('A valid contactNumber is required');

  const incoming = { name, location, email, phone, interest, dynamicFields };
  const hasIncomingContent = Boolean(
    (name && String(name).trim()) ||
    (location && String(location).trim()) ||
    (email && String(email).trim()) ||
    (phone && String(phone).trim()) ||
    (interest && String(interest).trim()) ||
    (dynamicFields || []).some((f) => f && formatDynamicValue(f.value))
  );
  if (!hasIncomingContent) throw new Error('At least one confirmed field is required');

  // Same connection resolution + status checks Lead operations (and
  // createNote above) use.
  const connectionRow = await zohoLeadService.resolveConnectionRow(workspaceId, whatsappAccountId);

  const { rows: linkRows } = await pool.query(
    `SELECT * FROM coexistence.zoho_lead_links
      WHERE workspace_id = $1 AND whatsapp_account_id = $2 AND contact_number = $3`,
    [workspaceId, whatsappAccountId, normalizedNumber]
  );
  const link = linkRows[0];
  if (!link || !link.zoho_lead_id) {
    const err = new Error('No linked Zoho Lead found for this contact — create the Lead first');
    err.status = 404;
    throw err;
  }

  const key = CONVERSATION_NOTE_IDEMPOTENCY_KEY;

  const { rows: existingRows } = await pool.query(
    `SELECT * FROM coexistence.zoho_lead_notes
      WHERE workspace_id = $1 AND whatsapp_account_id = $2 AND zoho_lead_id = $3 AND idempotency_key = $4`,
    [workspaceId, whatsappAccountId, link.zoho_lead_id, key]
  );
  const existing = existingRows[0];

  // ── First-ever conversation Note for this Lead ──────────────────────
  if (!existing) {
    const mergedFields = mergeConversationFields({}, incoming);
    const content = renderConsolidatedNoteContent(mergedFields);

    // Atomic claim — same pattern as createNote (spec §9B). If a
    // concurrent first sync wins the race, fall through to the
    // update/merge path instead of ever creating a second Note.
    const { rows: claimedRows } = await pool.query(
      `INSERT INTO coexistence.zoho_lead_notes
         (workspace_id, whatsapp_account_id, zoho_connection_id, zoho_lead_id, contact_number, idempotency_key, status, note_fields)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
       ON CONFLICT ON CONSTRAINT uq_zoho_lead_notes_identity DO NOTHING
       RETURNING *`,
      [workspaceId, whatsappAccountId, connectionRow.id, link.zoho_lead_id, normalizedNumber, key, JSON.stringify(mergedFields)]
    );

    if (claimedRows.length === 0) {
      // Re-entrant retry, NOT a call through the public upsertConversationNote
      // wrapper — we're already running inside this contact's lock, so
      // calling the locked wrapper here would deadlock waiting on itself.
      return upsertConversationNoteLocked(input);
    }

    const claimed = claimedRows[0];
    let zohoNoteId;
    try {
      zohoNoteId = await zohoLeadService.withAccessToken(workspaceId, whatsappAccountId, connectionRow, (accessToken) =>
        createZohoNote(connectionRow, accessToken, link.zoho_lead_id, { title, content })
      );
    } catch (err) {
      await pool.query(
        `UPDATE coexistence.zoho_lead_notes SET status = 'failed', last_error = $2, updated_at = NOW() WHERE id = $1`,
        [claimed.id, String(err.message || 'Zoho Note creation failed').slice(0, 500)]
      );
      throw err;
    }
    if (!zohoNoteId) {
      await pool.query(
        `UPDATE coexistence.zoho_lead_notes SET status = 'failed', last_error = $2, updated_at = NOW() WHERE id = $1`,
        [claimed.id, 'Zoho did not return a Note id']
      );
      throw new Error('Zoho CRM did not return a Note id');
    }

    const { rows: finalRows } = await pool.query(
      `UPDATE coexistence.zoho_lead_notes
          SET zoho_note_id = $2, status = 'synced', last_error = NULL, note_fields = $3, updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [claimed.id, zohoNoteId, JSON.stringify(mergedFields)]
    );
    return serializeConversationNote(finalRows[0], { created: true, updated: false, unchanged: false });
  }

  // ── Existing row already carries a synced Zoho Note: merge + UPDATE ──
  const existingFields = safeParseNoteFields(existing.note_fields);
  const mergedFields = mergeConversationFields(existingFields, incoming);

  if (existing.zoho_note_id) {
    const oldContent = renderConsolidatedNoteContent(existingFields);
    const newContent = renderConsolidatedNoteContent(mergedFields);

    if (newContent === oldContent) {
      // Nothing new merged in this round (repeat/duplicate info, or a
      // retry of the exact same extraction) — never call Zoho again.
      return serializeConversationNote(existing, { created: false, updated: false, unchanged: true });
    }

    try {
      await zohoLeadService.withAccessToken(workspaceId, whatsappAccountId, connectionRow, (accessToken) =>
        updateZohoNote(connectionRow, accessToken, link.zoho_lead_id, existing.zoho_note_id, { title, content: newContent })
      );
    } catch (err) {
      await pool.query(
        `UPDATE coexistence.zoho_lead_notes SET status = 'failed', last_error = $2, updated_at = NOW() WHERE id = $1`,
        [existing.id, String(err.message || 'Zoho Note update failed').slice(0, 500)]
      );
      throw err;
    }

    const { rows: updatedRows } = await pool.query(
      `UPDATE coexistence.zoho_lead_notes
          SET status = 'synced', last_error = NULL, note_fields = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [existing.id, JSON.stringify(mergedFields)]
    );
    return serializeConversationNote(updatedRows[0], { created: false, updated: true, unchanged: false });
  }

  // ── Prior attempt for this Lead never got a Zoho Note id (still
  // 'pending'/'failed') — retry the CREATE, reusing this SAME row so a
  // retry NEVER inserts a second row / creates a second Zoho Note for
  // this Lead (spec §7, §9c). Optimistic status-guard mirrors createNote's
  // own "already in progress" 409 for a genuinely concurrent attempt.
  const { rows: claimRows } = await pool.query(
    `UPDATE coexistence.zoho_lead_notes
        SET status = 'pending', note_fields = $2, updated_at = NOW()
      WHERE id = $1 AND status <> 'pending'
      RETURNING *`,
    [existing.id, JSON.stringify(mergedFields)]
  );
  if (claimRows.length === 0) {
    const err = new Error('A Note creation for this Lead is already in progress. Retry later.');
    err.status = 409;
    throw err;
  }

  const content = renderConsolidatedNoteContent(mergedFields);
  let zohoNoteId;
  try {
    zohoNoteId = await zohoLeadService.withAccessToken(workspaceId, whatsappAccountId, connectionRow, (accessToken) =>
      createZohoNote(connectionRow, accessToken, link.zoho_lead_id, { title, content })
    );
  } catch (err) {
    await pool.query(
      `UPDATE coexistence.zoho_lead_notes SET status = 'failed', last_error = $2, updated_at = NOW() WHERE id = $1`,
      [existing.id, String(err.message || 'Zoho Note creation failed').slice(0, 500)]
    );
    throw err;
  }
  if (!zohoNoteId) {
    await pool.query(
      `UPDATE coexistence.zoho_lead_notes SET status = 'failed', last_error = $2, updated_at = NOW() WHERE id = $1`,
      [existing.id, 'Zoho did not return a Note id']
    );
    throw new Error('Zoho CRM did not return a Note id');
  }

  const { rows: finalRows } = await pool.query(
    `UPDATE coexistence.zoho_lead_notes
        SET zoho_note_id = $2, status = 'synced', last_error = NULL, updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [existing.id, zohoNoteId]
  );
  return serializeConversationNote(finalRows[0], { created: true, updated: false, unchanged: false });
}

module.exports = {
  createNote,
  computeIdempotencyKey,
  upsertConversationNote,
  // Exported for focused unit tests only.
  renderConsolidatedNoteContent,
  mergeConversationFields,
  upsertConversationNoteLocked,
  withContactLock,
};