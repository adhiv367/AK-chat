import {
  Inbox,
  Users,
  LayoutTemplate,
  Megaphone,
  Zap,
  BarChart3,
  Settings,
  UserCog,
} from 'lucide-react';
import { IG, FONT } from '../../constants.js';

const NAV_ITEMS = [
  { id: 'ig-accounts', label: 'Accounts', Icon: UserCog },
  { id: 'ig-inbox', label: 'Inbox', Icon: Inbox },
  { id: 'ig-contacts', label: 'Contacts', Icon: Users },
  { id: 'ig-templates', label: 'Templates', Icon: LayoutTemplate },
  { id: 'ig-campaigns', label: 'Campaigns', Icon: Megaphone },
  { id: 'ig-workflow', label: 'Workflow', Icon: Zap },
  { id: 'ig-analytics', label: 'Analytics', Icon: BarChart3 },
  { id: 'ig-settings', label: 'Settings', Icon: Settings },
];

export default function InstagramSidebar({ activePage, onPageChange }) {
  return (
    <div style={{
      width: 84,
      minHeight: '100%',
      background: IG.sidebarBg,
      borderRight: `1px solid ${IG.border}`,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      flexShrink: 0,
      paddingTop: 18,
      gap: 6,
    }}>
      {NAV_ITEMS.map(item => {
        const active = activePage === item.id;
        return (
          <div
            key={item.id}
            onClick={() => onPageChange(item.id)}
            title={item.label}
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 3,
              background: active ? IG.accentBg : 'transparent',
              border: active ? `1px solid ${IG.border}` : '1px solid transparent',
              transition: 'background .12s, border-color .12s',
            }}
          >
            <item.Icon size={19} color={active ? IG.primary : IG.textMuted} strokeWidth={active ? 2.4 : 1.8} />
            <span style={{
              fontSize: 9, fontWeight: 700, fontFamily: FONT,
              color: active ? IG.primary : IG.textMuted,
            }}>
              {item.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}