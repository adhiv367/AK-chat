'use strict';

// Phase 7.3 — Product Catalog service tests.
//
// No live Postgres is reachable from this sandbox (same constraint as every
// other test file in this repo — see test/commerceSchema.test.js). Rather
// than string-match every SQL statement, this file implements a small
// in-memory fake of the exact tables/queries productService.js issues, so
// tests exercise real CRUD + workspace-isolation *behaviour*, not just SQL
// shape. The IMPORTANT TEST PRINCIPLE from the spec is honoured throughout:
// every isolation test uses at least two workspaces/tenants (never a single
// "Invi Creations"-style tenant).

const test = require('node:test');
const assert = require('node:assert/strict');

function makeFakeDb() {
  let nextId = 1;
  const products = [];
  const variants = [];
  const collections = [];
  const productCollections = [];
  const inventory = [];
  const whatsappAccounts = [];

  function query(sqlRaw, params = []) {
    const sql = sqlRaw.replace(/\s+/g, ' ').trim();

    // ── products ──────────────────────────────────────────────────────
    if (/^SELECT p\.\* FROM coexistence\.products p WHERE/i.test(sql)) {
      // listProducts — very small hand-rolled filter matching the service's
      // WHERE fragments in order: workspace_id, [status], [source], [search], [collectionId]
      let rows = products.filter((p) => p.workspace_id === params[0]);
      let i = 1;
      if (/p\.status = \$/.test(sql)) { rows = rows.filter((p) => p.status === params[i]); i++; }
      if (/p\.source = \$/.test(sql)) { rows = rows.filter((p) => p.source === params[i]); i++; }
      if (/p\.name ILIKE/.test(sql)) {
        const term = params[i].replace(/%/g, '').toLowerCase();
        rows = rows.filter((p) =>
          (p.name || '').toLowerCase().includes(term) ||
          (p.sku || '').toLowerCase().includes(term) ||
          (p.product_id || '').toLowerCase().includes(term) ||
          (p.retailer_id || '').toLowerCase().includes(term));
        i++;
      }
      if (/pc\.collection_id = \$/.test(sql)) {
        const collectionId = params[i];
        const productIds = new Set(productCollections.filter((pc) => pc.collection_id === collectionId).map((pc) => pc.product_id));
        rows = rows.filter((p) => productIds.has(p.id));
        i++;
      }
      const sortDesc = /DESC/.test(sql);
      rows = rows.slice().sort((a, b) => (a.id - b.id) * (sortDesc ? -1 : 1));
      const limit = params[params.length - 2];
      const offset = params[params.length - 1];
      return { rows: rows.slice(offset, offset + limit) };
    }
    if (/^SELECT COUNT\(\*\)::int AS count FROM coexistence\.products p WHERE/i.test(sql)) {
      let rows = products.filter((p) => p.workspace_id === params[0]);
      let i = 1;
      if (/p\.status = \$/.test(sql)) { rows = rows.filter((p) => p.status === params[i]); i++; }
      if (/p\.source = \$/.test(sql)) { rows = rows.filter((p) => p.source === params[i]); i++; }
      if (/p\.name ILIKE/.test(sql)) {
        const term = params[i].replace(/%/g, '').toLowerCase();
        rows = rows.filter((p) => (p.name || '').toLowerCase().includes(term));
        i++;
      }
      return { rows: [{ count: rows.length }] };
    }
    if (/^SELECT \* FROM coexistence\.products WHERE id = \$1 AND workspace_id = \$2$/i.test(sql)) {
      const row = products.find((p) => p.id === Number(params[0]) && p.workspace_id === params[1]);
      return { rows: row ? [row] : [] };
    }
    if (/^SELECT id FROM coexistence\.products WHERE id = \$1 AND workspace_id = \$2$/i.test(sql)) {
      const row = products.find((p) => p.id === Number(params[0]) && p.workspace_id === params[1]);
      return { rows: row ? [{ id: row.id }] : [] };
    }
    if (/^INSERT INTO coexistence\.products \(/i.test(sql)) {
      const columns = sql.match(/\(([^)]+)\)/)[1].split(',').map((s) => s.trim());
      const row = { id: nextId++, created_at: new Date(), updated_at: new Date() };
      columns.forEach((col, idx) => { row[col] = params[idx]; });
      products.push(row);
      return { rows: [row] };
    }
    if (/^UPDATE coexistence\.products/i.test(sql)) {
      const id = Number(params[0]);
      const workspaceId = params[1];
      const row = products.find((p) => p.id === id && p.workspace_id === workspaceId);
      if (!row) return { rows: [] };
      if (/SET status = 'archived'/i.test(sql)) {
        row.status = 'archived';
      } else {
        const setSql = sql.match(/SET (.+) WHERE/i)[1];
        const assignments = setSql.split(',').map((s) => s.trim()).filter((s) => !s.startsWith('updated_at'));
        assignments.forEach((assign, idx) => {
          const col = assign.split('=')[0].trim();
          row[col] = params[idx + 2];
        });
      }
      row.updated_at = new Date();
      return { rows: [row] };
    }

    // ── whatsapp_accounts ────────────────────────────────────────────
    if (/^SELECT id FROM coexistence\.whatsapp_accounts WHERE id = \$1 AND workspace_id = \$2$/i.test(sql)) {
      const row = whatsappAccounts.find((w) => w.id === params[0] && w.workspace_id === params[1]);
      return { rows: row ? [row] : [] };
    }

    // ── product_variants ─────────────────────────────────────────────
    if (/^SELECT \* FROM coexistence\.product_variants WHERE product_id = \$1 ORDER BY id ASC$/i.test(sql)) {
      return { rows: variants.filter((v) => v.product_id === Number(params[0])) };
    }
    if (/^SELECT \* FROM coexistence\.product_variants WHERE id = \$1 AND product_id = \$2$/i.test(sql)) {
      const row = variants.find((v) => v.id === Number(params[0]) && v.product_id === Number(params[1]));
      return { rows: row ? [row] : [] };
    }
    if (/^INSERT INTO coexistence\.product_variants \(/i.test(sql)) {
      const columns = sql.match(/\(([^)]+)\)/)[1].split(',').map((s) => s.trim());
      const row = { id: nextId++, created_at: new Date(), updated_at: new Date() };
      columns.forEach((col, idx) => { row[col] = params[idx]; });
      variants.push(row);
      return { rows: [row] };
    }
    if (/^UPDATE coexistence\.product_variants/i.test(sql)) {
      const id = Number(params[0]);
      const productId = Number(params[1]);
      const row = variants.find((v) => v.id === id && v.product_id === productId);
      if (!row) return { rows: [] };
      const setSql = sql.match(/SET (.+) WHERE/i)[1];
      const assignments = setSql.split(',').map((s) => s.trim()).filter((s) => !s.startsWith('updated_at'));
      assignments.forEach((assign, idx) => {
        const col = assign.split('=')[0].trim();
        row[col] = params[idx + 2];
      });
      row.updated_at = new Date();
      return { rows: [row] };
    }
    if (/^DELETE FROM coexistence\.product_variants WHERE id = \$1 AND product_id = \$2$/i.test(sql)) {
      const idx = variants.findIndex((v) => v.id === Number(params[0]) && v.product_id === Number(params[1]));
      if (idx === -1) return { rowCount: 0 };
      variants.splice(idx, 1);
      return { rowCount: 1 };
    }

    // ── collections ──────────────────────────────────────────────────
    if (/^SELECT \* FROM coexistence\.collections WHERE workspace_id = \$1/i.test(sql)) {
      let rows = collections.filter((c) => c.workspace_id === params[0]);
      let i = 1;
      if (/archived_at IS NULL/.test(sql)) rows = rows.filter((c) => !c.archived_at);
      if (/name ILIKE/.test(sql)) {
        const term = params[i].replace(/%/g, '').toLowerCase();
        rows = rows.filter((c) => (c.name || '').toLowerCase().includes(term));
        i++;
      }
      rows = rows.slice().sort((a, b) => a.name.localeCompare(b.name));
      const limit = params[params.length - 2];
      const offset = params[params.length - 1];
      return { rows: rows.slice(offset, offset + limit) };
    }
    if (/^SELECT COUNT\(\*\)::int AS count FROM coexistence\.collections WHERE/i.test(sql)) {
      let rows = collections.filter((c) => c.workspace_id === params[0]);
      if (/archived_at IS NULL/.test(sql)) rows = rows.filter((c) => !c.archived_at);
      return { rows: [{ count: rows.length }] };
    }
    if (/^SELECT \* FROM coexistence\.collections WHERE id = \$1 AND workspace_id = \$2$/i.test(sql)) {
      const row = collections.find((c) => c.id === Number(params[0]) && c.workspace_id === params[1]);
      return { rows: row ? [row] : [] };
    }
    if (/^INSERT INTO coexistence\.collections \(workspace_id, name, description\)/i.test(sql)) {
      const row = { id: nextId++, workspace_id: params[0], name: params[1], description: params[2], archived_at: null, created_at: new Date(), updated_at: new Date() };
      collections.push(row);
      return { rows: [row] };
    }
    if (/^UPDATE coexistence\.collections/i.test(sql)) {
      const id = Number(params[0]);
      const workspaceId = params[1];
      const row = collections.find((c) => c.id === id && c.workspace_id === workspaceId);
      if (!row) return { rows: [] };
      if (/archived_at = NOW\(\)/i.test(sql)) {
        row.archived_at = new Date();
      } else {
        const setSql = sql.match(/SET (.+) WHERE/i)[1];
        const assignments = setSql.split(',').map((s) => s.trim()).filter((s) => !s.startsWith('updated_at'));
        assignments.forEach((assign, idx) => {
          const col = assign.split('=')[0].trim();
          row[col] = params[idx + 2];
        });
      }
      row.updated_at = new Date();
      return { rows: [row] };
    }

    // ── product_collections ──────────────────────────────────────────
    if (/^INSERT INTO coexistence\.product_collections/i.test(sql)) {
      const exists = productCollections.find((pc) => pc.product_id === Number(params[0]) && pc.collection_id === Number(params[1]));
      if (exists) return { rows: [] };
      const row = { product_id: Number(params[0]), collection_id: Number(params[1]), created_at: new Date() };
      productCollections.push(row);
      return { rows: [row] };
    }
    if (/^SELECT \* FROM coexistence\.product_collections WHERE product_id = \$1 AND collection_id = \$2$/i.test(sql)) {
      const row = productCollections.find((pc) => pc.product_id === Number(params[0]) && pc.collection_id === Number(params[1]));
      return { rows: row ? [row] : [] };
    }
    if (/^DELETE FROM coexistence\.product_collections WHERE product_id = \$1 AND collection_id = \$2$/i.test(sql)) {
      const idx = productCollections.findIndex((pc) => pc.product_id === Number(params[0]) && pc.collection_id === Number(params[1]));
      if (idx === -1) return { rowCount: 0 };
      productCollections.splice(idx, 1);
      return { rowCount: 1 };
    }
    if (/^SELECT c\.\* FROM coexistence\.collections c/i.test(sql)) {
      const productId = Number(params[0]);
      const workspaceId = params[1];
      const collectionIds = new Set(productCollections.filter((pc) => pc.product_id === productId).map((pc) => pc.collection_id));
      const rows = collections.filter((c) => collectionIds.has(c.id) && c.workspace_id === workspaceId);
      return { rows };
    }

    // ── inventory_levels ─────────────────────────────────────────────
    if (/^SELECT \* FROM coexistence\.inventory_levels\s+WHERE product_id = \$1 AND variant_id IS NOT DISTINCT FROM \$2$/i.test(sql)) {
      const row = inventory.find((iv) => iv.product_id === Number(params[0]) && (iv.variant_id || null) === (params[1] || null));
      return { rows: row ? [row] : [] };
    }
    if (/^SELECT \* FROM coexistence\.inventory_levels WHERE product_id = \$1 ORDER BY/i.test(sql)) {
      return { rows: inventory.filter((iv) => iv.product_id === Number(params[0])) };
    }
    if (/^SELECT id FROM coexistence\.product_variants WHERE id = \$1 AND product_id = \$2$/i.test(sql)) {
      const row = variants.find((v) => v.id === Number(params[0]) && v.product_id === Number(params[1]));
      return { rows: row ? [{ id: row.id }] : [] };
    }
    if (/^INSERT INTO coexistence\.inventory_levels/i.test(sql)) {
      const [workspaceId, productId, variantId, available, reserved, source, externalId] = params;
      let row = inventory.find((iv) => iv.product_id === productId && (iv.variant_id || null) === (variantId || null));
      if (row) {
        row.available_quantity = available;
        row.reserved_quantity = reserved;
        row.source = source;
        row.external_inventory_id = externalId;
        row.updated_at = new Date();
      } else {
        row = {
          id: nextId++, workspace_id: workspaceId, product_id: productId, variant_id: variantId,
          available_quantity: available, reserved_quantity: reserved, source, external_inventory_id: externalId,
          created_at: new Date(), updated_at: new Date(),
        };
        inventory.push(row);
      }
      return { rows: [row] };
    }

    throw new Error(`Unhandled fake SQL: ${sql}`);
  }

  return { query, products, variants, collections, productCollections, inventory, whatsappAccounts };
}

