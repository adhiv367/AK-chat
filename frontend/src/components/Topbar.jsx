import { useState, useRef, useEffect } from 'react';
import { LogOut, Settings, AlertTriangle, Search, Bell } from 'lucide-react';
import { C, FONT, DISPLAY_FONT } from '../constants.js';
import { api } from '../api.js';
import ModuleSwitch from './instagram/ModuleSwitch.jsx';

export default function Topbar({ user, onLogout, onNavigate, activeModule, onModuleChange }) {
  const [userOpen, setUserOpen] = useState(false);
  const [unhealthyAccounts, setUnhealthyAccounts] = useState([]);
  const [searchFocused, setSearchFocused] = useState(false);

  const ref = useRef(null);

  useEffect(() => {
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setUserOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      api.whatsappAccounts.list()
        .then(accs => { if (!cancelled) setUnhealthyAccounts(accs.filter(a => a.healthStatus === 'invalid_token')); })
        .catch(() => {});
    };
    check();
    const t = setInterval(check, 60000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return (
    <>
    {unhealthyAccounts.length > 0 && (
      <div
        onClick={() => onNavigate('admin-settings')}
        style={{
          background: '#7C2D12', color: '#fff', padding: '9px 16px',
          fontSize: 12.5, fontFamily: FONT, display: 'flex', alignItems: 'center',
          justifyContent: 'center', gap: 8, cursor: 'pointer', fontWeight: 500,
        }}
      >
        <AlertTriangle size={14} />
        <span>
          Access token expired for {unhealthyAccounts.map(a => a.displayName).join(', ')} — click to reconnect in Workspace Settings → Channels
        </span>
      </div>
    )}
    <div style={{
      height: 68,
      background: C.headerBg,
      display: 'flex',
      alignItems: 'center',
      paddingLeft: 0,
      paddingRight: 24,
      borderBottom: `1px solid ${C.headerBorder}`,
      flexShrink: 0,
      zIndex: 100,
      position: 'relative',
      gap: 22,
    }}>
      {/* Logo area — aligns with sidebar */}
      <button
        onClick={() => onNavigate('chats')}
        style={{
          width: 256,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 22,
          gap: 10,
          borderRight: `1px solid ${C.headerBorder}`,
          height: '100%',
          background: 'transparent',
          border: 'none',
          borderRightWidth: 1,
          borderRightStyle: 'solid',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <div style={{
          width: 34, height: 34, borderRadius: 10, flexShrink: 0,
          background: `linear-gradient(135deg, ${C.primary}, #2DD4BF)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9.5" stroke="#04201C" strokeWidth="1.8" />
            <circle cx="12" cy="12" r="4.6" stroke="#04201C" strokeWidth="1.6" />
            <circle cx="12" cy="12" r="1.4" fill="#04201C" />
          </svg>
        </div>
        <div style={{ lineHeight: 1.1 }}>
          <div style={{
            fontSize: 16,
            fontWeight: 700,
            color: C.headerText,
            fontFamily: DISPLAY_FONT,
            letterSpacing: '-0.01em',
            lineHeight: 1,
          }}>
            AK Chat
          </div>
          <div style={{ fontSize: 9.5, color: C.headerMuted, fontFamily: FONT, letterSpacing: '.04em', marginTop: 3 }}>
            MESSAGING PLATFORM
          </div>
        </div>
      </button>

      {/* Search bar */}
      <div style={{
        flex: 1,
        maxWidth: 460,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        background: C.headerSurface,
        border: `1.5px solid ${searchFocused ? C.primary : C.border}`,
        borderRadius: 12,
        padding: '10px 15px',
        color: C.textMuted,
        transition: 'border-color .15s',
      }}>
        <Search size={15} strokeWidth={2} color={searchFocused ? C.primary : C.textMuted} />
        <input
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          placeholder="Search conversations, clients, campaigns…"
          style={{
            flex: 1,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            fontSize: 13,
            fontFamily: FONT,
            color: C.text,
          }}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <ModuleSwitch activeModule={activeModule} onModuleChange={onModuleChange} />
      </div>

      {/* Right controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginLeft: 'auto' }}>
        <button
          style={{
            width: 40, height: 40, borderRadius: 12,
            border: `1px solid ${C.border}`, background: 'transparent',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', color: C.textSecondary,
            transition: 'background .15s, border-color .15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = C.primaryLight; e.currentTarget.style.borderColor = C.primary; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = C.border; }}
          title="Alerts"
        >
          <Bell size={17} />
        </button>

        {/* User avatar */}
        <div ref={ref} style={{ position: 'relative' }}>
          <button
            onClick={() => setUserOpen(p => !p)}
            style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              background: `linear-gradient(135deg, ${C.primary}, #2DD4BF)`,
              border: userOpen ? `2px solid ${C.primary}` : `1.5px solid ${C.border}`,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 15,
              fontWeight: 700,
              color: '#04201C',
              fontFamily: DISPLAY_FONT,
              transition: 'border .15s',
              padding: 0,
              overflow: 'hidden',
              marginLeft: 4,
            }}
          >
            {(user.displayName || user.username).charAt(0).toUpperCase()}
          </button>

          {userOpen && (
            <div style={{
              position: 'absolute',
              top: 50,
              right: 0,
              background: C.cardBg,
              border: `1px solid ${C.border}`,
              borderRadius: 14,
              boxShadow: C.shadowMd,
              padding: 8,
              minWidth: 200,
              zIndex: 200,
            }}>
              <div style={{ padding: '10px 12px', borderBottom: `1px solid ${C.border}`, marginBottom: 5 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: C.text, fontFamily: DISPLAY_FONT }}>
                  {user.displayName || user.username}
                </div>
                <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                  Workspace Owner
                </div>
              </div>
              <button
                onClick={() => { setUserOpen(false); onNavigate('admin-settings'); }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  padding: '10px 12px',
                  borderRadius: 9,
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  color: C.text,
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: FONT,
                  marginBottom: 4,
                }}
                onMouseEnter={e => e.currentTarget.style.background = C.hover}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <Settings size={14} />
                Workspace Settings
              </button>
              <button
                onClick={() => { setUserOpen(false); onLogout(); }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  padding: '10px 12px',
                  borderRadius: 9,
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  color: C.primary,
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: FONT,
                }}
                onMouseEnter={e => e.currentTarget.style.background = C.primaryLight}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <LogOut size={14} />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
    </>
  );
}
