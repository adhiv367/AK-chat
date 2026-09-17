// Phase 8F-1A — standalone transactional email service.
//
// The ONE place that knows how to send outbound transactional email
// (workspace invitations, password reset). Every caller (auth.js,
// routes/invitations.js) goes through sendWorkspaceInvitationEmail /
// sendPasswordResetEmail here instead of building its own transport.
//
// Fail-open-but-report contract: sendEmail() (and everything built on top
// of it) NEVER throws. If no provider is configured, or delivery fails for
// any reason, it resolves to { sent: false, error }, so a caller like
// auth.js's forgot-password flow can always fall through to its generic
// response without an unhandled rejection ever reaching the request.
//
// Provider configuration is intentionally minimal — SMTP via nodemailer,
// driven entirely by environment variables (see .env.example):
//   EMAIL_PROVIDER   'smtp' to enable delivery; anything else/unset ->
//                    log-only mode (sendEmail logs and returns sent:false).
//   EMAIL_FROM       the From address used for every outbound email.
//   EMAIL_FROM_NAME  display name paired with EMAIL_FROM.
//   SMTP_HOST/PORT/USER/PASSWORD  standard SMTP transport config.

let nodemailer;
try {
  nodemailer = require('nodemailer');
} catch (err) {
  nodemailer = null;
}

function isSmtpConfigured() {
  return process.env.EMAIL_PROVIDER === 'smtp' && !!process.env.SMTP_HOST;
}

// emailProviderStatus() -> { provider, configured }
// Pure/synchronous — used by health checks / admin diagnostics, never
// touches the network.
function emailProviderStatus() {
  if (isSmtpConfigured()) {
    return { provider: 'smtp', configured: true };
  }
  return { provider: 'none', configured: false };
}

let cachedTransport = null;
function getTransport() {
  if (!nodemailer) return null;
  if (!isSmtpConfigured()) return null;
  if (cachedTransport) return cachedTransport;
  cachedTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined,
  });
  return cachedTransport;
}

// sendEmail({ to, subject, html }) -> Promise<{ sent, error? }>
// Never throws — every failure mode (missing fields, no provider
// configured, transport error) resolves to { sent: false, error }.
async function sendEmail({ to, subject, html } = {}) {
  try {
    if (!to || !subject || !html) {
      return { sent: false, error: 'missing required fields (to, subject, html)' };
    }

    const status = emailProviderStatus();
    if (!status.configured) {
      console.log(`[emailService] log-only mode (no provider configured) — would send to=${to} subject="${subject}"`);
      return { sent: false, error: 'no email provider configured' };
    }

    const transport = getTransport();
    if (!transport) {
      return { sent: false, error: 'email transport unavailable' };
    }

    const fromName = process.env.EMAIL_FROM_NAME || 'AKChat';
    const fromAddress = process.env.EMAIL_FROM || process.env.SMTP_USER;
    await transport.sendMail({
      from: fromAddress ? `"${fromName}" <${fromAddress}>` : undefined,
      to,
      subject,
      html,
    });
    return { sent: true };
  } catch (err) {
    console.error('[emailService] sendEmail failed:', err.message);
    return { sent: false, error: err.message };
  }
}

// Minimal HTML-escaping for values interpolated into email templates —
// workspace names / inviter names are user-supplied, so this prevents
// HTML/markup injection into the rendered email body.
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendWorkspaceInvitationEmail({ to, workspaceName, inviterName, acceptUrl, expiresAt }) {
  const safeWorkspace = escapeHtml(workspaceName);
  const safeInviter = escapeHtml(inviterName || 'A teammate');
  const expiresText = expiresAt ? new Date(expiresAt).toUTCString() : '';
  const html = `
    <p>${safeInviter} invited you to join <strong>${safeWorkspace}</strong> on AKChat.</p>
    <p><a href="${acceptUrl}">Accept invitation</a></p>
    ${expiresText ? `<p>This invitation expires on ${expiresText}.</p>` : ''}
  `;
  return sendEmail({ to, subject: `You're invited to join ${safeWorkspace} on AKChat`, html });
}

async function sendPasswordResetEmail({ to, resetUrl, expiresAt }) {
  const expiresText = expiresAt ? new Date(expiresAt).toUTCString() : '';
  const html = `
    <p>We received a request to reset your AKChat password.</p>
    <p><a href="${resetUrl}">Reset your password</a></p>
    ${expiresText ? `<p>This link expires on ${expiresText}.</p>` : ''}
    <p>If you didn't request this, you can safely ignore this email.</p>
  `;
  return sendEmail({ to, subject: 'Reset your AKChat password', html });
}

module.exports = {
  emailProviderStatus,
  sendEmail,
  sendWorkspaceInvitationEmail,
  sendPasswordResetEmail,
};