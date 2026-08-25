import { useState, useEffect } from 'react';
import { MessageSquare } from 'lucide-react';
import { IG, FONT } from '../../constants.js';
import { getActiveIgAccount } from '../../igAccount';

export default function InstagramTemplatesPage() {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/instagram/templates?accountId=${getActiveIgAccount()}`, { credentials: 'include' })
      .then(r => r.json())
      .then(setTemplates)
      .catch(() => setTemplates([]))
      .finally(() => setLoading(false));
  }, [getActiveIgAccount()]);

  return (
    <div style={{ padding: 28, fontFamily: FONT }}>
      <h2 style={{ fontSize: 18, fontWeight: 800, color: IG.text, marginBottom: 20 }}>
        Quick Replies
      </h2>
      {loading ? (
        <div style={{ color: IG.textMuted, fontSize: 13 }}>Loading…</div>
      ) : templates.length === 0 ? (
        <div style={{ color: IG.textMuted, fontSize: 13 }}>No quick replies created yet.</div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 16,
        }}>
          {templates.map(t => (
            <div key={t.id} style={{
              border: `1px solid ${IG.border}`, borderRadius: 18,
              padding: 18, background: IG.cardBg,
            }}>
              <div style={{
                width: 36, height: 36, borderRadius: '50%', background: IG.gradient,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                marginBottom: 10,
              }}>
                <MessageSquare size={16} color="#fff" />
              </div>
              <div style={{ fontWeight: 700, fontSize: 14, color: IG.text }}>{t.title}</div>
              <div style={{ fontSize: 12, color: IG.primary, marginTop: 2 }}>/{t.shortcut}</div>
              <div style={{ fontSize: 12, color: IG.textMuted, marginTop: 8 }}>{t.message}</div>
              <div style={{
                display: 'inline-block', marginTop: 10, fontSize: 11,
                background: IG.accentBg, color: IG.primary, padding: '3px 10px', borderRadius: 20,
              }}>
                {t.category || 'General'}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
