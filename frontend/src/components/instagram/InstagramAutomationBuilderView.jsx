import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Zap, MessageSquare, GitBranch, Clock, Bot, Send, UserPlus, Tag, Square,
  X, Plus, Minus, Maximize2, Save, Play, List, Power,
} from 'lucide-react';
import { IG, FONT } from '../../constants.js';

const NODE_DEFS = [
  { type: 'trigger', label: 'Trigger', Icon: Zap, group: 'Triggers' },
  { type: 'keyword', label: 'Keyword', Icon: MessageSquare, group: 'Logic' },
  { type: 'condition', label: 'Condition', Icon: GitBranch, group: 'Logic' },
  { type: 'delay', label: 'Delay', Icon: Clock, group: 'Logic' },
  { type: 'ai_reply', label: 'AI Reply', Icon: Bot, group: 'Actions' },
  { type: 'send_message', label: 'Send Message', Icon: Send, group: 'Actions' },
  { type: 'assign_user', label: 'Assign User', Icon: UserPlus, group: 'Actions' },
  { type: 'tag_contact', label: 'Tag Contact', Icon: Tag, group: 'Actions' },
  { type: 'end', label: 'End Workflow', Icon: Square, group: 'Actions' },
];
const nodeMeta = (type) => NODE_DEFS.find(n => n.type === type) || NODE_DEFS[0];
const GROUPS = ['Triggers', 'Logic', 'Actions'];
const MESSAGE_TYPES = ['Text Message', 'Image Message', 'Video Message', 'Document / PDF', 'Quick Reply', 'List Message'];

let cid = 1;
const newId = () => `n${cid++}`;

