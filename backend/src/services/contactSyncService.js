// Upserts one Shopify-order row (from the Google Sheet) into
// coexistence.contacts — the same table Contacts/Chats already use.
// New phone -> creates a contact (purchaseCount=1).
// Existing phone -> increments purchaseCount, sums totalPurchaseAmount, keeps
// the most recent purchase date, refreshes city/state/etc, merges tags.
// All the extra order fields live in the existing custom_fields JSONB column
// — no schema changes to coexistence.contacts required.
//
// Also home to upsertContactFromRetarget() — the Retarget <-> Contacts
// bridge. Every Retarget customer created/updated (CSV import, Excel
// import, Google Sheet sync, or the manual Retarget CRUD API) is mirrored
// here into coexistence.contacts by phone number, same "one row per phone"
// rule as the Shopify sync above.

const pool = require('../db');
const { getSingleAccount } = require('../routes/whatsappAccounts');
const { detectExitCategory } = require('./retargetClassifier');

function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  digits = digits.replace(/^0+/, '');
  if (!digits) return null;
  if (digits.length === 10) digits = '91' + digits; // default India country code
  if (digits.length < 11 || digits.length > 15) return null;
  return digits;
}

function toNumberOrNull(v) {
  if (v === '' || v == null) return 0;
  const n = parseFloat(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function parseTags(raw) {
  if (!raw) return [];
  return String(raw).split(',').map((t) => t.trim()).filter(Boolean);
}

/**
 * Resolve the wa_number to attach synced contacts to. Each workspace can
 * have its own connected WhatsApp Business account(s)
 * (coexistence.whatsapp_accounts.workspace_id), so every synced contact is
 * scoped to the CALLER's own workspace's account — getSingleAccount(null)
 * would resolve to an arbitrary workspace's account instead. Every caller
 * must pass its own workspaceId: the Shopify Google Sheet sync
 * (sheetSyncScheduler.js, Phase 3E) now iterates one tick per workspace and
 * passes that workspace's own id; Retarget call sites always pass their
 * workspaceId too — see upsertContactFromRetarget below. The `= null`
 * default only exists so a genuinely workspace-less caller fails fast with
 * the "No WhatsApp Business account connected" error below rather than
 * silently resolving to an arbitrary workspace's account.
 *
 * @param {number} workspaceId - required; every caller (Shopify sheet sync,
 *   Retarget bridge) must pass its own workspace's id. Never omit this —
 *   getSingleAccount(null) resolves to an arbitrary workspace's account.
 */
async function resolveSyncWaNumber(workspaceId) {
  if (!workspaceId) throw new Error('workspaceId is required to resolve a WhatsApp account for syncing.');
  const acc = await getSingleAccount(workspaceId);
  if (!acc) throw new Error('No WhatsApp Business account connected — connect one before syncing contacts.');
  return acc.displayPhoneNumber.replace(/\D/g, '');
}

/**
 * @param {object} row - one parsed Google Sheet row.
 * @param {string} waNumber - the workspace's own WhatsApp display number,
 *   already resolved by the caller via resolveSyncWaNumber(workspaceId).
 * @param {number} workspaceId - required; the same workspace that
 *   resolved waNumber above. Every lookup/insert below is scoped by it so
 *   this sync never reads or writes another workspace's contact for the
 *   same (wa_number, contact_number) pair. Threaded through by
 *   sheetSyncScheduler.js's runSyncTickForWorkspace(), which already has
 *   settings.workspace_id.
 * @returns {Promise<{skipped?:boolean, created?:boolean, updated?:boolean, reason?:string}>}
 */
async function upsertCustomerFromRow(row, waNumber, workspaceId) {
  if (!workspaceId) return { skipped: true, reason: 'workspaceId is required to sync a contact' };

  const phone = normalizePhone(row.phone);
  if (!phone) return { skipped: true, reason: 'missing/invalid phone' };

  const name = (row.name || '').trim() || null;
  const orderAmount = toNumberOrNull(row.orderAmount);
  const purchaseDate = (row.purchaseDate || '').trim() || null;
  const incomingTags = parseTags(row.tags);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existingRows } = await client.query(
      `SELECT id, custom_fields, tags FROM coexistence.contacts
        WHERE workspace_id = $1 AND wa_number = $2 AND contact_number = $3
        FOR UPDATE`,
      [workspaceId, waNumber, phone]
    );

    if (existingRows.length === 0) {
      const customFields = {
        email: row.email || null,
        address: row.address || null,
        city: row.city || null,
        state: row.state || null,
        country: row.country || null,
        lastProduct: row.product || null,
        lastOrderId: row.orderId || null,
        lastPaymentStatus: row.paymentStatus || null,
        purchaseCount: 1,
        totalPurchaseAmount: orderAmount,
        lastPurchase: purchaseDate,
        source: 'shopify_sheet_sync',
      };
      await client.query(
        `INSERT INTO coexistence.contacts (workspace_id, wa_number, contact_number, name, tags, custom_fields, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, NOW())`,
        [workspaceId, waNumber, phone, name, JSON.stringify(incomingTags), JSON.stringify(customFields)]
      );
      await client.query('COMMIT');
      return { created: true };
    }

    const existing = existingRows[0];
    const cf = existing.custom_fields || {};
    const prevCount = Number(cf.purchaseCount) || 0;
    const prevTotal = Number(cf.totalPurchaseAmount) || 0;
    const prevDate = cf.lastPurchase ? new Date(cf.lastPurchase) : null;
    const newDate = purchaseDate ? new Date(purchaseDate) : null;
    const useNewDate = newDate && (!prevDate || newDate >= prevDate);

    const mergedCustomFields = {
      ...cf,
      email: row.email || cf.email || null,
      address: row.address || cf.address || null,
      city: row.city || cf.city || null,
      state: row.state || cf.state || null,
      country: row.country || cf.country || null,
      lastProduct: row.product || cf.lastProduct || null,
      lastOrderId: row.orderId || cf.lastOrderId || null,
      lastPaymentStatus: row.paymentStatus || cf.lastPaymentStatus || null,
      purchaseCount: prevCount + 1,
      totalPurchaseAmount: prevTotal + orderAmount,
      lastPurchase: useNewDate ? purchaseDate : (cf.lastPurchase || purchaseDate),
      source: 'shopify_sheet_sync',
    };
    const existingTags = Array.isArray(existing.tags) ? existing.tags : [];
    const mergedTags = Array.from(new Set([...existingTags, ...incomingTags]));

    await client.query(
      `UPDATE coexistence.contacts
          SET name = COALESCE($1, name),
              tags = $2::jsonb,
              custom_fields = $3::jsonb,
              updated_at = NOW()
        WHERE id = $4`,
      [name, JSON.stringify(mergedTags), JSON.stringify(mergedCustomFields), existing.id]
    );
    await client.query('COMMIT');
    return { updated: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Retarget -> Contacts bridge. Mirrors one coexistence.retarget_customers
 * row into coexistence.contacts, matched by phone (unique per wa_number).
 * - No phone on the retarget record -> skipped.
 * - No WhatsApp account connected yet -> skipped (nothing to scope the
 *   contact to); the retarget customer itself is still saved as normal.
 * - Existing contact for that phone -> updated in place (never duplicated).
 * - No existing contact -> created.
 *
 * Retarget-derived data is namespaced under custom_fields so it never
 * collides with fields other flows (manual add, Shopify sync) already
 * own — same pattern as `source` / `purchaseCount` above:
 *   isRetarget        - true
 *   retargetType       - 'Cart' | 'Checkout' | 'Product' | 'Collection' | 'Other'
 *   retargetURL        - the exit URL that triggered the retarget event
 *   retargetTimestamp  - when that exit event happened
 *   retargetLastSync   - when this bridge last wrote the contact
 *   retargetSource     - 'csv_import' | 'excel_import' | 'sheet_sync' | 'import' | 'pending'
 *
 * @param {object} retargetCustomer - a row from coexistence.retarget_customers
 *   (id, name, phone, email, exit_url, retarget_type, timestamp, source, status)
 * @param {number|null} [workspaceId] - the Retarget customer's own workspace
 *   (Phase 3C-4). Resolves the WhatsApp account to mirror into from THIS
 *   workspace only, so a Retarget customer never gets mirrored into another
 *   workspace's Contacts. Passed through by every caller in
 *   retargetService.js / retargetImportService.js — never trust a
 *   workspace id supplied by the client instead.
 * @returns {Promise<{skipped?:boolean, created?:boolean, updated?:boolean, reason?:string}>}
 */
async function upsertContactFromRetarget(retargetCustomer, workspaceId = null) {
  if (!retargetCustomer) return { skipped: true, reason: 'no retarget customer supplied' };

  const phone = normalizePhone(retargetCustomer.phone);
  if (!phone) return { skipped: true, reason: 'missing/invalid phone number' };

  let waNumber;
  try {
    waNumber = await resolveSyncWaNumber(workspaceId);
  } catch (err) {
    return { skipped: true, reason: err.message };
  }

  const retargetFields = {
    isRetarget: true,
    retargetType: detectExitCategory(retargetCustomer.exit_url),
    retargetURL: retargetCustomer.exit_url || null,
    retargetTimestamp: retargetCustomer.timestamp || null,
    retargetLastSync: new Date().toISOString(),
    retargetSource: retargetCustomer.source || null,
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existingRows } = await client.query(
      `SELECT id, name, custom_fields FROM coexistence.contacts
        WHERE wa_number = $1 AND contact_number = $2
        FOR UPDATE`,
      [waNumber, phone]
    );

    if (existingRows.length === 0) {
      const customFields = {
        email: retargetCustomer.email || null,
        ...retargetFields,
      };
      const { rows } = await client.query(
        `INSERT INTO coexistence.contacts (workspace_id, wa_number, contact_number, name, tags, custom_fields, updated_at)
         VALUES ($1, $2, $3, $4, '[]'::jsonb, $5::jsonb, NOW())
         RETURNING id`,
        [workspaceId, waNumber, phone, retargetCustomer.name || null, JSON.stringify(customFields)]
      );
      await client.query('COMMIT');
      return { created: true, contactId: rows[0].id };
    }

    const existing = existingRows[0];
    const cf = existing.custom_fields || {};
    const mergedCustomFields = {
      ...cf,
      email: retargetCustomer.email || cf.email || null,
      ...retargetFields,
    };

    await client.query(
      `UPDATE coexistence.contacts
          SET name = COALESCE($1, name),
              custom_fields = $2::jsonb,
              updated_at = NOW()
        WHERE id = $3`,
      [retargetCustomer.name || null, JSON.stringify(mergedCustomFields), existing.id]
    );
    await client.query('COMMIT');
    return { updated: true, contactId: existing.id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  upsertCustomerFromRow,
  upsertContactFromRetarget,
  normalizePhone,
  resolveSyncWaNumber,
};