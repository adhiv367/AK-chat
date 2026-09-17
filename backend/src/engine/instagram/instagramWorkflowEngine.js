const pool = require('../../db');
const { generateInstagramReply } = require('../../services/instagram/instagramAiService');
const { sendTextMessage } = require('../../services/instagram/instagramMessageService');

/* ══════════════════════════════════════════════════════════════════════
   Instagram Workflow Execution Engine — Phase 4.4 live wiring.

   Walks a workflow's node graph starting from its Trigger node, following
   `config.edges` ({from,to}) in order, executing each node type. This
   mirrors engine/automationEngine.js's node/edge shape (the WhatsApp
   engine) rather than the previous version of this file, which referenced
   `instagram_workflow_nodes` / `instagram_workflow_edges` /
   `instagram_workflow_logs` tables that were never created anywhere in the
   schema (db/instagramSchema.js) — the real, actually-created workflow
   storage is `instagram_workflows.config` as a single JSONB blob
   ({nodes, edges}), same convention as coexistence.chatbots. That mismatch
   meant the manual test-run endpoint has been throwing on every call; this
   rewrite fixes it and wires it to real Instagram sends + Gemini AI reply
   as well as the real inbound webhook.

   Two execution modes, both walking the exact same graph:
     - source: 'webhook' -> real actions (real Graph API sends, real tags/
       assignment), gated by workspace ownership resolved server-side.
     - source: 'test'    -> dry-run ("Would send…" style results), same as
       the previous behavior, so the manual test endpoint stays safe to use
       during workflow authoring.
   ══════════════════════════════════════════════════════════════════════ */

function matchesKeyword(messageBody, keyword, matchType, caseSensitive) {
  if (!messageBody || !keyword) return false;
  const msg = caseSensitive ? String(messageBody).trim() : String(messageBody).toLowerCase().trim();
  const kw = caseSensitive ? String(keyword).trim() : String(keyword).toLowerCase().trim();
  if (!kw) return false;
  switch (matchType) {
    case 'contains': return msg.includes(kw);
    case 'starts': return msg.startsWith(kw);
    case 'exact':
    default:
      return msg === kw;
  }
}

// Minimal {{var}} support — Instagram workflows don't have the custom-field
// system WhatsApp automations do, so only {{name}} is resolved for now.
function resolveVariables(text, contactName) {
  if (!text) return text;
  return String(text).replace(/\{\{\s*name\s*\}\}/gi, contactName || '');
}

async function createExecution(client, workflowId, triggerSource, contactRef) {
  const { rows } = await client.query(
    `INSERT INTO coexistence.instagram_workflow_executions
       (workflow_id, status, trigger_source, contact_ref, started_at)
     VALUES ($1, 'running', $2, $3, NOW())
     RETURNING *`,
    [workflowId, triggerSource, contactRef || null]
  );
  return rows[0];
}

async function finishExecution(client, executionId, status, errorMessage) {
  await client.query(
    `UPDATE coexistence.instagram_workflow_executions
        SET status = $1, error_message = $2, completed_at = NOW()
      WHERE id = $3`,
    [status, errorMessage || null, executionId]
  );
}

async function logStep(client, executionId, node, status, result, durationMs) {
  await client.query(
    `INSERT INTO coexistence.instagram_workflow_execution_steps
       (execution_id, node_id, node_type, status, result, started_at, duration_ms)
     VALUES ($1, $2, $3, $4, $5, NOW(), $6)`,
    [executionId, node.id, node.type, status, typeof result === 'string' ? result : JSON.stringify(result), durationMs || 0]
  );
}
/**
 * @param {number|string} workflowId
 * @param {string} incomingMessage - the inbound DM text (or test message)
 * @param {object} context
 * @param {number} context.workspaceId - REQUIRED. Never trusted from a
 *   client — callers must resolve it server-side (webhook: from the owning
 *   Instagram account; test-run route: from req.workspace). The workflow is
 *   only ever loaded scoped to this workspace_id.
 * @param {'webhook'|'test'} [context.source]
 * @param {boolean} [context.isNewConversation] - true if this inbound
 *   message started a brand-new conversation, for trigger.triggerType ===
 *   'new_conversation' workflows.
 * @param {object} [context.account] - instagram_accounts row (needed for real sends)
 * @param {string} [context.igUserId] - recipient's IG-scoped user id (needed for real sends)
 * @param {number} [context.conversationId]
 * @param {number} [context.contactId]
 * @param {string} [context.contactName]
 */