function withFakeDb(run) {
  return async () => {
    const pool = require('../src/db');
    const fake = makeFakeDb();
    const original = pool.query;
    pool.query = fake.query;
    try {
      delete require.cache[require.resolve('../src/services/productService')];
      const svc = require('../src/services/productService');
      await run(svc, fake);
    } finally {
      pool.query = original;
    }
  };
}

// ── CRUD ────────────────────────────────────────────────────────────────

test('createProduct + getProduct round-trip within a workspace', withFakeDb(async (svc) => {
  const created = await svc.createProduct(10, { name: 'Blue Mug', sku: 'MUG-BLU', source: 'manual' });
  assert.equal(created.name, 'Blue Mug');
  assert.equal(created.workspace_id, 10);
  assert.equal(created.status, 'draft');

  const fetched = await svc.getProduct(10, created.id);
  assert.equal(fetched.sku, 'MUG-BLU');
}));

test('createProduct rejects a missing name', withFakeDb(async (svc) => {
  await assert.rejects(() => svc.createProduct(10, {}), (err) => err.status === 400);
}));

test('createProduct rejects an invalid source', withFakeDb(async (svc) => {
  await assert.rejects(() => svc.createProduct(10, { name: 'X', source: 'not-a-real-source' }), (err) => err.status === 400);
}));

