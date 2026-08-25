import { useState, useEffect } from 'react';
import { IG, FONT } from '../../constants.js';
import { getActiveIgAccount } from '../../igAccount';

function Avatar({ name, size = 56 }) {
  const initial = (name || '?').charAt(0).toUpperCase();
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: IG.gradient, color: '#fff', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      fontWeight: 700, fontSize: size * 0.36, fontFamily: FONT, margin: '0 auto 10px',
    }}>
      {initial}
    </div>
  );
}

export default function InstagramContactsPage() {
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/instagram/contacts?accountId=${getActiveIgAccount()}`, { credentials: 'include' })
      .then(r => r.json())
      .then(setContacts)
      .catch(() => setContacts([]))
      .finally(() => setLoading(false));
  }, [getActiveIgAccount()]);

  return (
    <div style={{ padding: 28, fontFamily: FONT }}>
      <h2 style={{ fontSize: 18, fontWeight: 800, color: IG.text, marginBottom: 20 }}>
        Contacts
      </h2>
      {loading ? (
        <div style={{ color: IG.textMuted, fontSize: 13 }}>Loading…</div>
      ) : contacts.length === 0 ? (
        <div style={{ color: IG.textMuted, fontSize: 13 }}>No Instagram contacts yet.</div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
          gap: 16,
        }}>
          {contacts.map(c => (
            <div key={c.id} style={{
              border: `1px solid ${IG.border}`, borderRadius: 18,
              padding: '20px 12px', textAlign: 'center', background: IG.cardBg,
            }}>
              <Avatar name={c.display_name || c.username} />
              <div style={{ fontWeight: 700, fontSize: 13, color: IG.text }}>
                {c.display_name || '—'}
              </div>
              <div style={{ fontSize: 12, color: IG.textMuted, marginTop: 2 }}>
                @{c.username}
              </div>
              {c.last_message && (
                <div style={{
                  fontSize: 11, color: IG.textMuted, marginTop: 8,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {c.last_message}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}