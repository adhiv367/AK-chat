import { useState, useEffect, useMemo } from 'react';
import { Plus, Search, Copy, Trash2, Zap } from 'lucide-react';
import { IG, FONT } from '../../constants.js';
import InstagramAutomationBuilderView from '../../components/instagram/InstagramAutomationBuilderView.jsx';
import { getActiveIgAccount } from '../../igAccount.js';

export default function InstagramWorkflowPage({ navigate, subParts }) {
  const [workflows, setWorkflows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const editingId = subParts && subParts[0];

  const load = () => {
    fetch(`/api/instagram/workflows?accountId=${getActiveIgAccount()}`, { credentials: 'include' })
      .then(r => r.json()).then(setWorkflows).catch(() => setWorkflows([])).finally(() => setLoading(false));
  };
  useEffect(() => {
  load();
  }, [getActiveIgAccount()]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return workflows;
    return workflows.filter(w => w.name.toLowerCase().includes(q));
  }, [workflows, search]);

  const createWorkflow = async () => {
    const res = await fetch('/api/instagram/workflows', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Workflow', config: { nodes: [], edges: [] } }),
    });
    const wf = await res.json();
    navigate('ig-workflow', String(wf.id));
  };

  const duplicateWorkflow = async (id, e) => {
    e.stopPropagation();
    await fetch(`/api/instagram/workflows/${id}/duplicate`, { method: 'POST', credentials: 'include' });
    load();
  };

  const deleteWorkflow = async (id, e) => {
    e.stopPropagation();
    if (!confirm('Delete this workflow?')) return;
    await fetch(`/api/instagram/workflows/${id}`, { method: 'DELETE', credentials: 'include' });
    load();
  };

  if (editingId) {
    return <InstagramAutomationBuilderView workflowId={editingId} onBack={() => navigate('ig-workflow')} />;
  }

  return (
    <div style={{ padding: 28, fontFamily: FONT }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 800, color: IG.text, margin: 0 }}>Workflow</h2>
          <div style={{ fontSize: 12, color: IG.textMuted, marginTop: 2 }}>Build and manage Instagram automation flows.</div>
        </div>
        <button onClick={createWorkflow} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '9px 16px',
          borderRadius: 12, border: 'none', background: IG.gradient, color: '#fff',
          fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: FONT,
        }}>
          <Plus size={14} /> New Workflow
        </button>
      </div>

      <div style={{ position: 'relative', margin: '20px 0', maxWidth: 320 }}>
        <Search size={14} color={IG.textMuted} style={{ position: 'absolute', left: 12, top: 11 }} />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search workflows…"
          style={{
            width: '100%', padding: '9px 12px 9px 34px', borderRadius: 12,
            border: `1px solid ${IG.border}`, fontSize: 13, fontFamily: FONT,
          }}
        />
      </div>

      {loading ? (
        <div style={{ color: IG.textMuted, fontSize: 13 }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ color: IG.textMuted, fontSize: 13 }}>No workflows found.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
          {filtered.map(w => (
            <div key={w.id} onClick={() => navigate('ig-workflow', String(w.id))} style={{
              border: `1px solid ${IG.border}`, borderRadius: 18, padding: 18,
              background: IG.cardBg, cursor: 'pointer', position: 'relative',
            }}>
              <div style={{
                width: 36, height: 36, borderRadius: '50%', background: IG.gradient,
                display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 10,
              }}>
                <Zap size={16} color="#fff" />
              </div>
              <div style={{ fontWeight: 700, fontSize: 14, color: IG.text }}>{w.name}</div>
              <div style={{ fontSize: 11, color: IG.textMuted, marginTop: 2 }}>{w.description || '—'}</div>
              <div style={{
                display: 'inline-block', marginTop: 8, fontSize: 11,
                background: IG.accentBg, color: IG.primary, padding: '3px 10px', borderRadius: 20,
                textTransform: 'capitalize',
              }}>
                {w.status}
              </div>
              <div style={{ position: 'absolute', top: 14, right: 14, display: 'flex', gap: 6 }}>
                <Copy size={14} color={IG.textMuted} style={{ cursor: 'pointer' }} onClick={(e) => duplicateWorkflow(w.id, e)} />
                <Trash2 size={14} color={IG.textMuted} style={{ cursor: 'pointer' }} onClick={(e) => deleteWorkflow(w.id, e)} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}