import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Send, FlaskConical } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT } from '../constants.js';
import { useTableSelection, SelectAllCheckbox, RowCheckbox } from '../components/TableSelection.jsx';
import MaskedNumber from '../components/MaskedNumber.jsx';
import WhatsAppPreview, { BroadcastMessagePreview } from '../components/WhatsAppPreview.jsx';

const FIELD_DEFS = [
  { key: 'name', label: 'Name', type: 'text', core: true },
  { key: 'contact_number', label: 'Phone', type: 'text', core: true },
  { key: 'city', label: 'City', type: 'text' },
  { key: 'state', label: 'State', type: 'text' },
  { key: 'country', label: 'Country', type: 'text' },
  { key: 'lastProduct', label: 'Product Purchased', type: 'text' },
  { key: 'purchaseCount', label: 'Purchase Count', type: 'number' },
  { key: 'totalPurchaseAmount', label: 'Total Purchase Amount', type: 'number' },
  { key: 'lastPurchase', label: 'Last Purchase', type: 'date' },
  { key: 'email', label: 'Email', type: 'text' },
];

const OPERATORS_BY_TYPE = {
  text: [
    { key: 'equals', label: '=' }, { key: 'not_equals', label: '≠' },
    { key: 'contains', label: 'contains' },
    { key: 'is_empty', label: 'is empty' }, { key: 'not_empty', label: 'is not empty' },
  ],
  number: [
    { key: 'equals', label: '=' }, { key: 'gt', label: '>' }, { key: 'lt', label: '<' },
    { key: 'gte', label: '>=' }, { key: 'lte', label: '<=' }, { key: 'between', label: 'between' },
    { key: 'is_empty', label: 'is empty' }, { key: 'not_empty', label: 'is not empty' },
  ],
  date: [
    { key: 'within_days', label: 'within (days)' }, { key: 'equals', label: '=' },
    { key: 'is_empty', label: 'is empty' }, { key: 'not_empty', label: 'is not empty' },
  ],
};

const inputStyle = {
  padding: '7px 10px', borderRadius: 7, border: `1px solid ${C.border}`,
  fontSize: 12.5, fontFamily: FONT, color: C.text, background: 'var(--c-cardBg)',
};
const labelStyle = { fontSize: 11, fontWeight: 600, color: C.textMuted, marginBottom: 4, display: 'block' };
const sectionCard = {
  background: 'var(--c-cardBg)', border: `1px solid ${C.border}`, borderRadius: 12,
  padding: 18, marginBottom: 16,
};
const sectionTitle = { fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 12 };
const btnPrimary = {
  padding: '9px 16px', background: C.primary, color: '#fff', border: 'none', borderRadius: 8,
  fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: FONT, display: 'inline-flex',
  alignItems: 'center', gap: 6,
};
const btnGhost = {
  padding: '8px 14px', background: 'transparent', color: C.text, border: `1.5px solid ${C.border}`,
  borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: FONT,
  display: 'inline-flex', alignItems: 'center', gap: 6,
};

function Stat({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 700, color: C.text }}>{value}</div>
      <div style={{ fontSize: 11, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
    </div>
  );
}

