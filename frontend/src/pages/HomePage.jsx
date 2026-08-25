import { useState, useEffect } from 'react';
import {
  Users, UserPlus, Inbox, Send, Activity, Zap, MessageCircle,
  Megaphone, AlertTriangle, Info, ArrowUpRight, ArrowDownRight,
  FileText, Trophy, RefreshCw, X, Sparkles,
} from 'lucide-react';
import { C, FONT, MONO, DISPLAY_FONT } from '../constants.js';
import { api } from '../api.js';
import { usePolling } from '../hooks/usePolling.js';

const RANGES = [
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
];

const KPI_ICONS = {
  contacts: Users, newLeads: UserPlus, open: Inbox, sent: Send,
  response: Activity, automations: Zap, convos: MessageCircle,
};

// Fixed teal/indigo palette used everywhere a chart needs multiple colors —
// deliberately ignores any color a tag might carry in the backend data, so
// charts always stay on-theme regardless of what tags.color is set to.
const CHART_PALETTE = ['#0D9488', '#2DD4BF', '#818CF8', '#5EEAD4', '#6366F1', '#99F6E4', '#4338CA', '#0F766E'];

const fmt = (n) => (n ?? 0).toLocaleString('en-IN');
const shortDate = (s) => new Date(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

// ── Small custom tooltip for KPI info icons ────────────────────────────
function InfoIcon({ text }) {
  const [show, setShow] = useState(false);
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex', marginLeft: 6 }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <Info size={13} strokeWidth={2.5} style={{ color: C.textMuted, cursor: 'help' }} />
      {show && (
        <span style={{
          position: 'absolute', bottom: '150%', left: '50%', transform: 'translateX(-50%)',
          background: '#181D28', color: '#fff', fontSize: 11, lineHeight: 1.5,
          padding: '8px 10px', borderRadius: 9, width: 216, zIndex: 60,
          boxShadow: C.shadowMd, fontFamily: FONT, fontWeight: 500,
          pointerEvents: 'none', textAlign: 'left', border: '1px solid rgba(255,255,255,.08)',
        }}>{text}</span>
      )}
    </span>
  );
}

function Card({ children, style }) {
  return (
    <div style={{
      background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 18,
      boxShadow: C.shadowSm, padding: 22, ...style,
    }}>{children}</div>
  );
}

function SectionTitle({ icon: Icon, children, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {Icon && (
          <span style={{
            width: 28, height: 28, borderRadius: 9, background: C.primaryLight,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <Icon size={14} strokeWidth={2.3} style={{ color: '#2DD4BF' }} />
          </span>
        )}
        <span style={{ fontSize: 15, fontWeight: 600, color: C.text, fontFamily: DISPLAY_FONT, letterSpacing: '-.01em' }}>{children}</span>
      </div>
      {right}
    </div>
  );
}

// ── KPI card (number is a clickable drill-down) ─────────────────────────
function KpiCard({ tile, onSelect }) {
  const Icon = KPI_ICONS[tile.key] || Activity;
  const value = tile.unit === '%' ? `${tile.value}%` : fmt(tile.value);
  const hasDelta = tile.delta != null;
  const up = hasDelta && tile.delta >= 0;
  return (
    <Card style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', fontSize: 11.5, fontWeight: 700, color: C.textSecondary, fontFamily: FONT, letterSpacing: '.04em', textTransform: 'uppercase' }}>
          {tile.label}
          {tile.tooltip && <InfoIcon text={tile.tooltip} />}
        </div>
        <span style={{
          width: 32, height: 32, borderRadius: 10, background: C.primaryLight,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon size={15} strokeWidth={2.2} style={{ color: '#2DD4BF' }} />
        </span>
      </div>
      <button
        onClick={() => onSelect(tile)}
        title={`View ${tile.label.toLowerCase()} details`}
        style={{
          border: 'none', background: 'none', padding: 0, cursor: 'pointer',
          fontSize: 30, fontWeight: 600, color: C.text, fontFamily: DISPLAY_FONT,
          margin: '0 0 8px', letterSpacing: '-.02em', display: 'inline-block',
        }}
        onMouseEnter={e => { e.currentTarget.style.color = '#2DD4BF'; }}
        onMouseLeave={e => { e.currentTarget.style.color = C.text; }}
      >
        {value}
      </button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 18 }}>
        {hasDelta && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 2,
            fontSize: 11.5, fontWeight: 700, fontFamily: MONO,
            color: up ? C.green : C.textSecondary,
          }}>
            {up ? <ArrowUpRight size={13} strokeWidth={2.5} /> : <ArrowDownRight size={13} strokeWidth={2.5} />}
            {Math.abs(tile.delta)}%
          </span>
        )}
        {tile.sub && <span style={{ fontSize: 11.5, color: C.textMuted, fontFamily: FONT }}>{tile.sub}</span>}
      </div>
    </Card>
  );
}

