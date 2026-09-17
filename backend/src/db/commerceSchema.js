// Phase 7.2 — Commerce: DATABASE FOUNDATION ONLY.
//
// This file creates twelve new, additive tables under the `coexistence`
// schema. No Shopify sync logic, no Meta Catalog sync logic, no cart/order
// routes, no checkout flow, and no frontend UI exist yet — that is
// explicitly out of scope for 7.2. This mirrors the flowsSchema.js /
// zohoSchema.js convention: idempotent `CREATE TABLE IF NOT EXISTS` +
// `CREATE INDEX IF NOT EXISTS`, plain-TEXT + CHECK-constraint enums (not
// Postgres ENUM types) so future values can be added with a constraint
// migration, not a type migration, and local `updated_at` touch-triggers
// on every table that can be updated after creation.
//
// ── relationship this schema is built around ───────────────────────────
//   coexistence.workspaces          (existing, workspaceSchema.js)
//         │
//   coexistence.whatsapp_accounts   (existing table; workspace_id added by
//         │                          whatsappAccountsSchema.js)
//         ▼
//   coexistence.products ───────┬── coexistence.product_variants
//         │                     │
//         │                     └── coexistence.product_collections ── coexistence.collections
//         │
//         ├── coexistence.inventory_levels
//         │
//         ├── coexistence.cart_items ── coexistence.carts
//         │
//         └── coexistence.order_items ── coexistence.orders
//
//   coexistence.shopify_connections ── coexistence.shopify_sync_state
//   coexistence.meta_catalog_connections
//
// Nothing here touches Shopify integration code, Meta Catalog code,
// WhatsApp code, Zoho code, Campaign Studio, Automation Builder, CRM,
// Contacts, Authentication, Permissions, or any Phase 0–6/7.1 table. This
// is a pure additive schema change.
//
// contact_number (not a contact_id FK) is used for carts/orders to match
// the existing identity convention already used throughout this codebase
// for contact-scoped rows (see zohoSchema.js's zoho_lead_links /
// contactsWorkspaceSchema.js) — there is no numeric coexistence.contacts
// primary key this schema could safely FK against.
//
// Token/secret handling: shopify_connections.access_token_encrypted stores
// ciphertext produced by util/crypto.js's encrypt() (AES-256-GCM, the same
// helper already used for WhatsApp and Zoho tokens) — never plaintext,
// never logged, never sent to the frontend. 7.2 only reserves this column;
// no Shopify OAuth/App-install flow writes it yet.
//
// Must run after:
//   - ensureWorkspaceTables()             (FKs coexistence.workspaces)
//   - ensureWhatsappAccountsSaasColumns() (FKs coexistence.whatsapp_accounts)
// See index.js boot order.

const pool = require('../db');

const PRODUCT_STATUSES = ['draft', 'active', 'archived'];
// Phase 7.3 — widened from the original 7.2 list (['manual','shopify','meta'])
// to cover every catalog source the generic Product Catalog UI must support
// for ANY tenant per the Phase 7.3 spec: manual entry, Shopify, a customer
// website/API/feed, a Google Sheet, a CSV upload, Meta Catalog, or an
// unspecified future connector ('other'). This is an additive enum widening
// on a table this schema file itself owns (coexistence.products /
// coexistence.inventory_levels both reference PRODUCT_SOURCES) — no table is
// redesigned, no existing row's source value stops being valid, and no
// column is renamed or dropped. See ensureProductSourceConstraintWidened()
// below for the idempotent ALTER that applies this to an already-deployed
// 7.2 database.
const PRODUCT_SOURCES = ['manual', 'shopify', 'meta', 'website', 'google_sheet', 'csv', 'other'];
const LEGACY_PRODUCT_SOURCES = ['manual', 'shopify', 'meta'];

const CART_STATUSES = ['active', 'abandoned', 'converted', 'cancelled'];

const ORDER_PAYMENT_STATUSES = ['pending', 'paid', 'partially_paid', 'refunded', 'failed'];
const ORDER_FULFILLMENT_STATUSES = ['unfulfilled', 'partially_fulfilled', 'fulfilled', 'cancelled'];
const ORDER_STATUSES = ['open', 'closed', 'cancelled'];
const ORDER_SOURCES = ['manual', 'whatsapp', 'shopify'];