export default function TargetMessagePage() {
  // ── Customers / filters (always reads live from synced contacts) ────────
  const [customers, setCustomers] = useState([]);
  const [totalMatched, setTotalMatched] = useState(0);
  const [search, setSearch] = useState('');
  const [combinator, setCombinator] = useState('AND');
  const [filters, setFilters] = useState([]);
  const [loadingCustomers, setLoadingCustomers] = useState(false);
  const sel = useTableSelection(customers, (r) => r.id);

  // ── Message composer (unchanged from before — already correct) ──────────
  const [accounts, setAccounts] = useState([]);
  const [fromNumber, setFromNumber] = useState('');
  const [templates, setTemplates] = useState([]);
  const [mediaItems, setMediaItems] = useState([]);
  const [messageType, setMessageType] = useState('text');
  const [templateId, setTemplateId] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [mediaLibraryId, setMediaLibraryId] = useState('');
  const [caption, setCaption] = useState('');
  const [testNumber, setTestNumber] = useState('');
  const [sendBusy, setSendBusy] = useState(false);
  const [sendMsg, setSendMsg] = useState('');

  const selectedTemplate = templates.find((t) => String(t.id) === String(templateId));

  useEffect(() => {
    api.whatsappAccounts.list(true).then((rows) => {
      setAccounts(rows || []);
      if (rows && rows.length > 0) setFromNumber(rows[0].displayPhoneNumber || rows[0].display_phone_number || '');
    }).catch(() => {});
    api.templates.list({ status: 'APPROVED' }).then((r) => setTemplates(r.templates || r || [])).catch(() => {});
    api.mediaLibrary.list().then((r) => setMediaItems(r?.media || r || [])).catch(() => {});
  }, []);

  const loadCustomers = useCallback(() => {
    setLoadingCustomers(true);
    api.targetMessage.customers({ search, filters, combinator, limit: 500 })
      .then((r) => { setCustomers(r.rows || []); setTotalMatched(r.total || 0); })
      .catch(() => { setCustomers([]); setTotalMatched(0); })
      .finally(() => setLoadingCustomers(false));
  }, [search, filters, combinator]);

  useEffect(() => { loadCustomers(); }, [loadCustomers]);

  // Poll every 30s so newly-synced contacts (from the Google Sheet) appear
  // automatically without a manual refresh.
  useEffect(() => {
    const t = setInterval(() => loadCustomers(), 30000);
    return () => clearInterval(t);
  }, [loadCustomers]);

  // ── Filter handlers ───────────────────────────────────────────────────
  const addFilter = () => setFilters((f) => [...f, { field: 'city', operator: 'equals', value: '' }]);
  const updateFilter = (idx, patch) => setFilters((f) => f.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const removeFilter = (idx) => setFilters((f) => f.filter((_, i) => i !== idx));

  // ── Send / test ────────────────────────────────────────────────────────
  const buildCampaignPayload = () => {
    const payload = { filters, combinator, fromNumber, messageType };
    if (sel.selectedCount > 0) payload.customerIds = [...sel.selectedIds];
    if (messageType === 'template') {
      payload.templateId = templateId;
      payload.variableMapping = { 1: '{{contact.name}}' };
    } else if (messageType === 'text') {
      payload.body = bodyText;
    } else {
      payload.mediaLibraryId = mediaLibraryId;
      payload.caption = caption;
    }
    return payload;
  };

  const handleTestSend = async () => {
    if (!testNumber.trim()) { setSendMsg('Enter a test number first.'); return; }
    setSendBusy(true); setSendMsg('');
    try {
      const { broadcastId } = await api.targetMessage.createCampaign(buildCampaignPayload());
      await api.broadcasts.test(broadcastId, testNumber.trim());
      setSendMsg(`Test message sent to ${testNumber}.`);
    } catch (err) {
      setSendMsg(`Test send failed: ${err.message}`);
    } finally { setSendBusy(false); }
  };

  const handleSendNow = async () => {
    setSendBusy(true); setSendMsg('');
    try {
      const { broadcastId, audienceCount } = await api.targetMessage.createCampaign(buildCampaignPayload());
      await api.broadcasts.send(broadcastId);
      setSendMsg(`Campaign sent to ${audienceCount} customer(s).`);
    } catch (err) {
      setSendMsg(`Send failed: ${err.message}`);
    } finally { setSendBusy(false); }
  };

  return (
    <div style={{ padding: 24, fontFamily: FONT, maxWidth: 1200 }}>
      <h2 style={{ margin: 0, marginBottom: 4, fontSize: 22, color: C.text }}>Target Message</h2>
      <p style={{ color: C.textMuted, fontSize: 13, marginBottom: 20 }}>
        Filter your synchronized customers and send targeted WhatsApp campaigns through your existing sending pipeline.
      </p>

      {/* ── Search + Filters ─────────────────────────────────────────── */}
      <div style={sectionCard}>
        <div style={sectionTitle}>1. Filter Customers</div>
        <input
          style={{ ...inputStyle, width: 320, marginBottom: 14 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or phone…"
        />

        {filters.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <select style={{ ...inputStyle, marginBottom: 10 }} value={combinator} onChange={(e) => setCombinator(e.target.value)}>
              <option value="AND">Match ALL conditions (AND)</option>
              <option value="OR">Match ANY condition (OR)</option>
            </select>
            {filters.map((f, idx) => {
              const fieldDef = FIELD_DEFS.find((d) => d.key === f.field) || FIELD_DEFS[0];
              const ops = OPERATORS_BY_TYPE[fieldDef.type];
              const needsValue = !['is_empty', 'not_empty'].includes(f.operator);
              return (
                <div key={idx} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
                  <select style={inputStyle} value={f.field} onChange={(e) => updateFilter(idx, { field: e.target.value, operator: 'equals', value: '' })}>
                    {FIELD_DEFS.filter((d) => !d.core).map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                  </select>
                  <select style={inputStyle} value={f.operator} onChange={(e) => updateFilter(idx, { operator: e.target.value })}>
                    {ops.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                  </select>
                  {needsValue && (
                    <input
                      style={{ ...inputStyle, width: 140 }}
                      value={f.value}
                      onChange={(e) => updateFilter(idx, { value: e.target.value })}
                      placeholder="Value"
                    />
                  )}
                  <button onClick={() => removeFilter(idx)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#A32D2D' }}>
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <button style={btnGhost} onClick={addFilter}><Plus size={14} /> Add Condition</button>
      </div>

      {/* ── Audience summary + customer table ───────────────────────── */}
      <div style={sectionCard}>
        <div style={{ display: 'flex', gap: 32, marginBottom: 16 }}>
          <Stat label="Matched Customers" value={loadingCustomers ? '…' : totalMatched} />
          <Stat label="Selected" value={sel.selectedCount} />
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                <th style={{ padding: 8 }}><SelectAllCheckbox sel={sel} /></th>
                <th style={{ padding: 8, textAlign: 'left' }}>Name</th>
                <th style={{ padding: 8, textAlign: 'left' }}>Phone</th>
                <th style={{ padding: 8, textAlign: 'left' }}>Email</th>
                <th style={{ padding: 8, textAlign: 'left' }}>City</th>
                <th style={{ padding: 8, textAlign: 'left' }}>Purchases</th>
                <th style={{ padding: 8, textAlign: 'left' }}>Last Purchase</th>
                <th style={{ padding: 8, textAlign: 'left' }}>Total Amount</th>
                <th style={{ padding: 8, textAlign: 'left' }}>Tags</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: 8 }}><RowCheckbox sel={sel} id={c.id} label={c.name} /></td>
                  <td style={{ padding: 8 }}>{c.name || '—'}</td>
                  <td style={{ padding: 8 }}><MaskedNumber number={c.contact_number} /></td>
                  <td style={{ padding: 8 }}>{c.custom_fields?.email || '—'}</td>
                  <td style={{ padding: 8 }}>{c.custom_fields?.city || '—'}</td>
                  <td style={{ padding: 8 }}>{c.custom_fields?.purchaseCount ?? '—'}</td>
                  <td style={{ padding: 8 }}>{c.custom_fields?.lastPurchase || '—'}</td>
                  <td style={{ padding: 8 }}>{c.custom_fields?.totalPurchaseAmount ?? '—'}</td>
                  <td style={{ padding: 8 }}>{(c.tags || []).join(', ') || '—'}</td>
                </tr>
              ))}
              {customers.length === 0 && (
                <tr><td colSpan={9} style={{ padding: 20, textAlign: 'center', color: C.textMuted }}>
                  No synced customers match yet. Configure Google Sheet Settings in Admin Settings, or wait for the next sync.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Message composer (unchanged) ─────────────────────────────── */}
      <div style={sectionCard}>
        <div style={sectionTitle}>2. Message</div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 320 }}>
            <label style={labelStyle}>Send From</label>
            <select style={{ ...inputStyle, width: '100%', marginBottom: 12 }} value={fromNumber} onChange={(e) => setFromNumber(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.displayPhoneNumber || a.display_phone_number}>{a.displayName || a.display_name}</option>
              ))}
            </select>

            <label style={labelStyle}>Message Type</label>
            <select style={{ ...inputStyle, width: '100%', marginBottom: 12 }} value={messageType} onChange={(e) => setMessageType(e.target.value)}>
              <option value="text">Plain Text</option>
              <option value="template">Approved Template</option>
              <option value="image">Image</option>
              <option value="video">Video</option>
              <option value="document">Document</option>
            </select>

            {messageType === 'template' && (
              <select style={{ ...inputStyle, width: '100%', marginBottom: 12 }} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">— Select template —</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}

            {messageType === 'text' && (
              <>
                <textarea
                  style={{ ...inputStyle, width: '100%', minHeight: 100, marginBottom: 6 }}
                  value={bodyText} onChange={(e) => setBodyText(e.target.value)}
                  placeholder="Hello {{contact.name}}, we have something special for you!"
                />
                <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 12 }}>
                  Supported placeholders: <code>{'{{contact.name}}'}</code>, <code>{'{{contact.number}}'}</code>.
                </div>
              </>
            )}

            {['image', 'video', 'document'].includes(messageType) && (
              <>
                <select style={{ ...inputStyle, width: '100%', marginBottom: 8 }} value={mediaLibraryId} onChange={(e) => setMediaLibraryId(e.target.value)}>
                  <option value="">— Select from Media Library —</option>
                  {mediaItems.filter((m) => (m.mediaType || m.media_type) === messageType).map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
                <input style={{ ...inputStyle, width: '100%', marginBottom: 12 }} value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Caption (optional) — supports {{contact.name}}" />
              </>
            )}

            <label style={labelStyle}>Test Send</label>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <input style={{ ...inputStyle, flex: 1 }} value={testNumber} onChange={(e) => setTestNumber(e.target.value)} placeholder="Mobile number" />
              <button style={btnGhost} onClick={handleTestSend} disabled={sendBusy}><FlaskConical size={14} /> Test</button>
            </div>

            <button style={{ ...btnPrimary, width: '100%', justifyContent: 'center' }} onClick={handleSendNow} disabled={sendBusy}>
              <Send size={15} /> {sendBusy ? 'Sending…' : 'Send Now'}
            </button>
            {sendMsg && <div style={{ marginTop: 10, fontSize: 12.5, color: sendMsg.includes('failed') ? '#A32D2D' : '#1a7f37' }}>{sendMsg}</div>}
          </div>

          <div style={{ width: 300 }}>
            <label style={labelStyle}>Preview</label>
            {messageType === 'template' ? (
              <WhatsAppPreview template={selectedTemplate} />
            ) : (
              <BroadcastMessagePreview
                messageType={messageType}
                body={bodyText}
                caption={caption}
                mediaItems={mediaItems}
                mediaLibraryId={mediaLibraryId}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


