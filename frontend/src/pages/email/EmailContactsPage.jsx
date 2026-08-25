import { useEffect, useState } from 'react';
import { C, FONT } from '../../constants.js';

const G = '#16a34a';

export default function EmailContactsPage() {
  const [sources, setSources] = useState([]);
  const [sourceName, setSourceName] = useState('');
  const [sheetUrl, setSheetUrl] = useState('');
  const [emptyMode, setEmptyMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');

  const [expandedSourceId, setExpandedSourceId] = useState(null);
  const [expandedSubs, setExpandedSubs] = useState([]);

  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');

  const [manualEmail, setManualEmail] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualStatus, setManualStatus] = useState('');

  const loadSources = () => {
    fetch('/api/email/sources', { credentials: 'include' })
      .then(r => r.json())
      .then(res => setSources(res.data || []))
      .catch(() => {});
  };

  useEffect(() => { loadSources(); }, []);

  async function createEmptyList() {
    if (!sourceName.trim()) {
      setStatus('Please enter a list name.');
      return;
    }
    setLoading(true);
    setStatus('Creating list...');
    try {
      const res = await fetch('/api/email/sources', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: sourceName.trim() }),
      });
      const json = await res.json();
      if (json.success) {
        setStatus(`List "${sourceName}" created!`);
        setSourceName('');
        loadSources();
      } else {
        setStatus(json.error || 'Failed to create list.');
      }
    } catch {
      setStatus('Failed to create list.');
    }
    setLoading(false);
  }

  async function importFromSheet() {
    if (!sourceName || !sheetUrl) {
      setStatus('Please enter both a name and a Google Sheet URL.');
      return;
    }
    setLoading(true);
    setStatus('Importing emails...');
    try {
      const match = sheetUrl.match(/\/d\/(.*?)\//);
      if (!match) { setStatus('Invalid Google Sheet URL'); setLoading(false); return; }
      const sheetId = match[1];
      const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
      const res = await fetch(csvUrl);
      const text = await res.text();

      function parseCsvLine(line) {
        const cells = [];
        let cur = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (ch === '"') { inQuotes = !inQuotes; }
          else if (ch === ',' && !inQuotes) { cells.push(cur); cur = ''; }
          else { cur += ch; }
        }
        cells.push(cur);
        return cells;
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const lines = text.split('\n').slice(1);
      const extracted = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        const cells = parseCsvLine(line);
        for (const cell of cells) {
          const val = cell.replace(/"/g, '').trim();
          if (emailRegex.test(val)) { extracted.push(val); break; }
        }
      }

      const unique = [...new Set(extracted)];
      if (unique.length === 0) {
        setStatus('No valid emails found in sheet.');
        setLoading(false);
        return;
      }

      const saveRes = await fetch('/api/email/subscribers/bulk', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails: unique, sourceName, sheetUrl }),
      });
      const saveJson = await saveRes.json();
      if (saveJson.success) {
        setStatus(`Imported and saved ${saveJson.added} emails to "${sourceName}"!`);
        setSourceName('');
        setSheetUrl('');
        loadSources();
      } else {
        setStatus(saveJson.error || 'Failed to save emails.');
      }
    } catch {
      setStatus('Failed to import. Make sure the sheet is public.');
    }
    setLoading(false);
  }

  function toggleExpand(source) {
    if (expandedSourceId === source.id) {
      setExpandedSourceId(null);
      setExpandedSubs([]);
      setManualEmail('');
      setManualName('');
      setManualStatus('');
      return;
    }
    setExpandedSourceId(source.id);
    setManualEmail('');
    setManualName('');
    setManualStatus('');
    fetch(`/api/email/subscribers?sourceId=${source.id}`, { credentials: 'include' })
      .then(r => r.json())
      .then(res => setExpandedSubs(res.data || []))
      .catch(() => setExpandedSubs([]));
  }

  async function addManualEmail(sourceId) {
    const email = manualEmail.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      setManualStatus('Enter a valid email address.');
      return;
    }
    setManualStatus('Adding...');
    try {
      const res = await fetch('/api/email/subscribers', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name: manualName.trim(), sourceId }),
      });
      const json = await res.json();
      if (json.success) {
        setManualStatus('Added!');
        setManualEmail('');
        setManualName('');
        fetch(`/api/email/subscribers?sourceId=${sourceId}`, { credentials: 'include' })
          .then(r => r.json())
          .then(res => setExpandedSubs(res.data || []))
          .catch(() => {});
        loadSources();
      } else {
        setManualStatus(json.error || 'Failed to add.');
      }
    } catch {
      setManualStatus('Failed to add.');
    }
  }

  function startRename(source) {
    setRenamingId(source.id);
    setRenameValue(source.name);
  }

  async function saveRename(id) {
    if (!renameValue.trim()) return;
    await fetch(`/api/email/sources/${id}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: renameValue.trim() }),
    });
    setRenamingId(null);
    loadSources();
  }

  async function deleteSource(source) {
    if (!confirm(`Delete "${source.name}" and all ${source.subscriber_count} subscribers in it? This cannot be undone.`)) return;
    await fetch(`/api/email/sources/${source.id}`, { method: 'DELETE', credentials: 'include' });
    if (expandedSourceId === source.id) { setExpandedSourceId(null); setExpandedSubs([]); }
    loadSources();
  }

  async function removeSubscriber(id, sourceId) {
    if (!confirm('Remove this subscriber?')) return;
    await fetch(`/api/email/subscribers/${id}`, { method: 'DELETE', credentials: 'include' });
    setExpandedSubs(prev => prev.filter(s => s.id !== id));
    loadSources();
  }

  const totalSubs = sources.reduce((sum, s) => sum + s.subscriber_count, 0);

  return (
    <div style={{ padding: 28, fontFamily: FONT, color: C.text, maxWidth: 900 }}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: C.text, letterSpacing: -0.5 }}>Email Contacts</div>
        <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4 }}>Import and manage your subscriber lists ({totalSubs} total)</div>
      </div>

      <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 14, padding: 22, marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 16, marginBottom: 14 }}>
          <button
            onClick={() => setEmptyMode(false)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              fontSize: 14, fontWeight: 700, color: !emptyMode ? G : C.textMuted,
              borderBottom: !emptyMode ? `2px solid ${G}` : '2px solid transparent', paddingBottom: 6,
            }}
          >
            Import from Sheet
          </button>
          <button
            onClick={() => setEmptyMode(true)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              fontSize: 14, fontWeight: 700, color: emptyMode ? G : C.textMuted,
              borderBottom: emptyMode ? `2px solid ${G}` : '2px solid transparent', paddingBottom: 6,
            }}
          >
            Create Empty List
          </button>
        </div>

        {emptyMode ? (
          <>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14 }}>Create a named list with no subscribers yet — you can add emails manually below.</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <input
                value={sourceName}
                onChange={e => setSourceName(e.target.value)}
                placeholder="List name (e.g. VIP Customers)"
                style={{ flex: 1, padding: '10px 14px', background: C.pageBg, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 13, outline: 'none', fontFamily: FONT }}
              />
              <button
                onClick={createEmptyList}
                disabled={loading}
                style={{ padding: '10px 20px', background: G, border: 'none', borderRadius: 8, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
              >
                {loading ? 'Creating...' : 'Create List'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14 }}>Name this list (e.g. "Retargeting" or "Marketing"), then paste a public Google Sheet URL. First column should have email addresses.</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <input
                value={sourceName}
                onChange={e => setSourceName(e.target.value)}
                placeholder="List name (e.g. Retargeting)"
                style={{ padding: '10px 14px', background: C.pageBg, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 13, outline: 'none', fontFamily: FONT }}
              />
              <div style={{ display: 'flex', gap: 10 }}>
                <input
                  value={sheetUrl}
                  onChange={e => setSheetUrl(e.target.value)}
                  placeholder="https://docs.google.com/spreadsheets/d/..."
                  style={{ flex: 1, padding: '10px 14px', background: C.pageBg, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 13, outline: 'none', fontFamily: FONT }}
                />
                <button
                  onClick={importFromSheet}
                  disabled={loading}
                  style={{ padding: '10px 20px', background: G, border: 'none', borderRadius: 8, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
                >
                  {loading ? 'Importing...' : 'Import'}
                </button>
              </div>
            </div>
          </>
        )}
        {status && <div style={{ marginTop: 10, fontSize: 12, color: (status.includes('Imported') || status.includes('created')) ? G : '#ef4444' }}>{status}</div>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {sources.length === 0 ? (
          <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 14, padding: 22, fontSize: 13, color: C.textMuted }}>
            No lists yet. Create one above.
          </div>
        ) : sources.map(source => (
          <div key={source.id} style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 14, padding: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => toggleExpand(source)}>
                {renamingId === source.id ? (
                  <div style={{ display: 'flex', gap: 8 }} onClick={e => e.stopPropagation()}>
                    <input
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      autoFocus
                      style={{ padding: '6px 10px', background: C.pageBg, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, fontSize: 13, outline: 'none', fontFamily: FONT }}
                    />
                    <button onClick={() => saveRename(source.id)} style={{ background: G, border: 'none', borderRadius: 6, color: '#fff', fontSize: 12, padding: '6px 12px', cursor: 'pointer' }}>Save</button>
                    <button onClick={() => setRenamingId(null)} style={{ background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, color: C.textMuted, fontSize: 12, padding: '6px 12px', cursor: 'pointer' }}>Cancel</button>
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{source.name}</div>
                    <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{source.subscriber_count} subscribers — {expandedSourceId === source.id ? 'click to collapse' : 'click to view'}</div>
                  </>
                )}
              </div>
              {renamingId !== source.id && (
                <div style={{ display: 'flex', gap: 14 }}>
                  <button onClick={() => startRename(source)} style={{ background: 'none', border: 'none', color: G, cursor: 'pointer', fontSize: 12 }}>Rename</button>
                  <button onClick={() => deleteSource(source)} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 12 }}>Delete</button>
                </div>
              )}
            </div>

            {expandedSourceId === source.id && (
              <div style={{ marginTop: 14, borderTop: `1px solid ${C.border}`, paddingTop: 14 }}>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  <input
                    value={manualEmail}
                    onChange={e => setManualEmail(e.target.value)}
                    placeholder="email@example.com"
                    style={{ flex: 1, padding: '8px 12px', background: C.pageBg, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, fontSize: 12, outline: 'none', fontFamily: FONT }}
                  />
                  <input
                    value={manualName}
                    onChange={e => setManualName(e.target.value)}
                    placeholder="Name (optional)"
                    style={{ width: 140, padding: '8px 12px', background: C.pageBg, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, fontSize: 12, outline: 'none', fontFamily: FONT }}
                  />
                  <button
                    onClick={() => addManualEmail(source.id)}
                    style={{ padding: '8px 16px', background: G, border: 'none', borderRadius: 6, color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                  >
                    Add
                  </button>
                </div>
                {manualStatus && <div style={{ fontSize: 11, color: manualStatus === 'Added!' ? G : '#ef4444', marginBottom: 10 }}>{manualStatus}</div>}

                <div style={{ maxHeight: 300, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {expandedSubs.length === 0 ? (
                    <div style={{ fontSize: 12, color: C.textMuted }}>No subscribers in this list yet.</div>
                  ) : expandedSubs.map(s => (
                    <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', background: C.pageBg, borderRadius: 6, fontSize: 12 }}>
                      <span style={{ color: C.text }}>{s.email}</span>
                      <button onClick={() => removeSubscriber(s.id, source.id)} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 11 }}>Remove</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
