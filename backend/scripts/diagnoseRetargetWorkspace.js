// PHASE 3F-1 — DIAGNOSTIC ONLY. Makes NO writes. Safe to run any time.
//
// Prints exactly why the Retarget page shows "0 retarget customers" while
// Client Directory → Retarget Contacts shows 1,227+.
//
// Run from backend/ with your real .env loaded:
//   node scripts/diagnoseRetargetWorkspace.js
//
// What it checks:
//   1. Every workspace that exists, oldest first (the "default workspace"
//      every Phase 3 backfill script picks via ORDER BY id ASC LIMIT 1).
//   2. How retarget_customers.workspace_id values are actually distributed
//      (including any NULLs left over from a failed/partial backfill).
//   3. How contacts.workspace_id values are distributed, for comparison —
//      this is the table the working "Retarget Contacts" tab reads from.
//   4. Every user + which workspace they're currently a member of (this is
//      what req.workspace.id resolves to for their session).
//   5. A direct verdict: for each workspace that has a user, does that
//      workspace's id actually own any retarget_customers rows?

require('dotenv').config();
const pool = require('../src/db');

async function main() {
  console.log('\n=== 1. Workspaces (oldest first = default backfill target) ===');
  const { rows: workspaces } = await pool.query(
    `SELECT id, name, slug, status, created_at FROM coexistence.workspaces ORDER BY id ASC`
  );
  console.table(workspaces);

  console.log('\n=== 2. retarget_customers.workspace_id distribution ===');
  const { rows: retargetDist } = await pool.query(
    `SELECT workspace_id, COUNT(*)::int AS row_count
       FROM coexistence.retarget_customers
      GROUP BY workspace_id
      ORDER BY row_count DESC`
  );
  console.table(retargetDist);
  const retargetNulls = retargetDist.find(r => r.workspace_id === null);
  if (retargetNulls) {
    console.log(`  ⚠ ${retargetNulls.row_count} retarget_customers row(s) still have workspace_id = NULL`);
    console.log('    → backfillWorkspaceId() either never ran, or errored before completing.');
  }

  console.log('\n=== 3. contacts.workspace_id distribution (for comparison) ===');
  const { rows: contactsDist } = await pool.query(
    `SELECT workspace_id, COUNT(*)::int AS row_count
       FROM coexistence.contacts
      GROUP BY workspace_id
      ORDER BY row_count DESC`
  );
  console.table(contactsDist);

  console.log('\n=== 4. Users and their resolved workspace (req.workspace.id per session) ===');
  const { rows: users } = await pool.query(
    `SELECT u.id AS user_id, u.email, wm.workspace_id, wm.status AS membership_status, wm.workspace_role
       FROM coexistence.users u
       LEFT JOIN coexistence.workspace_members wm
              ON wm.user_id = u.id AND wm.status = 'active'
      ORDER BY u.id ASC`
  );
  console.table(users);

  console.log('\n=== 5. Verdict ===');
  for (const u of users) {
    if (u.workspace_id == null) {
      console.log(`  ⚠ User ${u.email} (id ${u.user_id}) has NO active workspace membership — req.workspace would be null for them, every workspace-scoped page returns empty/403.`);
      continue;
    }
    const match = retargetDist.find(r => r.workspace_id === u.workspace_id);
    const contactMatch = contactsDist.find(r => r.workspace_id === u.workspace_id);
    console.log(
      `  User ${u.email} → workspace_id=${u.workspace_id} → ` +
      `retarget_customers: ${match ? match.row_count : 0} row(s), ` +
      `contacts: ${contactMatch ? contactMatch.row_count : 0} row(s)`
    );
    if ((!match || match.row_count === 0) && contactMatch && contactMatch.row_count > 0) {
      console.log(
        `    ⚠ ROOT CAUSE CONFIRMED for ${u.email}: their workspace (${u.workspace_id}) owns contacts ` +
        `but zero (or no) retarget_customers rows. The legacy retarget_customers data is sitting under ` +
        `a DIFFERENT workspace_id — see the table in section 2 above to find which one, then it can be ` +
        `corrected with a targeted UPDATE (not included here — this script never writes).`
      );
    }
  }

  console.log('\nDone. No data was modified.');
  await pool.end();
}

main().catch(err => {
  console.error('[diagnoseRetargetWorkspace] error:', err);
  process.exit(1);
});