const SHOPIFY_CONNECTION_STATUSES = ['disconnected', 'connected', 'error', 'reauth_required'];

const SHOPIFY_SYNC_RESOURCE_TYPES = ['products', 'collections', 'inventory', 'orders'];
const SHOPIFY_SYNC_STATUSES = ['idle', 'syncing', 'error'];

const META_CATALOG_CONNECTION_STATUSES = ['disconnected', 'connected', 'error'];

function touchTriggerName(table) {
  return `trg_${table}_touch_updated_at`;
}

function touchFunctionName(table) {
  return `coexistence.${table}_touch_updated_at`;
}

async function ensureTouchTrigger(table) {
  await pool.query(`
    CREATE OR REPLACE FUNCTION ${touchFunctionName(table)}()
    RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    DROP TRIGGER IF EXISTS ${touchTriggerName(table)} ON coexistence.${table}
  `);
  await pool.query(`
    CREATE TRIGGER ${touchTriggerName(table)}
      BEFORE UPDATE ON coexistence.${table}
      FOR EACH ROW EXECUTE FUNCTION ${touchFunctionName(table)}()
  `);
}

async function ensureCommerceTables() {
  // ── 1. coexistence.products ─────────────────────────────────────────────
  // shopify_product_id / meta_product_id are UNIQUE per workspace so a
  // future sync job can use INSERT ... ON CONFLICT to stay idempotent
  // without a separate SELECT-then-INSERT race.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.products (
      id                    BIGSERIAL PRIMARY KEY,
      workspace_id          BIGINT NOT NULL
        REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,
      whatsapp_account_id   BIGINT
        REFERENCES coexistence.whatsapp_accounts(id) ON DELETE SET NULL,

      name                  TEXT NOT NULL,
      description           TEXT,
      product_id            TEXT,
      retailer_id           TEXT,
      sku                   TEXT,
      price                 NUMERIC(12,2),
      currency              TEXT,
      status                TEXT NOT NULL DEFAULT 'draft',
      product_url           TEXT,
      image_url             TEXT,
      source                TEXT NOT NULL DEFAULT 'manual',

      shopify_product_id    TEXT,
      meta_product_id       TEXT,

      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT products_status_check
        CHECK (status IN (${PRODUCT_STATUSES.map((s) => `'${s}'`).join(', ')})),
      CONSTRAINT products_source_check
        CHECK (source IN (${PRODUCT_SOURCES.map((s) => `'${s}'`).join(', ')})),

      -- Idempotency for Shopify/Meta sync (INSERT ... ON CONFLICT target).
      CONSTRAINT uq_products_workspace_shopify_product
        UNIQUE (workspace_id, shopify_product_id),
      CONSTRAINT uq_products_workspace_meta_product
        UNIQUE (workspace_id, meta_product_id)
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_workspace_id ON coexistence.products (workspace_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_workspace_whatsapp_account ON coexistence.products (workspace_id, whatsapp_account_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_sku ON coexistence.products (sku)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_status ON coexistence.products (workspace_id, status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_shopify_product_id ON coexistence.products (shopify_product_id) WHERE shopify_product_id IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_meta_product_id ON coexistence.products (meta_product_id) WHERE meta_product_id IS NOT NULL`);

  await ensureTouchTrigger('products');

  // ── 2. coexistence.product_variants ─────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.product_variants (
      id                    BIGSERIAL PRIMARY KEY,
      product_id            BIGINT NOT NULL
        REFERENCES coexistence.products(id) ON DELETE CASCADE,

      variant_id            TEXT,
      title                 TEXT,
      sku                   TEXT,
      price                 NUMERIC(12,2),
      inventory_quantity    INTEGER NOT NULL DEFAULT 0,

      shopify_variant_id    TEXT,
      meta_variant_id       TEXT,

      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT uq_product_variants_product_shopify_variant
        UNIQUE (product_id, shopify_variant_id)
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_product_variants_product_id ON coexistence.product_variants (product_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_product_variants_sku ON coexistence.product_variants (sku)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_product_variants_shopify_variant_id ON coexistence.product_variants (shopify_variant_id) WHERE shopify_variant_id IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_product_variants_meta_variant_id ON coexistence.product_variants (meta_variant_id) WHERE meta_variant_id IS NOT NULL`);

  await ensureTouchTrigger('product_variants');

  // ── 3. coexistence.collections ──────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.collections (
      id                      BIGSERIAL PRIMARY KEY,
      workspace_id            BIGINT NOT NULL
        REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,

      name                    TEXT NOT NULL,
      description             TEXT,
      shopify_collection_id   TEXT,
      meta_collection_id      TEXT,

      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT uq_collections_workspace_shopify_collection
        UNIQUE (workspace_id, shopify_collection_id)
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_collections_workspace_id ON coexistence.collections (workspace_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_collections_shopify_collection_id ON coexistence.collections (shopify_collection_id) WHERE shopify_collection_id IS NOT NULL`);

  await ensureTouchTrigger('collections');

  // ── 4. coexistence.product_collections ──────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.product_collections (
      id              BIGSERIAL PRIMARY KEY,
      product_id      BIGINT NOT NULL
        REFERENCES coexistence.products(id) ON DELETE CASCADE,
      collection_id   BIGINT NOT NULL
        REFERENCES coexistence.collections(id) ON DELETE CASCADE,

      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT uq_product_collections_product_collection
        UNIQUE (product_id, collection_id)
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_product_collections_product_id ON coexistence.product_collections (product_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_product_collections_collection_id ON coexistence.product_collections (collection_id)`);

  // ── 5. coexistence.inventory_levels ─────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.inventory_levels (
      id                      BIGSERIAL PRIMARY KEY,
      workspace_id            BIGINT NOT NULL
        REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,
      product_id              BIGINT NOT NULL
        REFERENCES coexistence.products(id) ON DELETE CASCADE,
      variant_id               BIGINT
        REFERENCES coexistence.product_variants(id) ON DELETE CASCADE,

      available_quantity      INTEGER NOT NULL DEFAULT 0,
      reserved_quantity       INTEGER NOT NULL DEFAULT 0,
      source                  TEXT NOT NULL DEFAULT 'manual',
      external_inventory_id   TEXT,

      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT inventory_levels_source_check
        CHECK (source IN (${PRODUCT_SOURCES.map((s) => `'${s}'`).join(', ')})),

      -- One inventory row per (product, variant) pair — variant_id is NULL
      -- for products without variants, so a partial unique index is used
      -- (a plain table-level UNIQUE treats each NULL as distinct, which
      -- Postgres already does, so a single row per variant-less product is
      -- naturally enforced too via the NULLS NOT DISTINCT-style workaround
      -- below).
      CONSTRAINT uq_inventory_levels_product_variant
        UNIQUE (product_id, variant_id)
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_inventory_levels_workspace_id ON coexistence.inventory_levels (workspace_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_inventory_levels_product_id ON coexistence.inventory_levels (product_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_inventory_levels_variant_id ON coexistence.inventory_levels (variant_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_inventory_levels_external_inventory_id ON coexistence.inventory_levels (external_inventory_id) WHERE external_inventory_id IS NOT NULL`);

  await ensureTouchTrigger('inventory_levels');

  // ── 6. coexistence.carts ────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.carts (
      id                    BIGSERIAL PRIMARY KEY,
      workspace_id          BIGINT NOT NULL
        REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,
      whatsapp_account_id   BIGINT
        REFERENCES coexistence.whatsapp_accounts(id) ON DELETE SET NULL,
      contact_number        TEXT NOT NULL,

      status                TEXT NOT NULL DEFAULT 'active',
      currency              TEXT,
      total_amount          NUMERIC(12,2) NOT NULL DEFAULT 0,

      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT carts_status_check
        CHECK (status IN (${CART_STATUSES.map((s) => `'${s}'`).join(', ')}))
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_carts_workspace_id ON coexistence.carts (workspace_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_carts_workspace_whatsapp_account ON coexistence.carts (workspace_id, whatsapp_account_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_carts_contact_number ON coexistence.carts (contact_number)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_carts_status ON coexistence.carts (workspace_id, status)`);

  await ensureTouchTrigger('carts');

  // ── 7. coexistence.cart_items ───────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.cart_items (
      id            BIGSERIAL PRIMARY KEY,
      cart_id       BIGINT NOT NULL
        REFERENCES coexistence.carts(id) ON DELETE CASCADE,
      product_id    BIGINT
        REFERENCES coexistence.products(id) ON DELETE SET NULL,
      variant_id    BIGINT
        REFERENCES coexistence.product_variants(id) ON DELETE SET NULL,

      quantity      INTEGER NOT NULL DEFAULT 1,
      unit_price    NUMERIC(12,2) NOT NULL DEFAULT 0,

      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT uq_cart_items_cart_product_variant
        UNIQUE (cart_id, product_id, variant_id)
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cart_items_cart_id ON coexistence.cart_items (cart_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cart_items_product_id ON coexistence.cart_items (product_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cart_items_variant_id ON coexistence.cart_items (variant_id)`);

  await ensureTouchTrigger('cart_items');

  // ── 8. coexistence.orders ───────────────────────────────────────────────
  // external_order_id is UNIQUE per workspace — the idempotency key for
  // Shopify order-webhook ingestion (INSERT ... ON CONFLICT target).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.orders (
      id                      BIGSERIAL PRIMARY KEY,
      workspace_id            BIGINT NOT NULL
        REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,
      whatsapp_account_id     BIGINT
        REFERENCES coexistence.whatsapp_accounts(id) ON DELETE SET NULL,
      contact_number          TEXT NOT NULL,
      cart_id                 BIGINT
        REFERENCES coexistence.carts(id) ON DELETE SET NULL,

      external_order_id       TEXT,
      order_number            TEXT,
      currency                TEXT,
      subtotal                NUMERIC(12,2) NOT NULL DEFAULT 0,
      total_amount            NUMERIC(12,2) NOT NULL DEFAULT 0,

      payment_status          TEXT NOT NULL DEFAULT 'pending',
      fulfillment_status      TEXT NOT NULL DEFAULT 'unfulfilled',
      order_status            TEXT NOT NULL DEFAULT 'open',

      shipping_name           TEXT,
      shipping_address        TEXT,
      shipping_city           TEXT,
      shipping_state          TEXT,
      shipping_postal_code    TEXT,
      shipping_country        TEXT,
      shipping_phone          TEXT,

      source                  TEXT NOT NULL DEFAULT 'manual',
      shopify_order_id        TEXT,

      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT orders_payment_status_check
        CHECK (payment_status IN (${ORDER_PAYMENT_STATUSES.map((s) => `'${s}'`).join(', ')})),
      CONSTRAINT orders_fulfillment_status_check
        CHECK (fulfillment_status IN (${ORDER_FULFILLMENT_STATUSES.map((s) => `'${s}'`).join(', ')})),
      CONSTRAINT orders_order_status_check
        CHECK (order_status IN (${ORDER_STATUSES.map((s) => `'${s}'`).join(', ')})),
      CONSTRAINT orders_source_check
        CHECK (source IN (${ORDER_SOURCES.map((s) => `'${s}'`).join(', ')})),

      CONSTRAINT uq_orders_workspace_external_order
        UNIQUE (workspace_id, external_order_id),
      CONSTRAINT uq_orders_workspace_shopify_order
        UNIQUE (workspace_id, shopify_order_id)
    )
  `);

  // Phase 7.10A — FIX 3: idempotency key for WhatsApp-native order ingestion
  // (routes/webhook.js -> orderService.createOrderFromWhatsappMessage()).
  // Meta can redeliver the same inbound 'order' message (its own retries,
  // or n8n forwarding jitter) with the same message_id — nullable so
  // manual/Shopify orders (which have no inbound WhatsApp message) are
  // unaffected, and a *partial* unique index (not a table-wide UNIQUE
  // column, and not global across tenants) so it only enforces
  // one-order-per-message within a single workspace, matching the
  // (workspace_id, wa_message_id) scoping every other lookup in this file
  // uses.
  await pool.query(`ALTER TABLE coexistence.orders ADD COLUMN IF NOT EXISTS wa_message_id TEXT`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_workspace_wa_message_id
      ON coexistence.orders (workspace_id, wa_message_id)
      WHERE wa_message_id IS NOT NULL
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_workspace_id ON coexistence.orders (workspace_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_workspace_whatsapp_account ON coexistence.orders (workspace_id, whatsapp_account_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_contact_number ON coexistence.orders (contact_number)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_order_number ON coexistence.orders (order_number)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_external_order_id ON coexistence.orders (external_order_id) WHERE external_order_id IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_shopify_order_id ON coexistence.orders (shopify_order_id) WHERE shopify_order_id IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_status ON coexistence.orders (workspace_id, order_status)`);

  await ensureTouchTrigger('orders');

  // ── 9. coexistence.order_items ──────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.order_items (
      id               BIGSERIAL PRIMARY KEY,
      order_id         BIGINT NOT NULL
        REFERENCES coexistence.orders(id) ON DELETE CASCADE,
      product_id       BIGINT
        REFERENCES coexistence.products(id) ON DELETE SET NULL,
      variant_id       BIGINT
        REFERENCES coexistence.product_variants(id) ON DELETE SET NULL,

      -- Snapshots: an order line must keep showing what the customer
      -- actually bought even if the product/variant is later renamed,
      -- re-SKU'd, or deleted (product_id/variant_id go NULL on delete).
      product_name     TEXT NOT NULL,
      sku               TEXT,

      quantity         INTEGER NOT NULL DEFAULT 1,
      unit_price       NUMERIC(12,2) NOT NULL DEFAULT 0,
      total_price      NUMERIC(12,2) NOT NULL DEFAULT 0,

      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON coexistence.order_items (order_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON coexistence.order_items (product_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_items_variant_id ON coexistence.order_items (variant_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_items_sku ON coexistence.order_items (sku)`);

  await ensureTouchTrigger('order_items');

  // ── 10. coexistence.shopify_connections ─────────────────────────────────
  // access_token_encrypted stores AES-256-GCM ciphertext via
  // util/crypto.js's encrypt() — never plaintext at rest, never logged,
  // never serialized to the frontend. Same convention as
  // zoho_connections.access_token_encrypted.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.shopify_connections (
      id                        BIGSERIAL PRIMARY KEY,
      workspace_id              BIGINT NOT NULL
        REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,

      shop_domain               TEXT NOT NULL,
      shopify_shop_id           TEXT,

      access_token_encrypted    TEXT,
      scopes                    TEXT,

      status                    TEXT NOT NULL DEFAULT 'disconnected',
      connected_at              TIMESTAMPTZ,
      last_success_at           TIMESTAMPTZ,
      last_error                TEXT,
      last_error_at             TIMESTAMPTZ,

      created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT shopify_connections_status_check
        CHECK (status IN (${SHOPIFY_CONNECTION_STATUSES.map((s) => `'${s}'`).join(', ')})),

      CONSTRAINT uq_shopify_connections_workspace_shop_domain
        UNIQUE (workspace_id, shop_domain)
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_shopify_connections_workspace_id ON coexistence.shopify_connections (workspace_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_shopify_connections_shop_domain ON coexistence.shopify_connections (shop_domain)`);

  await ensureTouchTrigger('shopify_connections');

  // ── 11. coexistence.shopify_sync_state ──────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.shopify_sync_state (
      id               BIGSERIAL PRIMARY KEY,
      workspace_id     BIGINT NOT NULL
        REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,
      connection_id    BIGINT NOT NULL
        REFERENCES coexistence.shopify_connections(id) ON DELETE CASCADE,

      resource_type    TEXT NOT NULL,
      cursor           TEXT,
      last_synced_at   TIMESTAMPTZ,
      status           TEXT NOT NULL DEFAULT 'idle',
      last_error       TEXT,

      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT shopify_sync_state_resource_type_check
        CHECK (resource_type IN (${SHOPIFY_SYNC_RESOURCE_TYPES.map((s) => `'${s}'`).join(', ')})),
      CONSTRAINT shopify_sync_state_status_check
        CHECK (status IN (${SHOPIFY_SYNC_STATUSES.map((s) => `'${s}'`).join(', ')})),

      CONSTRAINT uq_shopify_sync_state_connection_resource
        UNIQUE (connection_id, resource_type)
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_shopify_sync_state_workspace_id ON coexistence.shopify_sync_state (workspace_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_shopify_sync_state_connection_id ON coexistence.shopify_sync_state (connection_id)`);

  await ensureTouchTrigger('shopify_sync_state');

  // ── 12. coexistence.meta_catalog_connections ────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.meta_catalog_connections (
      id                    BIGSERIAL PRIMARY KEY,
      workspace_id          BIGINT NOT NULL
        REFERENCES coexistence.workspaces(id) ON DELETE CASCADE,
      whatsapp_account_id   BIGINT
        REFERENCES coexistence.whatsapp_accounts(id) ON DELETE SET NULL,

      catalog_id            TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'disconnected',

      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT meta_catalog_connections_status_check
        CHECK (status IN (${META_CATALOG_CONNECTION_STATUSES.map((s) => `'${s}'`).join(', ')})),

      CONSTRAINT uq_meta_catalog_connections_workspace_account_catalog
        UNIQUE (workspace_id, whatsapp_account_id, catalog_id)
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_meta_catalog_connections_workspace_id ON coexistence.meta_catalog_connections (workspace_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_meta_catalog_connections_whatsapp_account_id ON coexistence.meta_catalog_connections (whatsapp_account_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_meta_catalog_connections_catalog_id ON coexistence.meta_catalog_connections (catalog_id)`);

  await ensureTouchTrigger('meta_catalog_connections');

  // ── Phase 7.3 additive changes (still this schema's own tables) ────────
  await ensureProductSourceConstraintWidened();
  await ensureCollectionsArchivedColumn();
}

// Widens products_source_check / inventory_levels_source_check on an
// already-deployed 7.2 database from LEGACY_PRODUCT_SOURCES to the full
// PRODUCT_SOURCES list. DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT is
// idempotent (safe to run on every boot) and only ever widens the allowed
// set — it never removes a value, so no existing row can be invalidated.
// Both coexistence.products and coexistence.inventory_levels are tables
// this schema file owns (see EXPECTED_TABLES in commerceSchema.test.js),
// so this ALTER is consistent with "never ALTER a pre-existing table this
// schema doesn't own."
async function ensureProductSourceConstraintWidened() {
  await pool.query(`ALTER TABLE coexistence.products DROP CONSTRAINT IF EXISTS products_source_check`);
  await pool.query(`
    ALTER TABLE coexistence.products ADD CONSTRAINT products_source_check
      CHECK (source IN (${PRODUCT_SOURCES.map((s) => `'${s}'`).join(', ')}))
  `);
  await pool.query(`ALTER TABLE coexistence.inventory_levels DROP CONSTRAINT IF EXISTS inventory_levels_source_check`);
  await pool.query(`
    ALTER TABLE coexistence.inventory_levels ADD CONSTRAINT inventory_levels_source_check
      CHECK (source IN (${PRODUCT_SOURCES.map((s) => `'${s}'`).join(', ')}))
  `);
}

// Adds a nullable archived_at TIMESTAMPTZ to coexistence.collections so
// "archive collection" (required by the Phase 7.3 spec) has somewhere to
// live without redesigning the 7.2 table or removing any column. NULL =
// active (the default/existing behaviour for every pre-existing row);
// non-NULL = archived. ADD COLUMN IF NOT EXISTS is idempotent.
async function ensureCollectionsArchivedColumn() {
  await pool.query(`ALTER TABLE coexistence.collections ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_collections_archived_at ON coexistence.collections (workspace_id, archived_at)`);
}

module.exports = {
  ensureCommerceTables,
  ensureProductSourceConstraintWidened,
  ensureCollectionsArchivedColumn,
  PRODUCT_STATUSES,
  PRODUCT_SOURCES,
  LEGACY_PRODUCT_SOURCES,
  CART_STATUSES,
  ORDER_PAYMENT_STATUSES,
  ORDER_FULFILLMENT_STATUSES,
  ORDER_STATUSES,
  ORDER_SOURCES,
  SHOPIFY_CONNECTION_STATUSES,
  SHOPIFY_SYNC_RESOURCE_TYPES,
  SHOPIFY_SYNC_STATUSES,
  META_CATALOG_CONNECTION_STATUSES,
};