import { useEffect, useState } from 'react';
import { C, FONT } from '../../constants.js';

const G = '#16a34a';

export default function EmailCampaignsPage() {
  const [templates, setTemplates] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [sources, setSources] = useState([]);
  const [selectedSourceIds, setSelectedSourceIds] = useState([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [subject, setSubject] = useState('');
  const [htmlBody, setHtmlBody] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState('');

  const load = () => {
    fetch('/api/email/templates', { credentials: 'include' })
      .then(r => r.json()).then(res => setTemplates(res.data || [])).catch(() => {});
    fetch('/api/email/campaigns', { credentials: 'include' })
      .then(r => r.json()).then(res => setCampaigns(res.data || [])).catch(() => {});
    fetch('/api/email/sources', { credentials: 'include' })
      .then(r => r.json()).then(res => setSources(res.data || [])).catch(() => {});
  };

  useEffect(() => { load(); }, []);

  function toggleSource(id) {
    setSelectedSourceIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  }

  const totalSubs = sources.reduce((sum, s) => sum + s.subscriber_count, 0);
  const recipientCount = selectedSourceIds.length === 0
    ? totalSubs
    : sources
        .filter(s => selectedSourceIds.includes(s.id))
        .reduce((sum, s) => sum + s.subscriber_count, 0);

  function pickTemplate(id) {
    setSelectedTemplateId(id);
    if (!id) { setSubject(''); setHtmlBody(''); return; }
    const t = templates.find(t => String(t.id) === String(id));
    if (t) { setSubject(t.subject); setHtmlBody(t.html_body); }
  }

  async function sendCampaign() {
    if (!subject || !htmlBody) {
      setStatus('Subject and body are required - pick a template or write your own.');
      return;
    }
    const label = selectedSourceIds.length === 0
      ? `all ${recipientCount} active subscribers`
      : `${recipientCount} subscribers in the selected list(s)`;
    if (!confirm(`Send this email to ${label}?`)) return;
    setSending(true);
    setStatus('Sending... this may take a moment.');
    try {
      const res = await fetch('/api/email/campaigns/send', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateId: selectedTemplateId || null,
          subject,
          htmlBody,
          sourceIds: selectedSourceIds.length > 0 ? selectedSourceIds : undefined,
        }),
      });
      const json = await res.json();
      if (json.success) {
        setStatus(`Sent! ${json.sent} delivered, ${json.failed} failed, out of ${json.total} subscribers.`);
        load();
      } else {
        setStatus(json.error || 'Failed to send campaign.');
      }
    } catch {
      setStatus('Failed to send campaign.');
    }
    setSending(false);
  }

  return (
    <div style={{ padding: 28, fontFamily: FONT, color: C.text, maxWidth: 900 }}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: C.text, letterSpacing: -0.5 }}>Campaigns</div>
        <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4 }}>Send an email to your subscriber list</div>
      </div>

      <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 14, padding: 22, marginBottom: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 14 }}>
          Compose Campaign - sending to {recipientCount} active subscribers
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          <div>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 6 }}>
              Select Contacts (leave all unchecked to send to everyone)
            </div>
            {sources.length === 0 ? (
              <div style={{ fontSize: 12, color: C.textMuted }}>No lists yet — add some in Contacts first.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, background: C.pageBg, border: `1px solid ${C.border}`, borderRadius: 8, padding: 12 }}>
                {sources.map(s => (
                  <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.text, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={selectedSourceIds.includes(s.id)}
                      onChange={() => toggleSource(s.id)}
                      style={{ accentColor: G, width: 15, height: 15, cursor: 'pointer' }}
                    />
                    {s.name} <span style={{ color: C.textMuted }}>({s.subscriber_count} subscribers)</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 6 }}>Use a Template (optional)</div>
            <select
              value={selectedTemplateId}
              onChange={e => pickTemplate(e.target.value)}
              style={{ width: '100%', padding: '10px 14px', background: C.pageBg, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 13, outline: 'none', fontFamily: FONT, boxSizing: 'border-box' }}
            >
              <option value="">Write custom email</option>
              {templates.map(t => (
                <option key={t.id} value={t.id}>{t.title}</option>
              ))}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 6 }}>Subject Line</div>
            <input
              value={subject}
              onChange={e => setSubject(e.target.value)}
              placeholder="Email subject"
              style={{ width: '100%', padding: '10px 14px', background: C.pageBg, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 13, outline: 'none', fontFamily: FONT, boxSizing: 'border-box' }}
            />
          </div>
          <div>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 6 }}>Email Body (HTML allowed)</div>
            <textarea
              value={htmlBody}
              onChange={e => setHtmlBody(e.target.value)}
              rows={10}
              style={{ width: '100%', padding: '10px 14px', background: C.pageBg, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 13, outline: 'none', fontFamily: 'monospace', boxSizing: 'border-box', resize: 'vertical' }}
            />
          </div>
          {status && <div style={{ fontSize: 12, color: status.includes('Sent!') ? G : '#ef4444' }}>{status}</div>}
          <button
            onClick={sendCampaign}
            disabled={sending}
            style={{ padding: '12px 24px', background: G, border: 'none', borderRadius: 8, color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
          >{sending ? 'Sending...' : `Send to ${recipientCount} Subscribers`}</button>
        </div>
      </div>

      <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 14, padding: 22 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 14 }}>
          Campaign History ({campaigns.length})
        </div>
        {campaigns.length === 0 ? (
          <div style={{ fontSize: 13, color: C.textMuted }}>No campaigns sent yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {campaigns.map(c => (
              <div key={c.id} style={{ padding: '12px 14px', background: C.pageBg, borderRadius: 8, border: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{c.subject}</div>
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                  {c.sent_count} sent, {c.failed_count} failed, of {c.recipient_count} recipients - {c.status} - {new Date(c.created_at).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