export default function InstagramAutomationBuilderView({ workflowId, onBack }) {
  const [workflow, setWorkflow] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [zoom, setZoom] = useState(1);
  const [selectedId, setSelectedId] = useState(null);
  const [connectFrom, setConnectFrom] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [history, setHistory] = useState([]);
  const [future, setFuture] = useState([]);
  const [tab, setTab] = useState('editor'); // 'editor' | 'executions'
  const [executions, setExecutions] = useState([]);
  const [execSteps, setExecSteps] = useState(null);
  const [selectedExec, setSelectedExec] = useState(null);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const canvasRef = useRef(null);
  const dragOffset = useRef({ x: 0, y: 0 });
  const skipHistoryPush = useRef(false);

  // ── Load ──────────────────────────────────────────────────────────
  useEffect(() => {
    fetch(`/api/instagram/workflows/${workflowId}`, { credentials: 'include' })
      .then(r => r.json())
      .then(wf => {
        setWorkflow(wf);
        const cfg = wf.config || { nodes: [], edges: [] };
        setNodes(cfg.nodes || []);
        setEdges(cfg.edges || []);
      });
  }, [workflowId]);

  // ── Undo/Redo ─────────────────────────────────────────────────────
  const pushHistory = useCallback((prevNodes, prevEdges) => {
    if (skipHistoryPush.current) { skipHistoryPush.current = false; return; }
    setHistory(h => [...h.slice(-49), { nodes: prevNodes, edges: prevEdges }]);
    setFuture([]);
  }, []);

  const undo = () => {
    if (!history.length) return;
    const last = history[history.length - 1];
    setFuture(f => [{ nodes, edges }, ...f]);
    skipHistoryPush.current = true;
    setNodes(last.nodes);
    setEdges(last.edges);
    setHistory(h => h.slice(0, -1));
  };
  const redo = () => {
    if (!future.length) return;
    const next = future[0];
    setHistory(h => [...h, { nodes, edges }]);
    skipHistoryPush.current = true;
    setNodes(next.nodes);
    setEdges(next.edges);
    setFuture(f => f.slice(1));
  };

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ── Node ops ──────────────────────────────────────────────────────
  const addNode = (type) => {
    pushHistory(nodes, edges);
    setNodes(ns => [...ns, { id: newId(), type, config: {}, x: 240 + ns.length * 24, y: 60 + ns.length * 50 }]);
  };

  const deleteNode = (id) => {
    pushHistory(nodes, edges);
    setNodes(ns => ns.filter(n => n.id !== id));
    setEdges(es => es.filter(e => e.from !== id && e.to !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const duplicateNode = (id) => {
    const n = nodes.find(x => x.id === id);
    if (!n) return;
    pushHistory(nodes, edges);
    setNodes(ns => [...ns, { ...n, id: newId(), x: n.x + 30, y: n.y + 30 }]);
  };

  const updateConfig = (id, config) => setNodes(ns => ns.map(n => n.id === id ? { ...n, config } : n));

  // ── Drag ──────────────────────────────────────────────────────────
  const onMouseDownNode = (e, node) => {
    e.stopPropagation();
    pushHistory(nodes, edges);
    const rect = canvasRef.current.getBoundingClientRect();
    dragOffset.current = { x: (e.clientX - rect.left) / zoom - node.x, y: (e.clientY - rect.top) / zoom - node.y };
    setDragId(node.id);
  };
  const onMouseMove = (e) => {
    if (!dragId) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / zoom - dragOffset.current.x;
    const y = (e.clientY - rect.top) / zoom - dragOffset.current.y;
    setNodes(ns => ns.map(n => n.id === dragId ? { ...n, x, y } : n));
  };
  const onMouseUp = () => setDragId(null);

  // ── Connect ───────────────────────────────────────────────────────
  const startConnect = (e, node) => { e.stopPropagation(); setConnectFrom(node.id); };
  const finishConnect = (e, node) => {
    e.stopPropagation();
    if (connectFrom && connectFrom !== node.id) {
      pushHistory(nodes, edges);
      setEdges(es => [...es.filter(x => !(x.from === connectFrom)), { from: connectFrom, to: node.id }]);
    }
    setConnectFrom(null);
  };

  // ── Validation ────────────────────────────────────────────────────
  const validate = () => {
    const errors = [];
    if (!nodes.some(n => n.type === 'trigger')) errors.push('Missing a Trigger node.');
    const ids = new Set(nodes.map(n => n.id));
    for (const e of edges) {
      if (!ids.has(e.from) || !ids.has(e.to)) errors.push('Invalid connection referencing a deleted node.');
    }
    for (const n of nodes) {
      if (n.type === 'keyword' && !n.config.keywords) errors.push(`"${nodeMeta(n.type).label}" node is missing keywords.`);
      if (n.type === 'send_message' && !n.config.message) errors.push(`"${nodeMeta(n.type).label}" node has an empty message.`);
    }
    return errors;
  };

  // ── Save / Enable / Test / Auto layout ───────────────────────────
  const save = async () => {
    setSaving(true);
    setStatus('');
    const errors = validate();
    if (errors.length) { setStatus('⚠ ' + errors[0]); setSaving(false); return; }
    try {
      await fetch(`/api/instagram/workflows/${workflowId}`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { nodes, edges } }),
      });
      setStatus('Saved.');
    } catch (err) {
      setStatus('Error: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleEnable = async () => {
    const next = workflow.status === 'active' ? 'inactive' : 'active';
    const res = await fetch(`/api/instagram/workflows/${workflowId}/status`, {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: next }),
    });
    setWorkflow(await res.json());
  };

  const testRun = async () => {
    const errors = validate();
    if (errors.length) { setStatus('⚠ ' + errors[0]); return; }
    const res = await fetch(`/api/instagram/workflows/${workflowId}/test-run`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testMessage: 'hello, what is the price?' }),
    });
    const result = await res.json();
    setStatus(result.ok ? `Test run: ${result.steps.length} step(s) executed.` : `Test failed: ${result.error}`);
    if (tab === 'executions') loadExecutions();
  };

  const autoLayout = () => {
    pushHistory(nodes, edges);
    const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
    const incoming = new Set(edges.map(e => e.to));
    const root = nodes.find(n => !incoming.has(n.id)) || nodes[0];
    if (!root) return;
    const order = [];
    const seen = new Set();
    const walk = (id) => {
      if (!id || seen.has(id)) return;
      seen.add(id); order.push(id);
      edges.filter(e => e.from === id).forEach(e => walk(e.to));
    };
    walk(root.id);
    nodes.forEach(n => { if (!seen.has(n.id)) order.push(n.id); });
    setNodes(order.map((id, i) => ({ ...byId[id], x: 240, y: 40 + i * 110 })));
  };

  // ── Executions ────────────────────────────────────────────────────
  const loadExecutions = () => {
    fetch(`/api/instagram/workflows/${workflowId}/executions`, { credentials: 'include' })
      .then(r => r.json()).then(setExecutions).catch(() => setExecutions([]));
  };
  useEffect(() => { if (tab === 'executions') loadExecutions(); }, [tab]);

  const openExecution = (exec) => {
    setSelectedExec(exec);
    fetch(`/api/instagram/workflows/executions/${exec.id}/steps`, { credentials: 'include' })
      .then(r => r.json()).then(setExecSteps).catch(() => setExecSteps([]));
  };

  if (!workflow) return <div style={{ padding: 28, fontSize: 13, color: IG.textMuted, fontFamily: FONT }}>Loading…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: FONT }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 20px', borderBottom: `1px solid ${IG.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <button onClick={onBack} style={{ border: 'none', background: 'transparent', color: IG.textMuted, fontSize: 13, cursor: 'pointer', fontFamily: FONT }}>← Back</button>
          <div style={{ fontWeight: 800, fontSize: 14, color: IG.text }}>{workflow.name}</div>
          <span style={{ fontSize: 10, padding: '2px 10px', borderRadius: 20, background: IG.accentBg, color: IG.primary, textTransform: 'uppercase', fontWeight: 700 }}>
            {workflow.status}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <div style={{ display: 'flex', borderRadius: 10, overflow: 'hidden', border: `1px solid ${IG.border}` }}>
            <button onClick={() => setTab('editor')} style={tabBtn(tab === 'editor')}>Editor</button>
            <button onClick={() => setTab('executions')} style={tabBtn(tab === 'executions')}>Executions</button>
          </div>
          {status && <span style={{ fontSize: 11, color: IG.textMuted, maxWidth: 220 }}>{status}</span>}
          {tab === 'editor' && (
            <>
              <IconBtn onClick={undo} title="Undo (Ctrl+Z)">↶</IconBtn>
              <IconBtn onClick={redo} title="Redo (Ctrl+Y)">↷</IconBtn>
              <IconBtn onClick={() => setZoom(z => Math.max(0.4, z - 0.1))}><Minus size={13} /></IconBtn>
              <span style={{ fontSize: 11, color: IG.textMuted, width: 34, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
              <IconBtn onClick={() => setZoom(z => Math.min(2, z + 0.1))}><Plus size={13} /></IconBtn>
              <IconBtn onClick={() => setZoom(1)}><Maximize2 size={13} /></IconBtn>
              <button onClick={autoLayout} style={btnStyle('outline')}>Auto Layout</button>
              <button onClick={testRun} style={btnStyle('outline')}><Play size={13} /> Test Run</button>
              <button onClick={toggleEnable} style={btnStyle(workflow.status === 'active' ? 'solid' : 'outline')}>
                <Power size={13} /> {workflow.status === 'active' ? 'Disable' : 'Enable'}
              </button>
              <button onClick={save} disabled={saving} style={btnStyle('solid')}><Save size={13} /> {saving ? 'Saving…' : 'Save'}</button>
            </>
          )}
        </div>
      </div>

      {tab === 'editor' ? (
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* Palette */}
          <div style={{ width: 170, borderRight: `1px solid ${IG.border}`, padding: 14, overflow: 'auto', flexShrink: 0 }}>
            {GROUPS.map(g => (
              <div key={g} style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: IG.textMuted, textTransform: 'uppercase', marginBottom: 8 }}>{g}</div>
                {NODE_DEFS.filter(n => n.group === g).map(n => (
                  <button key={n.type} onClick={() => addNode(n.type)} style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%', marginBottom: 6,
                    padding: '8px 10px', borderRadius: 12, border: `1px solid ${IG.border}`,
                    background: IG.cardBg, cursor: 'pointer', fontFamily: FONT, fontSize: 12, fontWeight: 600, color: IG.text, textAlign: 'left',
                  }}>
                    <n.Icon size={13} color={IG.primary} /> {n.label}
                  </button>
                ))}
              </div>
            ))}
          </div>

          {/* Canvas */}
          <div
            ref={canvasRef}
            onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}
            onClick={() => setSelectedId(null)}
            style={{
              flex: 1, position: 'relative', overflow: 'auto',
              background: 'repeating-linear-gradient(0deg, #fafafa, #fafafa 24px, #f2f2f2 25px), repeating-linear-gradient(90deg, transparent, transparent 24px, #f2f2f2 25px)',
            }}
          >
            <div style={{ transform: `scale(${zoom})`, transformOrigin: '0 0', position: 'relative', width: 2000, height: 1400 }}>
              <svg style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
                <defs>
                  <marker id="ig-arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
                    <path d="M0,0 L8,4 L0,8 Z" fill={IG.primary} />
                  </marker>
                </defs>
                {edges.map((e, i) => {
                  const from = nodes.find(n => n.id === e.from), to = nodes.find(n => n.id === e.to);
                  if (!from || !to) return null;
                  return <line key={i} x1={from.x + 90} y1={from.y + 30} x2={to.x} y2={to.y + 30} stroke={IG.primary} strokeWidth={2} markerEnd="url(#ig-arrow)" />;
                })}
              </svg>

              {nodes.map(node => {
                const meta = nodeMeta(node.type);
                const selected = selectedId === node.id;
                return (
                  <div key={node.id}
                    onMouseDown={(e) => onMouseDownNode(e, node)}
                    onClick={(e) => { e.stopPropagation(); connectFrom ? finishConnect(e, node) : setSelectedId(node.id); }}
                    style={{
                      position: 'absolute', left: node.x, top: node.y, width: 180,
                      background: IG.cardBg, borderRadius: 16, padding: 12, cursor: 'grab', userSelect: 'none',
                      border: `2px solid ${connectFrom === node.id ? IG.primary : selected ? IG.text : IG.border}`,
                      boxShadow: selected ? '0 4px 14px rgba(0,0,0,.1)' : '0 2px 8px rgba(0,0,0,.05)',
                    }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ width: 22, height: 22, borderRadius: '50%', background: IG.gradient, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <meta.Icon size={12} color="#fff" />
                        </div>
                        <span style={{ fontSize: 12, fontWeight: 700, color: IG.text }}>{meta.label}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <Copy2 onClick={(e) => { e.stopPropagation(); duplicateNode(node.id); }} />
                        <X size={13} color={IG.textMuted} style={{ cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); deleteNode(node.id); }} />
                      </div>
                    </div>
                    <div style={{ fontSize: 11, color: IG.textMuted }}>
                      {Object.keys(node.config || {}).length ? summarize(node) : 'Click to configure'}
                    </div>
                    <div onMouseDown={(e) => e.stopPropagation()} onClick={(e) => startConnect(e, node)} title="Drag to connect"
                      style={{ position: 'absolute', right: -8, top: '50%', transform: 'translateY(-50%)', width: 16, height: 16, borderRadius: '50%', background: IG.gradient, border: '2px solid #fff', cursor: 'crosshair' }} />
                  </div>
                );
              })}
            </div>

            {/* Mini-map */}
            <div style={{
              position: 'fixed', bottom: 16, right: 16, width: 160, height: 110, background: IG.cardBg,
              border: `1px solid ${IG.border}`, borderRadius: 12, overflow: 'hidden', boxShadow: '0 2px 10px rgba(0,0,0,.08)',
            }}>
              <div style={{ fontSize: 9, color: IG.textMuted, padding: '4px 8px', fontWeight: 700, textTransform: 'uppercase' }}>Mini-map</div>
              <div style={{ position: 'relative', width: '100%', height: 84 }}>
                {nodes.map(n => (
                  <div key={n.id} style={{
                    position: 'absolute', left: n.x / 12, top: n.y / 12, width: 14, height: 6,
                    background: IG.primary, borderRadius: 2,
                  }} />
                ))}
              </div>
            </div>
          </div>

          {/* Inspector */}
          {selectedId && (
            <Inspector node={nodes.find(n => n.id === selectedId)} onChange={(cfg) => updateConfig(selectedId, cfg)} onClose={() => setSelectedId(null)} />
          )}
        </div>
      ) : (
        // Executions tab
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <div style={{ width: 300, borderRight: `1px solid ${IG.border}`, overflow: 'auto' }}>
            <div style={{ padding: '12px 16px', fontSize: 11, fontWeight: 800, color: IG.textMuted, textTransform: 'uppercase' }}>
              Executions ({executions.length})
            </div>
            {executions.length === 0 ? (
              <div style={{ padding: '0 16px', fontSize: 12, color: IG.textMuted }}>No runs yet.</div>
            ) : executions.map(ex => (
              <div key={ex.id} onClick={() => openExecution(ex)} style={{
                padding: '10px 16px', cursor: 'pointer', borderBottom: `1px solid ${IG.border}`,
                background: selectedExec?.id === ex.id ? IG.accentBg : 'transparent',
              }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: ex.status === 'error' ? '#c0392b' : IG.primary }}>{ex.status}</div>
                <div style={{ fontSize: 11, color: IG.textMuted, marginTop: 2 }}>{new Date(ex.started_at).toLocaleString()}</div>
              </div>
            ))}
          </div>
          <div style={{ flex: 1, padding: 20, overflow: 'auto' }}>
            {!execSteps ? (
              <div style={{ fontSize: 13, color: IG.textMuted }}>Select an execution to view its node-by-node replay.</div>
            ) : (
              execSteps.map((s, i) => (
                <div key={s.id} style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: 14, marginBottom: 10,
                  border: `1px solid ${s.status === 'error' ? '#e0a1a1' : IG.border}`, borderRadius: 14,
                  background: s.status === 'error' ? '#fdf2f2' : IG.cardBg,
                }}>
                  <div style={{ width: 28, height: 28, borderRadius: '50%', background: IG.gradient, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <span style={{ color: '#fff', fontSize: 11, fontWeight: 700 }}>{i + 1}</span>
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13, color: IG.text }}>{s.node_type}</div>
                    <div style={{ fontSize: 11, color: IG.textMuted }}>{s.result}</div>
                  </div>
                  <span style={{ marginLeft: 'auto', fontSize: 10, padding: '2px 8px', borderRadius: 20, background: s.status === 'error' ? '#f6d5d5' : IG.accentBg, color: s.status === 'error' ? '#c0392b' : IG.primary }}>
                    {s.status}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function summarize(node) {
  const c = node.config || {};
  if (node.type === 'keyword') return `Keywords: ${c.keywords}`;
  if (node.type === 'send_message') return `${c.messageType || 'Text'}: ${(c.message || '').slice(0, 30)}`;
  if (node.type === 'delay') return `${c.seconds || 0}s delay`;
  if (node.type === 'condition') return `${c.field || ''} ${c.operator || ''} ${c.value || ''}`;
  return 'Configured ✓';
}

function Copy2({ onClick }) {
  return <span onClick={onClick} title="Duplicate" style={{ cursor: 'pointer', fontSize: 11, color: '#999' }}>⧉</span>;
}

function tabBtn(active) {
  return { padding: '7px 14px', border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: FONT, background: active ? IG.gradient : IG.cardBg, color: active ? '#fff' : IG.textMuted };
}
function btnStyle(kind) {
  return {
    display: 'flex', alignItems: 'center', gap: 5, padding: '7px 12px', borderRadius: 10,
    fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: FONT,
    border: kind === 'outline' ? `1px solid ${IG.border}` : 'none',
    background: kind === 'outline' ? IG.cardBg : IG.gradient,
    color: kind === 'outline' ? IG.text : '#fff',
  };
}
function IconBtn({ children, onClick, title }) {
  return <button onClick={onClick} title={title} style={{ width: 26, height: 26, borderRadius: 8, border: `1px solid ${IG.border}`, background: IG.cardBg, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: IG.text }}>{children}</button>;
}

function Inspector({ node, onChange, onClose }) {
  const cfg = node.config || {};
  const set = (key, value) => onChange({ ...cfg, [key]: value });
  const input = { width: '100%', padding: '8px 10px', borderRadius: 10, border: `1px solid ${IG.border}`, fontSize: 12, fontFamily: FONT, marginTop: 4, marginBottom: 12 };
  const label = { fontSize: 11, color: IG.textMuted, fontWeight: 600 };
  const meta = nodeMeta(node.type);

  return (
    <div style={{ width: 320, borderLeft: `1px solid ${IG.border}`, padding: 20, overflow: 'auto', flexShrink: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontWeight: 800, fontSize: 14, color: IG.text }}>Configure: {meta.label}</div>
        <X size={16} style={{ cursor: 'pointer' }} onClick={onClose} />
      </div>

      {node.type === 'trigger' && (
        <>
          <label style={label}>Trigger Type</label>
          <select style={input} value={cfg.triggerType || 'keyword'} onChange={e => set('triggerType', e.target.value)}>
            <option value="keyword">Keyword Trigger</option>
            <option value="new_conversation">New Conversation</option>
          </select>
        </>
      )}

      {node.type === 'keyword' && (
        <>
          <label style={label}>Keywords (comma-separated)</label>
          <input style={input} value={cfg.keywords || ''} onChange={e => set('keywords', e.target.value)} placeholder="hi, hello, price" />
          <label style={label}>Match Type</label>
          <select style={input} value={cfg.matchType || 'contains'} onChange={e => set('matchType', e.target.value)}>
            <option value="exact">Exact match</option>
            <option value="contains">Contains</option>
            <option value="starts">Starts with</option>
          </select>
          <label style={{ ...label, display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={!!cfg.caseSensitive} onChange={e => set('caseSensitive', e.target.checked)} />
            Case sensitive
          </label>
        </>
      )}

      {node.type === 'condition' && (
        <>
          <label style={label}>Field</label>
          <input style={input} value={cfg.field || ''} onChange={e => set('field', e.target.value)} placeholder="tag / status" />
          <label style={label}>Operator</label>
          <select style={input} value={cfg.operator || '=='} onChange={e => set('operator', e.target.value)}>
            <option value="==">equals</option>
            <option value="!=">not equals</option>
            <option value="contains">contains</option>
          </select>
          <label style={label}>Value</label>
          <input style={input} value={cfg.value || ''} onChange={e => set('value', e.target.value)} />
        </>
      )}

      {node.type === 'delay' && (
        <>
          <label style={label}>Delay (seconds)</label>
          <input type="number" style={input} value={cfg.seconds || ''} onChange={e => set('seconds', e.target.value)} />
        </>
      )}

      {node.type === 'ai_reply' && (
        <>
          <label style={label}>Instructions for AI</label>
          <textarea style={{ ...input, minHeight: 70 }} value={cfg.instructions || ''} onChange={e => set('instructions', e.target.value)} placeholder="Answer questions about pricing politely…" />
        </>
      )}

      {node.type === 'send_message' && (
        <>
          <label style={label}>Message Type</label>
          <select style={input} value={cfg.messageType || 'Text Message'} onChange={e => set('messageType', e.target.value)}>
            {MESSAGE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <label style={label}>Message</label>
          <textarea style={{ ...input, minHeight: 80 }} value={cfg.message || ''} onChange={e => set('message', e.target.value)} placeholder="Insert variables like {{name}}" />
          <label style={{ ...label, display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={!!cfg.waitForReply} onChange={e => set('waitForReply', e.target.checked)} />
            Wait for customer's reply before continuing
          </label>
        </>
      )}

      {node.type === 'assign_user' && (
        <>
          <label style={label}>User ID</label>
          <input style={input} value={cfg.userId || ''} onChange={e => set('userId', e.target.value)} />
        </>
      )}

      {node.type === 'tag_contact' && (
        <>
          <label style={label}>Tag</label>
          <input style={input} value={cfg.tag || ''} onChange={e => set('tag', e.target.value)} />
        </>
      )}

      {node.type === 'end' && (
        <div style={{ fontSize: 12, color: IG.textMuted }}>No configuration needed — this ends the workflow.</div>
      )}
    </div>
  );
}


















