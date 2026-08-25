import { useState, useEffect } from 'react';
import { Megaphone } from 'lucide-react';
import { IG, FONT } from '../../constants.js';
import { getActiveIgAccount } from '../../igAccount';

export default function InstagramCampaignsPage() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/instagram/campaigns?accountId=${getActiveIgAccount()}`, { credentials: 'include' })
      .then(r => r.json())
      .then(setCampaigns)
      .catch(() => setCampaigns([]))
      .finally(() => setLoading(false));
  }, [getActiveIgAccount()]);

  return (
    <div style={{ padding: 28, fontFamily: FONT }}>
      <h2 style={{ fontSize: 18, fontWeight: 800, color: IG.text, marginBottom: 20 }}>
        Campaigns
      </h2>
      {loading ? (
        <div style={{ color: IG.textMuted, fontSize: 13 }}>Loading…</div>
      ) : campaigns.length === 0 ? (
        <div style={{ color: IG.textMuted, fontSize: 13 }}>No campaigns yet.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
          {campaigns.map(c => (
            <div key={c.id} style={{
              border: `1px solid ${IG.border}`, borderRadius: 18,
              padding: 18, background: IG.cardBg,
            }}>
              <div style={{
                width: 36, height: 36, borderRadius: '50%', background: IG.gradient,
                display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 10,
              }}>
                <Megaphone size={16} color="#fff" />
              </div>
              <div style={{ fontWeight: 700, fontSize: 14, color: IG.text }}>{c.name}</div>
              <div style={{
                display: 'inline-block', marginTop: 8, fontSize: 11,
                background: IG.accentBg, color: IG.primary, padding: '3px 10px', borderRadius: 20,
              }}>
                {c.status}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}