import { useState, useEffect } from 'react';
import { IG, FONT } from '../../constants.js';

export default function InstagramAnalyticsPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/instagram/analytics', { credentials: 'include' })
      .then(r => r.json())
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  const cards = [
    { label: 'Messages Received', value: data?.messagesReceived ?? 0 },
    { label: 'Messages Sent', value: data?.messagesSent ?? 0 },
    { label: 'Active Conversations', value: data?.activeConversations ?? 0 },
    { label: 'Avg Response Time', value: data?.avgResponseTime ?? '—' },
  ];

  return (
    <div style={{ padding: 28, fontFamily: FONT }}>
      <h2 style={{ fontSize: 18, fontWeight: 800, color: IG.text, marginBottom: 20 }}>
        Analytics
      </h2>
      {loading ? (
        <div style={{ color: IG.textMuted, fontSize: 13 }}>Loading…</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
          {cards.map(c => (
            <div key={c.label} style={{
              background: IG.cardBg, border: `1px solid ${IG.border}`,
              borderRadius: 18, padding: 20,
            }}>
              <div style={{ fontSize: 12, color: IG.textMuted, marginBottom: 6 }}>{c.label}</div>
              <div style={{
                fontSize: 26, fontWeight: 800,
                background: IG.gradient, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
              }}>
                {c.value}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}