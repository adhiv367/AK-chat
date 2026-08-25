import { useState, useEffect } from 'react';
import { Send, Plus } from 'lucide-react';
import { IG, FONT } from '../../constants.js';
import { getActiveIgAccount } from '../../igAccount';

function Avatar({ name, size = 40 }) {
  const initial = (name || '?').charAt(0).toUpperCase();
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      background: IG.gradient, color: '#fff', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      fontWeight: 700, fontSize: size * 0.4, fontFamily: FONT,
    }}>
      {initial}
    </div>
  );
}

export default function InstagramInboxPage() {
  const [conversations, setConversations] = useState([]);
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([]);
  const [notes, setNotes] = useState([]);
  const [draft, setDraft] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [loading, setLoading] = useState(true);

  const loadConversations = () => {
    fetch(`/api/instagram/inbox?accountId=${getActiveIgAccount()}`, { credentials: 'include' })
      .then(r => r.json())
      .then(setConversations)
      .catch(() => setConversations([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadConversations(); }, [getActiveIgAccount()]);

  const openConversation = (conv) => {
    setSelected(conv);
    fetch(`/api/instagram/inbox/${conv.id}/messages`, { credentials: 'include' })
      .then(r => r.json()).then(setMessages).catch(() => setMessages([]));
    fetch(`/api/instagram/inbox/${conv.id}/notes`, { credentials: 'include' })
      .then(r => r.json()).then(setNotes).catch(() => setNotes([]));
  };

  const sendMessage = async () => {
    if (!draft.trim() || !selected) return;
    const res = await fetch(`/api/instagram/inbox/${selected.id}/messages`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: draft }),
    });
    const msg = await res.json();
    setMessages(m => [...m, msg]);
    setDraft('');
    loadConversations();
  };

  const addNote = async () => {
    if (!noteDraft.trim() || !selected) return;
    const res = await fetch(`/api/instagram/inbox/${selected.id}/notes`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: noteDraft }),
    });
    const note = await res.json();
    setNotes(n => [note, ...n]);
    setNoteDraft('');
  };

  const seedTestConversation = async () => {
    await fetch('/api/instagram/inbox/seed-test', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: `user_${Math.floor(Math.random() * 1000)}`,
        displayName: 'Test Contact',
        message: 'Hi, I have a question!',
      }),
    });
    loadConversations();
  };

  return (
    <div style={{ display: 'flex', height: '100%', fontFamily: FONT, background: IG.cardBg }}>
      {/* Conversation list — card style, not flat rows */}
      <div style={{ width: 340, borderRight: `1px solid ${IG.border}`, overflow: 'auto', flexShrink: 0, padding: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 8px 14px' }}>
          <div style={{ fontWeight: 800, fontSize: 16, color: IG.text }}>Direct Messages</div>
          <button
            onClick={seedTestConversation}
            title="Add test conversation"
            style={{
              width: 30, height: 30, borderRadius: '50%', border: 'none',
              background: IG.gradient, color: '#fff', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Plus size={16} />
          </button>
        </div>
        {loading ? (
          <div style={{ padding: 12, color: IG.textMuted, fontSize: 13 }}>Loading…</div>
        ) : conversations.length === 0 ? (
          <div style={{ padding: 12, color: IG.textMuted, fontSize: 13 }}>
            No conversations yet. Tap + to simulate one.
          </div>
        ) : (
          conversations.map(c => (
            <div
              key={c.id}
              onClick={() => openConversation(c)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 10px', cursor: 'pointer', borderRadius: 16,
                background: selected?.id === c.id ? IG.accentBg : 'transparent',
                marginBottom: 4,
              }}
            >
              <Avatar name={c.display_name || c.username} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: IG.text }}>
                  {c.display_name || c.username}
                </div>
                <div style={{
                  fontSize: 12, color: IG.textMuted, marginTop: 2,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {c.last_message}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Chat thread */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {!selected ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: IG.textMuted, fontSize: 13 }}>
            Select a conversation to view messages
          </div>
        ) : (
          <>
            <div style={{ padding: '14px 20px', borderBottom: `1px solid ${IG.border}`, display: 'flex', alignItems: 'center', gap: 10 }}>
              <Avatar name={selected.display_name || selected.username} size={34} />
              <div style={{ fontWeight: 700, fontSize: 14, color: IG.text }}>
                {selected.display_name || selected.username}
              </div>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
              {messages.map(m => (
                <div key={m.id} style={{
                  display: 'flex',
                  justifyContent: m.direction === 'outbound' ? 'flex-end' : 'flex-start',
                  marginBottom: 10,
                }}>
                  <div style={{
                    maxWidth: '55%', padding: '10px 14px', borderRadius: 20,
                    background: m.direction === 'outbound' ? IG.gradient : '#efefef',
                    color: m.direction === 'outbound' ? '#fff' : IG.text,
                    fontSize: 13,
                  }}>
                    {m.content}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ padding: 14, borderTop: `1px solid ${IG.border}`, display: 'flex', gap: 8 }}>
              <input
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && sendMessage()}
                placeholder="Message…"
                style={{
                  flex: 1, padding: '10px 16px', borderRadius: 24,
                  border: `1px solid ${IG.border}`, fontSize: 13, fontFamily: FONT,
                  background: '#fafafa',
                }}
              />
              <button
                onClick={sendMessage}
                style={{
                  width: 42, height: 42, borderRadius: '50%', border: 'none', background: IG.gradient,
                  color: '#fff', cursor: 'pointer', display: 'flex',
                  alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}
              >
                <Send size={16} />
              </button>
            </div>
          </>
        )}
      </div>

      {/* Contact details / notes */}
      {selected && (
        <div style={{ width: 300, borderLeft: `1px solid ${IG.border}`, padding: 20, overflow: 'auto', flexShrink: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 18 }}>
            <Avatar name={selected.display_name || selected.username} size={64} />
            <div style={{ fontWeight: 800, fontSize: 14, color: IG.text, marginTop: 8 }}>
              {selected.display_name}
            </div>
            <div style={{ fontSize: 12, color: IG.textMuted }}>@{selected.username}</div>
          </div>

          <div style={{ fontWeight: 800, fontSize: 13, color: IG.text, margin: '16px 0 8px' }}>Notes</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            <input
              value={noteDraft}
              onChange={e => setNoteDraft(e.target.value)}
              placeholder="Add a note…"
              style={{
                flex: 1, padding: '6px 10px', borderRadius: 10,
                border: `1px solid ${IG.border}`, fontSize: 12, fontFamily: FONT,
              }}
            />
            <button onClick={addNote} style={{
              padding: '6px 12px', borderRadius: 10, border: 'none',
              background: IG.gradient, color: '#fff', fontSize: 12, cursor: 'pointer',
            }}>Add</button>
          </div>
          {notes.map(n => (
            <div key={n.id} style={{ fontSize: 12, color: IG.text, padding: '8px 0', borderBottom: `1px solid ${IG.border}` }}>
              {n.note}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


