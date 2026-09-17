// Retarget module — exit-URL classification helpers.
// Shared by retargetImportService.js (writes coexistence.retarget_customers)
// and contactSyncService.js (writes coexistence.contacts), so the two
// modules classify a given exit URL identically without requiring each
// other — kept dependency-free on purpose to avoid a require() cycle.

// Coarse type stored on coexistence.retarget_customers.retarget_type —
// matches models/retargetCustomer.js RETARGET_TYPES.
function detectRetargetType(exitUrl) {
  if (!exitUrl) return 'other';
  const url = String(exitUrl).toLowerCase();

  if (/\/checkout|\bcheckout\b/.test(url)) return 'checkout_exit';
  if (/\/cart\b|\bcart\b/.test(url)) return 'cart_abandonment';
  if (/\/collections?\//.test(url)) return 'page_exit';
  if (/\/products?\//.test(url)) return 'page_exit';
  return 'other';
}

// Finer-grained category used for the Contacts page "Source" badge and the
// Retarget sync preview (Cart / Checkout / Product / Collection / Other).
function detectExitCategory(exitUrl) {
  if (!exitUrl) return 'Other';
  const url = String(exitUrl).toLowerCase();

  if (/\/checkout|\bcheckout\b/.test(url)) return 'Checkout';
  if (/\/cart\b|\bcart\b/.test(url)) return 'Cart';
  if (/\/products?\//.test(url)) return 'Product';
  if (/\/collections?\//.test(url)) return 'Collection';
  return 'Other';
}

module.exports = { detectRetargetType, detectExitCategory };