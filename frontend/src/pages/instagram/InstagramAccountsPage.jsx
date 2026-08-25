import { useEffect, useState } from 'react';
import { IG, FONT } from '../../constants.js';
import { getActiveIgAccount, setActiveIgAccount } from '../../igAccount.js';

export default function InstagramAccountsPage() {
  const [accounts, setAccounts] = useState([]);
  const [active, setActive] = useState(getActiveIgAccount());

  const load = () => {
    fetch('/api/instagram/accounts', { credentials: 'include' })
      .then(r => r.json())
      .then(setAccounts)
      .catch(() => {});
  };

  useEffect(() => {
    load();
    const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
    if (params.get('error')) alert('Connect failed: ' + params.get('error'));
  }, []);

  const connect = () => { window.location.href = '/api/instagram/oauth/start'; };

  const select = (id) => { setActiveIgAccount(String(id)); setActive(String(id)); };

  const disconnect = async (id) => {
    if (!confirm('Disconnect this account? Conversation history is kept.')) return;
    await fetch(`/api/instagram/accounts/${id}/disconnect`, { method: 'POST', credentials: 'include' });
    load();
  };

  const refreshToken = async (id) => {
    await fetch(`/api/instagram/accounts/${id}/refresh-token`, { method: 'POST', credentials: 'include' });
    load();
  };

  const remove = async (id) => {
    if (!confirm('Delete this account permanently?')) return;
    await fetch(`/api/instagram/accounts/${id}`, { method: 'DELETE', credentials: 'include' });
    load();
  };

  return (
    <div style={{ padding: 28, fontFamily: FONT }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ fontSize: 18, fontWeight: 800, color: IG.text }}>Instagram Accounts</h2>
        <button onClick={connect} style={{
          padding: '9px 18px', borderRadius: 12, border: 'none',
          background: IG.gradient, color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer',
        }}>+ Connect Instagram</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
        {accounts.map(a => (
          <div key={a.id} style={{
            background: IG.cardBg, border: active === String(a.id) ? `2px solid ${IG.primary}` : `1px solid ${IG.border}`,
            borderRadius: 18, padding: 16,
          }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
              {a.profilePicture
                ? <img src={a.profilePicture} alt="" style={{ width: 40, height: 40, borderRadius: '50%' }} />
                : <div style={{ width: 40, height: 40, borderRadius: '50%', background: IG.gradient }} />}
              <div>
                <div style={{ fontWeight: 700, fontSize: 14, color: IG.text }}>{a.accountName}</div>
                <div style={{ fontSize: 12, color: IG.textMuted }}>@{a.username}</div>
              </div>
            </div>
            <div style={{ fontSize: 11, color: IG.textMuted, marginBottom: 10 }}>
              Status: <b>{a.status}</b> · Last sync: {a.lastSync ? new Date(a.lastSync).toLocaleString() : '—'}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button onClick={() => select(a.id)} style={btnStyle(active === String(a.id))}>
                {active === String(a.id) ? 'Active' : 'Open'}
              </button>
              <button onClick={() => refreshToken(a.id)} style={btnStyle(false)}>Refresh Token</button>
              <button onClick={() => disconnect(a.id)} style={btnStyle(false)}>Disconnect</button>
              <button onClick={() => remove(a.id)} style={btnStyle(false)}>Delete</button>
            </div>
          </div>
        ))}
      </div>
      {accounts.length === 0 && (
        <div style={{ color: IG.textMuted, fontSize: 13, marginTop: 20 }}>
          No Instagram accounts connected yet.
        </div>
      )}
    </div>
  );
}

function btnStyle(activeState) {
  return {
    padding: '6px 12px', borderRadius: 10, border: `1px solid ${IG.border}`,
    background: activeState ? IG.gradient : '#fafafa', color: activeState ? '#fff' : IG.text,
    fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: FONT,
  };
}


