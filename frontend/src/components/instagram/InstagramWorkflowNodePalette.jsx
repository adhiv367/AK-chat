import {
  Zap, MessageSquare, GitBranch, Clock, Bot,
  Send, UserPlus, Tag, Square,
} from 'lucide-react';
import { IG, FONT } from '../../constants.js';

export const NODE_TYPES = [
  { type: 'trigger', label: 'Trigger', Icon: Zap },
  { type: 'keyword', label: 'Keyword', Icon: MessageSquare },
  { type: 'condition', label: 'Condition', Icon: GitBranch },
  { type: 'delay', label: 'Delay', Icon: Clock },
  { type: 'ai_reply', label: 'AI Reply', Icon: Bot },
  { type: 'send_message', label: 'Send Message', Icon: Send },
  { type: 'assign_user', label: 'Assign User', Icon: UserPlus },
  { type: 'tag_contact', label: 'Tag Contact', Icon: Tag },
  { type: 'end', label: 'End Workflow', Icon: Square },
];

export default function InstagramWorkflowNodePalette({ onAddNode }) {
  return (
    <div style={{
      width: 160, borderRight: `1px solid ${IG.border}`, padding: 14,
      display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0, overflow: 'auto',
    }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: IG.textMuted, marginBottom: 4, textTransform: 'uppercase' }}>
        Nodes
      </div>
      {NODE_TYPES.map(nt => (
        <button
          key={nt.type}
          onClick={() => onAddNode(nt.type)}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '9px 10px', borderRadius: 12, border: `1px solid ${IG.border}`,
            background: IG.cardBg, cursor: 'pointer', fontFamily: FONT,
            fontSize: 12, fontWeight: 600, color: IG.text, textAlign: 'left',
          }}
        >
          <nt.Icon size={14} color={IG.primary} />
          {nt.label}
        </button>
      ))}
    </div>
  );
}