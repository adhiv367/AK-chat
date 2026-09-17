// Phase 7.4 — Catalog Connection Layer: Shopify adapter.
//
// Workspace-scoped replacement of the legacy services/shopifyService.js
// (which reads a single global SHOPIFY_STORE_DOMAIN/SHOPIFY_ACCESS_TOKEN
// from env vars — fine for the original single-tenant WhatsApp
// catalog-lookup use case, but not usable for multi-tenant "each workspace
// connects its own store"). This file does NOT modify or replace
// shopifyService.js; that file's getProduct() may still be used elsewhere
// (e.g. WhatsApp catalog message lookups) and is out of scope for 7.4.
//
// Auth model: the connection's Admin API access token is stored encrypted
// on coexistence.catalog_connections.secret_encrypted (via util/crypto.js,
// same helper zohoTokenService.js uses for Zoho's OAuth tokens). This
// adapter expects a private/custom-app Admin API token (Settings > Apps >
// Develop apps, in the merchant's own Shopify admin) rather than a full
// OAuth flow — the smallest connect step that still keeps each workspace's
// credentials isolated. A public-OAuth "Connect with Shopify" button can be
// layered on top later using routes/integrations/zoho.js as the template,
// writing into this same secret_encrypted column, without changing this
// adapter.
//
// config: { shopDomain }  e.g. "my-store.myshopify.com"
// secret: the plaintext Admin API access token (decrypted by the caller —
//   see catalogImportService.js — and passed in, never re-read from the DB
//   here, so this file never touches util/crypto.js directly)

const axios = require('axios');

const API_VERSION = '2025-04';
const PAGE_LIMIT = 100;

function normalizeVariantPrice(product) {
  const variant = (product.variants || [])[0];
  return variant ? variant.price : null;
}

function normalizeRow(product) {
  return {
    name: product.title,
    sku: (product.variants || [])[0]?.sku || null,
    price: normalizeVariantPrice(product),
    currency: null, // Shopify's REST product payload doesn't include shop currency; left for the shop-level settings call if needed later
    description: product.body_html ? String(product.body_html).replace(/<[^>]*>/g, ' ').trim().slice(0, 2000) : null,
    imageUrl: product.image?.src || null,
    productUrl: null,
    status: product.status === 'active' ? 'active' : (product.status === 'draft' ? 'draft' : 'archived'),
    // Kept separately (not part of the generic NormalizedProductRow fields)
    // so catalogImportService.js can upsert on the existing
    // shopify_product_id unique constraint from commerceSchema.js instead
    // of guessing a match by name/SKU.
    shopifyProductId: String(product.id),
  };
}

async function fetchRows(config, context) {
  const shopDomain = config && config.shopDomain;
  const accessToken = context && context.secret;
  if (!shopDomain) throw Object.assign(new Error('shopDomain is required'), { status: 400 });
  if (!accessToken) throw Object.assign(new Error('Shopify connection has no access token — reconnect the store'), { status: 400 });

  const rows = [];
  let pageInfo = null;

  do {
    const url = pageInfo
      ? `https://${shopDomain}/admin/api/${API_VERSION}/products.json?limit=${PAGE_LIMIT}&page_info=${pageInfo}`
      : `https://${shopDomain}/admin/api/${API_VERSION}/products.json?limit=${PAGE_LIMIT}`;

    let res;
    try {
      res = await axios.get(url, {
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      });
    } catch (err) {
      if (err.response?.status === 401) {
        throw Object.assign(new Error('Shopify rejected the access token — reconnect the store'), { status: 401 });
      }
      throw new Error(`Could not reach Shopify: ${err.message}`);
    }

    const products = res.data.products || [];
    rows.push(...products.map(normalizeRow));

    // Shopify REST pagination via the Link response header (cursor-based).
    const link = res.headers.link || res.headers.Link;
    const nextMatch = link && link.match(/<[^>]*page_info=([^&>]*)[^>]*>;\s*rel="next"/);
    pageInfo = nextMatch ? nextMatch[1] : null;
  } while (pageInfo);

  return { rows };
}

module.exports = { fetchRows };


