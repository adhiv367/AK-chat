import { useState, useEffect } from 'react';
import { IG, FONT } from '../../constants.js';
import { getActiveIgAccount } from '../../igAccount.js';

export default function InstagramSettingsPage() {
  const [form, setForm] = useState({
    pageId: '', businessAccountId: '', accessToken: '',
    webhookUrl: '', verifyToken: '', appSecret: '',
  });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    fetch('/api/instagram/settings', { credentials: 'include' })
      .then(r => r.json())
      .then(data => data && setForm(f => ({ ...f, ...data })))
      .catch(() => {});
  }, [getActiveIgAccount()]);

  const handleSave = async () => {
    setSaving(true);
    setStatus('');
    try {
      const res = await fetch('/api/instagram/settings', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error(await res.text());
      setStatus('Saved.');
    } catch (err) {
      setStatus('Error: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const fields = [
    ['pageId', 'Meta Page ID'],
    ['businessAccountId', 'Instagram Business Account ID'],
    ['accessToken', 'Access Token'],
    ['webhookUrl', 'Webhook URL'],
    ['verifyToken', 'Verify Token'],
    ['appSecret', 'App Secret'],
  ];

  return (
    <div style={{ padding: 28, fontFamily: FONT, maxWidth: 480 }}>
      <h2 style={{ fontSize: 18, fontWeight: 800, color: IG.text, marginBottom: 20 }}>
        Instagram Settings
      </h2>
      <div style={{ background: IG.cardBg, border: `1px solid ${IG.border}`, borderRadius: 18, padding: 20 }}>
        {fields.map(([key, label]) => (
          <div key={key} style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 12, color: IG.textMuted, display: 'block', marginBottom: 5 }}>
              {label}
            </label>
            <input
              value={form[key] || ''}
              onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
              style={{
                width: '100%', padding: '9px 12px', borderRadius: 12,
                border: `1px solid ${IG.border}`, fontSize: 13, fontFamily: FONT,
                background: '#fafafa',
              }}
            />
          </div>
        ))}
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            padding: '9px 20px', borderRadius: 12, border: 'none',
            background: IG.gradient, color: '#fff', fontWeight: 700,
            fontSize: 13, cursor: 'pointer', fontFamily: FONT,
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {status && <div style={{ marginTop: 10, fontSize: 12, color: IG.textMuted }}>{status}</div>}
      </div>
    </div>
  );
}