async function runWorkflow(workflowId, incomingMessage = '', context = {}) {
  const workspaceId = context.workspaceId;
  const isTest = context.source === 'test';
  if (!workspaceId) {
    return { ok: false, error: 'workspaceId is required to run a workflow' };
  }

  const client = await pool.connect();
  try {
    const { rows: wfRows } = await client.query(
      `SELECT id, config FROM coexistence.instagram_workflows WHERE id = $1 AND workspace_id = $2`,
      [workflowId, workspaceId]
    );
    if (!wfRows[0]) {
      return { ok: false, error: 'Workflow not found in this workspace' };
    }
    const config = wfRows[0].config || {};
    const nodes = Array.isArray(config.nodes) ? config.nodes : [];
    const edges = Array.isArray(config.edges) ? config.edges : [];

    const triggerNode = nodes.find(n => n.type === 'trigger');
    if (!triggerNode) {
      return { ok: false, error: 'No trigger node' };
    }

    // Trigger-type gate, resolved before creating an execution record so a
    // workflow simply not applicable to this event (e.g. a
    // new_conversation-only workflow firing on a reply in an existing
    // conversation) doesn't leave noise in the execution log.
    const triggerType = triggerNode.config?.triggerType || 'keyword';
    if (triggerType === 'new_conversation' && !isTest && !context.isNewConversation) {
      return { ok: true, skipped: true, reason: 'trigger requires a new conversation' };
    }

    const execution = await createExecution(
      client, workflowId, context.source || 'webhook', context.igUserId || null
    );

    const steps = [];
    let current = triggerNode;
    const visited = new Set();
    let stoppedByGate = false;

    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      const cfg = current.config || {};
      const startedAt = Date.now();
      let status = 'success';
      let result = '';

      switch (current.type) {
        case 'trigger':
          result = 'Workflow started';
          break;

        case 'keyword': {
          const keywords = (cfg.keywords || '').split(',').map(k => k.trim()).filter(Boolean);
          const matched = keywords.length === 0 || keywords.some(k =>
            matchesKeyword(incomingMessage, k, cfg.matchType || 'contains', !!cfg.caseSensitive)
          );
          result = matched ? 'Matched' : 'No match';
          if (!matched) {
            status = 'skipped';
            stoppedByGate = true;
          }
          break;
        }

        case 'condition':
          // Placeholder evaluation, matching the previous behavior — real
          // field comparisons against IG contact data are out of scope for
          // Phase 4.4 (no new workflow DSL/features). Always passes through.
          result = `Evaluated: ${cfg.field || 'n/a'} ${cfg.operator || '=='} ${cfg.value || ''}`;
          break;

        case 'delay':
          // No job queue wired up yet — same stub as before, called out as
          // a limitation rather than half-implemented here.
          result = `Would wait ${cfg.seconds || 0}s (not yet scheduled)`;
          break;

        case 'ai_reply': {
          if (isTest) {
            result = 'AI reply stub — dry run (test mode does not call Gemini or send)';
            break;
          }
          const { reply, error } = await generateInstagramReply({
            customerMessage: incomingMessage,
            contactName: context.contactName,
            instructions: cfg.instructions,
          });
          if (!reply) {
            status = 'error';
            result = `AI reply failed: ${error}`;
            // Graceful failure — if the node has a fallback message
            // configured, still try to send that; otherwise just log and
            // move on without crashing the workflow.
            if (cfg.fallbackMessage && context.account && context.igUserId) {
              const sendRes = await sendTextMessage({
                account: context.account,
                igUserId: context.igUserId,
                conversationId: context.conversationId,
                contactId: context.contactId,
                text: resolveVariables(cfg.fallbackMessage, context.contactName),
              });
              result += sendRes.ok ? ' — fallback message sent' : ` — fallback send also failed: ${sendRes.error}`;
            }
          } else if (context.account && context.igUserId) {
            const sendRes = await sendTextMessage({
              account: context.account,
              igUserId: context.igUserId,
              conversationId: context.conversationId,
              contactId: context.contactId,
              text: reply,
            });
            result = sendRes.ok ? `AI replied: "${reply}"` : `AI reply generated but send failed: ${sendRes.error}`;
            if (!sendRes.ok) status = 'error';
          } else {
            status = 'error';
            result = 'AI reply generated but no account/recipient context to send it to';
          }
          break;
        }

        case 'send_message': {
          const text = resolveVariables(cfg.message || '', context.contactName);
          if (isTest) {
            result = `Would send: "${text}"`;
            break;
          }
          if (!context.account || !context.igUserId) {
            status = 'error';
            result = 'No account/recipient context to send to';
            break;
          }
          const sendRes = await sendTextMessage({
            account: context.account,
            igUserId: context.igUserId,
            conversationId: context.conversationId,
            contactId: context.contactId,
            text,
          });
          result = sendRes.ok ? `Sent: "${text}"` : `Send failed: ${sendRes.error}`;
          if (!sendRes.ok) status = 'error';
          break;
        }

        case 'assign_user': {
          if (isTest) {
            result = `Would assign to user ${cfg.userId || 'n/a'}`;
            break;
          }
          if (!cfg.userId || !context.conversationId) {
            status = 'error';
            result = 'Missing userId or conversation context';
            break;
          }
          await client.query(
            `UPDATE coexistence.instagram_conversations
                SET assignee_id = $1, updated_at = NOW()
              WHERE id = $2 AND workspace_id = $3`,
            [cfg.userId, context.conversationId, workspaceId]
          );
          result = `Assigned to user ${cfg.userId}`;
          break;
        }

        case 'tag_contact': {
          if (isTest) {
            result = `Would tag contact with "${cfg.tag || ''}"`;
            break;
          }
          if (!cfg.tag || !context.contactId) {
            status = 'error';
            result = 'Missing tag or contact context';
            break;
          }
          const existing = await client.query(
            `SELECT id FROM coexistence.instagram_tags WHERE contact_id = $1 AND tag = $2`,
            [context.contactId, cfg.tag]
          );
          if (existing.rows.length === 0) {
            await client.query(
              `INSERT INTO coexistence.instagram_tags (contact_id, tag) VALUES ($1, $2)`,
              [context.contactId, cfg.tag]
            );
          }
          result = `Tagged contact with "${cfg.tag}"`;
          break;
        }

        case 'end':
          result = 'Workflow ended';
          steps.push({ node: current.id, type: 'end', result });
          await logStep(client, execution.id, current, status, result, Date.now() - startedAt);
          current = null;
          continue;

        default:
          status = 'skipped';
          result = 'Unknown node type — skipped';
      }

      steps.push({ node: current.id, type: current.type, result, status });
      await logStep(client, execution.id, current, status, result, Date.now() - startedAt);

      if (stoppedByGate) { current = null; continue; }

      const nextEdge = edges.find(e => e.from === current.id);
      current = nextEdge ? nodes.find(n => n.id === nextEdge.to) : null;
    }

    await finishExecution(client, execution.id, stoppedByGate ? 'skipped' : 'success', null);
    return { ok: true, executionId: execution.id, steps };
  } catch (err) {
    console.error('[instagram-engine] runWorkflow error:', err.message);
    return { ok: false, error: err.message };
  } finally {
    client.release();
  }
}
/**
 * Called from the real inbound webhook. Loads every active workflow in the
 * message's workspace and runs each through the same graph walker used by
 * the manual test endpoint. Never throws — a failure here must not prevent
 * the webhook from acknowledging Meta's delivery.
 */
async function evaluateInstagramTriggers({ workspaceId, incomingMessage, account, igUserId, conversationId, contactId, contactName, isNewConversation }) {
  if (!workspaceId) return [];
  const results = [];
  try {
    const { rows: workflows } = await pool.query(
      `SELECT id FROM coexistence.instagram_workflows WHERE workspace_id = $1 AND status = 'active'`,
      [workspaceId]
    );
    for (const wf of workflows) {
      const result = await runWorkflow(wf.id, incomingMessage, {
        workspaceId,
        source: 'webhook',
        account,
        igUserId,
        conversationId,
        contactId,
        contactName,
        isNewConversation,
      });
      results.push({ workflowId: wf.id, ...result });
    }
  } catch (err) {
    console.error('[instagram-engine] evaluateInstagramTriggers error:', err.message);
  }
  return results;
}
module.exports = { runWorkflow, evaluateInstagramTriggers, matchesKeyword };