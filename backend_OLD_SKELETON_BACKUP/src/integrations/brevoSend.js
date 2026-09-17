// Brevo transactional email sender — used by the Email Marketing module
// to dispatch campaign emails via Brevo's REST API (v3/smtp/email).
// Mirrors the style of integrations/metaSend.js.

const axios = require('axios');

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

/**
 * Sends a single email via Brevo.
 * @param {Object} opts
 * @param {string} opts.toEmail
 * @param {string} [opts.toName]
 * @param {string} opts.subject
 * @param {string} opts.htmlContent
 * @returns {Promise<{ok: boolean, messageId?: string, error?: string}>}
 */
async function sendBrevoEmail({ toEmail, toName, subject, htmlContent }) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME || 'AK Chat';

  if (!apiKey) return { ok: false, error: 'BREVO_API_KEY is not set' };
  if (!senderEmail) return { ok: false, error: 'BREVO_SENDER_EMAIL is not set' };
  if (!toEmail) return { ok: false, error: 'toEmail is required' };

  try {
    const { data } = await axios.post(
      BREVO_API_URL,
      {
        sender: { email: senderEmail, name: senderName },
        to: [{ email: toEmail, name: toName || undefined }],
        subject,
        htmlContent,
      },
      {
        headers: {
          'api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        timeout: 15000,
      }
    );
    return { ok: true, messageId: data.messageId };
  } catch (err) {
    const brevoError = err.response?.data?.message || err.message;
    console.error('[brevoSend] error:', brevoError);
    return { ok: false, error: brevoError };
  }
}

module.exports = { sendBrevoEmail };