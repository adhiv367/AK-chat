import { useEffect, useState } from 'react';
import { C, FONT, DISPLAY_FONT, TYPE, SPACE } from '../../constants.js';

const Icon = {
  Mail: (p) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="2" y="4" width="20" height="16" rx="3" /><path d="m2 7 10 6 10-6" />
    </svg>
  ),
  Send: (p) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4 20-7Z" />
    </svg>
  ),
  Trend: (p) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3 17 9 11l4 4 8-8" /><path d="M15 7h6v6" />
    </svg>
  ),
  List: (p) => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" />
    </svg>
  ),
  File: (p) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" />
    </svg>
  ),
};

export default function EmailDashboardPage() {
  const [sources, setSources] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [templateCount, setTemplateCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/email/sources', { credentials: 'include' }).then(r => r.json()).catch(() => ({ data: [] })),
      fetch('/api/email/campaigns', { credentials: 'include' }).then(r => r.json()).catch(() => ({ data: [] })),
      fetch('/api/email/templates', { credentials: 'include' }).then(r => r.json()).catch(() => ({ data: [] })),
    ]).then(([srcRes, campRes, tmplRes]) => {
      setSources(srcRes.data || []);
      setCampaigns(campRes.data || []);
      setTemplateCount((tmplRes.data || []).length);
      setLoading(false);
    });
  }, []);

  const totalSubscribers = sources.reduce((sum, s) => sum + s.subscriber_count, 0);
  const totalCampaignsSent = campaigns.length;
  const totalDelivered = campaigns.reduce((sum, c) => sum + (c.sent_count || 0), 0);
  const totalRecipients = campaigns.reduce((sum, c) => sum + (c.recipient_count || 0), 0);
  const openRate = totalRecipients > 0 ? Math.round((totalDelivered / totalRecipients) * 100) : 0;

  const stats = [
    { label: 'Total Subscribers', value: totalSubscribers, color: C.green, icon: Icon.Mail },
    { label: 'Campaigns Sent', value: totalCampaignsSent, color: C.purple, icon: Icon.Send },
    { label: 'Delivery Rate', value: `${openRate}%`, color: C.amber, icon: Icon.Trend },
  ];

  return (
    <div style={{ padding: SPACE.xxl, fontFamily: FONT, color: C.text, maxWidth: 960 }}>
      <style>{`
        .ed-stat-card:hover { border-color: ${C.borderDark}; transform: translateY(-2px); box-shadow: ${C.shadowMd}; }
        .ed-list-row:hover { border-color: ${C.borderDark}; background: ${C.surfaceAlt} !important; }
        .ed-camp-row:hover { border-color: ${C.borderDark}; }
      `}</style>

      <div style={{ marginBottom: SPACE.xxl }}>
        <div style={{ ...TYPE.label, color: C.primary, marginBottom: SPACE.xs }}>Email Marketing</div>
        <div style={{ ...TYPE.display, fontFamily: DISPLAY_FONT }}>Email Dashboard</div>
        <div style={{ ...TYPE.body, color: C.textMuted, marginTop: SPACE.xs }}>
          Manage and send marketing emails to your customers
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: SPACE.lg, marginBottom: SPACE.xl }}>
        {stats.map(s => (
          <div
            key={s.label}
            className="ed-stat-card"
            style={{
              background: C.cardBg,
              border: `1px solid ${C.border}`,
              borderRadius: C.radiusMd,
              padding: SPACE.lg,
              transition: 'transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease',
            }}
          >
            <div style={{
              width: 34, height: 34, borderRadius: 9,
              background: `${s.color}1F`, color: s.color,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              marginBottom: SPACE.md,
            }}>
              <s.icon />
            </div>
            <div style={{ fontFamily: DISPLAY_FONT, fontSize: 26, fontWeight: 600, color: s.color, letterSpacing: '-0.02em' }}>
              {loading ? '—' : s.value}
            </div>
            <div style={{ ...TYPE.label, color: C.textMuted, marginTop: SPACE.xs }}>{s.label}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SPACE.lg }}>

        <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: C.radiusLg, padding: SPACE.xl }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: SPACE.lg }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: SPACE.sm }}>
              <Icon.List style={{ color: C.textMuted }} />
              <div style={{ ...TYPE.h2, fontFamily: DISPLAY_FONT }}>Your Lists</div>
            </div>
            <div style={{ ...TYPE.small, color: C.textMuted, background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 999, padding: '2px 10px' }}>
              {sources.length}
            </div>
          </div>
          {loading ? (
            <div style={{ fontSize: 13, color: C.textMuted }}>Loading…</div>
          ) : sources.length === 0 ? (
            <div style={{ fontSize: 13, color: C.textMuted }}>No lists yet — add some in Contacts.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: SPACE.sm }}>
              {sources.map(s => (
                <div
                  key={s.id}
                  className="ed-list-row"
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '10px 12px', background: C.pageBg,
                    borderRadius: C.radiusSm, border: `1px solid ${C.border}`,
                    transition: 'background 0.15s ease, border-color 0.15s ease',
                  }}
                >
                  <span style={{ fontSize: 13, color: C.text, fontWeight: 600 }}>{s.name}</span>
                  <span style={{ fontSize: 12, color: C.textMuted }}>{s.subscriber_count} subscribers</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: C.radiusLg, padding: SPACE.xl }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: SPACE.lg }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: SPACE.sm }}>
              <Icon.File style={{ color: C.textMuted }} />
              <div style={{ ...TYPE.h2, fontFamily: DISPLAY_FONT }}>Recent Campaigns</div>
            </div>
            <div style={{ ...TYPE.small, color: C.textMuted, background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 999, padding: '2px 10px' }}>
              {templateCount} templates
            </div>
          </div>
          {loading ? (
            <div style={{ fontSize: 13, color: C.textMuted }}>Loading…</div>
          ) : campaigns.length === 0 ? (
            <div style={{ fontSize: 13, color: C.textMuted }}>No campaigns sent yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: SPACE.sm, maxHeight: 260, overflow: 'auto' }}>
              {campaigns.slice(0, 6).map(c => (
                <div
                  key={c.id}
                  className="ed-camp-row"
                  style={{
                    padding: '10px 12px', background: C.pageBg,
                    borderRadius: C.radiusSm, border: `1px solid ${C.border}`,
                    transition: 'border-color 0.15s ease',
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{c.subject}</div>
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                    {c.sent_count} sent, {c.failed_count} failed — {new Date(c.created_at).toLocaleDateString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
