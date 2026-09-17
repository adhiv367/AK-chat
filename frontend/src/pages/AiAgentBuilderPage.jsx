import { useState, useEffect, useMemo } from 'react';
import { Bot, Loader2, CheckCircle2, AlertTriangle, Sparkles, Building2 } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT } from '../constants.js';

// ─── Design tokens ──────────────────────────────────────────────────────────
const B = {
  card: C.cardBg,
  cardBorder: C.border,
  innerBg: C.surfaceAlt,
  innerBorder: C.borderDark,
  t1: C.text,
  t3: C.textSecondary,
  t5: C.textMuted,
  accent: C.primary,
  accentBg: C.primaryLight,
  green: '#34D399',
  greenBg: 'rgba(52,211,153,0.16)',
  red: '#F87171',
  redBg: 'rgba(248,113,113,0.14)',
  amber: '#FBBF24',
  amberBg: 'rgba(251,191,36,0.14)',
};

const MAX_GOAL_CHARS = 500;
const MAX_INSTRUCTIONS_CHARS = 2000;

const MODEL_OPTIONS = [
  { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash (fastest, default)' },
  { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro (higher quality)' },
  { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
];
const DEFAULT_MODEL = 'gemini-1.5-flash';

const BUSINESS_TYPE_LABELS = {
  general: 'General',
  real_estate: 'Real Estate',
  clothing: 'Clothing / Fashion',
  construction: 'Construction / Contracting',
};

const AI_AGENT_MARKER = 'ai_agent_v1';

const TRIGGER_NODE_ID = 'trigger';
const MESSAGE_NODE_ID = 'ai_reply';

function buildConfig({ keyword, matchType, aiGoal, aiInstructions, aiModel, fallbackTemplateId }) {
  return {
    nodes: [
      {
        id: TRIGGER_NODE_ID, type: 'trigger', x: 80, y: 60,
        title: 'Trigger: AI Agent',
        sub: 'When a contact sends a message matching the AI Agent trigger',
        triggerKind: 'keyword',
        keyword: keyword || '',
        matchType: matchType || 'contains',
        caseSensitive: false,
      },
      {
        id: MESSAGE_NODE_ID, type: 'message', x: 80, y: 260,
        title: 'AI Agent reply',
        sub: 'Generate a reply with Gemini',
        messageMode: 'direct',
        directType: 'ai_reply',
        directData: {
          aiGoal: aiGoal || '',
          aiInstructions: aiInstructions || '',
          aiModel: aiModel || DEFAULT_MODEL,
          fallbackTemplateId: fallbackTemplateId || '',
        },
      },
    ],
    edges: [{ from: TRIGGER_NODE_ID, to: MESSAGE_NODE_ID, fromHandle: 'default' }],
    meta: { source: AI_AGENT_MARKER },
  };
}

function readConfig(chatbot) {
  const cfg = chatbot?.config || {};
  const nodes = Array.isArray(cfg.nodes) ? cfg.nodes : [];
  const trigger = nodes.find(n => n && n.type === 'trigger') || {};
  const message = nodes.find(n => n && n.type === 'message' && n.directType === 'ai_reply') || {};
  const dd = message.directData || {};
  return {
    keyword: trigger.keyword || '',
    matchType: trigger.matchType || 'contains',
    aiGoal: dd.aiGoal || '',
    aiInstructions: dd.aiInstructions || '',
    aiModel: dd.aiModel || DEFAULT_MODEL,
    fallbackTemplateId: dd.fallbackTemplateId || '',
  };
}

const Field = ({ label, hint, error, children }) => (
  <div style={{ marginBottom: 18 }}>
    <div style={{ fontSize: 12.5, fontWeight: 600, color: B.t1, marginBottom: 5, fontFamily: FONT }}>{label}</div>
    {children}
    {hint && !error && <div style={{ fontSize: 11, color: B.t5, marginTop: 5, fontFamily: FONT }}>{hint}</div>}
    {error && <div style={{ fontSize: 11, color: B.red, marginTop: 5, fontWeight: 600, fontFamily: FONT }}>{error}</div>}
  </div>
);

const inputStyle = (hasError) => ({
  width: '100%',
  padding: '9px 11px',
  border: `1.5px solid ${hasError ? B.red : B.innerBorder}`,
  borderRadius: 8,
  fontSize: 13,
  fontFamily: FONT,
  outline: 'none',
  background: B.innerBg,
  color: B.t1,
  boxSizing: 'border-box',
});

// ─── Business Profile section (workspace-level) ────────────────────────────
function BusinessProfileSection({ workspaceId }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [businessType, setBusinessType] = useState('general');
  const [workspaceInstructions, setWorkspaceInstructions] = useState('');
  const [presets, setPresets] = useState({});
  const [customized, setCustomized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState(null);
  const [saveMessage, setSaveMessage] = useState('');

  useEffect(() => {
    if (!workspaceId) { setLoading(false); return; }
    let alive = true;
    api.workspaces.getAiProfile(workspaceId)
      .then((data) => {
        if (!alive) return;
        setBusinessType(data.businessType || 'general');
        setWorkspaceInstructions(data.systemInstructions || '');
        setPresets(data.presets || {});
        const preset = data.presets?.[data.businessType];
        setCustomized(!!data.systemInstructions && data.systemInstructions !== preset);
      })
      .catch((err) => { if (alive) setError(err.message || 'Failed to load Business Profile'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [workspaceId]);

  const handleBusinessTypeChange = (nextType) => {
    setBusinessType(nextType);
    if (!customized) setWorkspaceInstructions(presets[nextType] || '');
  };

  const handleInstructionsChange = (value) => {
    setWorkspaceInstructions(value);
    setCustomized(true);
  };

  const handleResetToPreset = () => {
    setWorkspaceInstructions(presets[businessType] || '');
    setCustomized(false);
  };

  const handleSave = async () => {
    if (!workspaceId) return;
    setSaving(true);
    setSaveState(null);
    setSaveMessage('');
    try {
      await api.workspaces.updateAiProfile(workspaceId, {
        businessType,
        systemInstructions: workspaceInstructions,
      });
      setSaveState('ok');
      setSaveMessage('Business Profile saved.');
    } catch (err) {
      setSaveState('error');
      setSaveMessage(err.message || 'Failed to save Business Profile');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ background: B.card, border: `1px solid ${B.cardBorder}`, borderRadius: 12, padding: 22, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8, color: B.t5, fontFamily: FONT, fontSize: 13 }}>
        <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Loading Business Profile…
      </div>
    );
  }

  return (
    <div style={{ background: B.card, border: `1px solid ${B.cardBorder}`, borderRadius: 12, padding: 22, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <Building2 size={18} color={B.accent} />
        <div style={{ fontSize: 15, fontWeight: 700, color: B.t1, fontFamily: FONT }}>Business Profile</div>
      </div>
      <div style={{ fontSize: 11.5, color: B.t5, marginBottom: 18, fontFamily: FONT, lineHeight: 1.6 }}>
        Workspace-level context that every AI Agent automation inherits automatically.
        The AI Agent's own Goal and Instructions below are layered on top of this — they
        add to or override it for that specific automation, but this profile is never dropped.
      </div>

      {error && (
        <div style={{ background: B.redBg, border: `1px solid rgba(248,113,113,0.35)`, borderRadius: 10, padding: 12, marginBottom: 16, color: B.red, fontFamily: FONT, fontSize: 12.5, fontWeight: 600 }}>
          {error}
        </div>
      )}

      <Field label="Business Type">
        <select
          value={businessType}
          onChange={(e) => handleBusinessTypeChange(e.target.value)}
          style={{ ...inputStyle(false), cursor: 'pointer' }}
        >
          {Object.keys(presets).length > 0
            ? Object.keys(presets).map((key) => (
                <option key={key} value={key}>{BUSINESS_TYPE_LABELS[key] || key}</option>
              ))
            : <option value="general">General</option>
          }
        </select>
      </Field>

      <Field
        label={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Workspace AI Instructions</span>
            {customized && (
              <button
                onClick={handleResetToPreset}
                style={{ background: 'none', border: 'none', color: B.accent, fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}
              >
                Reset to preset
              </button>
            )}
          </div>
        }
        hint="Applies to every AI Agent automation in this workspace unless a specific automation overrides it below."
      >
        <textarea
          rows={4}
          value={workspaceInstructions}
          onChange={(e) => handleInstructionsChange(e.target.value)}
          placeholder="e.g. We are Invi Creation, an ethnic wear brand. Keep replies short, warm, and on-brand."
          style={{ ...inputStyle(false), resize: 'vertical' }}
        />
      </Field>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={handleSave} disabled={saving} style={{
          display: 'flex', alignItems: 'center', gap: 7, padding: '10px 18px', borderRadius: 9,
          border: 'none', background: B.accent, color: '#fff', fontSize: 13, fontWeight: 700,
          fontFamily: FONT, cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.7 : 1,
        }}>
          {saving ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Building2 size={14} />}
          {saving ? 'Saving…' : 'Save Business Profile'}
        </button>
        {saveState === 'ok' && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: B.green, fontWeight: 600, fontFamily: FONT }}>
            <CheckCircle2 size={14} /> {saveMessage}
          </span>
        )}
        {saveState === 'error' && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: B.red, fontWeight: 600, fontFamily: FONT }}>
            <AlertTriangle size={14} /> {saveMessage}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────
export default function AiAgentBuilderPage({ user }) {
  const permitted = !user || user.role === 'admin' || !Array.isArray(user.pages) || user.pages.includes('chatbot-builder');
  const workspaceId = user?.workspace?.id;

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [chatbotId, setChatbotId] = useState(null);
  const [enabled, setEnabled] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [matchType, setMatchType] = useState('contains');
  const [aiGoal, setAiGoal] = useState('');
  const [aiInstructions, setAiInstructions] = useState('');
  const [aiModel, setAiModel] = useState(DEFAULT_MODEL);
  const [fallbackTemplateId, setFallbackTemplateId] = useState('');
  const [templates, setTemplates] = useState([]);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState(null);
  const [saveMessage, setSaveMessage] = useState('');

  useEffect(() => {
    if (!permitted) { setLoading(false); return; }
    let alive = true;
    (async () => {
      try {
        const [bots, tpls] = await Promise.all([
          api.chatbots.list(),
          api.templates.list().catch(() => []),
        ]);
        if (!alive) return;
        setTemplates((tpls || []).filter(t => {
          const s = String(t.status || '').toUpperCase();
          return s === 'APPROVED' || s === 'SUBMITTED';
        }));

        const existing = (bots || []).find(b => b?.config?.meta?.source === AI_AGENT_MARKER) || null;
        if (existing) {
          setChatbotId(existing.id);
          setEnabled(existing.status === 'active');
          const parsed = readConfig(existing);
          setKeyword(parsed.keyword);
          setMatchType(parsed.matchType);
          setAiGoal(parsed.aiGoal);
          setAiInstructions(parsed.aiInstructions);
          setAiModel(parsed.aiModel);
          setFallbackTemplateId(parsed.fallbackTemplateId);
        }
      } catch (err) {
        if (alive) setLoadError(err.message || 'Failed to load AI Agent settings');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permitted]);

  const errors = useMemo(() => {
    const e = {};
    if (enabled && !aiGoal.trim()) e.aiGoal = 'Goal is required to enable the AI Agent.';
    if (aiGoal.length > MAX_GOAL_CHARS) e.aiGoal = `Keep the goal under ${MAX_GOAL_CHARS} characters.`;
    if (aiInstructions.length > MAX_INSTRUCTIONS_CHARS) e.aiInstructions = `Keep instructions under ${MAX_INSTRUCTIONS_CHARS} characters.`;
    if (enabled && !keyword.trim()) e.keyword = 'A trigger phrase is required — the automation engine only fires on a matching inbound message (see note below).';
    if (enabled && !fallbackTemplateId) e.fallbackTemplateId = 'Pick a fallback template — required in case the AI reply fails or the contact is outside the 24h window.';
    return e;
  }, [enabled, aiGoal, aiInstructions, keyword, fallbackTemplateId]);

  const hasErrors = Object.keys(errors).length > 0;

  const handleSave = async () => {
    if (hasErrors) { setSaveState('error'); setSaveMessage('Fix the highlighted fields before saving.'); return; }
    setSaving(true);
    setSaveState(null);
    setSaveMessage('');
    try {
      const config = buildConfig({ keyword, matchType, aiGoal, aiInstructions, aiModel, fallbackTemplateId });
      const payload = {
        name: 'AI Agent',
        description: 'Workspace AI Agent — managed from the AI Agent Builder page.',
        status: enabled ? 'active' : 'inactive',
        trigger_type: 'keyword',
        config,
      };
      const saved = chatbotId
        ? await api.chatbots.update(chatbotId, payload)
        : await api.chatbots.create(payload);
      setChatbotId(saved.id);
      setSaveState('ok');
      setSaveMessage('AI Agent settings saved.');
    } catch (err) {
      setSaveState('error');
      setSaveMessage(err.message || 'Failed to save AI Agent settings.');
    } finally {
      setSaving(false);
    }
  };

  if (!permitted) {
    return (
      <div style={{ padding: '24px 28px' }}>
        <div style={{ background: B.redBg, border: `1px solid rgba(248,113,113,0.35)`, borderRadius: 10, padding: 16, color: B.red, fontFamily: FONT, fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertTriangle size={16} /> You don't have permission to configure the AI Agent.
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ padding: '24px 28px', display: 'flex', alignItems: 'center', gap: 8, color: B.t5, fontFamily: FONT, fontSize: 13 }}>
        <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Loading AI Agent settings…
      </div>
    );
  }

  return (
    <div style={{ padding: '24px 28px', maxWidth: 720 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 22 }}>
        <div style={{ width: 42, height: 42, borderRadius: 12, background: B.accentBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Bot size={22} color={B.accent} />
        </div>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: B.t1, margin: 0, letterSpacing: '-.02em', fontFamily: FONT }}>AI Agent</h1>
          <p style={{ fontSize: 12, color: B.t5, margin: '3px 0 0', fontFamily: FONT }}>
            Configure how the AI Agent replies on WhatsApp, powered by Gemini.
          </p>
        </div>
      </div>

      <BusinessProfileSection workspaceId={workspaceId} />

      {loadError && (
        <div style={{ background: B.redBg, border: `1px solid rgba(248,113,113,0.35)`, borderRadius: 10, padding: 12, marginBottom: 16, color: B.red, fontFamily: FONT, fontSize: 12.5, fontWeight: 600 }}>
          {loadError}
        </div>
      )}

      <div style={{ background: B.card, border: `1px solid ${B.cardBorder}`, borderRadius: 12, padding: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <Sparkles size={16} color={B.accent} />
          <div style={{ fontSize: 15, fontWeight: 700, color: B.t1, fontFamily: FONT }}>This Automation</div>
        </div>
        <div style={{ fontSize: 11.5, color: B.t5, marginBottom: 18, fontFamily: FONT, lineHeight: 1.6 }}>
          Settings specific to this AI Agent automation. Goal and Instructions here are added on top of
          the Business Profile above — they don't replace it.
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, paddingBottom: 18, borderBottom: `1px solid ${B.innerBorder}` }}>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: B.t1, fontFamily: FONT }}>AI Agent enabled</div>
            <div style={{ fontSize: 11.5, color: B.t5, marginTop: 2, fontFamily: FONT }}>
              When on, matching inbound messages get an AI-generated reply.
            </div>
          </div>
          <label style={{ position: 'relative', display: 'inline-block', width: 42, height: 24, flexShrink: 0 }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)}
              style={{ opacity: 0, width: 0, height: 0 }} />
            <span style={{
              position: 'absolute', cursor: 'pointer', inset: 0, borderRadius: 24,
              background: enabled ? B.accent : B.innerBorder, transition: '.15s',
            }}>
              <span style={{
                position: 'absolute', height: 18, width: 18, left: enabled ? 21 : 3, top: 3,
                background: '#fff', borderRadius: '50%', transition: '.15s',
              }} />
            </span>
          </label>
        </div>

        <Field label="Trigger phrase" error={errors.keyword}
          hint='The automation engine matches inbound messages by keyword only (no free-form "reply to everything" trigger exists yet — see note below). Use "contains" with a broad phrase to cover more messages.'>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="e.g. hi, hello, help"
              style={{ ...inputStyle(!!errors.keyword), flex: 1 }} />
            <select value={matchType} onChange={(e) => setMatchType(e.target.value)} style={{ ...inputStyle(false), width: 140 }}>
              <option value="contains">Contains</option>
              <option value="exact">Exact match</option>
              <option value="starts">Starts with</option>
            </select>
          </div>
        </Field>

        <Field label="Goal" error={errors.aiGoal} hint={`${aiGoal.length}/${MAX_GOAL_CHARS} characters — what should the AI Agent accomplish?`}>
          <textarea rows={3} value={aiGoal} onChange={(e) => setAiGoal(e.target.value)}
            placeholder="e.g. Answer product questions and qualify leads by asking about budget and timeline."
            style={{ ...inputStyle(!!errors.aiGoal), resize: 'vertical' }} />
        </Field>

        <Field label="Instructions / system context (adds to Business Profile above)" error={errors.aiInstructions} hint={`${aiInstructions.length}/${MAX_INSTRUCTIONS_CHARS} characters — extra tone, facts, pricing, policies just for this automation.`}>
          <textarea rows={5} value={aiInstructions} onChange={(e) => setAiInstructions(e.target.value)}
            placeholder="e.g. For this trigger specifically, also mention our current festive discount."
            style={{ ...inputStyle(!!errors.aiInstructions), resize: 'vertical' }} />
        </Field>

        <Field label="Model" hint="Uses your workspace's configured Gemini setup.">
          <select value={aiModel} onChange={(e) => setAiModel(e.target.value)} style={inputStyle(false)}>
            {MODEL_OPTIONS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </Field>

        <Field label="Fallback behavior" hint="Used if the AI reply fails, or the contact is outside WhatsApp's 24-hour service window.">
          <div style={{ fontSize: 12.5, color: B.t3, fontFamily: FONT, background: B.innerBg, border: `1px solid ${B.innerBorder}`, borderRadius: 8, padding: '9px 11px' }}>
            Send an approved WhatsApp template
          </div>
        </Field>

        <Field label="Fallback template" error={errors.fallbackTemplateId}>
          <select value={fallbackTemplateId} onChange={(e) => setFallbackTemplateId(e.target.value)} style={inputStyle(!!errors.fallbackTemplateId)}>
            <option value="">— Pick a template —</option>
            {templates.map(t => <option key={t.id} value={t.id}>{t.name} · {t.category}</option>)}
          </select>
          {templates.length === 0 && (
            <div style={{ fontSize: 11, color: B.amber, marginTop: 5, fontFamily: FONT }}>
              No approved or submitted templates found in this workspace yet — create one in Template Studio first.
            </div>
          )}
        </Field>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
          <button onClick={handleSave} disabled={saving} style={{
            display: 'flex', alignItems: 'center', gap: 7, padding: '10px 18px', borderRadius: 9,
            border: 'none', background: B.accent, color: '#fff', fontSize: 13, fontWeight: 700,
            fontFamily: FONT, cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.7 : 1,
          }}>
            {saving ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Sparkles size={14} />}
            {saving ? 'Saving…' : 'Save AI Agent'}
          </button>
          {saveState === 'ok' && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: B.green, fontWeight: 600, fontFamily: FONT }}>
              <CheckCircle2 size={14} /> {saveMessage}
            </span>
          )}
          {saveState === 'error' && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: B.red, fontWeight: 600, fontFamily: FONT }}>
              <AlertTriangle size={14} /> {saveMessage}
            </span>
          )}
        </div>
      </div>

      <div style={{ marginTop: 14, fontSize: 11.5, color: B.t5, fontFamily: FONT, lineHeight: 1.6 }}>
        This automation is also visible in Workflow Studio as "AI Agent" — editing it there uses the same
        underlying automation, so keep changes to one place to avoid confusion.
      </div>
    </div>
  );
}