require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const pool = require('./db');
const { router: authRouter, authMiddleware, ensureTables } = require('./auth');
const { attachWorkspace } = require('./middleware/workspaceContext');
const { router: messagesRouter } = require('./routes/messages');
const { router: webhookRouter } = require('./routes/webhook');
const { router: categoriesRouter } = require('./routes/categories');
const { router: productsRouter } = require('./routes/products'); // Phase 7.3 — generic Product Catalog
const { router: catalogConnectionsRouter } = require('./routes/catalogConnections'); // Phase 7.4 — Universal Catalog Connection Layer
const { router: metaCatalogRouter } = require('./routes/integrations/metaCatalog'); // Phase 7.5 — Meta Commerce Catalog Integration
const { router: cartsRouter } = require('./routes/carts'); // Phase 7.7 — Cart
const { router: ordersRouter } = require('./routes/orders'); // Phase 7.7 — Cart: Orders
const { router: contactFieldsRouter } = require('./routes/contactFields');
const { router: businessFieldsRouter } = require('./routes/businessFields'); // Phase 8E — Dynamic Business Fields
const { router: contactsRouter } = require('./routes/contacts');
const { router: usersRouter } = require('./routes/users');
const { router: invitationsRouter, publicRouter: invitationsPublicRouter } = require('./routes/invitations');
const { router: workspaceRouter } = require('./routes/workspace');
const { router: uploadsRouter, UPLOAD_DIR } = require('./routes/uploads');
const { router: templatesRouter, syncAllAccountTemplates } = require('./routes/templates');
const { router: broadcastsRouter } = require('./routes/broadcasts');
const { router: targetMessageRouter } = require('./routes/targetMessage');
const { router: campaignsRouter } = require('./routes/campaigns'); // Phase 6
const { router: sequencesRouter } = require('./routes/sequences'); // Phase 7 Part B
const { router: flowsRouter } = require('./routes/flows'); // Phase 6.2 — Flow CRUD + JSON builder/validation
const { router: chatbotsRouter } = require('./routes/chatbots');
const { router: mediaRouter } = require('./routes/media');
const { router: mediaLibraryRouter } = require('./routes/mediaLibrary');
const mediaStorage = require('./util/pgStorage');
const { router: whatsappAccountsRouter } = require('./routes/whatsappAccounts');
const { router: whatsappEmbeddedSignupRouter } = require('./routes/whatsappEmbeddedSignup');
const { router: dashboardRouter } = require('./routes/dashboard');
const { startWorker: startMediaWorker, shutdown: shutdownMediaQueue } = require('./queue/mediaQueue');
const { startSendWorker, shutdownSendQueue } = require('./queue/sendQueue');
const { startBroadcastScheduler } = require('./services/broadcastScheduler');
const { startSequenceScheduler, stopSequenceScheduler } = require('./services/sequenceScheduler'); // Phase 7 Part C
const { router: googleSheetSettingsRouter } = require('./routes/googleSheetSettings');
const { startSheetSyncScheduler, stopSheetSyncScheduler } = require('./services/sheetSyncScheduler');
const { startCatalogSyncScheduler, stopCatalogSyncScheduler } = require('./services/catalogSyncScheduler'); // Phase 7.4
const { ensureInstagramTables } = require('./db/instagramSchema');
const { ensureRetargetTables } = require('./db/retargetSchema');
const { ensureWorkspaceTables } = require('./db/workspaceSchema');
const { ensurePlansTables } = require('./db/plansSchema');
const { ensureInvoicesTable } = require('./db/invoicesSchema');
const { ensurePlanChangeRequestsTable } = require('./db/planChangeRequestsSchema');
const { ensureMessageUsageTable } = require('./db/messageUsageSchema');
const { router: billingRouter, webhookRouter: billingWebhookRouter } = require('./routes/billing');
const { router: invoicesRouter } = require('./routes/invoices');
const { ensureWhatsappAccountsSaasColumns } = require('./db/whatsappAccountsSchema');
const { ensureWorkspaceDefaultsTable } = require('./db/workspaceDefaultsSchema');
const { ensureWorkspaceAiProfileTable } = require('./db/workspaceAiProfileSchema');
const { ensureInstagramWorkspaceColumns } = require('./db/instagramWorkspaceSchema');
const { ensureRetargetWorkspaceColumns, ensureRetargetSheetWorkspaceColumns } = require('./db/retargetWorkspaceSchema');
const { ensureChatbotsWorkspaceColumns } = require('./db/chatbotsWorkspaceSchema');
const { ensureContactsWorkspaceColumns, ensureCategoriesWorkspaceColumns } = require('./db/contactsWorkspaceSchema');
const { ensureContactFieldsWorkspaceColumns } = require('./db/contactFieldsWorkspaceSchema');
const { ensureGoogleSheetWorkspaceColumns } = require('./db/googleSheetWorkspaceSchema');
const { ensureGoogleSheetBaseTables } = require('./db/googleSheetBaseSchema');
const { ensureBroadcastsWorkspaceColumns, ensureBroadcastsSourceColumn } = require('./db/broadcastsWorkspaceSchema');
const { ensureTemplatesWorkspaceColumns } = require('./db/templatesWorkspaceSchema');
const { ensureMediaLibraryWorkspaceColumns } = require('./db/mediaLibraryWorkspaceSchema');
const { ensureConversationReadsTable } = require('./db/conversationReadsSchema');
const { ensurePasswordResetTable } = require('./db/passwordResetSchema');
const { ensureCampaignsTable } = require('./db/campaignsSchema'); // Phase 6
const { ensureSequencesTable } = require('./db/sequencesSchema'); // Phase 7 Part A — schema foundation only
const { ensureZohoTables } = require('./db/zohoSchema'); // Phase 8A — Zoho CRM: schema foundation only
const { ensureZohoSyncStateTable } = require('./db/zohoSyncStateSchema'); // Phase 8H Part 1 — reconciliation foundation
const { startZohoReconciliationScheduler, stopZohoReconciliationScheduler } = require('./services/zohoReconciliationScheduler'); // Phase 8H Part 1
const { ensureBusinessFieldDefinitionColumns } = require('./db/businessFieldDefinitionsSchema'); // Phase 8E — Dynamic Business Fields
const { ensureFlowsTables } = require('./db/flowsSchema'); // Phase 6.1 — WhatsApp Flows: schema foundation only
const { ensureCommerceTables } = require('./db/commerceSchema'); // Phase 7.2 — Commerce: DB schema foundation only
const { ensureCatalogConnectionsTables } = require('./db/catalogConnectionsSchema'); // Phase 7.4
const { ensureMetaCatalogTables } = require('./db/metaCatalogSchema'); // Phase 7.5 — Meta Commerce Catalog Integration
const { router: retargetRouter } = require('./routes/retarget');
const { router: instagramInboxRouter } = require('./routes/instagram/instagramInbox');
const { router: instagramContactsRouter } = require('./routes/instagram/instagramContacts');
const { router: instagramTemplatesRouter } = require('./routes/instagram/instagramTemplates');
const { router: instagramCampaignsRouter } = require('./routes/instagram/instagramCampaigns');
const { router: instagramWorkflowsRouter } = require('./routes/instagram/instagramWorkflows');
const { router: instagramSettingsRouter } = require('./routes/instagram/instagramSettings');
const { router: instagramAnalyticsRouter } = require('./routes/instagram/instagramAnalytics');
const { router: instagramAccountsRouter } = require('./routes/instagram/instagramAccounts');
const { router: instagramOAuthRouter } = require('./routes/instagram/instagramOAuth');
const { router: instagramWebhookRouter } = require('./routes/instagram/instagramWebhook');
const { router: zohoRouter } = require('./routes/integrations/zoho'); // Phase 8B Part 2 — Zoho OAuth + connection routes
const { refreshAllAccounts } = require('./services/instagramTokenService');
const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

