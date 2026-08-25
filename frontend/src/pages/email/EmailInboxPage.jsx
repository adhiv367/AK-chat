import { useEffect, useState, useCallback, useMemo } from 'react';
import { C, FONT, DISPLAY_FONT, TYPE, SPACE } from '../../constants.js';

function initialsFor(nameOrEmail) {
  const src = (nameOrEmail || '').trim();
  if (!src) return '?';
  const parts = src.split(/[\s@.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}
function splitQuotedReply(text) {
  if (!text) return { main: '', quoted: '' };
  // Matches Gmail/Outlook-style quote headers like:
  // "On Fri, Aug 14, 2026 at 1:23 PM Invi Creation <...> wrote:"
  const quoteMarker = /\n?On .{5,80} wrote:\s*\n/i;
  const match = text.match(quoteMarker);
  if (!match) return { main: text.trim(), quoted: '' };
  const splitIndex = match.index;
  return {
    main: text.slice(0, splitIndex).trim(),
    quoted: text.slice(splitIndex).trim(),
  };
}
export default function EmailInboxPage() {
  const [conversations, setConversations] = useState([]);
  const [selectedEmail, setSelectedEmail] = useState(null);
  const [thread, setThread] = useState([]);
  const [replyText, setReplyText] = useState('');
  const [loadingList, setLoadingList] = useState(true);
  const [loadingThread, setLoadingThread] = useState(false);
  const [sending, setSending] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState('all'); // 'all' | 'unread'

  const loadConversations = useCallback(() => {
    fetch('/api/email/inbox', { credentials: 'include' })
      .then(r => r.json())
      .then(res => { setConversations(res.data || []); setLoadingList(false); })
      .catch(() => setLoadingList(false));
  }, []);

  useEffect(() => {
    loadConversations();
    const interval = setInterval(loadConversations, 30000);
    return () => clearInterval(interval);
  }, [loadConversations]);

  const openThread = (email) => {
    setSelectedEmail(email);
    setLoadingThread(true);
    fetch(`/api/email/inbox/${encodeURIComponent(email)}`, { credentials: 'include' })
      .then(r => r.json())
      .then(res => {
        setThread(res.data || []);
        setLoadingThread(false);
        loadConversations();
      })
      .catch(() => setLoadingThread(false));
  };

  const sendReply = async () => {
    if (!replyText.trim() || !selectedEmail) return;
    setSending(true);
    try {
      const lastSubject = thread.length > 0 ? thread[thread.length - 1].subject : '';
      const subject = lastSubject?.startsWith('Re:') ? lastSubject : `Re: ${lastSubject || 'your message'}`;
      const res = await fetch(`/api/email/inbox/${encodeURIComponent(selectedEmail)}/reply`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, htmlBody: `<p>${replyText.replace(/\n/g, '<br/>')}</p>` }),
      });
      const data = await res.json();
      if (data.success) {
        setReplyText('');
        openThread(selectedEmail);
      } else {
        alert('Failed to send: ' + (data.error || 'Unknown error'));
      }
    } catch (err) {
      alert('Failed to send: ' + err.message);
    } finally {
      setSending(false);
    }
  };

  const filteredConversations = useMemo(() => {
    let list = conversations;
    if (filterMode === 'unread') list = list.filter(c => c.unread_count > 0);
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter(c =>
        (c.contact_name || '').toLowerCase().includes(q) ||
        (c.contact_email || '').toLowerCase().includes(q) ||
        (c.subject || '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [conversations, filterMode, searchQuery]);

  const totalUnread = conversations.reduce((sum, c) => sum + (c.unread_count > 0 ? 1 : 0), 0);

  return (
    <div style={{ display: 'flex', height: '100%', fontFamily: FONT, color: C.text }}>
      <style>{`
        .eip-conv-row:hover { background: ${C.surfaceAlt} !important; }
        .eip-filter-btn.active { background: ${C.primary} !important; color: #04201C !important; }
        .eip-search-input:focus { border-color: ${C.primary} !important; }
      `}</style>

      <div style={{ width: 320, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div style={{ padding: SPACE.lg, borderBottom: `1px solid ${C.border}` }}>
          <div style={{ ...TYPE.label, color: C.primary, marginBottom: 4 }}>Email Marketing</div>
          <div style={{ fontFamily: DISPLAY_FONT, fontSize: 20, fontWeight: 600, marginBottom: 12 }}>Inbox</div>

          <input
            className="eip-search-input"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search by name or email…"
            style={{
              width: '100%', boxSizing: 'border-box', padding: '8px 12px',
              background: C.pageBg, border: `1px solid ${C.border}`, borderRadius: 8,
              color: C.text, fontSize: 12.5, outline: 'none', fontFamily: FONT,
              marginBottom: 10, transition: 'border-color 0.15s ease',
            }}
          />

          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className={`eip-filter-btn${filterMode === 'all' ? ' active' : ''}`}
              onClick={() => setFilterMode('all')}
              style={{
                flex: 1, padding: '6px 0', borderRadius: 7, border: `1px solid ${C.border}`,
                background: filterMode === 'all' ? C.primary : 'transparent',
                color: filterMode === 'all' ? '#04201C' : C.textMuted,
                fontSize: 11.5, fontWeight: 700, cursor: 'pointer', fontFamily: FONT,
              }}
            >
              All ({conversations.length})
            </button>
            <button
              className={`eip-filter-btn${filterMode === 'unread' ? ' active' : ''}`}
              onClick={() => setFilterMode('unread')}
              style={{
                flex: 1, padding: '6px 0', borderRadius: 7, border: `1px solid ${C.border}`,
                background: filterMode === 'unread' ? C.primary : 'transparent',
                color: filterMode === 'unread' ? '#04201C' : C.textMuted,
                fontSize: 11.5, fontWeight: 700, cursor: 'pointer', fontFamily: FONT,
              }}
            >
              Unread ({totalUnread})
            </button>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loadingList ? (
            <div style={{ padding: SPACE.lg, fontSize: 13, color: C.textMuted }}>Loading…</div>
          ) : filteredConversations.length === 0 ? (
            <div style={{ padding: SPACE.lg, fontSize: 13, color: C.textMuted }}>
              {conversations.length === 0 ? 'No messages yet. Replies to your campaigns will show up here.' : 'No conversations match your search.'}
            </div>
          ) : (
            filteredConversations.map(c => {
              const active = selectedEmail === c.contact_email;
              const unread = c.unread_count > 0;
              return (
                <div
                  key={c.contact_email}
                  className="eip-conv-row"
                  onClick={() => openThread(c.contact_email)}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10,
                    padding: '12px 16px',
                    cursor: 'pointer',
                    borderBottom: `1px solid ${C.border}`,
                    background: active ? C.surfaceAlt : 'transparent',
                    borderLeft: active ? `3px solid ${C.primary}` : '3px solid transparent',
                    transition: 'background 0.12s ease',
                  }}
                >
                  <div style={{
                    width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                    background: C.primaryLight || `${C.primary}22`, color: C.primary,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, fontWeight: 800, fontFamily: DISPLAY_FONT,
                  }}>
                    {initialsFor(c.contact_name || c.contact_email)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{
                        fontSize: 13, fontWeight: unread ? 800 : 600, color: C.text,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {c.contact_name || c.contact_email}
                      </span>
                      {unread && (
                        <span style={{
                          fontSize: 10, fontWeight: 700, color: '#04201C',
                          background: C.primary, borderRadius: 999,
                          padding: '1px 7px', flexShrink: 0, marginLeft: 6,
                        }}>
                          {c.unread_count}
                        </span>
                      )}
                    </div>
                    <div style={{
                      fontSize: 12, color: unread ? C.text : C.textMuted, marginTop: 2,
                      fontWeight: unread ? 600 : 400,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {c.subject || '(no subject)'}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {!selectedEmail ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.textMuted, fontSize: 13 }}>
            Select a conversation to view messages
          </div>
        ) : (
          <>
            <div style={{ padding: SPACE.lg, borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{
                width: 36, height: 36, borderRadius: '50%',
                background: C.primaryLight || `${C.primary}22`, color: C.primary,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 12, fontWeight: 800, fontFamily: DISPLAY_FONT, flexShrink: 0,
              }}>
                {initialsFor(selectedEmail)}
              </div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{selectedEmail}</div>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: SPACE.lg, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {loadingThread ? (
                <div style={{ fontSize: 13, color: C.textMuted }}>Loading…</div>
              ) : (
           thread.map(m => {
                  const outbound = m.direction === 'outbound';
                  const { main, quoted } = splitQuotedReply(m.body_text || m.subject || '');
                  return (
                    <div
                      key={m.id}
                      style={{
                        alignSelf: outbound ? 'flex-end' : 'flex-start',
                        maxWidth: '70%',
                        background: outbound ? C.primary : C.surfaceAlt,
                        color: outbound ? '#04201C' : C.text,
                        border: outbound ? 'none' : `1px solid ${C.border}`,
                        borderRadius: 14,
                        borderBottomRightRadius: outbound ? 4 : 14,
                        borderBottomLeftRadius: outbound ? 14 : 4,
                        padding: '10px 14px',
                      }}
                    >
                      <div style={{ fontSize: 11, opacity: 0.75, marginBottom: 4, fontWeight: 600 }}>
                        {outbound ? 'You' : (m.contact_name || m.contact_email)} · {new Date(m.created_at).toLocaleString()}
                      </div>
                      <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{main || '(no content)'}</div>
                      {quoted && (
                        <details style={{ marginTop: 8 }}>
                          <summary style={{ fontSize: 11, opacity: 0.7, cursor: 'pointer' }}>Show quoted text</summary>
                          <div style={{ fontSize: 11, opacity: 0.7, whiteSpace: 'pre-wrap', marginTop: 6, borderLeft: '2px solid currentColor', paddingLeft: 8 }}>
                            {quoted}
                          </div>
                        </details>
                      )}
                    </div>
                  );
                })
              )}
            </div>
            <div style={{ padding: SPACE.lg, borderTop: `1px solid ${C.border}`, display: 'flex', gap: 10 }}>
              <textarea
                value={replyText}
                onChange={e => setReplyText(e.target.value)}
                placeholder="Type your reply…"
                rows={2}
                style={{
                  flex: 1, resize: 'none', borderRadius: 10, border: `1px solid ${C.border}`,
                  padding: '10px 12px', fontFamily: FONT, fontSize: 13, background: C.cardBg, color: C.text,
                }}
              />
              <button
                onClick={sendReply}
                disabled={sending || !replyText.trim()}
                style={{
                  padding: '0 20px', borderRadius: 10, border: 'none',
                  background: sending ? C.textMuted : C.primary, color: '#04201C',
                  fontWeight: 700, fontFamily: FONT, cursor: sending ? 'default' : 'pointer',
                }}
              >
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