test('createProduct accepts every Phase 7.3 source value (generic, not Shopify-only)', withFakeDb(async (svc) => {
  const sources = ['manual', 'shopify', 'website', 'google_sheet', 'csv', 'other'];
  for (const source of sources) {
    const p = await svc.createProduct(10, { name: `Item ${source}`, source });
    assert.equal(p.source, source);
  }
}));

test('updateProduct patches only the supplied fields', withFakeDb(async (svc) => {
  const created = await svc.createProduct(10, { name: 'Widget', price: 9.99 });
  const updated = await svc.updateProduct(10, created.id, { price: 12.5 });
  assert.equal(updated.name, 'Widget');
  assert.equal(updated.price, 12.5);
}));

test('archiveProduct sets status to archived rather than deleting the row', withFakeDb(async (svc, fake) => {
  const created = await svc.createProduct(10, { name: 'Old Item' });
  const archived = await svc.archiveProduct(10, created.id);
  assert.equal(archived.status, 'archived');
  assert.equal(fake.products.length, 1, 'row must still exist after archive');
}));

// ── Multi-tenant workspace isolation (explicit two-workspace principle) ──

test('Workspace A cannot read Workspace B\'s product, and vice versa', withFakeDb(async (svc) => {
  const productA = await svc.createProduct(1001, { name: 'Product A' });
  const productB = await svc.createProduct(2002, { name: 'Product B' });

  await assert.rejects(() => svc.getProduct(1001, productB.id), (err) => err.status === 404);
  await assert.rejects(() => svc.getProduct(2002, productA.id), (err) => err.status === 404);

  const fromA = await svc.getProduct(1001, productA.id);
  const fromB = await svc.getProduct(2002, productB.id);
  assert.equal(fromA.name, 'Product A');
  assert.equal(fromB.name, 'Product B');
}));