const ALLOWED_ORIGINS = [
  process.env.CORS_ORIGIN,
  'http://localhost:5173',
].filter(Boolean);

const CORS_DOMAIN = (process.env.CORS_ORIGIN || '').replace(/^https?:\/\//, '');

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", ...(CORS_DOMAIN ? [`wss://${CORS_DOMAIN}`] : [])],
      mediaSrc: ["'self'", "blob:"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  credentials: true,
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
}));

app.use(cookieParser());
// Capture the raw request body so the webhook route can verify Meta's
// X-Hub-Signature-256 HMAC over the exact bytes Meta signed.
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

// Serve uploaded files statically
app.use('/uploads', express.static(UPLOAD_DIR));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health',
  keyGenerator: (req) => {
    try {
      const token = req.cookies?.akchat_token;
      if (token) {
        const decoded = require('jsonwebtoken').decode(token);
        if (decoded?.username) return `user:${decoded.username}`;
      }
    } catch {}
    return req.ip;
  },
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many requests, please try again later' });
  },
});
app.use(apiLimiter);

// Health check
app.get('/health', (req, res) => res.json({ ok: true }));

// Public routes (webhook from n8n — no auth)
app.use('/api', webhookRouter);
app.use('/api', instagramWebhookRouter);
// Phase 5B — billing-provider webhook. Public (no session), same as the
// Meta webhooks above: authentication is the HMAC signature, not a cookie.
// Mounted here (before authMiddleware) for the same reason webhookRouter is.
app.use('/api', billingWebhookRouter);

