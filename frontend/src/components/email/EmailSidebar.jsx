import { C, FONT } from '../../constants.js';
const NAV = [
  { id: 'email-dashboard', label: 'Dashboard' },
  { id: 'email-campaigns', label: 'Campaigns' },
  { id: 'email-inbox', label: 'Inbox' },
  { id: 'email-contacts', label: 'Contacts' },
  { id: 'email-templates', label: 'Templates' },
  { id: 'email-settings', label: 'Settings' },
];
export default function EmailSidebar({ activePage, onPageChange }) {
  return (
    <div style={{
      width: 200,
      minHeight: '100%',
      background: C.sidebarBg,
      borderRight: `1px solid ${C.border}`,
      display: 'flex',
      flexDirection: 'column',
      padding: '16px 10px',
      gap: 4,
    }}>
      <div style={{
        fontSize: 11,
        fontWeight: 700,
        color: '#16a34a',
        letterSpacing: 1.2,
        textTransform: 'uppercase',
        padding: '4px 10px 10px',
      }}>
        Email Marketing
      </div>
      {NAV.map(item => {
        const active = activePage === item.id;
        return (
          <div
            key={item.id}
            onClick={() => onPageChange(item.id)}
            style={{
              padding: '9px 12px',
              borderRadius: 8,
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: active ? 600 : 400,
              color: active ? '#16a34a' : C.textSecondary,
              background: active ? 'rgba(22,163,74,0.1)' : 'transparent',
              border: `1px solid ${active ? 'rgba(22,163,74,0.25)' : 'transparent'}`,
              transition: 'all 0.15s',
              fontFamily: FONT,
            }}
            onMouseEnter={e => { if (!active) e.currentTarget.style.background = C.hover; }}
            onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
          >
            {item.label}
          </div>
        );
      })}
    </div>
  );
}
