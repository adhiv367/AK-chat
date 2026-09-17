// Home dashboard aggregations.
//
// One endpoint, role-scoped: admins get org-wide numbers +
// automation/broadcast/alert sections; BDA Sales users get the same shape but
// scoped to ONLY the contacts assigned to them (assigned_user_id), and without
// the admin-only sections (they can't reach those features anyway).
//
// Scoping trick: every contact/chat query carries a `/*SCOPE*/` marker.
// applyScope() strips it for admins, or replaces every occurrence with the
// matching `assigned_user_id` filter for non-admins (reusing a single bind
// param — Postgres allows the same $N placeholder to appear multiple times).
//
// All queries are read-only, parameterised, and hit existing indexes.

const { Router } = require('express');
const pool = require('../db');
const { isAdmin } = require('../permissions');
// Phase 4F — Workspace Dashboard. Reuses the existing WhatsApp account
// shaping logic (connectionState derivation) rather than re-deriving it —
// same function whatsappOnboardingStatus.js already reuses this way.
const { publicShape } = require('./whatsappAccounts');

const router = Router();

const RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 };

// The tag category that defines a "lead" — drives the New Leads + Open
// Conversations KPIs. Configurable so each deployment can point at its own
// category name instead of being locked to the literal "Lead Source".
const LEAD_SOURCE_CATEGORY = process.env.LEAD_SOURCE_CATEGORY || 'Lead Source';

// Replace /*SCOPE*/ markers with the connected-account + per-user clauses.
//   kind 'contacts' → filters on the contacts alias `c`
//   kind 'chat'     → filters on the chat_history alias `ch` (and EXISTS
//                      against contacts for the per-user check)
// `wa` is the list of the current workspace's connected WhatsApp numbers —
// a workspace may now have multiple accounts, so every aggregate is
// restricted to ANY of them; without it the dashboard would also count
// orphaned rows from another workspace's number, or a previously-connected one.
function applyScope(sql, params, { admin, uid, kind, wa }) {
  const out = [...params];
  let clause = '';

  // Connected-account filter (both roles). No accounts → show nothing.
  if (wa && wa.length > 0) {
    out.push(wa);
    const wp = `$${out.length}`;
    clause += kind === 'contacts' ? ` AND c.wa_number = ANY(${wp}::text[])` : ` AND ch.wa_number = ANY(${wp}::text[])`;
  } else {
    clause += ' AND FALSE';
  }

  // Per-user visibility (non-admins see only their assigned contacts).
  if (!admin) {
    out.push(uid);
    const up = `$${out.length}`;
    clause += kind === 'contacts'
      ? ` AND c.assigned_user_id = ${up}`
      : ` AND EXISTS (SELECT 1 FROM coexistence.contacts sc
                       WHERE sc.wa_number = ch.wa_number
                         AND sc.contact_number = ch.contact_number
                         AND sc.assigned_user_id = ${up})`;
  }

  return { sql: sql.split('/*SCOPE*/').join(clause), params: out };
}

// Resolve every connected WhatsApp number (digits only) for a workspace.
// Multi-account: a workspace can now have several numbers, all of which
// count toward its dashboard totals.
async function getConnectedWaNumbers(workspaceId) {
  if (!workspaceId) return [];
  const { rows } = await pool.query(
    `SELECT display_phone_number AS wa FROM coexistence.whatsapp_accounts
      WHERE workspace_id = $1
      ORDER BY is_default DESC, id ASC`,
    [workspaceId]
  );
  return rows.map(r => (r.wa || '').replace(/\D/g, '')).filter(Boolean);
}

// pct change vs previous period; null when there's no baseline to compare to.
function pct(cur, prev) {
  if (!prev || prev <= 0) return null;
  return Math.round(((cur - prev) / prev) * 100);
}

