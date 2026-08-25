import { useState } from 'react';
import {
  LayoutGrid, Zap, LayoutTemplate, MessageCircle, Users,
  Megaphone, Image as ImageIcon, KanbanSquare, Target,
  ChevronLeft, ChevronRight, Repeat,
} from 'lucide-react';
import { C, DISPLAY_FONT, FONT } from '../constants.js';

// NOTE: every `id` below is unchanged from the original Sidebar — App.jsx's
// VALID_PAGES set, its routing switch, and user.pages permission checks all
// key off these exact strings. Only the group names, labels, icon for "home",
// and the whole visual system changed.
const NAV_GROUPS = [
  {
    label: 'Overview',
    items: [
      { id: 'home', label: 'Insights Hub', Icon: LayoutGrid },
    ],
  },
  {
    label: 'Engage',
    items: [
      { id: 'chats', label: 'Live Conversations', Icon: MessageCircle },
      { id: 'contacts', label: 'Client Directory', Icon: Users },
      { id: 'pipelines', label: 'Deal Pipeline', Icon: KanbanSquare },
      { id: 'retarget', label: 'Retarget', Icon: Repeat },
    ],
  },
  {
    label: 'Automate',
    items: [
      { id: 'chatbot-builder', label: 'Workflow Studio', Icon: Zap },
      { id: 'template-builder', label: 'Template Studio', Icon: LayoutTemplate },
      { id: 'bulk-message', label: 'Broadcast Studio', Icon: Megaphone },
      { id: 'target-message', label: 'Precision Targeting', Icon: Target },
    ],
  },
  {
    label: 'Assets',
    items: [
      { id: 'media-library', label: 'Media Vault', Icon: ImageIcon },
    ],
  },
];

export default function Sidebar({ activePage, onPageChange, collapsed, setCollapsed, user }) {
  const [hoveredId, setHoveredId] = useState(null);

  const canSee = (id) => user?.role === 'admin' || !Array.isArray(user?.pages) || user.pages.includes(id);

  return (
    <div style={{
      width: collapsed ? 72 : 256,
      minHeight: '100%',
      background: C.navBg,
      borderRight: `1px solid ${C.navBorder}`,
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      transition: 'width .25s cubic-bezier(.4,0,.2,1)',
      overflow: 'hidden',
      position: 'relative',
    }}>
      {/* Nav groups */}
      <div style={{ padding: collapsed ? '20px 12px' : '22px 16px', flex: 1, overflowY: 'auto' }}>
        {NAV_GROUPS.map((group, gi) => {
          const visible = group.items.filter(item => canSee(item.id));
          if (visible.length === 0) return null;
          return (
            <div key={group.label} style={{ marginBottom: gi < NAV_GROUPS.length - 1 ? 26 : 0 }}>
              {!collapsed && (
                <div style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '.12em',
                  textTransform: 'uppercase',
                  color: C.navGroupLabel,
                  padding: '0 10px 10px',
                  fontFamily: FONT,
                }}>
                  {group.label}
                </div>
              )}
              {visible.map(item => {
                const active = activePage === item.id;
                const hovered = hoveredId === item.id;
                return (
                  <div
                    key={item.id}
                    onClick={() => onPageChange(item.id)}
                    onMouseEnter={() => setHoveredId(item.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    title={collapsed ? item.label : ''}
                    style={{
                      position: 'relative',
                      display: 'flex',
                      alignItems: 'center',
                      gap: collapsed ? 0 : 12,
                      padding: collapsed ? '12px 0' : '10px 12px',
                      borderRadius: 12,
                      cursor: 'pointer',
                      marginBottom: 2,
                      background: active ? C.navActiveBg : (hovered ? C.navHover : 'transparent'),
                      color: active ? C.navActiveText : (hovered ? C.navText : C.navMuted),
                      justifyContent: collapsed ? 'center' : 'flex-start',
                      fontFamily: FONT,
                      fontSize: 13,
                      fontWeight: active ? 600 : 500,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      userSelect: 'none',
                      transition: 'background .15s ease, color .15s ease',
                      border: '1px solid',
                      borderColor: active ? 'rgba(45,212,191,0.22)' : 'transparent',
                    }}
                  >
                    {active && (
                      <span style={{
                        position: 'absolute',
                        left: 0,
                        top: 9,
                        bottom: 9,
                        width: 3,
                        borderRadius: 3,
                        background: C.navActiveBar,
                        boxShadow: '0 0 8px rgba(45,212,191,0.6)',
                      }} />
                    )}
                    <span style={{
                      width: 18,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      color: active ? '#2DD4BF' : (hovered ? C.navText : C.navMuted),
                    }}>
                      <item.Icon size={17} strokeWidth={active ? 2.1 : (hovered ? 2 : 1.8)} />
                    </span>
                    {!collapsed && <span style={{ letterSpacing: '-.01em' }}>{item.label}</span>}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* User profile + collapse control */}
      <div style={{ borderTop: `1px solid ${C.navBorder}` }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 11,
          padding: collapsed ? '14px 0' : '14px 16px',
          justifyContent: collapsed ? 'center' : 'flex-start',
        }}>
          <div style={{
            width: 34, height: 34, borderRadius: 10, flexShrink: 0,
            background: `linear-gradient(135deg, ${C.primary}, #2DD4BF)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, fontWeight: 700, color: '#04201C', fontFamily: DISPLAY_FONT,
          }}>
            {(user?.displayName || user?.username || 'U').charAt(0).toUpperCase()}
          </div>
          {!collapsed && (
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{
                fontSize: 12.5, fontWeight: 600, color: C.navText, fontFamily: FONT,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {user?.displayName || user?.username || 'User'}
              </div>
              <div style={{ fontSize: 10.5, color: C.navMuted, fontFamily: FONT, letterSpacing: '.02em' }}>
                {user?.role === 'admin' ? 'Workspace Owner' : 'Team Member'}
              </div>
            </div>
          )}
        </div>

        <div
          onClick={() => setCollapsed(p => !p)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: collapsed ? '13px 0' : '12px 16px',
            cursor: 'pointer',
            justifyContent: collapsed ? 'center' : 'flex-start',
            transition: 'background .15s',
            color: C.navMuted,
            borderTop: `1px solid ${C.navBorder}`,
          }}
          onMouseEnter={e => e.currentTarget.style.background = C.navHover}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <span style={{
            width: 22, height: 22, borderRadius: 7,
            background: C.navHover,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            {collapsed ? <ChevronRight size={13} /> : <ChevronLeft size={13} />}
          </span>
          {!collapsed && (
            <span style={{ fontSize: 12, fontWeight: 600, fontFamily: FONT }}>
              Collapse
            </span>
          )}
        </div>

        <div style={{ padding: collapsed ? '0 0 14px' : '0 16px 14px', textAlign: collapsed ? 'center' : 'left' }}>
          <span style={{
            fontSize: collapsed ? 7 : 9,
            fontWeight: 700,
            color: 'rgba(255,255,255,.38)',
            fontFamily: FONT,
            letterSpacing: '.1em',
            textTransform: 'uppercase',
          }}>
            {collapsed ? 'AK' : 'AK Chat Platform'}
          </span>
        </div>
      </div>
    </div>
  );
}