// Instagram OAuth (public — this is Instagram redirecting the user's raw
// browser back to us after login/consent; there is no AKChat login cookie
// on this request, so it must never sit behind authMiddleware)
app.use('/api/instagram/oauth', instagramOAuthRouter);

// Zoho CRM integration routes (Phase 8B Part 2). Mounted publicly for the
// same reason instagramOAuthRouter is above: /callback is Zoho redirecting
// the user's raw browser back with no AKChat session cookie attached. The
// other routes in this router (connect/status/disconnect/test) apply
// authMiddleware + attachWorkspace themselves, inline, exactly like
// instagramOAuth.js's /start does.
app.use('/api', zohoRouter);

// Auth routes (public)
app.use('/api', authRouter);
// Phase 4D: invitation acceptance is public too — the invitee has no
// session yet. Scoped strictly by the single-use token inside the route
// itself; never by anything workspace-context-derived.
app.use('/api', invitationsPublicRouter);


// Protected routes
// Attach req.workspace (from the authenticated user's membership) for every
// route below. Never trust a workspace_id supplied by the browser — this is
// the one source of truth customer-facing routes scope WhatsApp account
// access against. See middleware/workspaceContext.js.
app.use('/api', authMiddleware, attachWorkspace);

app.use('/api', authMiddleware, messagesRouter);
app.use('/api', authMiddleware, categoriesRouter);
app.use('/api', authMiddleware, contactFieldsRouter);
app.use('/api', authMiddleware, businessFieldsRouter);
app.use('/api', authMiddleware, contactsRouter);
app.use('/api', authMiddleware, usersRouter);
app.use('/api', authMiddleware, invitationsRouter);
app.use('/api', authMiddleware, workspaceRouter);
app.use('/api', authMiddleware, billingRouter);
// Phase 8C-3 — invoice API routes only, reuses invoiceService.js (8C-2).
app.use('/api', authMiddleware, invoicesRouter);
app.use('/api', authMiddleware, uploadsRouter);
app.use('/api', authMiddleware, templatesRouter);
app.use('/api', authMiddleware, broadcastsRouter);
app.use('/api', authMiddleware, targetMessageRouter);
app.use('/api', authMiddleware, campaignsRouter); // Phase 6
app.use('/api', authMiddleware, sequencesRouter); // Phase 7 Part B
app.use('/api', authMiddleware, flowsRouter); // Phase 6.2 — Flow CRUD + JSON builder/validation
app.use('/api', authMiddleware, googleSheetSettingsRouter);
app.use('/api', authMiddleware, chatbotsRouter);
app.use('/api', authMiddleware, mediaRouter);
app.use('/api', authMiddleware, mediaLibraryRouter);
app.use('/api', authMiddleware, whatsappAccountsRouter);
app.use('/api', authMiddleware, whatsappEmbeddedSignupRouter);
app.use('/api', authMiddleware, dashboardRouter);
app.use('/api', authMiddleware, instagramInboxRouter);
app.use('/api', authMiddleware, instagramContactsRouter);
app.use('/api', authMiddleware, instagramTemplatesRouter);
app.use('/api', authMiddleware, instagramCampaignsRouter);
app.use('/api', authMiddleware, instagramWorkflowsRouter);
app.use('/api', authMiddleware, instagramSettingsRouter);
app.use('/api', authMiddleware, instagramAnalyticsRouter);
app.use('/api', authMiddleware, instagramAccountsRouter);
app.use('/api', authMiddleware, retargetRouter);
app.use('/api', authMiddleware, productsRouter); // Phase 7.3 — generic Product Catalog
app.use('/api', authMiddleware, attachWorkspace, catalogConnectionsRouter); // Phase 7.4 — Universal Catalog Connection Layer
app.use('/api', authMiddleware, attachWorkspace, metaCatalogRouter); // Phase 7.5 — Meta Commerce Catalog Integration
app.use('/api', authMiddleware, attachWorkspace, cartsRouter); // Phase 7.7 — Cart
app.use('/api', authMiddleware, attachWorkspace, ordersRouter); // Phase 7.7 — Cart: Orders


