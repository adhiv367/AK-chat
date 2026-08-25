// Retarget module — model.
// Table coexistence.retarget_customers has no ORM in this codebase (the
// project talks to Postgres directly via pg), so this file documents the
// record shape and shared constants the repository/service/controller
// layers build against — the same role db/instagramSchema.js's table
// definitions play for the Instagram module.

const RETARGET_STATUSES = ['pending', 'contacted', 'converted', 'ignored'];

const RETARGET_TYPES = ['cart_abandonment', 'checkout_exit', 'page_exit', 'other'];

/**
 * @typedef {Object} RetargetCustomer
 * @property {number} id
 * @property {string|null} name
 * @property {string|null} phone
 * @property {string|null} email
 * @property {string|null} exit_url
 * @property {string|null} retarget_type
 * @property {string|null} timestamp   - ISO timestamp of the retarget-triggering event
 * @property {string|null} source
 * @property {string} status           - one of RETARGET_STATUSES
 * @property {string} created_at
 * @property {string} updated_at
 */

module.exports = { RETARGET_STATUSES, RETARGET_TYPES };