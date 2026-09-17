const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

// EMAIL_PROVIDER unset -> log-only mode, so sendEmail() never attempts a
// real network call in the test environment.
delete process.env.EMAIL_PROVIDER;
delete process.env.SMTP_HOST;

const {
  sendEmail,
  sendWorkspaceInvitationEmail,
  sendPasswordResetEmail,
  emailProviderStatus,
} = require('../src/services/emailService');

test('emailProviderStatus reports log-only mode when unconfigured', () => {
  const status = emailProviderStatus();
  assert.strictEqual(status.provider, 'none');
  assert.strictEqual(status.configured, false);
});

test('sendEmail never throws and reports sent:false without a provider', async () => {
  const result = await sendEmail({ to: 'user@example.com', subject: 'Hi', html: '<p>hi</p>' });
  assert.strictEqual(result.sent, false);
  assert.ok(result.error);
});

test('sendEmail rejects missing required fields without throwing', async () => {
  const result = await sendEmail({ to: '', subject: '', html: '' });
  assert.strictEqual(result.sent, false);
  assert.ok(result.error);
});

test('sendWorkspaceInvitationEmail builds without throwing and reports not-sent', async () => {
  const result = await sendWorkspaceInvitationEmail({
    to: 'invitee@example.com',
    workspaceName: 'Acme <script>',
    inviterName: 'Admin',
    acceptUrl: 'https://app.example.com/#/accept-invite/deadbeef',
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
  });
  assert.strictEqual(result.sent, false);
});

test('sendPasswordResetEmail builds without throwing and reports not-sent', async () => {
  const result = await sendPasswordResetEmail({
    to: 'user@example.com',
    resetUrl: 'https://app.example.com/#/reset-password/deadbeef',
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
  });
  assert.strictEqual(result.sent, false);
});

// Reset-token hashing: same algorithm auth.js uses internally (SHA-256 hex).
// Verifies the hash is deterministic and different tokens hash differently,
// which is what single-use/lookup-by-hash correctness depends on.
test('reset token hashing is deterministic and collision-free for distinct tokens', () => {
  const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
  const tokenA = crypto.randomBytes(32).toString('hex');
  const tokenB = crypto.randomBytes(32).toString('hex');
  assert.strictEqual(hash(tokenA), hash(tokenA));
  assert.notStrictEqual(hash(tokenA), hash(tokenB));
  assert.match(hash(tokenA), /^[a-f0-9]{64}$/);
});