test('Workspace A cannot update or archive Workspace B\'s product', withFakeDb(async (svc) => {
  const productB = await svc.createProduct(2002, { name: 'Product B' });
  await assert.rejects(() => svc.updateProduct(1001, productB.id, { name: 'Hijacked' }), (err) => err.status === 404);
  await assert.rejects(() => svc.archiveProduct(1001, productB.id), (err) => err.status === 404);
}));

test('listProducts for Workspace A never returns Workspace B rows', withFakeDb(async (svc) => {
  await svc.createProduct(1001, { name: 'A1' });
  await svc.createProduct(1001, { name: 'A2' });
  await svc.createProduct(2002, { name: 'B1' });

  const { items, pagination } = await svc.listProducts(1001, {});
  assert.equal(items.length, 2);
  assert.equal(pagination.total, 2);
  assert.ok(items.every((p) => p.workspace_id === 1001));
}));

test('Workspace A cannot create a variant on Workspace B\'s product', withFakeDb(async (svc) => {
  const productB = await svc.createProduct(2002, { name: 'Product B' });
  await assert.rejects(() => svc.createVariant(1001, productB.id, { title: 'Size M' }), (err) => err.status === 404);
}));

test('Workspace A cannot assign its product to Workspace B\'s collection', withFakeDb(async (svc) => {
  const productA = await svc.createProduct(1001, { name: 'Product A' });
  const collectionB = await svc.createCollection(2002, { name: 'Collection B' });
  await assert.rejects(() => svc.assignProductToCollection(1001, productA.id, collectionB.id), (err) => err.status === 404);
}));

