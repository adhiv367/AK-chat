import { useState, useRef } from 'react';
import { X } from 'lucide-react';
import { IG, FONT } from '../../constants.js';
import { NODE_TYPES } from './InstagramWorkflowNodePalette.jsx';

const nodeMeta = (type) => NODE_TYPES.find(n => n.type === type) || NODE_TYPES[0];

export default function InstagramWorkflowCanvas({ nodes, setNodes, edges, setEdges }) {
  const [dragId, setDragId] = useState(null);
  const [connectFrom, setConnectFrom] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const canvasRef = useRef(null);
  const dragOffset = useRef({ x: 0, y: 0 });

  const onMouseDownNode = (e, node) => {
    e.stopPropagation();
    const rect = canvasRef.current.getBoundingClientRect();
    dragOffset.current = {
      x: e.clientX - rect.left - node.x,
      y: e.clientY - rect.top - node.y,
    };
    setDragId(node.clientId);
  };

  const onMouseMove = (e) => {
    if (!dragId) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left - dragOffset.current.x;
    const y = e.clientY - rect.top - dragOffset.current.y;
    setNodes(ns => ns.map(n => n.clientId === dragId ? { ...n, x, y } : n));
  };

  const onMouseUp = () => setDragId(null);

  const startConnect = (e, node) => {
    e.stopPropagation();
    setConnectFrom(node.clientId);
  };

  const finishConnect = (e, node) => {
    e.stopPropagation();
    if (connectFrom && connectFrom !== node.clientId) {
      setEdges(es => [...es, { sourceClientId: connectFrom, targetClientId: node.clientId }]);
    }
    setConnectFrom(null);
  };

  const deleteNode = (clientId) => {
    setNodes(ns => ns.filter(n => n.clientId !== clientId));
    setEdges(es => es.filter(e => e.sourceClientId !== clientId && e.targetClientId !== clientId));
  };

  const updateConfig = (clientId, config) => {
    setNodes(ns => ns.map(n => n.clientId === clientId ? { ...n, config } : n));
  };

  const editingNode = nodes.find(n => n.clientId === editingId);

  return (
    <div
      ref={canvasRef}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      style={{
        flex: 1, position: 'relative', overflow: 'auto',
        background: 'repeating-linear-gradient(0deg, #fafafa, #fafafa 24px, #f3f3f3 25px), repeating-linear-gradient(90deg, transparent, transparent 24px, #f3f3f3 25px)',
        minHeight: 500,
      }}
    >
      {/* Edges */}
      <svg style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        {edges.map((e, i) => {
          const from = nodes.find(n => n.clientId === e.sourceClientId);
          const to = nodes.find(n => n.clientId === e.targetClientId);
          if (!from || !to) return null;
          const x1 = from.x + 90, y1 = from.y + 30, x2 = to.x, y2 = to.y + 30;
          return (
            <line key={i} x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={IG.primary} strokeWidth={2} markerEnd="url(#arrow)" />
          );
        })}
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill={IG.primary} />
          </marker>
        </defs>
      </svg>

      {/* Nodes */}
      {nodes.map(node => {
        const meta = nodeMeta(node.type);
        return (
          <div
            key={node.clientId}
            onMouseDown={(e) => onMouseDownNode(e, node)}
            onClick={(e) => connectFrom ? finishConnect(e, node) : null}
            style={{
              position: 'absolute', left: node.x, top: node.y, width: 180,
              background: IG.cardBg, border: `2px solid ${connectFrom === node.clientId ? IG.primary : IG.border}`,
              borderRadius: 16, padding: 12, cursor: 'grab', userSelect: 'none',
              boxShadow: '0 2px 8px rgba(0,0,0,.06)', fontFamily: FONT,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{
                  width: 22, height: 22, borderRadius: '50%', background: IG.gradient,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  <meta.Icon size={12} color="#fff" />
                </div>
                <span style={{ fontSize: 12, fontWeight: 700, color: IG.text }}>{meta.label}</span>
              </div>
              <X size={13} color={IG.textMuted} style={{ cursor: 'pointer' }}
                 onClick={(e) => { e.stopPropagation(); deleteNode(node.clientId); }} />
            </div>
            <div
              onClick={(e) => { e.stopPropagation(); setEditingId(node.clientId); }}
              style={{ fontSize: 11, color: IG.textMuted, cursor: 'pointer' }}
            >
              {Object.keys(node.config || {}).length ? 'Configured ✓' : 'Click to configure'}
            </div>
            <div
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => startConnect(e, node)}
              title="Drag a connection from here"
              style={{
                position: 'absolute', right: -8, top: '50%', transform: 'translateY(-50%)',
                width: 16, height: 16, borderRadius: '50%', background: IG.gradient,
                border: '2px solid #fff', cursor: 'crosshair',
              }}
            />
          </div>
        );
      })}

      {/* Simple config panel */}
      {editingNode && (
        <div style={{
          position: 'fixed', top: 0, right: 0, width: 320, height: '100vh',
          background: IG.cardBg, borderLeft: `1px solid ${IG.border}`,
          padding: 20, boxShadow: '-4px 0 20px rgba(0,0,0,.08)', zIndex: 500,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div style={{ fontWeight: 800, fontSize: 14, color: IG.text }}>
              Configure: {nodeMeta(editingNode.type).label}
            </div>
            <X size={16} style={{ cursor: 'pointer' }} onClick={() => setEditingId(null)} />
          </div>
          <NodeConfigForm node={editingNode} onChange={(cfg) => updateConfig(editingNode.clientId, cfg)} />
        </div>
      )}
    </div>
  );
}

function NodeConfigForm({ node, onChange }) {
  const cfg = node.config || {};
  const set = (key, value) => onChange({ ...cfg, [key]: value });
  const inputStyle = {
    width: '100%', padding: '8px 10px', borderRadius: 10,
    border: `1px solid ${IG.border}`, fontSize: 12, fontFamily: FONT, marginTop: 4, marginBottom: 12,
  };
  const labelStyle = { fontSize: 11, color: IG.textMuted, fontWeight: 600 };

  switch (node.type) {
    case 'keyword':
      return (
        <>
          <label style={labelStyle}>Keywords (comma-separated)</label>
          <input style={inputStyle} value={cfg.keywords || ''} onChange={e => set('keywords', e.target.value)} placeholder="hi, hello, price" />
        </>
      );
    case 'condition':
      return (
        <>
          <label style={labelStyle}>Field</label>
          <input style={inputStyle} value={cfg.field || ''} onChange={e => set('field', e.target.value)} placeholder="tag / status / etc." />
          <label style={labelStyle}>Operator</label>
          <input style={inputStyle} value={cfg.operator || ''} onChange={e => set('operator', e.target.value)} placeholder="== / != / contains" />
          <label style={labelStyle}>Value</label>
          <input style={inputStyle} value={cfg.value || ''} onChange={e => set('value', e.target.value)} />
        </>
      );
    case 'delay':
      return (
        <>
          <label style={labelStyle}>Delay (seconds)</label>
          <input type="number" style={inputStyle} value={cfg.seconds || ''} onChange={e => set('seconds', e.target.value)} />
        </>
      );
    case 'send_message':
      return (
        <>
          <label style={labelStyle}>Message</label>
          <textarea style={{ ...inputStyle, minHeight: 80 }} value={cfg.message || ''} onChange={e => set('message', e.target.value)} />
        </>
      );
    case 'assign_user':
      return (
        <>
          <label style={labelStyle}>User ID</label>
          <input style={inputStyle} value={cfg.userId || ''} onChange={e => set('userId', e.target.value)} />
        </>
      );
    case 'tag_contact':
      return (
        <>
          <label style={labelStyle}>Tag</label>
          <input style={inputStyle} value={cfg.tag || ''} onChange={e => set('tag', e.target.value)} />
        </>
      );
    default:
      return <div style={{ fontSize: 12, color: IG.textMuted }}>No configuration needed for this node.</div>;
  }
}


