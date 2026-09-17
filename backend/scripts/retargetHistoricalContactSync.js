// PHASE 3F-1 FOLLOW-UP — Historical Retarget → Contacts backfill.
//
// PURPOSE (per approved plan):
//   Restore visibility of legacy retarget_customers rows in Client Directory
//   by reusing the EXISTING, unmodified upsertContactFromRetarget() bridge
//   (services/contactSyncService.js) — the exact same function the live
//   import/sync flow already calls on every create/update. This script
//   introduces NO new contact-creation logic; it only decides, per row,
//   whether calling that existing function is SAFE.
//
// SCOPE: workspace_id = 1 only. Reads coexistence.retarget_customers.
// WRITES: coexistence.contacts ONLY (via upsertContactFromRetarget), and
// ONLY for rows classified 'create' below. Never writes retarget_customers.
// Never deletes anything. Never touches any other table.
//
// CLASSIFICATION (per retarget_customers row, matched by normalized phone):
//   - invalid          : phone fails normalizePhone() — skipped, not written.
//   - already_matching : a contacts row already exists with
//                         wa_number = <current active account> AND
//                         contact_number = phone. Calling the bridge again
//                         would only be a no-op-ish UPDATE — per rule #7
//                         ("do not change existing contact data
//                         unnecessarily") this script does NOT call the
//                         bridge for these; nothing is written.
//   - stale_wa_number  : a contacts row exists for this phone, but under a
//                         DIFFERENT wa_number than the current active
//                         account (the 5 known cases). NEVER written to —
//                         reported separately, always skipped, both in
//                         dry-run and execute mode, per explicit instruction.
//   - create           : no contacts row exists for this phone at all
//                         (any wa_number). This is the only category the
//                         script ever writes — by calling the existing
//                         upsertContactFromRetarget(row, workspaceId)
//                         unmodified. Since no row exists yet, this always
//                         inserts, never updates/duplicates.
//
// IDEMPOTENCY: running this script twice is safe. On the second run, every
// row that was 'create' on the first run is now 'already_matching' (a
// contacts row now exists under the current wa_number) and is skipped. The
// 5 stale rows remain 'stale_wa_number' forever (untouched) until someone
// explicitly approves a relink — this script performs no relink.
//
// DRY RUN (default): makes ZERO writes. Prints the full classification
// breakdown and the exact list of stale cases, then exits.
//
// EXECUTE: node scripts/retargetHistoricalContactSync.js --execute
//   Only rows classified 'create' are written, one at a time, via the
//   existing bridge function. Progress is logged per row. A final summary
//   matches the dry-run breakdown so the two can be diffed for a sanity
//   check.

require('dotenv').config();
const pool = require('../src/db');
const { normalizePhone, upsertContactFromRetarget, resolveSyncWaNumber } = require('../src/services/contactSyncService');

const WORKSPACE_ID = 1;
const EXECUTE = process.argv.includes('--execute');

async function main() {
  console.log(`\n=== Retarget → Contacts historical sync (workspace_id=${WORKSPACE_ID}) ===`);
  console.log(`Mode: ${EXECUTE ? 'EXECUTE (will write)' : 'DRY RUN (no writes)'}\n`);

  // Confirm the current active WhatsApp account for this workspace — this is
  // the exact same lookup upsertContactFromRetarget() itself performs
  // internally (resolveSyncWaNumber), surfaced here up front for the report.
  const currentWaNumber = await resolveSyncWaNumber(WORKSPACE_ID);
  console.log(`Current active WhatsApp account (wa_number): ${currentWaNumber}\n`);

  const { rows: retargetRows } = await pool.query(
    `SELECT id, workspace_id, name, phone, email, exit_url, retarget_type, timestamp, source, status
       FROM coexistence.retarget_customers
      WHERE workspace_id = $1
      ORDER BY id ASC`,
    [WORKSPACE_ID]
  );

  const buckets = {
    invalid: [],
    already_matching: [],
    stale_wa_number: [],
    create: [],
  };

  for (const row of retargetRows) {
    const phone = normalizePhone(row.phone);
    if (!phone) {
      buckets.invalid.push({ retarget_id: row.id, raw_phone: row.phone });
      continue;
    }

    const { rows: contactRows } = await pool.query(
      `SELECT id, wa_number FROM coexistence.contacts WHERE contact_number = $1`,
      [phone]
    );

    if (contactRows.length === 0) {
      buckets.create.push({ retarget_id: row.id, phone, row });
      continue;
    }

    const matchOnCurrent = contactRows.find((c) => c.wa_number === currentWaNumber);
    if (matchOnCurrent) {
      buckets.already_matching.push({ retarget_id: row.id, phone, contact_id: matchOnCurrent.id });
      continue;
    }

    // Exists, but only under a different wa_number — this is a stale case.
    for (const c of contactRows) {
      buckets.stale_wa_number.push({
        retarget_id: row.id, phone, contact_id: c.id, contact_wa_number: c.wa_number,
      });
    }
  }

  // ── Report (always printed, dry-run or execute) ──────────────────────────
  console.log('--- Classification summary ---');
  console.log(`Total retarget_customers rows checked : ${retargetRows.length}`);
  console.log(`Already matching (current wa_number)   : ${buckets.already_matching.length}  (skipped — no write needed)`);
  console.log(`Would create (no contact exists)       : ${buckets.create.length}  (${EXECUTE ? 'WILL be written' : 'would be written'})`);
  console.log(`Stale wa_number (existing, mismatched) : ${buckets.stale_wa_number.length}  (ALWAYS skipped — needs manual approval)`);
  console.log(`Invalid phone                          : ${buckets.invalid.length}  (skipped)`);

  if (buckets.stale_wa_number.length > 0) {
    console.log('\n--- STALE wa_number cases (untouched — review manually) ---');
    console.table(buckets.stale_wa_number);
  }

  if (buckets.invalid.length > 0) {
    console.log('\n--- Invalid phone rows (skipped) ---');
    console.table(buckets.invalid);
  }

  if (!EXECUTE) {
    console.log('\nDRY RUN complete. No data was written.');
    console.log('Re-run with --execute to create the missing contacts listed above.');
    await pool.end();
    return;
  }

  // ── Execute: only the 'create' bucket, via the EXISTING bridge function ──
  console.log(`\n--- Executing: creating ${buckets.create.length} contact(s) via upsertContactFromRetarget() ---`);
  let created = 0, updated = 0, skipped = 0, failed = 0;

  for (const item of buckets.create) {
    try {
      const result = await upsertContactFromRetarget(item.row, WORKSPACE_ID);
      if (result.created) created++;
      else if (result.updated) updated++; // shouldn't happen for this bucket, but counted honestly
      else if (result.skipped) { skipped++; console.log(`  skipped retarget_id=${item.retarget_id}: ${result.reason}`); }
    } catch (err) {
      failed++;
      console.error(`  FAILED retarget_id=${item.retarget_id} (${item.phone}): ${err.message}`);
    }
  }

  console.log('\n--- Execution summary ---');
  console.log(`Created : ${created}`);
  console.log(`Updated : ${updated}`);
  console.log(`Skipped : ${skipped}`);
  console.log(`Failed  : ${failed}`);
  console.log(`\nUntouched (unchanged): already_matching=${buckets.already_matching.length}, stale_wa_number=${buckets.stale_wa_number.length}, invalid=${buckets.invalid.length}`);
  console.log('\nDone.');
  await pool.end();
}

main().catch((err) => {
  console.error('[retargetHistoricalContactSync] fatal error:', err);
  process.exit(1);
});