test('Workspace A cannot read Workspace B\'s collection list', withFakeDb(async (svc) => {
  await svc.createCollection(1001, { name: 'A Coll' });
  await svc.createCollection(2002, { name: 'B Coll' });
  const { items } = await svc.listCollections(1001, {});
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'A Coll');
}));

// ── Variants ───────────────────────────────────────────────────────────

test('variant create/list/update/delete lifecycle', withFakeDb(async (svc) => {
  const product = await svc.createProduct(10, { name: 'Shirt' });
  const variant = await svc.createVariant(10, product.id, { title: 'Small', sku: 'SHIRT-S', inventoryQuantity: 5 });
  assert.equal(variant.title, 'Small');

  const list = await svc.listVariants(10, product.id);
  assert.equal(list.length, 1);

  const updated = await svc.updateVariant(10, product.id, variant.id, { inventoryQuantity: 8 });
  assert.equal(updated.inventory_quantity, 8);

  const result = await svc.deleteVariant(10, product.id, variant.id);
  assert.equal(result.ok, true);
  assert.equal((await svc.listVariants(10, product.id)).length, 0);
}));

test('invalid parent product for a variant operation is rejected', withFakeDb(async (svc) => {
  await assert.rejects(() => svc.listVariants(10, 99999), (err) => err.status === 404);
}));

// ── Collections ────────────────────────────────────────────────────────

test('collection create/update/archive lifecycle', withFakeDb(async (svc) => {
  const collection = await svc.createCollection(10, { name: 'Summer' });
  const updated = await svc.updateCollection(10, collection.id, { name: 'Summer 2026' });
  assert.equal(updated.name, 'Summer 2026');

  const archived = await svc.archiveCollection(10, collection.id);
  assert.ok(archived.archived_at);

  const { items } = await svc.listCollections(10, {});
  assert.equal(items.length, 0, 'archived collection excluded by default');

  const { items: withArchived } = await svc.listCollections(10, { includeArchived: true });
  assert.equal(withArchived.length, 1);
}));

