# AK Chat → Super RAG: Architecture & Implementation Plan

Based on a direct read of `AKchat_24_8.zip` (backend/src, schema.sql, engine/automationEngine.js,
services/aiReplyService.js, services/geminiService.js). Not a guess from the README — this is what's
actually in the code today.

---

## 1. What already exists

**Stack:** Node/Express backend, Postgres (schema `coexistence`), Redis + BullMQ for background jobs,
React frontend. No LangChain, no vector DB, no embeddings library in `package.json` — only
`@google/generative-ai`, `pg`, `bullmq`, `axios`.

**Multi-tenancy is already real, not aspirational.** Almost every table carries `workspace_id`, and
`resolveWorkspaceIdForRecord()` in `automationEngine.js` resolves it server-side from the WhatsApp
account the message arrived on — never from client input. `evaluateTriggers()` only loads automations
`WHERE workspace_id = $1`. This is exactly the isolation guarantee requirement #9 asks for, and it's
already enforced at the query layer. Big head start — don't rebuild this, extend it.

**Message ingestion:** `routes/webhook.js` receives inbound WhatsApp messages and writes them to
`coexistence.chat_history` — a flat, complete log (`direction`, `message_body`, `raw_payload`,
`media_*`, timestamps). This is your raw material for memory, but it is not memory itself — nothing
summarizes it today.

**Contacts:** `coexistence.contacts` has `wa_number`, `contact_number`, `name`, `tags` (jsonb),
`custom_fields` (jsonb), `assigned_user_id`, and an `ai_paused` flag (+ who paused it, when) — i.e.
human-handoff state already exists at the schema level.

**Automation engine:** `coexistence.chatbots` stores linear flows (`trigger_type = 'keyword'` only —
this is a legacy of a deliberate simplification pass, see `SESSION-HANDOFF.md`). `evaluateTriggers()`
fires **only on literal keyword match**. There is no "always respond" mode today.

**The current "AI Reply":** `engine/automationEngine.js` (~line 430) has an `ai_reply` directType that
calls `services/aiReplyService.js` → `services/geminiService.js`. This is a **single-turn, stateless
call**:
- Input: inbound message (truncated to 2000 chars), contact name, and a static goal/instructions
  string the user typed into the automation builder.
- No conversation history, no customer profile beyond name, no company knowledge, no live data, no
  memory.
- On failure it falls back to a configured WhatsApp template — that fallback path is solid and worth
  keeping.

There's also `executeAINode()` at line 1268 — a **stub**: `"note: 'AI processing logged (actual AI call
not implemented)'"`. This is dead scaffolding, not a real second AI path.

**Useful infrastructure already in place:**
- `coexistence.ai_models` table: encrypted API keys per provider, `available_models`/`enabled_models`
  jsonb — built for multi-provider, only Gemini is actually wired up yet.
- BullMQ + Redis — ready for background embedding/summarization jobs without new infra.
- `coexistence.deals` / `pipeline_stages` — CRM-ish data that can feed customer profile.

## 2. What's missing (maps directly to your 10 requirements)

| Requirement | Status |
|---|---|
| 1. Persistent conversation memory | **Absent.** Only raw `chat_history`; no summaries, no extracted facts, no selective retrieval. |
| 2. Intelligent retrieval (docs/FAQ/products) | **Absent.** No vector store, no chunking, no re-ranking. |
| 3. Customer-aware responses | **Partial.** Contact name only is passed in; `custom_fields`/`tags`/`deals` exist but aren't read into the AI path. |
| 4. Live data (Shopify/Zoho/Postgres/custom) | **Absent** from the AI path. (You have Zoho CRM work elsewhere — not connected here.) |
| 5. Intent detection | **Absent.** "Intent" today = exact keyword string match on the trigger. |
| 6. Context orchestration | **Absent.** No layer combines memory + profile + docs + live data. |
| 7. Answer validation / anti-hallucination | **Absent.** Whatever Gemini returns is sent as-is. |
| 8. Performance (caching, selective retrieval) | **Absent**, but BullMQ/Redis make it cheap to add. |
| 9. Multi-tenant isolation | **Already solid** — `workspace_id` enforcement exists throughout. Extend, don't rebuild. |
| 10. Not a copy of AiSensy | Current system is *less* than AiSensy today (keyword-only, single-turn) — the gap is real, not cosmetic. |

One structural point worth flagging explicitly: **today's AI reply only fires on keyword match.**
AiSensy-style "always-on assistant" behavior needs a new trigger mode, not just a smarter reply
generator — see Phase 6 below. This is a real architectural decision, not just an implementation detail.

## 3. Recommended Super RAG architecture (mapped to this codebase)

New module: `backend/src/services/superRag/` — kept separate from `aiReplyService.js` so nothing
existing breaks while it's being built.

