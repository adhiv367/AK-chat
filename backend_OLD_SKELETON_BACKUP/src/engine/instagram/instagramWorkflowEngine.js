const pool = require('../../db');

// Walks a workflow's node graph starting from its Trigger node, following
// edges in order, executing each node type. Logs every step. This is a
// synchronous walk (delay nodes just record intent for now — real timed
// delays require a job queue, wired up in a later stage).
async function runWorkflow(workflowId, incomingMessage = '') {
  const nodesRes = await pool.query(
    `SELECT * FROM coexistence.instagram_workflow_nodes WHERE workflow_id = $1`, [workflowId]
  );
  const edgesRes = await pool.query(
    `SELECT * FROM coexistence.instagram_workflow_edges WHERE workflow_id = $1`, [workflowId]
  );
  const nodes = nodesRes.rows;
  const edges = edgesRes.rows;

  const log = async (status, message) => {
    await pool.query(
      `INSERT INTO coexistence.instagram_workflow_logs (workflow_id, status, message) VALUES ($1, $2, $3)`,
      [workflowId, status, message]
    );
  };

  const trigger = nodes.find(n => n.type === 'trigger');
  if (!trigger) {
    await log('error', 'No trigger node found');
    return { ok: false, error: 'No trigger node' };
  }

  const steps = [];
  let current = trigger;
  const visited = new Set();

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const config = current.config || {};

    switch (current.type) {
      case 'trigger':
        steps.push({ node: current.id, type: 'trigger', result: 'Workflow started' });
        break;
      case 'keyword': {
        const keywords = (config.keywords || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
        const matched = keywords.some(k => incomingMessage.toLowerCase().includes(k));
        steps.push({ node: current.id, type: 'keyword', result: matched ? 'Matched' : 'No match' });
        if (!matched) { current = null; continue; }
        break;
      }
      case 'condition': {
        // Simple placeholder condition evaluation — extend later with real field comparisons
        steps.push({ node: current.id, type: 'condition', result: `Evaluated: ${config.field || 'n/a'} ${config.operator || '=='} ${config.value || ''}` });
        break;
      }
      case 'delay':
        steps.push({ node: current.id, type: 'delay', result: `Would wait ${config.seconds || 0}s (not yet scheduled)` });
        break;
      case 'ai_reply':
        steps.push({ node: current.id, type: 'ai_reply', result: 'AI reply stub — not yet connected to a model' });
        break;
      case 'send_message':
        steps.push({ node: current.id, type: 'send_message', result: `Would send: "${config.message || ''}"` });
        break;
      case 'assign_user':
        steps.push({ node: current.id, type: 'assign_user', result: `Would assign to user ${config.userId || 'n/a'}` });
        break;
      case 'tag_contact':
        steps.push({ node: current.id, type: 'tag_contact', result: `Would tag contact with "${config.tag || ''}"` });
        break;
      case 'end':
        steps.push({ node: current.id, type: 'end', result: 'Workflow ended' });
        current = null;
        continue;
      default:
        steps.push({ node: current.id, type: current.type, result: 'Unknown node type — skipped' });
    }

    const nextEdge = edges.find(e => e.source_node_id === current.id);
    current = nextEdge ? nodes.find(n => n.id === nextEdge.target_node_id) : null;
  }

  await log('success', JSON.stringify(steps));
  return { ok: true, steps };
}

module.exports = { runWorkflow };