// ── KPI drill-down modal: lists the items behind a KPI number ───────────
function KpiDetailModal({ tile, range, onClose }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  useEffect(() => {
    let alive = true;
    setState({ loading: true, error: null, data: null });
    api.dashboardDetails(tile.key, range)
      .then(d => { if (alive) setState({ loading: false, error: null, data: d }); })
      .catch(() => { if (alive) setState({ loading: false, error: 'Failed to load details', data: null }); });
    return () => { alive = false; };
  }, [tile.key, range]);

  const { loading, error, data } = state;
  const items = data?.items || [];
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(5,7,11,.6)', zIndex: 200,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      backdropFilter: 'blur(3px)',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: C.cardBg, borderRadius: 18, boxShadow: C.shadowLg, width: 'min(560px, 100%)',
        maxHeight: '82vh', display: 'flex', flexDirection: 'column', fontFamily: FONT,
        border: `1px solid ${C.border}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 20px', borderBottom: `1px solid ${C.border}` }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: C.text, fontFamily: DISPLAY_FONT }}>{data?.title || tile.label}</div>
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 3 }}>
              {loading ? 'Loading…' : `${fmt(data?.count ?? 0)} ${data?.count === 1 ? 'record' : 'records'}`}
            </div>
          </div>
          <button onClick={onClose} title="Close" style={{ border: 'none', background: C.pageBg, borderRadius: 10, width: 32, height: 32, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: C.textSecondary }}>
            <X size={16} strokeWidth={2.4} />
          </button>
        </div>
        <div style={{ overflowY: 'auto', padding: '6px 0' }}>
          {loading && (
            <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 9 }}>
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} style={{ height: 40, background: C.pageBg, borderRadius: 10, opacity: 0.7 }} />
              ))}
            </div>
          )}
          {!loading && error && (
            <div style={{ margin: 20, background: 'rgba(251,191,36,.1)', color: '#FBBF24', border: '1px solid rgba(251,191,36,.25)', borderRadius: 12, padding: '13px 15px', fontSize: 13 }}>{error}</div>
          )}
          {!loading && !error && items.length === 0 && (
            <div style={{ padding: '36px 20px', textAlign: 'center', fontSize: 13, color: C.textMuted }}>Nothing here yet.</div>
          )}
          {!loading && !error && items.map((it, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 20px', borderTop: i === 0 ? 'none' : `1px solid ${C.border}` }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.primary || '—'}</div>
                {it.secondary && <div style={{ fontSize: 11.5, color: C.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>{it.secondary}</div>}
              </div>
              {it.meta && (
                <div style={{
                  fontSize: 11.5, fontFamily: MONO, flexShrink: 0,
                  color: it.meta === 'No reply' ? C.textSecondary : it.meta === 'Replied' || it.meta === 'active' ? C.green : C.textSecondary,
                  fontWeight: it.meta === 'No reply' || it.meta === 'active' ? 700 : 500,
                }}>{it.meta}</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Pipeline funnel (horizontal bars) ──────────────────────────────────
function FunnelBars({ funnel }) {
  const stages = funnel.stages || [];
  const max = Math.max(1, ...stages.map(s => s.count));
  if (stages.length === 0) {
    return <div style={{ fontSize: 12.5, color: C.textMuted, fontFamily: FONT, padding: '22px 0' }}>
      No tagged clients yet. Tag clients to populate your pipeline view.
    </div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
      {stages.map((s, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <div style={{ width: 124, fontSize: 12, color: C.textSecondary, fontFamily: FONT, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={s.name}>{s.name}</div>
          <div style={{ flex: 1, height: 24, background: C.headerSurface, borderRadius: 8, overflow: 'hidden' }}>
            <div title={`${s.name}: ${fmt(s.count)} clients`} style={{
              width: `${(s.count / max) * 100}%`, height: '100%',
              background: CHART_PALETTE[i % CHART_PALETTE.length],
              borderRadius: 8, minWidth: s.count > 0 ? 4 : 0, transition: 'width .3s ease',
            }} />
          </div>
          <div style={{ width: 46, textAlign: 'right', fontSize: 13, fontWeight: 600, fontFamily: MONO, color: C.text }}>{fmt(s.count)}</div>
        </div>
      ))}
    </div>
  );
}

// ── Segment distribution donut ──────────────────────────────────────────
function polar(cx, cy, r, a) { return [cx + r * Math.sin(a), cy - r * Math.cos(a)]; }
function arcPath(cx, cy, R, r, a0, a1) {
  const large = (a1 - a0) > Math.PI ? 1 : 0;
  const [x0, y0] = polar(cx, cy, R, a0), [x1, y1] = polar(cx, cy, R, a1);
  const [x2, y2] = polar(cx, cy, r, a1), [x3, y3] = polar(cx, cy, r, a0);
  return `M${x0},${y0} A${R},${R} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${r},${r} 0 ${large} 0 ${x3},${y3} Z`;
}
function TagDonut({ data }) {
  const [hover, setHover] = useState(-1);
  const total = data.reduce((s, d) => s + d.count, 0);
  if (total === 0) {
    return <div style={{ fontSize: 12.5, color: C.textMuted, fontFamily: FONT, padding: '22px 0' }}>No segments tagged yet.</div>;
  }
  const cx = 80, cy = 80, R = 74, r = 48;
  let acc = 0;
  const segs = data.map((d, i) => {
    const a0 = (acc / total) * 2 * Math.PI; acc += d.count;
    const a1 = (acc / total) * 2 * Math.PI;
    return { ...d, a0, a1, i, color: CHART_PALETTE[i % CHART_PALETTE.length] };
  });
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
      <svg viewBox="0 0 160 160" width="150" height="150" style={{ flexShrink: 0 }}>
        {data.length === 1 ? (
          <circle cx={cx} cy={cy} r={(R + r) / 2} fill="none" stroke={CHART_PALETTE[0]} strokeWidth={R - r}>
            <title>{`${data[0].name}: ${fmt(data[0].count)} (100%)`}</title>
          </circle>
        ) : segs.map((s) => (
          <path key={s.i} d={arcPath(cx, cy, R, r, s.a0, s.a1)} fill={s.color}
            opacity={hover === -1 || hover === s.i ? 1 : 0.35}
            onMouseEnter={() => setHover(s.i)} onMouseLeave={() => setHover(-1)}
            style={{ transition: 'opacity .15s', cursor: 'default' }}>
            <title>{`${s.name}: ${fmt(s.count)} (${Math.round((s.count / total) * 100)}%)`}</title>
          </path>
        ))}
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize="22" fontWeight="600" fill={C.text} fontFamily="IBM Plex Mono">{fmt(total)}</text>
        <text x={cx} y={cy + 15} textAnchor="middle" fontSize="10" fill={C.textMuted} fontFamily="Inter">tagged</text>
      </svg>
      <div style={{ flex: 1, minWidth: 150, display: 'flex', flexDirection: 'column', gap: 9 }}>
        {data.map((d, i) => (
          <div key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(-1)}
            style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12, fontFamily: FONT, opacity: hover === -1 || hover === i ? 1 : 0.5, transition: 'opacity .15s' }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: CHART_PALETTE[i % CHART_PALETTE.length], flexShrink: 0 }} />
            <span style={{ color: C.textSecondary, fontWeight: 600, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={d.name}>{d.name}</span>
            <span style={{ color: C.text, fontFamily: MONO, fontWeight: 600 }}>{fmt(d.count)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Workflow performance stat ───────────────────────────────────────────
function AutomationStat({ label, value, color }) {
  return (
    <div style={{ flex: 1, textAlign: 'center', padding: '4px 0' }}>
      <div style={{ fontSize: 21, fontWeight: 600, fontFamily: MONO, color: color || C.text }}>{value}</div>
      <div style={{ fontSize: 10.5, color: C.textMuted, fontFamily: FONT, fontWeight: 600, marginTop: 3, letterSpacing: '.02em' }}>{label}</div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────
export default function HomePage({ user, onPageChange }) {
  const [range, setRange] = useState('7d');
  const [detailTile, setDetailTile] = useState(null);
  const { data, loading, error } = usePolling(() => api.dashboard(range), 60000, [range]);

  const go = (p) => onPageChange && onPageChange(p);
  const isAdmin = true; // single-owner system: the owner sees everything
  const greeting = user?.displayName || user?.username || 'there';

  const quickActions = isAdmin
    ? [
        { label: 'Launch Campaign', icon: Megaphone, page: 'bulk-message' },
        { label: 'Build Workflow', icon: Zap, page: 'chatbot-builder' },
        { label: 'Design Template', icon: FileText, page: 'template-builder' },
      ]
    : [
        { label: 'Open Conversations', icon: MessageCircle, page: 'chats', primary: true },
        { label: 'Client Directory', icon: Users, page: 'contacts' },
      ];

  return (
    <div style={{ padding: '32px 36px', fontFamily: FONT, width: '100%' }}>
      {/* Hero header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 28,
        flexWrap: 'wrap', gap: 16, padding: '24px 28px', borderRadius: 20,
        background: 'radial-gradient(900px 180px at 0% 0%, rgba(13,148,136,0.12), transparent), ' + C.cardBg,
        border: `1px solid ${C.border}`,
      }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 9 }}>
            <Sparkles size={13} color="#2DD4BF" />
            <span style={{ fontSize: 11, color: '#2DD4BF', fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase' }}>Insights Hub</span>
          </div>
          <h1 style={{ fontSize: 25, fontWeight: 600, color: C.text, letterSpacing: '-.02em', fontFamily: DISPLAY_FONT }}>
            Welcome back, {greeting}
          </h1>
          <p style={{ fontSize: 13, color: C.textMuted, margin: '6px 0 0', fontFamily: FONT }}>
            {isAdmin ? 'Workspace-wide performance snapshot' : 'Your personal activity snapshot'} · last {RANGES.find(r => r.key === range)?.label}
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 10 }}>
          <div style={{ display: 'flex', background: C.headerSurface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 4, gap: 2 }}>
            {RANGES.map(r => {
              const active = r.key === range;
              return (
                <button key={r.key} onClick={() => setRange(r.key)} style={{
                  border: 'none', cursor: 'pointer', fontFamily: FONT, fontSize: 12, fontWeight: 600,
                  padding: '7px 14px', borderRadius: 9,
                  background: active ? C.primary : 'transparent', color: active ? '#fff' : C.textSecondary,
                  transition: 'background .15s',
                }}>{r.label}</button>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {quickActions.map(a => (
              <button key={a.label} onClick={() => go(a.page)} style={{
                display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontFamily: FONT,
                fontSize: 12.5, fontWeight: 600, padding: '9px 15px', borderRadius: 11,
                border: a.primary ? 'none' : `1px solid ${C.border}`,
                background: a.primary ? C.primary : C.headerSurface,
                color: a.primary ? '#fff' : C.text,
              }}>
                <a.icon size={14} strokeWidth={2.3} />{a.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{ background: 'rgba(251,191,36,.1)', color: '#FBBF24', border: '1px solid rgba(251,191,36,.25)', borderRadius: 14, padding: '13px 16px', fontSize: 13, fontFamily: FONT, marginBottom: 18 }}>
          Couldn't load the dashboard. Please try again in a moment.
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !data && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 16, marginBottom: 18 }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} style={{ height: 120, background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 18, opacity: 0.6 }} />
            ))}
          </div>
          <div style={{ height: 290, background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 18, opacity: 0.6 }} />
        </div>
      )}

      {data && (
        <>
          {/* Alert strip */}
          {data.alerts && data.alerts.length > 0 && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 18 }}>
              {data.alerts.map((al, i) => {
                const warn = al.level === 'warn';
                return (
                  <button key={i} onClick={() => go(al.page)} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontFamily: FONT,
                    fontSize: 12.5, fontWeight: 600, padding: '9px 15px', borderRadius: 11,
                    border: `1px solid ${warn ? 'rgba(251,191,36,.3)' : C.border}`,
                    background: warn ? 'rgba(251,191,36,.08)' : C.cardBg,
                    color: warn ? '#FBBF24' : C.textSecondary,
                  }}>
                    <AlertTriangle size={13} strokeWidth={2.4} style={{ color: warn ? '#FBBF24' : C.textMuted }} />
                    {al.label}
                    <span style={{ fontFamily: MONO, fontWeight: 700 }}>{fmt(al.count)}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* KPI scorecard */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 22 }}>
            {data.kpis.map(t => <KpiCard key={t.key} tile={t} onSelect={setDetailTile} />)}
          </div>

          {/* Funnel + Segment distribution */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 18, marginBottom: 18 }}>
            <Card>
              <SectionTitle icon={Users}>
                Pipeline Stages{data.funnel?.categoryName ? ` · ${data.funnel.categoryName}` : ''}
              </SectionTitle>
              <FunnelBars funnel={data.funnel || { stages: [] }} />
            </Card>
            <Card>
              <SectionTitle icon={Trophy}>Segment Breakdown</SectionTitle>
              <TagDonut data={data.tagDistribution || []} />
            </Card>
          </div>

          {/* Workflow + Campaign activity (admin) */}
          {(data.automations || data.broadcasts) && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 18, marginBottom: 18 }}>
              {data.automations && (
                <Card>
                  <SectionTitle icon={Zap} right={
                    <button onClick={() => go('chatbot-builder')} style={{ border: 'none', background: 'none', color: '#2DD4BF', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: FONT }}>Open Workflow Studio →</button>
                  }>Workflow Performance</SectionTitle>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginBottom: 18 }}>
                    <span style={{ fontSize: 30, fontWeight: 600, fontFamily: DISPLAY_FONT, color: C.text }}>{data.automations.active}</span>
                    <span style={{ fontSize: 13, color: C.textMuted, fontFamily: FONT }}>of {data.automations.total} live</span>
                  </div>
                  <div style={{ display: 'flex', borderTop: `1px solid ${C.border}`, paddingTop: 16 }}>
                    <AutomationStat label={`runs · ${range}`} value={fmt(data.automations.runs.total)} />
                    <AutomationStat label="success" value={data.automations.successRate == null ? '—' : `${data.automations.successRate}%`} color={C.green} />
                    <AutomationStat label="waiting" value={fmt(data.automations.runs.paused)} color={C.amber} />
                    <AutomationStat label="errors" value={fmt(data.automations.runs.error)} color={data.automations.runs.error > 0 ? '#F87171' : C.text} />
                  </div>
                </Card>
              )}
              {data.broadcasts && (
                <Card>
                  <SectionTitle icon={Megaphone} right={
                    <button onClick={() => go('bulk-message')} style={{ border: 'none', background: 'none', color: '#2DD4BF', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: FONT }}>Open Broadcast Studio →</button>
                  }>Campaign Activity</SectionTitle>
                  {data.broadcasts.recent.length === 0 ? (
                    <div style={{ fontSize: 12.5, color: C.textMuted, fontFamily: FONT, padding: '16px 0' }}>No campaigns sent yet.</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                      {data.broadcasts.recent.map(b => (
                        <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, fontFamily: FONT }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.name || `Campaign #${b.id}`}</div>
                            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 1 }}>{shortDate(b.createdAt)} · {b.messageType}</div>
                          </div>
                          <div style={{ textAlign: 'right', fontFamily: MONO, fontSize: 12 }}>
                            <span style={{ color: C.green, fontWeight: 600 }}>{fmt(b.sent)}</span>
                            <span style={{ color: C.textMuted }}> / {fmt(b.recipients)}</span>
                            {b.failed > 0 && <span style={{ color: '#F87171', fontWeight: 600 }}> · {fmt(b.failed)}✕</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              )}
            </div>
          )}

          {/* footer note */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: C.textMuted, fontFamily: FONT, marginTop: 6 }}>
            <RefreshCw size={11} strokeWidth={2.2} /> Auto-refreshes every 60s · updated {new Date(data.generatedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}
          </div>
        </>
      )}

      {detailTile && (
        <KpiDetailModal tile={detailTile} range={range} onClose={() => setDetailTile(null)} />
      )}
    </div>
  );
}

