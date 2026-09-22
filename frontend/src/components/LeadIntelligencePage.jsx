import { useState, useEffect } from 'react';
import { Flame, TrendingUp, Eye, Package, MessageCircle } from 'lucide-react';
import { C, FONT, maskPhone } from '../constants.js';

const INTENT_META = {
  PURCHASE_INTENT: { label: '🛒 Purchase Intent', color: '#dc2626' },
  HOT_LEAD:         { label: '🔥 Hot Lead',         color: '#ea580c' },
  WARM_LEAD:        { label: '🟡 Warm Lead',        color: '#ca8a04' },
  PRODUCT_INTEREST: { label: '❤️ Product Interest', color: '#db2777' },
  JUST_BROWSING:    { label: '🔵 Browsing',          color: '#2563eb' },
  EXISTING_CUSTOMER:{ label: '📦 Existing Customer', color: '#0891b2' },
  SUPPORT:          { label: '❌ Complaint/Support', color: '#71717a' },
};

const FILTERS = ['All', 'PURCHASE_INTENT', 'HOT_LEAD', 'WARM_LEAD', 'PRODUCT_INTEREST', 'JUST_BROWSING', 'EXISTING_CUSTOMER', 'SUPPORT'];

export default function LeadIntelligencePage() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('All');

  useEffect(() => {
    const fetchLeads = () => {
      fetch('/api/lead-intelligence')
        .then(r => r.json())
        .then(data => { setLeads(Array.isArray(data) ? data : []); setLoading(false); })
        .catch(() => setLoading(false));
    };
    fetchLeads();
    const intervalId = setInterval(fetchLeads, 15000);
    return () => clearInterval(intervalId);
  }, []);

  const filtered = filter === 'All' ? leads : leads.filter(l => l.current_intent === filter);

  return (
    <div style={{ padding: 24, fontFamily: FONT, height: '100%', overflowY: 'auto' }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, color: C.text, marginBottom: 4 }}>
        Customer Intent / Lead Intelligence
      </h1>
      <p style={{ fontSize: 13, color: C.textMuted, marginBottom: 20 }}>
        {leads.length} customers tracked
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
        {FILTERS.map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              padding: '6px 14px', borderRadius: 100,
              border: `1.5px solid ${filter === f ? C.primary : C.border}`,
              background: filter === f ? C.primary : 'transparent',
              color: filter === f ? '#fff' : C.textSecondary,
              fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: FONT,
            }}
          >
            {f === 'All' ? 'All' : (INTENT_META[f]?.label || f)}
          </button>
        ))}
      </div>

      {loading && <div style={{ color: C.textMuted, fontSize: 13 }}>Loading...</div>}

      {!loading && (
        <div style={{ background: 'var(--c-cardBg)', borderRadius: 10, border: `1px solid ${C.border}`, overflow: 'hidden' }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '2fr 1.5fr 1fr 1fr 1.5fr',
            padding: '10px 16px', fontSize: 11, fontWeight: 700, color: C.textMuted,
            textTransform: 'uppercase', letterSpacing: '0.03em', borderBottom: `1px solid ${C.border}`,
          }}>
            <span>Customer</span>
            <span>Intent</span>
            <span>Score</span>
            <span>Viewed</span>
            <span>Last Activity</span>
          </div>

          {filtered.map(lead => {
            const meta = INTENT_META[lead.current_intent] || { label: lead.current_intent, color: C.textMuted };
            return (
              <div key={lead.contact_number} style={{
                display: 'grid', gridTemplateColumns: '2fr 1.5fr 1fr 1fr 1.5fr',
                padding: '12px 16px', fontSize: 13, color: C.text,
                borderBottom: `1px solid ${C.border}`, alignItems: 'center',
              }}>
                <span>{lead.name || lead.profile_name || `+${maskPhone(lead.contact_number)}`}</span>
                <span style={{ color: meta.color, fontWeight: 600 }}>{meta.label}</span>
                <span style={{ fontWeight: 700 }}>{lead.buying_score}</span>
                <span>{lead.products_viewed_count}</span>
                <span style={{ color: C.textMuted, fontSize: 12 }}>
                  {lead.last_activity ? new Date(lead.last_activity).toLocaleString() : '—'}
                </span>
              </div>
            );
          })}

          {filtered.length === 0 && (
            <div style={{ padding: 40, textAlign: 'center', color: C.textMuted, fontSize: 13 }}>
              No customers in this category yet
            </div>
          )}
        </div>
      )}
    </div>
  );
}