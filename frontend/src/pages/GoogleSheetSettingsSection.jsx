import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Save, CheckCircle2, AlertTriangle } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT } from '../constants.js';

const inputStyle = {
  padding: '9px 12px', borderRadius: 8, border: `1px solid ${C.border}`,
  fontSize: 13, fontFamily: FONT, color: C.text, background: 'var(--c-cardBg)',
};
const labelStyle = { fontSize: 12, fontWeight: 600, color: C.textMuted, marginBottom: 6, display: 'block' };
const btnPrimary = {
  padding: '9px 16px', background: C.primary, color: '#fff', border: 'none', borderRadius: 8,
  fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: FONT, display: 'inline-flex',
  alignItems: 'center', gap: 6,
};
const btnGhost = {
  padding: '9px 16px', background: 'transparent', color: C.text, border: `1.5px solid ${C.border}`,
  borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: FONT,
  display: 'inline-flex', alignItems: 'center', gap: 6,
};

// Drop this component inside AdminSettingsPage.jsx as a new tab, e.g.:
//   {activeTab === 'google-sheet' && <GoogleSheetSettingsSection />}
// and add a tab button for it next to your other Settings tabs.
export default function GoogleSheetSettingsSection() {
  const [settings, setSettings] = useState(null);
  const [sheetUrl, setSheetUrl] = useState('');
  const [sheetName, setSheetName] = useState('');
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState('');
  const [log, setLog] = useState([]);

  const load = useCallback(() => {
    api.googleSheetSettings.get().then((s) => {
      setSettings(s);
      if (s) { setSheetUrl(s.sheet_url || ''); setSheetName(s.sheet_name || ''); }
    }).catch(() => {});
    api.googleSheetSettings.syncLog().then(setLog).catch(() => setLog([]));
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(load, 15000); // refresh status every 15s
    return () => clearInterval(t);
  }, [load]);

  const handleSave = async () => {
    if (!sheetUrl.trim()) { setMsg('Enter a Google Sheet URL first.'); return; }
    setSaving(true); setMsg('');
    try {
      await api.googleSheetSettings.save(sheetUrl.trim(), sheetName.trim());
      setMsg('Saved. Auto-sync will pick up new rows within a minute.');
      load();
    } catch (err) {
      setMsg(`Save failed: ${err.message}`);
    } finally { setSaving(false); }
  };

  const handleSyncNow = async () => {
    setSyncing(true); setMsg('');
    try {
      await api.googleSheetSettings.syncNow();
      setMsg('Sync triggered.');
      setTimeout(load, 1500);
    } catch (err) {
      setMsg(`Sync failed: ${err.message}`);
    } finally { setSyncing(false); }
  };

  return (
    <div style={{ padding: 20, fontFamily: FONT, maxWidth: 720 }}>
      <h3 style={{ margin: 0, marginBottom: 4, fontSize: 16, color: C.text }}>Google Sheet Settings</h3>
      <p style={{ color: C.textMuted, fontSize: 12.5, marginBottom: 18 }}>
        Configure this once. Your Shopify orders sheet will sync into Contacts automatically every minute.
      </p>

      <label style={labelStyle}>Google Sheet URL</label>
      <input
        style={{ ...inputStyle, width: '100%', marginBottom: 12 }}
        value={sheetUrl}
        onChange={(e) => setSheetUrl(e.target.value)}
        placeholder="https://docs.google.com/spreadsheets/d/.../edit"
      />
      <div style={{ fontSize: 11.5, color: C.textMuted, marginBottom: 12 }}>
        Sheet must be shared as "Anyone with the link can view".
      </div>

      <label style={labelStyle}>Sheet Name (optional)</label>
      <input
        style={{ ...inputStyle, width: '100%', marginBottom: 16 }}
        value={sheetName}
        onChange={(e) => setSheetName(e.target.value)}
        placeholder="e.g. Orders"
      />

      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <button style={btnPrimary} onClick={handleSave} disabled={saving}>
          <Save size={14} /> {saving ? 'Saving…' : 'Save'}
        </button>
        <button style={btnGhost} onClick={handleSyncNow} disabled={syncing || !settings}>
          <RefreshCw size={14} /> {syncing ? 'Syncing…' : 'Sync Now'}
        </button>
      </div>

      {msg && <div style={{ fontSize: 12.5, marginBottom: 16, color: msg.includes('failed') ? '#A32D2D' : '#1a7f37' }}>{msg}</div>}

      {settings && (
        <div style={{ background: '#fafaf9', borderRadius: 8, padding: 12, border: `1px solid ${C.border}`, marginBottom: 20, fontSize: 12.5 }}>
          <div><strong>Last synced:</strong> {settings.last_synced_at ? new Date(settings.last_synced_at).toLocaleString() : 'Never'}</div>
          <div><strong>Rows synced so far:</strong> {settings.last_synced_row}</div>
          {settings.last_error_message && (
            <div style={{ color: '#A32D2D', marginTop: 6, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
              <AlertTriangle size={13} style={{ marginTop: 1, flexShrink: 0 }} />
              {settings.last_error_message}
            </div>
          )}
        </div>
      )}

      <h4 style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 10 }}>Recent Sync Log</h4>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${C.border}` }}>
            <th style={{ padding: 6, textAlign: 'left' }}>Started</th>
            <th style={{ padding: 6, textAlign: 'left' }}>Rows</th>
            <th style={{ padding: 6, textAlign: 'left' }}>Created</th>
            <th style={{ padding: 6, textAlign: 'left' }}>Updated</th>
            <th style={{ padding: 6, textAlign: 'left' }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {log.map((l) => (
            <tr key={l.id} style={{ borderBottom: `1px solid ${C.border}` }}>
              <td style={{ padding: 6 }}>{new Date(l.started_at).toLocaleTimeString()}</td>
              <td style={{ padding: 6 }}>{l.rows_read}</td>
              <td style={{ padding: 6 }}>{l.contacts_created}</td>
              <td style={{ padding: 6 }}>{l.contacts_updated}</td>
              <td style={{ padding: 6 }}>
                {l.status === 'success'
                  ? <CheckCircle2 size={13} color="#1a7f37" style={{ verticalAlign: 'middle' }} />
                  : <AlertTriangle size={13} color="#A32D2D" style={{ verticalAlign: 'middle' }} />}
              </td>
            </tr>
          ))}
          {log.length === 0 && (
            <tr><td colSpan={5} style={{ padding: 12, textAlign: 'center', color: C.textMuted }}>No syncs yet.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}






