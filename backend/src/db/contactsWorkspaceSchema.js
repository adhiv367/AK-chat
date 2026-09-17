// Phase 3C — additive SaaS column on the pre-existing coexistence.contacts
// and coexistence.categories tables (neither is created anywhere in this
// codebase's db/ folder — same situation as whatsapp_accounts, see
// whatsappAccountsSchema.js). This file only ALTERs them, additively, the
// same idempotent way the rest of the schema files do:
//   1. ADD COLUMN IF NOT EXISTS workspace_id.
//   2. Backfill workspace_id on any existing row that doesn't have one.
//   3. Index it.
//
// MUST run after:
//   - ensureWorkspaceTables()            (default workspace must exist)
//   - ensureWhatsappAccountsSaasColumns()  (whatsapp_accounts.workspace_id
//     must already be backfilled — contacts are backfilled BY JOINING to it)
//
// Backfill strategy for contacts is more precise than a flat "everything ->
// default workspace": every contact carries a wa_number, and every
// wa_number is already tied to exactly one workspace via
// coexistence.whatsapp_accounts.workspace_id (digits-only match, mirrors
// the join used throughout messages.js/contacts.js). So:
//   - contacts whose wa_number matches a known WhatsApp account -> that
//     account's workspace.
//   - any remaining orphans (wa_number no longer matches a connected
//     account, e.g. a disconnected/renamed number) -> the same default
//     workspace every other Phase 2/3 backfill uses (oldest workspace).
// This never duplicates or deletes a contact — it only tags existing rows.
//
// categories has no wa_number to derive a workspace from, so it backfills
// straight to the default workspace, same as chatbots/whatsapp_accounts did.

const pool = require('../db');

async function getDefaultWorkspaceId() {
  const { rows } = await pool.query(
    `SELECT id FROM coexistence.workspaces ORDER BY id ASC LIMIT 1`
  );
  return rows[0]?.id ?? null;
}

async function ensureContactsWorkspaceColumns() {
  await pool.query(`
    ALTER TABLE coexistence.contacts
      ADD COLUMN IF NOT EXISTS workspace_id BIGINT
        REFERENCES coexistence.workspaces(id) ON DELETE CASCADE
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_contacts_workspace_id
      ON coexistence.contacts (workspace_id)
  `);

  await backfillContactsWorkspaceId();
}

async function backfillContactsWorkspaceId() {
  const { rows: needsBackfill } = await pool.query(
    `SELECT id FROM coexistence.contacts WHERE workspace_id IS NULL LIMIT 1`
  );
  if (needsBackfill.length === 0) return;

  // 1) Precise pass: contacts whose wa_number matches a connected WhatsApp
  //    account inherit THAT account's workspace. Digits-only match tolerates
  //    '+'/spaces in whatsapp_accounts.display_phone_number, same as every
  //    other wa_number join in this codebase.
  const { rowCount: viaAccount } = await pool.query(`
    UPDATE coexistence.contacts c
       SET workspace_id = wa.workspace_id
      FROM coexistence.whatsapp_accounts wa
     WHERE c.workspace_id IS NULL
       AND wa.workspace_id IS NOT NULL
       AND regexp_replace(c.wa_number, '\\D', '', 'g') =
           regexp_replace(wa.display_phone_number, '\\D', '', 'g')
  `);

  // 2) Fallback: anything still unmatched (orphaned/disconnected wa_number)
  //    goes to the default workspace — same "first workspace" convention
  //    used by whatsappAccountsSchema.js / chatbotsWorkspaceSchema.js.
  const defaultWorkspaceId = await getDefaultWorkspaceId();
  let orphans = 0;
  if (defaultWorkspaceId) {
    const { rowCount } = await pool.query(
      `UPDATE coexistence.contacts
          SET workspace_id = $1
        WHERE workspace_id IS NULL`,
      [defaultWorkspaceId]
    );
    orphans = rowCount;
  } else {
    console.warn('[contactsWorkspaceSchema] no workspace found to backfill orphaned contacts onto yet; will retry next boot');
  }

  if (viaAccount > 0 || orphans > 0) {
    console.log(`[contactsWorkspaceSchema] backfilled workspace_id on contacts: ${viaAccount} via matching WhatsApp account, ${orphans} orphaned -> default workspace ${defaultWorkspaceId}`);
  }
}

async function ensureCategoriesWorkspaceColumns() {
  await pool.query(`
    ALTER TABLE coexistence.categories
      ADD COLUMN IF NOT EXISTS workspace_id BIGINT
        REFERENCES coexistence.workspaces(id) ON DELETE CASCADE
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_categories_workspace_id
      ON coexistence.categories (workspace_id)
  `);

  const { rows: needsBackfill } = await pool.query(
    `SELECT id FROM coexistence.categories WHERE workspace_id IS NULL LIMIT 1`
  );
  if (needsBackfill.length === 0) return;

  const defaultWorkspaceId = await getDefaultWorkspaceId();
  if (!defaultWorkspaceId) {
    console.warn('[contactsWorkspaceSchema] no workspace found to backfill categories onto yet; will retry next boot');
    return;
  }
  const { rowCount } = await pool.query(
    `UPDATE coexistence.categories
        SET workspace_id = $1
      WHERE workspace_id IS NULL`,
    [defaultWorkspaceId]
  );
  if (rowCount > 0) {
    console.log(`[contactsWorkspaceSchema] backfilled workspace_id for ${rowCount} existing categor${rowCount === 1 ? 'y' : 'ies'} -> workspace ${defaultWorkspaceId}`);
  }
}

module.exports = { ensureContactsWorkspaceColumns, ensureCategoriesWorkspaceColumns };