test('assign/remove product to/from a collection', withFakeDb(async (svc) => {
  const product = await svc.createProduct(10, { name: 'Hat' });
  const collection = await svc.createCollection(10, { name: 'Headwear' });

  await svc.assignProductToCollection(10, product.id, collection.id);
  const cols = await svc.listProductCollections(10, product.id);
  assert.equal(cols.length, 1);
  assert.equal(cols[0].name, 'Headwear');

  await svc.removeProductFromCollection(10, product.id, collection.id);
  assert.equal((await svc.listProductCollections(10, product.id)).length, 0);
}));

// ── Inventory ──────────────────────────────────────────────────────────

test('upsertInventory creates then updates the same product/variant row', withFakeDb(async (svc) => {
  const product = await svc.createProduct(10, { name: 'Candle' });
  const first = await svc.upsertInventory(10, product.id, { availableQuantity: 20, reservedQuantity: 2 });
  assert.equal(first.available_quantity, 20);

  const second = await svc.upsertInventory(10, product.id, { availableQuantity: 15, reservedQuantity: 0 });
  assert.equal(second.available_quantity, 15);

  const list = await svc.listInventoryForProduct(10, product.id);
  assert.equal(list.length, 1, 'update, not duplicate insert');
}));

test('upsertInventory rejects a variantId that does not belong to the product', withFakeDb(async (svc) => {
  const productA = await svc.createProduct(10, { name: 'A' });
  const productB = await svc.createProduct(10, { name: 'B' });
  const variantOfB = await svc.createVariant(10, productB.id, { title: 'V' });
  await assert.rejects(
    () => svc.upsertInventory(10, productA.id, { variantId: variantOfB.id, availableQuantity: 1 }),
    (err) => err.status === 400
  );
}));

// ── Search / filtering / pagination ───────────────────────────────────

test('listProducts search matches name, sku, product_id, retailer_id', withFakeDb(async (svc) => {
  await svc.createProduct(10, { name: 'Red Chair', sku: 'CHR-RED' });
  await svc.createProduct(10, { name: 'Blue Table', sku: 'TBL-BLU' });

  const bySku = await svc.listProducts(10, { search: 'CHR-RED' });
  assert.equal(bySku.items.length, 1);
  assert.equal(bySku.items[0].name, 'Red Chair');
}));

test('listProducts filters by status and source', withFakeDb(async (svc) => {
  await svc.createProduct(10, { name: 'Active Manual', status: 'active', source: 'manual' });
  await svc.createProduct(10, { name: 'Draft Shopify', status: 'draft', source: 'shopify' });

  const activeOnly = await svc.listProducts(10, { status: 'active' });
  assert.equal(activeOnly.items.length, 1);
  assert.equal(activeOnly.items[0].name, 'Active Manual');

  const shopifyOnly = await svc.listProducts(10, { source: 'shopify' });
  assert.equal(shopifyOnly.items.length, 1);
  assert.equal(shopifyOnly.items[0].name, 'Draft Shopify');
}));

test('listProducts paginates', withFakeDb(async (svc) => {
  for (let i = 0; i < 5; i++) await svc.createProduct(10, { name: `P${i}` });
  const page1 = await svc.listProducts(10, { page: 1, pageSize: 2 });
  const page2 = await svc.listProducts(10, { page: 2, pageSize: 2 });
  assert.equal(page1.items.length, 2);
  assert.equal(page2.items.length, 2);
  assert.equal(page1.pagination.total, 5);
  assert.equal(page1.pagination.totalPages, 3);
  assert.notDeepEqual(page1.items.map((p) => p.id), page2.items.map((p) => p.id));
}));

test('listProducts filters by collection', withFakeDb(async (svc) => {
  const p1 = await svc.createProduct(10, { name: 'In Collection' });
  const p2 = await svc.createProduct(10, { name: 'Not In Collection' });
  const collection = await svc.createCollection(10, { name: 'Featured' });
  await svc.assignProductToCollection(10, p1.id, collection.id);

  const { items } = await svc.listProducts(10, { collectionId: collection.id });
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'In Collection');
  void p2;
}));

test('listProducts rejects an invalid status filter', withFakeDb(async (svc) => {
  await assert.rejects(() => svc.listProducts(10, { status: 'bogus' }), (err) => err.status === 400);
}));







