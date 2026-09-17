// Builds the AI reply prompt from data the calling automation context
// already legitimately has access to (this workspace's contact + inbound
// message), and asks geminiService for a reply. Never throws — every path
// returns { reply: null, error: '<reason>' } on failure so the caller
// (automationEngine's ai_reply directType) can fall back cleanly.
//
// IMPORTANT: this service does not perform its own DB queries and does not
// accept a workspace_id to go look things up with — it only uses whatever
// fields are handed to it directly by the caller, which are themselves
// already scoped to the correct workspace by automationEngine (see
// context.workspace_id / context.contact there). This keeps the "never
// fetch unrelated/global data" requirement structurally true rather than
// relying on this file to remember to filter correctly.

const { askGemini } = require('./geminiService');

const MAX_CUSTOMER_MESSAGE_CHARS = 2000;
const MAX_GOAL_CHARS = 500;
const MAX_INSTRUCTIONS_CHARS = 2000;
const MAX_CONTACT_NAME_CHARS = 200;
const MAX_PROFILE_INSTRUCTIONS_CHARS = 2000;

function truncate(str, max) {
  if (!str) return '';
  const s = String(str);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * @param {object} params
 * @param {string} params.customerMessage - the inbound message body
 * @param {string} [params.contactName] - this workspace's contact's display name, if known
 * @param {string} [params.goal] - short goal/purpose for this AI reply node (from directData)
 * @param {string} [params.instructions] - free-form instructions/context for this AI reply node
 * @param {object} [params.businessProfile] - optional workspace-level baseline, e.g.
 *   { businessType: 'real_estate', systemInstructions: '...' }. Applied BEFORE
 *   the per-node goal/instructions below, so a node can still narrow or override
 *   it for its own trigger without the profile ever being silently dropped.
 *   Caller is responsible for scoping this to the correct workspace_id — this
 *   function does not fetch it itself, same rule as every other param here.
 * @param {string} [params.model] - optional model override
 * @param {number} [params.timeoutMs] - optional timeout override
 * @returns {Promise<{ reply: string|null, error: string|null }>}
 */
async function generateReply({ customerMessage, contactName, goal, instructions, businessProfile, model, timeoutMs } = {}) {
  const trimmedMessage = truncate(customerMessage, MAX_CUSTOMER_MESSAGE_CHARS);
  if (!trimmedMessage.trim()) {
    return { reply: null, error: 'no customer message to reply to' };
  }

  const safeName = truncate(contactName, MAX_CONTACT_NAME_CHARS);
  const safeGoal = truncate(goal, MAX_GOAL_CHARS);
  const safeInstructions = truncate(instructions, MAX_INSTRUCTIONS_CHARS);
  const safeProfileInstructions = truncate(businessProfile?.systemInstructions, MAX_PROFILE_INSTRUCTIONS_CHARS);

  const promptLines = [
    'You are a WhatsApp Business customer support assistant replying on behalf of this business.',
    'Keep the reply concise, professional, and appropriate for a WhatsApp message (a few sentences at most).',
  ];
  if (safeProfileInstructions) promptLines.push(`Business context (applies to all replies): ${safeProfileInstructions}`);
  if (safeGoal) promptLines.push(`Goal for this reply: ${safeGoal}`);
  if (safeInstructions) promptLines.push(`Additional instructions: ${safeInstructions}`);
  if (safeName) promptLines.push(`Customer name: ${safeName}`);
  promptLines.push(`Customer message: ${trimmedMessage}`);
  promptLines.push('Reply:');

  const prompt = promptLines.join('\n');

  const { text, error } = await askGemini(prompt, { model, timeoutMs });
  if (error || !text) {
    return { reply: null, error: error || 'empty AI response' };
  }
  return { reply: text, error: null };
}

module.exports = {
  generateReply,
};