```
webhook.js (inbound msg)
   → evaluateTriggers()  [existing, unchanged — keyword automations keep working]
   → evaluateDefaultAI() [NEW — only if no keyword automation matched, and workspace has AI agent enabled]
        → contextOrchestrator.handle(messageRecord, workspaceId)
             ├─ intentService.classify()        → multi-intent JSON
             ├─ memoryService.getSummary()       → conversation_memory table
             ├─ customerProfileService.get()     → contacts + deals + tags/custom_fields
             ├─ retrievalService.search()        → knowledge_chunks (pgvector) + re-rank
             ├─ liveDataService.fetch(intents)   → Shopify/Zoho/custom, with caching
             └─ (assemble bounded context) → LLM → validationService.check()
        → on low confidence: clarification question or ai_paused=true (existing handoff flag)
        → send via existing WhatsApp send path (unchanged)
```

Each service is independently testable and each one degrades gracefully (missing knowledge base ≠
crash — orchestrator just runs with less context), matching the existing `aiReplyService` philosophy
of "never throw, return null + reason."

## 4. Database changes (additive only — matches this project's own "non-destructive" convention)

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE coexistence.conversation_memory (
  id bigint PRIMARY KEY, workspace_id bigint NOT NULL,
  wa_number text NOT NULL, contact_number text NOT NULL,
  summary text, key_facts jsonb DEFAULT '{}',
  message_count_at_summary int, updated_at timestamptz DEFAULT now()
);

CREATE TABLE coexistence.knowledge_documents (
  id bigint PRIMARY KEY, workspace_id bigint NOT NULL,
  source_type text, title text, content text,
  metadata jsonb DEFAULT '{}', created_at timestamptz DEFAULT now()
);

CREATE TABLE coexistence.knowledge_chunks (
  id bigint PRIMARY KEY, document_id bigint NOT NULL, workspace_id bigint NOT NULL,
  chunk_text text, embedding vector(1536), token_count int,
  created_at timestamptz DEFAULT now()
);
-- ivfflat/hnsw index on embedding, scoped queries always filter workspace_id first

CREATE TABLE coexistence.live_data_cache (
  id bigint PRIMARY KEY, workspace_id bigint NOT NULL,
  cache_key text, response jsonb, fetched_at timestamptz, expires_at timestamptz
);

CREATE TABLE coexistence.ai_reply_audit (
  id bigint PRIMARY KEY, workspace_id bigint NOT NULL, contact_number text,
  inbound_message_id text, intents jsonb, retrieved_context jsonb,
  live_data_used jsonb, generated_reply text, validation_status text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE coexistence.workspace_ai_settings (
  workspace_id bigint PRIMARY KEY, enabled boolean DEFAULT false,
  system_prompt text, fallback_template_id integer,
  confidence_threshold numeric DEFAULT 0.6
);
```

No existing table is altered. `workspace_ai_settings.enabled` defaults to `false` — the always-on
agent stays opt-in per workspace until you're confident in it.

## 5. API/webhook changes

- `routes/webhook.js`: no change to ingestion. After `evaluateTriggers()` returns no match, call
  `evaluateDefaultAI(messageRecord)` gated by `workspace_ai_settings.enabled`.
- New: `routes/knowledge.js` — CRUD for documents, triggers chunk+embed BullMQ job.
- New: `routes/aiSettings.js` — per-workspace toggle, system prompt, provider/model, threshold.
- New: `routes/integrations/shopify.js`, `routes/integrations/zoho.js` — live-data connectors,
  following the existing service-file pattern (`whatsappEmbeddedSignupService.js` style).
- `automationEngine.js`: extend the `ai_reply` directType to optionally call
  `contextOrchestrator.handle()` instead of bare `aiReplyService` — as an opt-in upgrade on the node,
  not a replacement, so existing automations using plain AI Reply keep behaving exactly as before.

## 6. Phased implementation plan

| Phase | Scope | Breaks anything? |
|---|---|---|
| **0 — Foundation** | Enable pgvector, add new tables, add embedding-capable provider to `ai_models`. No behavior change. | No |
| **1 — Memory** | BullMQ job summarizes `chat_history` → `conversation_memory`. Read-only service, not wired to replies yet. | No |
| **2 — Knowledge RAG** | Doc upload → chunk → embed → `retrievalService` top-k search. Admin UI page per workspace. | No |
| **3 — Customer-aware + intent** | `customerProfileService` + `intentService`; new "Super RAG Reply" node type alongside (not replacing) existing "AI Reply". | No |
| **4 — Live data** | Shopify/Zoho connectors + caching, routed by intent. | No |
| **5 — Re-ranking + validation** | Score/re-rank retrieved chunks; grounding check before send; low-confidence → clarify or `ai_paused=true` handoff. | No |
| **6 — Always-on agent** | New `workspace_ai_settings.enabled` path so Super RAG answers messages with no keyword match — this is the actual AiSensy-equivalent behavior. Off by default. | No (opt-in) |
| **7 — SaaS hardening** | Per-workspace cost caps, `ai_reply_audit` dashboards, multi-provider selection via `ai_models`. | No |

Every phase is additive and independently shippable — your existing keyword automations, templates,
and broadcasts keep working untouched throughout.

---

**Recommendation:** start with Phase 0 + 1 together (foundation + memory) — it's low-risk, testable in
isolation, and everything else depends on it. Say the word and I'll start on the migration + memory
service without touching anything in the existing automation/webhook flow.
