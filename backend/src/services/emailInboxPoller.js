// Email Inbox poller — checks the Gmail inbox (BREVO_SENDER_EMAIL account)
// every 2 minutes for new replies via IMAP, saves them into
// coexistence.email_inbox_messages, and links them to an existing
// subscriber by email if one matches.
//
// IMPORTANT: We track progress using the mailbox's UID (a permanent,
// ever-increasing message number) rather than the \Seen flag. Gmail marks
// messages as "read" the moment they're opened in the Gmail web app — if we
// relied on \Seen, any email you personally read would silently vanish from
// our poll results before we ever saved it. UID tracking is immune to that:
// we always fetch everything newer than the last UID we've already saved.

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const cron = require('node-cron');
const pool = require('../db');

async function getLastUid() {
  const res = await pool.query('SELECT last_uid FROM coexistence.email_inbox_poll_state WHERE id = 1');
  return res.rows[0]?.last_uid || 0;
}

async function setLastUid(uid) {
  await pool.query(
    `INSERT INTO coexistence.email_inbox_poll_state (id, last_uid) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET last_uid = GREATEST(coexistence.email_inbox_poll_state.last_uid, $1)`,
    [uid]
  );
}

async function checkInboxOnce() {
  if (!process.env.IMAP_USER || !process.env.IMAP_PASSWORD) {
    console.log('[email-inbox] IMAP not configured, skipping check');
    return;
  }

  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.gmail.com',
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    secure: true,
    auth: {
      user: process.env.IMAP_USER,
      pass: process.env.IMAP_PASSWORD,
    },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      const lastUid = await getLastUid();
      // uid range "lastUid+1:*" means "everything newer than what we've already processed"
      const range = `${lastUid + 1}:*`;
      let highestSeenUid = lastUid;

      const messages = client.fetch(range, { source: true, uid: true }, { uid: true });
      for await (const msg of messages) {
        if (msg.uid <= lastUid) continue; // Gmail's range syntax can include the boundary; skip already-processed
        if (msg.uid > highestSeenUid) highestSeenUid = msg.uid;

        const parsed = await simpleParser(msg.source);
        const fromEmail = (parsed.from?.value?.[0]?.address || '').toLowerCase().trim();
        const fromName = parsed.from?.value?.[0]?.name || '';
        const messageId = parsed.messageId || null;
        if (!fromEmail) continue;

        const sub = await pool.query(
          'SELECT id FROM coexistence.email_subscribers WHERE email = $1',
          [fromEmail]
        );
        const subscriberId = sub.rows[0]?.id || null;

        const insertResult = await pool.query(
          `INSERT INTO coexistence.email_inbox_messages
             (subscriber_id, contact_email, contact_name, direction, subject, body_text, body_html, message_id)
           VALUES ($1, $2, $3, 'inbound', $4, $5, $6, $7)
           ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING
           RETURNING id`,
          [subscriberId, fromEmail, fromName, parsed.subject || '', parsed.text || '', parsed.html || '', messageId]
        );

        if (insertResult.rows.length > 0) {
          console.log(`[email-inbox] New reply saved from ${fromEmail} (uid ${msg.uid})`);
        } else {
          console.log(`[email-inbox] Skipped duplicate from ${fromEmail} (uid ${msg.uid})`);
        }
      }

      if (highestSeenUid > lastUid) {
        await setLastUid(highestSeenUid);
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    console.error('[email-inbox] Poll error:', err.message);
  }
}

function startEmailInboxPoller() {
  checkInboxOnce();
  cron.schedule('*/2 * * * *', checkInboxOnce);
  console.log('[email-inbox] Poller scheduled (every 2 min, UID-tracked)');
}

module.exports = { startEmailInboxPoller, checkInboxOnce };