router.get('/dashboard', async (req, res) => {
  try {
    const admin = isAdmin(req.user);
    const uid = req.user.id;
    // workspaceId always comes from req.workspace.id (attachWorkspace,
    // mounted globally in index.js) — never from the client. Every
    // workspace-owned aggregate below (automations, broadcasts, templates,
    // WhatsApp accounts) is filtered by it; a missing workspace fails
    // closed to empty/zeroed sections rather than running unscoped.
    const workspaceId = req.workspace?.id ?? null;
    const range = RANGE_DAYS[req.query.range] ? req.query.range : '7d';
    const days = RANGE_DAYS[range];
    const connectedWa = await getConnectedWaNumbers(req.workspace?.id);

    // Helper: run a scoped query (restricted to the connected account).
    const q = async (sql, params, kind) => {
      const built = applyScope(sql, params, { admin, uid, kind, wa: connectedWa });
      const { rows } = await pool.query(built.sql, built.params);
      return rows;
    };

    // Resolve the "Lead Source" category id (case-insensitive). A "lead" is a
    // contact tagged under this category — drives the New Leads + Open
    // Conversations cards.
    // Phase 7.13B fix (7.13A-2): coexistence.categories is a workspace-owned
    // table (see routes/categories.js) — without workspace_id scoping this
    // could resolve to a different workspace's "Lead Source" category if one
    // happens to exist with the same name, silently mis-attributing the KPI.
    // A workspace with no resolved workspace yet gets leadSourceCatId = null
    // (fails closed) rather than matching across tenants.
    const { rows: lsRows } = workspaceId
      ? await pool.query(
          `SELECT id FROM coexistence.categories WHERE LOWER(name) = LOWER($1) AND workspace_id = $2 ORDER BY created_at LIMIT 1`,
          [LEAD_SOURCE_CATEGORY, workspaceId]
        )
      : { rows: [] };
    const leadSourceCatId = lsRows[0]?.id || null;

    // ── Contacts (totals + new this/prev period) ──────────────────────
    const [contactRow] = await q(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE c.created_at >= NOW() - ($1 * INTERVAL '1 day'))::int AS new_in_range,
         count(*) FILTER (WHERE c.created_at >= NOW() - ($1 * INTERVAL '1 day') * 2
                            AND c.created_at <  NOW() - ($1 * INTERVAL '1 day'))::int AS prev_new
       FROM coexistence.contacts c
       WHERE TRUE /*SCOPE*/`,
      [days], 'contacts'
    );

    // ── New leads: contacts tagged under "Lead Source", new this/prev ──
    let leadRow = { new_in_range: 0, prev_new: 0 };
    if (leadSourceCatId) {
      [leadRow] = await q(
        `SELECT
           count(DISTINCT c.id) FILTER (WHERE c.created_at >= NOW() - ($1 * INTERVAL '1 day'))::int AS new_in_range,
           count(DISTINCT c.id) FILTER (WHERE c.created_at >= NOW() - ($1 * INTERVAL '1 day') * 2
                              AND c.created_at <  NOW() - ($1 * INTERVAL '1 day'))::int AS prev_new
         FROM coexistence.contacts c,
              jsonb_array_elements(COALESCE(c.tags, '[]'::jsonb)) t
         WHERE (t->>'category_id') = $2 /*SCOPE*/`,
        [days, leadSourceCatId], 'contacts'
      );
    }

    // ── Messages + active conversations (this/prev period) ────────────
    const [msgRow] = await q(
      `SELECT
         count(DISTINCT (ch.wa_number, ch.contact_number))
           FILTER (WHERE ch.timestamp >= NOW() - ($1 * INTERVAL '1 day'))::int AS active_convos,
         count(*) FILTER (WHERE ch.direction='outgoing'
                            AND ch.timestamp >= NOW() - ($1 * INTERVAL '1 day'))::int AS sent,
         count(*) FILTER (WHERE ch.direction='incoming'
                            AND ch.timestamp >= NOW() - ($1 * INTERVAL '1 day'))::int AS received,
         count(*) FILTER (WHERE ch.direction='outgoing'
                            AND ch.timestamp >= NOW() - ($1 * INTERVAL '1 day') * 2
                            AND ch.timestamp <  NOW() - ($1 * INTERVAL '1 day'))::int AS prev_sent
       FROM coexistence.chat_history ch
       WHERE TRUE /*SCOPE*/`,
      [days], 'chat'
    );

    // ── Response rate: inbound conversations that got a reply ──────────
    const [respRow] = await q(
      `WITH conv AS (
         SELECT ch.wa_number, ch.contact_number,
                bool_or(ch.direction='incoming') AS has_in,
                bool_or(ch.direction='outgoing') AS has_out
         FROM coexistence.chat_history ch
         WHERE ch.timestamp >= NOW() - ($1 * INTERVAL '1 day') /*SCOPE*/
         GROUP BY ch.wa_number, ch.contact_number
       )
       SELECT count(*) FILTER (WHERE has_in)::int AS inbound_convos,
              count(*) FILTER (WHERE has_in AND has_out)::int AS replied_convos
       FROM conv`,
      [days], 'chat'
    );

    // ── Open conversations: unread incoming newer than last read, AND the
    //    contact is tagged under the "Lead Source" category ──────────────
    let openRow = { open_convos: 0 };
    if (leadSourceCatId) {
      [openRow] = await q(
        `WITH last_in AS (
           SELECT ch.wa_number, ch.contact_number, max(ch.timestamp) AS last_in_ts
           FROM coexistence.chat_history ch
           WHERE ch.direction='incoming' /*SCOPE*/
           GROUP BY ch.wa_number, ch.contact_number
         )
         SELECT count(*)::int AS open_convos
         FROM last_in li
         LEFT JOIN coexistence.conversation_reads r
           ON r.wa_number = li.wa_number AND r.contact_number = li.contact_number
         WHERE (r.last_read_at IS NULL OR li.last_in_ts > r.last_read_at)
           AND EXISTS (
             SELECT 1 FROM coexistence.contacts lc,
                  jsonb_array_elements(COALESCE(lc.tags, '[]'::jsonb)) lt
              WHERE lc.wa_number = li.wa_number
                AND lc.contact_number = li.contact_number
                AND (lt->>'category_id') = $1
           )`,
        [leadSourceCatId], 'chat'
      );
    }

    // ── Lead funnel: pick a tag category (override via ?funnelCategory) ─
    let funnelCategoryId = (req.query.funnelCategory || '').trim() || null;
    if (!funnelCategoryId) {
      const top = await q(
        `SELECT (t->>'category_id') AS cat_id, count(DISTINCT c.id) AS cnt
         FROM coexistence.contacts c,
              jsonb_array_elements(COALESCE(c.tags, '[]'::jsonb)) t
         WHERE (t->>'category_id') IS NOT NULL /*SCOPE*/
         GROUP BY 1
         ORDER BY cnt DESC NULLS LAST
         LIMIT 1`,
        [], 'contacts'
      );
      funnelCategoryId = top[0]?.cat_id || null;
    }

    let funnel = { categoryId: null, categoryName: null, stages: [], total: 0 };
    if (funnelCategoryId) {
      const stages = await q(
        `SELECT t->>'name' AS name,
                COALESCE(t->>'color', '#dc2626') AS color,
                count(DISTINCT c.id)::int AS count
         FROM coexistence.contacts c,
              jsonb_array_elements(COALESCE(c.tags, '[]'::jsonb)) t
         WHERE (t->>'category_id') = $1 /*SCOPE*/
         GROUP BY 1, 2
         ORDER BY count DESC`,
        [funnelCategoryId], 'contacts'
      );
      // Phase 7.13B fix (7.13A-1): coexistence.categories is workspace-owned
      // (routes/categories.js always scopes it) — without workspace_id here,
      // a client-supplied ?funnelCategory=<id> from another workspace would
      // resolve to that other workspace's category name (cross-tenant
      // metadata leak). Scoped by workspaceId so a foreign/nonexistent id
      // now resolves to categoryName: null, same as any other not-found id.
      const { rows: catRows } = workspaceId
        ? await pool.query(
            `SELECT name FROM coexistence.categories WHERE id = $1 AND workspace_id = $2`,
            [funnelCategoryId, workspaceId]
          )
        : { rows: [] };
      funnel = {
        categoryId: funnelCategoryId,
        categoryName: catRows[0]?.name || null,
        stages,
        total: stages.reduce((s, r) => s + r.count, 0),
      };
    }
    // All categories for a future selector.
    // Phase 7.13B fix (7.13A-1): must be scoped to this workspace only —
    // previously returned every workspace's category ids/names (cross-tenant
    // metadata leak), matching the same fix applied to categoryName above.
    const { rows: allCats } = workspaceId
      ? await pool.query(
          `SELECT id, name FROM coexistence.categories WHERE workspace_id = $1 ORDER BY name`,
          [workspaceId]
        )
      : { rows: [] };
    funnel.categories = allCats;

    // ── Tag distribution (top 8 across visible contacts) ──────────────
    const tagDistribution = await q(
      `SELECT t->>'name' AS name,
              COALESCE(t->>'color', '#dc2626') AS color,
              count(DISTINCT c.id)::int AS count
       FROM coexistence.contacts c,
            jsonb_array_elements(COALESCE(c.tags, '[]'::jsonb)) t
       WHERE TRUE /*SCOPE*/
       GROUP BY 1, 2
       ORDER BY count DESC
       LIMIT 8`,
      [], 'contacts'
    );

    // ── Build KPI tiles (5 common + 1 role-specific) ──────────────────
    const responseRate = respRow.inbound_convos > 0
      ? Math.round((respRow.replied_convos / respRow.inbound_convos) * 100)
      : 0;

    const kpis = [
      {
        key: 'contacts', label: 'Total Contacts', value: contactRow.total, unit: '',
        delta: pct(contactRow.new_in_range, contactRow.prev_new),
        sub: `+${contactRow.new_in_range} new`,
        tooltip: admin
          ? 'All contacts captured. Change compares new contacts this period vs the previous one.'
          : 'Contacts assigned to you. Change compares new ones this period vs the previous one.',
      },
      {
        key: 'newLeads', label: 'New Leads', value: leadRow.new_in_range, unit: '',
        delta: pct(leadRow.new_in_range, leadRow.prev_new), sub: `in last ${days}d`,
        tooltip: `New contacts tagged under the “${LEAD_SOURCE_CATEGORY}” category in the selected period.`,
      },
      {
        key: 'open', label: 'Open Conversations', value: openRow.open_convos, unit: '',
        delta: null, sub: 'awaiting reply',
        tooltip: `Conversations awaiting a reply where the contact is tagged under the “${LEAD_SOURCE_CATEGORY}” category.`,
      },
      {
        key: 'sent', label: 'Messages Sent', value: msgRow.sent, unit: '',
        delta: pct(msgRow.sent, msgRow.prev_sent), sub: `${msgRow.received} received`,
        tooltip: 'Outbound WhatsApp messages in the period. Change compares vs the previous period.',
      },
      {
        key: 'response', label: 'Response Rate', value: responseRate, unit: '%',
        delta: null, sub: `${respRow.replied_convos}/${respRow.inbound_convos} replied`,
        tooltip: 'Share of inbound conversations that received at least one reply in the period.',
      },
    ];

    // Admin/BDA sections + 6th KPI
    let automations = null, broadcasts = null, workspaceSummary = null;
    const alerts = [];

    if (admin) {
      // Every query below is workspace-scoped from workspaceId (never the
      // client). No workspace resolved for this session -> fail closed:
      // skip every admin query entirely and report zeroed/empty sections,
      // rather than running any of them unscoped.
      const [autoCounts] = workspaceId
        ? (await pool.query(
            `SELECT count(*) FILTER (WHERE status='active')::int AS active,
                    count(*)::int AS total
             FROM coexistence.chatbots
             WHERE workspace_id = $1`,
            [workspaceId]
          )).rows
        : [{ active: 0, total: 0 }];
      // automation_executions has no workspace_id of its own — ownership is
      // derived by joining to its parent chatbot's workspace_id via
      // automation_id -> chatbots.id (same relationship already used by
      // routes/chatbots.js), so cross-workspace runs never get counted.
      const [runRow] = workspaceId
        ? (await pool.query(
            `SELECT count(*)::int AS total,
                    count(*) FILTER (WHERE e.status='success')::int AS success,
                    count(*) FILTER (WHERE e.status='error')::int AS error,
                    count(*) FILTER (WHERE e.status='paused')::int AS paused
             FROM coexistence.automation_executions e
             JOIN coexistence.chatbots c ON c.id = e.automation_id
             WHERE e.started_at >= NOW() - ($1 * INTERVAL '1 day')
               AND c.workspace_id = $2`,
            [days, workspaceId]
          )).rows
        : [{ total: 0, success: 0, error: 0, paused: 0 }];
      automations = {
        active: autoCounts.active, total: autoCounts.total,
        runs: runRow,
        successRate: runRow.total > 0 ? Math.round((runRow.success / runRow.total) * 100) : null,
      };
      kpis.push({
        key: 'automations', label: 'Active Automations', value: autoCounts.active, unit: '',
        delta: null, sub: `of ${autoCounts.total} total`,
        tooltip: 'Automation flows currently enabled (status = active).',
      });

      // Broadcasts summary + recent. broadcast_logs has no workspace_id of
      // its own — ownership is derived by joining to its parent broadcast's
      // workspace_id via broadcast_id -> broadcasts.id, per instruction #6.
      const [bcSummary] = workspaceId
        ? (await pool.query(
            `SELECT count(*)::int AS campaigns
             FROM coexistence.broadcasts
             WHERE created_at >= NOW() - ($1 * INTERVAL '1 day')
               AND workspace_id = $2`,
            [days, workspaceId]
          )).rows
        : [{ campaigns: 0 }];
      const recent = workspaceId
        ? (await pool.query(
            `SELECT b.id, b.name, b.message_type AS "messageType", b.status,
                    b.created_at AS "createdAt",
                    count(*) FILTER (WHERE l.action='BROADCAST')::int AS recipients,
                    count(*) FILTER (WHERE l.action='BROADCAST' AND l.status='SENT')::int AS sent,
                    count(*) FILTER (WHERE l.action='BROADCAST' AND l.status='FAILED')::int AS failed
             FROM coexistence.broadcasts b
             LEFT JOIN coexistence.broadcast_logs l ON l.broadcast_id = b.id
             WHERE b.workspace_id = $1
             GROUP BY b.id
             ORDER BY b.created_at DESC
             LIMIT 5`,
            [workspaceId]
          )).rows
        : [];
      broadcasts = { campaigns: bcSummary.campaigns, recent };

      // Alerts (admin operational health)
      const [tpl] = workspaceId
        ? (await pool.query(
        `SELECT count(*) FILTER (WHERE status='REJECTED')::int AS rejected,
                count(*) FILTER (WHERE status='PAUSED')::int AS paused,
                count(*) FILTER (WHERE status='SUBMITTED')::int AS pending,
                count(*) FILTER (WHERE quality_score='RED')::int AS low_quality
         FROM coexistence.message_templates
         WHERE workspace_id = $1`,
            [workspaceId]
          )).rows
        : [{ rejected: 0, paused: 0, pending: 0, low_quality: 0 }];
      if (tpl.rejected > 0) alerts.push({ level: 'warn', label: 'Templates rejected', count: tpl.rejected, page: 'template-builder' });
      if (tpl.paused > 0) alerts.push({ level: 'warn', label: 'Templates paused', count: tpl.paused, page: 'template-builder' });
      if (tpl.low_quality > 0) alerts.push({ level: 'warn', label: 'Low-quality templates', count: tpl.low_quality, page: 'template-builder' });
      if (tpl.pending > 0) alerts.push({ level: 'info', label: 'Templates pending review', count: tpl.pending, page: 'template-builder' });
      if (runRow.error > 0) alerts.push({ level: 'warn', label: 'Failed automation runs', count: runRow.error, page: 'chatbot-builder' });
      const [waba] = workspaceId
        ? (await pool.query(
        `SELECT count(*) FILTER (WHERE NOT is_active)::int AS inactive FROM coexistence.whatsapp_accounts WHERE workspace_id = $1`,
            [workspaceId]
          )).rows
        : [{ inactive: 0 }];
      if (waba.inactive > 0) alerts.push({ level: 'warn', label: 'Inactive WhatsApp accounts', count: waba.inactive, page: 'admin-settings' });

      // ── Phase 4F — Workspace Dashboard summary ────────────────────────
      // Purely additive `workspace` section on the response. Every query is
      // scoped by workspaceId, resolved server-side by attachWorkspace
      // (middleware/workspaceContext.js) and NEVER accepted from the
      // client — identical rule to every other admin-only query above.
      // Reuses existing tables only: workspace_members (team count),
      // whatsapp_accounts (via the same publicShape()/connectionState this
      // codebase already uses for the onboarding-status endpoint),
      // contacts/chat_history (already computed above as contactRow/
      // openRow/msgRow), broadcasts, chatbots + automation_executions.
      // No new tables, no new routes, no duplicate scoping logic.
      if (workspaceId) {
        // Phase 4G: count both active members and pending invitations
        // (workspace_members.status — 'active' from Phase 1, 'pending' from
        // the Phase 4D invite flow, see routes/invitations.js). "Invited/
        // configured" is true the moment an admin has done EITHER — invited
        // someone (pending) or already has a second active member — without
        // requiring the pending invite to be accepted first.
        const [{ active_count: memberCount, pending_count: pendingInvites }] = (await pool.query(
          `SELECT
             count(*) FILTER (WHERE status = 'active')::int AS active_count,
             count(*) FILTER (WHERE status = 'pending')::int AS pending_count
           FROM coexistence.workspace_members
          WHERE workspace_id = $1`,
          [workspaceId]
        )).rows;

        const { rows: waRows } = await pool.query(
          `SELECT * FROM coexistence.whatsapp_accounts
             WHERE workspace_id = $1
             ORDER BY is_default DESC, id ASC`,
          [workspaceId]
        );
        const waAccounts = waRows.map(r => {
          const shaped = publicShape(r);
          return {
            id: shaped.id,
            displayPhoneNumber: shaped.displayPhoneNumber,
            isDefault: shaped.isDefault,
            connectionState: shaped.connectionState,
          };
        });
        const waActive = waAccounts.filter(
          a => a.connectionState === 'healthy' || a.connectionState === 'unverified'
        ).length;

        const [{ count: broadcastsTotal }] = (await pool.query(
          `SELECT count(*)::int AS count FROM coexistence.broadcasts WHERE workspace_id = $1`,
          [workspaceId]
        )).rows;

        // Recent activity: merge the most recent messages, broadcasts, and
        // automation runs for this workspace into one timeline. Each
        // sub-query reuses the same workspace-scoping already used above
        // (connectedWa for chat_history; workspace_id for broadcasts /
        // automation_executions via their parent chatbot).
        const recentMessages = connectedWa.length > 0
          ? (await pool.query(
              `SELECT ch.direction, ch.timestamp,
                      COALESCE(NULLIF(c.name,''), NULLIF(c.profile_name,''), ch.contact_number) AS contact
                 FROM coexistence.chat_history ch
                 LEFT JOIN coexistence.contacts c
                   ON c.wa_number = ch.wa_number AND c.contact_number = ch.contact_number
                WHERE ch.wa_number = ANY($1::text[])
                ORDER BY ch.timestamp DESC LIMIT 5`,
              [connectedWa]
            )).rows
          : [];
        const { rows: recentBroadcasts } = await pool.query(
          `SELECT id, name, status, created_at AS "createdAt"
             FROM coexistence.broadcasts
            WHERE workspace_id = $1
            ORDER BY created_at DESC LIMIT 5`,
          [workspaceId]
        );
        const { rows: recentRuns } = await pool.query(
          `SELECT e.status, e.started_at AS "startedAt", c.name AS "automationName"
             FROM coexistence.automation_executions e
             JOIN coexistence.chatbots c ON c.id = e.automation_id
            WHERE c.workspace_id = $1
            ORDER BY e.started_at DESC LIMIT 5`,
          [workspaceId]
        );

        const recentActivity = [
          ...recentMessages.map(m => ({
            type: 'message',
            label: m.direction === 'outgoing' ? `Message sent to ${m.contact}` : `Message received from ${m.contact}`,
            at: m.timestamp,
          })),
          ...recentBroadcasts.map(b => ({
            type: 'broadcast',
            label: `Campaign "${b.name || `#${b.id}`}" ${(b.status || '').toLowerCase()}`.trim(),
            at: b.createdAt,
          })),
          ...recentRuns.map(r => ({
            type: 'automation',
            label: `Automation "${r.automationName}" ${r.status}`,
            at: r.startedAt,
          })),
        ]
          .filter(a => a.at)
          .sort((a, b) => new Date(b.at) - new Date(a.at))
          .slice(0, 10);

        workspaceSummary = {
          id: workspaceId,
          name: req.workspace?.name || null,
          businessName: req.workspace?.businessName || null,
          memberCount,
          contactsTotal: contactRow.total,
          conversationsOpen: openRow.open_convos,
          messagesSent: msgRow.sent,
          broadcastsTotal,
          automationsTotal: autoCounts.total,
          whatsapp: { total: waAccounts.length, active: waActive, accounts: waAccounts },
          recentActivity,
          // Phase 4G — Workspace Setup Completion / Readiness. Reuses only
          // data already resolved above (workspace_members counts,
          // waActive, req.workspace's Phase 4E business fields) — no new
          // tables or queries beyond the member-count one just added.
          // `steps` is the single source of truth for both the checklist
          // UI and the completion percentage, so the two can never drift.
          // Kept alongside the original Phase 4F boolean fields
          // (businessInfoComplete/whatsappConnected/teamInvited) for
          // backward compatibility with anything already reading them.
          readiness: (() => {
            const businessInfoComplete = !!(req.workspace?.businessName && req.workspace?.timezone);
            const whatsappConnected = waActive > 0;
            const teamConfigured = memberCount > 1 || pendingInvites > 0;
            const steps = [
              { key: 'workspaceCreated', label: 'Workspace created', complete: true, action: null },
              {
                key: 'businessInfo', label: 'Business information', complete: businessInfoComplete,
                action: businessInfoComplete ? null : { label: 'Complete business information', page: 'admin-settings', tab: 'workspace' },
              },
              {
                key: 'whatsapp', label: 'WhatsApp connected', complete: whatsappConnected,
                action: whatsappConnected ? null : { label: 'Connect WhatsApp', page: 'admin-settings', tab: 'whatsapp-accounts' },
              },
              {
                key: 'team', label: 'Invite/configure team', complete: teamConfigured,
                action: teamConfigured ? null : { label: 'Invite team member', page: 'admin-settings', tab: 'workspace' },
              },
            ];
            const percent = Math.round((steps.filter(s => s.complete).length / steps.length) * 100);
            return {
              // Legacy Phase 4F fields — unchanged shape/meaning.
              onboardingCompleted: !!req.workspace?.onboardingCompleted,
              businessInfoComplete,
              whatsappConnected,
              teamInvited: teamConfigured,
              // New Phase 4G fields.
              steps,
              percent,
            };
          })(),
        };
      }
    } else {
      // BDA 6th KPI: their active conversations
      kpis.push({
        key: 'convos', label: 'Active Conversations', value: msgRow.active_convos, unit: '',
        delta: null, sub: `${msgRow.received} received`,
        tooltip: 'Your customer threads with at least one message in the period.',
      });
      if (openRow.open_convos > 0) {
        alerts.push({ level: 'warn', label: 'Conversations awaiting your reply', count: openRow.open_convos, page: 'chats' });
      }
    }

    res.json({
      range,
      scope: admin ? 'admin' : 'bda',
      generatedAt: new Date().toISOString(),
      kpis,
      funnel,
      tagDistribution,
      automations,
      broadcasts,
      alerts,
      workspace: workspaceSummary,
    });
  } catch (err) {
    console.error('[dashboard] error:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// ── KPI drill-down: the list of items behind a KPI number ──────────────
// GET /api/dashboard/details?metric=<kpi key>&range=7d|30d|90d
// Returns { metric, title, count, items:[{primary, secondary, meta}] },
// role-scoped exactly like the main dashboard. `items` is a uniform shape so
// the frontend modal can render any metric with one list component.
router.get('/dashboard/details', async (req, res) => {
  try {
    const admin = isAdmin(req.user);
    const uid = req.user.id;
    // workspaceId always comes from req.workspace.id, never the client —
    // used to scope the 'automations' metric below the same way as the
    // main /dashboard admin block.
    const workspaceId = req.workspace?.id ?? null;
    const range = RANGE_DAYS[req.query.range] ? req.query.range : '7d';
    const days = RANGE_DAYS[range];
    const metric = String(req.query.metric || '');
    const LIMIT = 300;

    const connectedWa = await getConnectedWaNumbers(req.workspace?.id);
    const q = async (sql, params, kind) => {
      const built = applyScope(sql, params, { admin, uid, kind, wa: connectedWa });
      const { rows } = await pool.query(built.sql, built.params);
      return rows;
    };
    // Phase 7.13B fix (7.13A-2): same workspace scoping as the main
    // /dashboard handler's "Lead Source" resolution above — see that
    // comment for rationale. Fails closed (null) with no workspace.
    const leadCat = async () => {
      if (!workspaceId) return null;
      const { rows } = await pool.query(
        `SELECT id FROM coexistence.categories WHERE LOWER(name) = LOWER($1) AND workspace_id = $2 ORDER BY created_at LIMIT 1`,
        [LEAD_SOURCE_CATEGORY, workspaceId]
      );
      return rows[0]?.id || null;
    };
    // Reusable display-name expression for a contacts alias.
    const nameExpr = (a) => `COALESCE(NULLIF(${a}.name,''), NULLIF(${a}.profile_name,''), ${a}.contact_number)`;

    let title = '';
    let items = [];

    switch (metric) {
      case 'contacts': {
        title = 'All contacts';
        items = await q(
          `SELECT ${nameExpr('c')} AS primary, c.contact_number AS secondary,
                  to_char(c.created_at, 'DD Mon YYYY') AS meta
             FROM coexistence.contacts c
            WHERE TRUE /*SCOPE*/
            ORDER BY c.created_at DESC LIMIT ${LIMIT}`,
          [], 'contacts'
        );
        break;
      }
      case 'newLeads': {
        title = `New leads · last ${days}d`;
        const cat = await leadCat();
        if (cat) items = await q(
          `SELECT ${nameExpr('c')} AS primary, c.contact_number AS secondary,
                  to_char(c.created_at, 'DD Mon YYYY') AS meta
             FROM coexistence.contacts c
            WHERE c.created_at >= NOW() - ($2 * INTERVAL '1 day')
              AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(c.tags,'[]'::jsonb)) t
                           WHERE (t->>'category_id') = $1)
              /*SCOPE*/
            ORDER BY c.created_at DESC LIMIT ${LIMIT}`,
          [cat, days], 'contacts'
        );
        break;
      }
      case 'open': {
        title = `Open conversations · ${LEAD_SOURCE_CATEGORY}`;
        const cat = await leadCat();
        if (cat) items = await q(
          `WITH last_in AS (
             SELECT ch.wa_number, ch.contact_number, max(ch.timestamp) AS last_in_ts
             FROM coexistence.chat_history ch
             WHERE ch.direction='incoming' /*SCOPE*/
             GROUP BY 1, 2
           )
           SELECT ${nameExpr('c')} AS primary, li.contact_number AS secondary,
                  to_char(li.last_in_ts, 'DD Mon, HH24:MI') AS meta
           FROM last_in li
           LEFT JOIN coexistence.conversation_reads r
             ON r.wa_number = li.wa_number AND r.contact_number = li.contact_number
           LEFT JOIN coexistence.contacts c
             ON c.wa_number = li.wa_number AND c.contact_number = li.contact_number
           WHERE (r.last_read_at IS NULL OR li.last_in_ts > r.last_read_at)
             AND EXISTS (SELECT 1 FROM coexistence.contacts lc, jsonb_array_elements(COALESCE(lc.tags,'[]'::jsonb)) lt
                          WHERE lc.wa_number = li.wa_number AND lc.contact_number = li.contact_number
                            AND (lt->>'category_id') = $1)
           ORDER BY li.last_in_ts DESC LIMIT ${LIMIT}`,
          [cat], 'chat'
        );
        break;
      }
      case 'sent': {
        title = `Messages sent · last ${days}d`;
        items = await q(
          `SELECT ${nameExpr('c')} AS primary,
                  LEFT(COALESCE(NULLIF(ch.message_body,''), '[' || ch.message_type || ']'), 64) AS secondary,
                  to_char(ch.timestamp, 'DD Mon, HH24:MI') AS meta
             FROM coexistence.chat_history ch
             LEFT JOIN coexistence.contacts c
               ON c.wa_number = ch.wa_number AND c.contact_number = ch.contact_number
            WHERE ch.direction='outgoing'
              AND ch.timestamp >= NOW() - ($1 * INTERVAL '1 day') /*SCOPE*/
            ORDER BY ch.timestamp DESC LIMIT ${LIMIT}`,
          [days], 'chat'
        );
        break;
      }
      case 'response': {
        title = `Inbound conversations · last ${days}d`;
        items = await q(
          `WITH conv AS (
             SELECT ch.wa_number, ch.contact_number,
                    bool_or(ch.direction='incoming') AS has_in,
                    bool_or(ch.direction='outgoing') AS has_out,
                    max(ch.timestamp) AS last_ts
             FROM coexistence.chat_history ch
             WHERE ch.timestamp >= NOW() - ($1 * INTERVAL '1 day') /*SCOPE*/
             GROUP BY 1, 2
           )
           SELECT ${nameExpr('c')} AS primary, conv.contact_number AS secondary,
                  CASE WHEN conv.has_out THEN 'Replied' ELSE 'No reply' END AS meta
           FROM conv
           LEFT JOIN coexistence.contacts c
             ON c.wa_number = conv.wa_number AND c.contact_number = conv.contact_number
           WHERE conv.has_in
           ORDER BY conv.has_out ASC, conv.last_ts DESC LIMIT ${LIMIT}`,
          [days], 'chat'
        );
        break;
      }
      case 'convos': {
        title = `Active conversations · last ${days}d`;
        items = await q(
          `SELECT ${nameExpr('c')} AS primary, ch.contact_number AS secondary,
                  to_char(max(ch.timestamp), 'DD Mon, HH24:MI') AS meta
             FROM coexistence.chat_history ch
             LEFT JOIN coexistence.contacts c
               ON c.wa_number = ch.wa_number AND c.contact_number = ch.contact_number
            WHERE ch.timestamp >= NOW() - ($1 * INTERVAL '1 day') /*SCOPE*/
            GROUP BY ch.wa_number, ch.contact_number, c.name, c.profile_name
            ORDER BY max(ch.timestamp) DESC LIMIT ${LIMIT}`,
          [days], 'chat'
        );
        break;
      }
      case 'automations': {
        title = 'Active automations';
        if (admin && workspaceId) {
          items = (await pool.query(
            `SELECT name AS primary, ('trigger: ' || trigger_type) AS secondary, status AS meta
               FROM coexistence.chatbots
              WHERE status='active' AND workspace_id = $1
              ORDER BY updated_at DESC LIMIT ${LIMIT}`,
            [workspaceId]
          )).rows;
        }
        break;
      }
      default:
        return res.status(400).json({ error: 'Unknown metric' });
    }

    res.json({ metric, title, count: items.length, items });
  } catch (err) {
    console.error('[dashboard/details] error:', err.message);
    res.status(500).json({ error: 'Failed to load details' });
  }
});

module.exports = { router };