// Error handler
app.use((err, req, res, next) => {
  // Full error (with stack) in dev for debugging; message-only in production.
  if (process.env.NODE_ENV !== 'production') console.error('[Error]', err);
  else console.error('[Error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server

async function start() {
  console.log("STEP 1");
await ensureTables();
// Must run after ensureTables() — workspace_members.user_id FKs
// coexistence.akchat_users(id), and the backfill step reads existing users.
await ensureWorkspaceTables();
// Phase 5B — plans/entitlements/billing. Must run after ensureWorkspaceTables()
// (grandfathers every pre-existing workspace onto the legacy_unlimited plan;
// coexistence.workspaces must already exist and be populated).
await ensurePlansTables();
// Phase 5C — manual billing plan-change request history. Must run after
// ensurePlansTables() (FKs coexistence.plans) and ensureWorkspaceTables()
// (FKs coexistence.workspaces / akchat_users).
await ensurePlanChangeRequestsTable();
// Phase 8C-1 — invoice database foundation only (no generation, no payment
// integration). Must run after ensureWorkspaceTables() (FKs
// coexistence.workspaces). Independent of plans/workspace_billing — placed
// alongside the other billing-adjacent boot steps.
await ensureInvoicesTable();
// Phase 8A — message usage metering (counter only, no enforcement). Must
// run after ensureWorkspaceTables() (FKs coexistence.workspaces); does not
// depend on plans/plan_change_requests, just placed alongside the other
// billing-adjacent boot steps.
await ensureMessageUsageTable();
// Must run after ensureWorkspaceTables() — backfills workspace_id onto
// whatsapp_accounts using the default workspace it just seeded.
await ensureWhatsappAccountsSaasColumns();
// Phase 8A — Zoho CRM integration: schema foundation only (no OAuth routes,
// no Zoho API calls, no lead sync, no AI extraction, no frontend UI yet).
// Must run after ensureWorkspaceTables() (FKs coexistence.workspaces) AND
// ensureWhatsappAccountsSaasColumns() (FKs coexistence.whatsapp_accounts,
// which must already exist with its workspace_id column populated).
await ensureZohoTables();
// Phase 8H Part 1 — Zoho reconciliation foundation: persistent sync-state
// + bounded-retry table. Must run after ensureZohoTables() (FKs
// coexistence.zoho_connections) and after ensureWorkspaceTables()/
// ensureWhatsappAccountsSaasColumns() (FKs coexistence.workspaces /
// coexistence.whatsapp_accounts), same as ensureZohoTables() itself.
await ensureZohoSyncStateTable();
await ensureBusinessFieldDefinitionColumns();
// Phase 4H — Workspace-Level Defaults. Only depends on ensureWorkspaceTables()
// (needs coexistence.workspaces to exist and be populated to backfill onto);
// independent of whatsapp_accounts/instagram/retarget, so it can run here.
await ensureWorkspaceDefaultsTable();
await ensureWorkspaceAiProfileTable();
await ensureInstagramTables();
await ensureRetargetTables();
// Must run after ensureWorkspaceTables() (default workspace must exist to
// backfill onto) and after their respective ensure*Tables() (the tables
// they ALTER must already exist).
await ensureInstagramWorkspaceColumns();
await ensureRetargetWorkspaceColumns();
// Must run after ensureRetargetWorkspaceColumns() only in the sense that
// both need ensureRetargetTables() + ensureWorkspaceTables() first; order
// between the two Retarget calls themselves doesn't matter (different
// tables, independent backfills).
await ensureRetargetSheetWorkspaceColumns();
await ensureChatbotsWorkspaceColumns();
// Must run after ensureWorkspaceTables() (default workspace) AND after
// ensureWhatsappAccountsSaasColumns() (contacts backfill joins against
// whatsapp_accounts.workspace_id — see contactsWorkspaceSchema.js).
await ensureContactsWorkspaceColumns();
await ensureCategoriesWorkspaceColumns();
// Phase 6 Gap #1: contact_field_definitions.workspace_id column, same
// additive-migration convention as categories above (no per-row workspace
// signal to derive from, so it backfills straight to the default
// workspace). Must also run after ensureWorkspaceTables() (default
// workspace to backfill onto).
await ensureContactFieldsWorkspaceColumns();
// Phase 3E: google_sheet_settings / contact_sync_log workspace_id column,
// same additive-migration convention as the calls above. Must also run
// after ensureWorkspaceTables() (default workspace to backfill onto).
await ensureGoogleSheetBaseTables();
await ensureGoogleSheetWorkspaceColumns();
// Phase 3F-1B: broadcasts.workspace_id column, same additive-migration
// convention as the calls above. Must also run after ensureWorkspaceTables()
// (default workspace to backfill onto).
await ensureBroadcastsWorkspaceColumns();
// Phase 6 Part 3A: broadcasts.source column — Campaign Studio's Send Now
// (routes/campaigns.js) inserts 'campaign' into this column so
// campaign-originated broadcasts are distinguishable from ones created
// directly in Broadcast Studio. Only needs coexistence.broadcasts to
// exist, same as ensureBroadcastsWorkspaceColumns() above, so it runs
// right alongside it.
await ensureBroadcastsSourceColumn();
// Phase 3F-1C: message_templates.workspace_id column, same additive-migration
// convention as the calls above. Must run after ensureWorkspaceTables()
// (default workspace to backfill onto) and after
// ensureWhatsappAccountsSaasColumns() (inherits workspace_id from the linked
// WhatsApp account where possible before falling back to the default).
await ensureTemplatesWorkspaceColumns();
// Must run after ensureWorkspaceTables() (default workspace) AND after
// ensureWhatsappAccountsSaasColumns() (whatsapp_accounts.workspace_id must
// already be backfilled — media_library is backfilled BY JOINING to it).
await ensureMediaLibraryWorkspaceColumns();
// Unrelated to Workspace Phase (conversation_reads has no workspace_id) —
// fixes a pre-existing gap where this table was never created by any
// ensure*Tables() step, so it was missing the unique index that
// POST /messages/mark-read's ON CONFLICT (wa_number, contact_number) target
// requires. Safe to run on every boot: idempotent, only dedupes exact
// duplicate read-stamps for the same conversation. See conversationReadsSchema.js.
await ensureConversationReadsTable();
// Phase 5A — password_reset_tokens depends only on akchat_users (via
// ensureTables() above), no workspace dependency.
await ensurePasswordResetTable();
// Phase 6 — Campaign Studio. Must run after ensureWorkspaceTables() (FKs
// coexistence.workspaces / akchat_users), ensureTemplatesWorkspaceColumns()
// (FKs coexistence.message_templates), ensureMediaLibraryWorkspaceColumns()
// (FKs coexistence.media_library), and ensureBroadcastsWorkspaceColumns()
// (FKs coexistence.broadcasts, via the Part-2 execution-linkage column).
await ensureCampaignsTable();
// Phase 7 Part A — Sequence / Drip Automation schema foundation only (no
// CRUD/enrollment/scheduler/UI yet). Must run after ensureWorkspaceTables()
// (FKs coexistence.workspaces / akchat_users) and
// ensureTemplatesWorkspaceColumns() (FKs coexistence.message_templates via
// sequence_steps.template_id) — both already satisfied by this point in
// boot, same as ensureCampaignsTable() above.
await ensureSequencesTable();
// Phase 6.1 — WhatsApp Flows schema foundation only (no Flow UI, no Meta
// API integration, no Flow sending, no webhook.js changes yet). Must run
// after ensureWorkspaceTables() (FKs coexistence.workspaces),
// ensureWhatsappAccountsSaasColumns() (FKs coexistence.whatsapp_accounts),
// and ensureTables() (FKs coexistence.akchat_users via created_by) — all
// already satisfied by this point in boot.
await ensureFlowsTables();
// Phase 7.2 — Commerce DB foundation only (no Shopify sync, no Meta
// Catalog sync, no cart/order routes, no checkout flow, no frontend UI
// yet). Must run after ensureWorkspaceTables() (FKs coexistence.workspaces)
// and ensureWhatsappAccountsSaasColumns() (FKs coexistence.whatsapp_accounts)
// — both already satisfied by this point in boot.
await ensureCommerceTables();
await ensureCatalogConnectionsTables(); // Phase 7.4
await ensureMetaCatalogTables(); // Phase 7.5 — Meta Commerce Catalog Integration
console.log("STEP 2");

await mediaStorage.ensureBucket().catch(err => {
    console.error("MEDIA ERROR:", err);
});
console.log("STEP 3");

startMediaWorker();
console.log("STEP 4");

startSendWorker();
console.log("STEP 5");

startBroadcastScheduler();
console.log("STEP 6");

startSequenceScheduler(); // Phase 7 Part C
console.log("STEP 6B");

startSheetSyncScheduler();
startCatalogSyncScheduler(); // Phase 7.4
console.log("STEP 7");
// Phase 8H Part 1 — Zoho reconciliation scheduler: retries conversations
// left in a durable pending/lead_synced/note_pending state by
// zohoSyncService (see zohoSyncStateSchema.js / zohoReconciliationService.js).
startZohoReconciliationScheduler();
console.log("STEP 7B");

setInterval(() => {
    refreshAllAccounts()
        .catch(e => console.error('[ig token cron]', e.message));
}, 24 * 60 * 60 * 1000);
refreshAllAccounts()
    .catch(e => console.error('[ig token cron]', e.message));

  // Stale-pause sweeper: mark paused automation executions that have outlived
  // their expires_at as error. Resume already inline-checks expires_at, so
  // this is purely hygiene against forever-paused rows accumulating.
  setInterval(async () => {
    try {
      const { rowCount } = await pool.query(
        `UPDATE coexistence.automation_executions
            SET status='error',
                error_message='Paused execution expired (no reply within timeout)',
                completed_at=NOW()
          WHERE status='paused' AND expires_at < NOW()`
      );
      if (rowCount > 0) console.log(`[sweeper] expired ${rowCount} paused execution(s)`);

      // Reap orphaned 'running' executions: the engine runs synchronously and
      // finishes in ms, so anything 'running' for >15m means the process died
      // mid-walk (e.g. a restart) and the status was never updated to error.
      const { rowCount: orphans } = await pool.query(
        `UPDATE coexistence.automation_executions
            SET status='error',
                error_message='Execution interrupted (no completion within 15 minutes)',
                completed_at=NOW()
          WHERE status='running' AND started_at < NOW() - INTERVAL '15 minutes'`
      );
      if (orphans > 0) console.log(`[sweeper] reaped ${orphans} orphaned running execution(s)`);
    } catch (err) {
      console.error('[sweeper] error:', err.message);
    }
  }, 30 * 60 * 1000).unref();
  // Template status auto-sync: Meta does NOT push template approval/rejection
  // status — we must poll. The tick fires every 10 min but only calls Meta while
  // at least one template is still awaiting review (status='SUBMITTED'). Once all
  // are resolved (approved/rejected/etc.) it idles with zero Meta calls, and
  // auto-resumes when a new template is submitted. Override interval with
  // TEMPLATE_SYNC_INTERVAL_MS.
  const TEMPLATE_SYNC_MS = parseInt(process.env.TEMPLATE_SYNC_INTERVAL_MS || '', 10) || 10 * 60 * 1000;
  const runTemplateSync = async () => {
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS pending FROM coexistence.message_templates WHERE status = 'SUBMITTED'`
      );
      const pending = rows[0]?.pending || 0;
      if (pending === 0) return; // all resolved → skip Meta entirely (idle)
      const r = await syncAllAccountTemplates();
      if (r.totalUpdated > 0) {
        console.log(`[template-sync] ${pending} pending → updated ${r.totalUpdated} template(s)`);
      }
    } catch (err) {
      console.error('[template-sync] error:', err.message);
    }
  };
  setTimeout(runTemplateSync, 60 * 1000).unref();        // initial catch-up ~1 min after startup
  setInterval(runTemplateSync, TEMPLATE_SYNC_MS).unref(); // every 10 min (gated by pending count)

  const server = app.listen(PORT, () => {
    console.log(`[AKchat] Backend running on port ${PORT}`);
  });
  // Graceful shutdown so BullMQ marks in-flight jobs as stalled (not lost)
  const shutdown = async (sig) => {
    console.log(`[AKchat] ${sig} received, draining…`);
    server.close(() => {});
    await shutdownMediaQueue();
    await shutdownSendQueue();
    stopSheetSyncScheduler();
    stopCatalogSyncScheduler(); // Phase 7.4
    stopSequenceScheduler(); // Phase 7 Part C
    stopZohoReconciliationScheduler(); // Phase 8H Part 1
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}
start().catch(err => {
  console.error('[Fatal] Failed to start:', err.message);
  process.exit(1);
});