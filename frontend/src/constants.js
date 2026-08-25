// src/constants.js — full replacement (v2: complete design-system overhaul)

export const C = {
  pageBg: 'var(--c-pageBg, #0A0E14)',
  sidebarBg: 'var(--c-sidebarBg, #0D1119)',
  sidebarBorder: 'var(--c-sidebarBorder, rgba(255,255,255,.07))',
  headerBg: 'var(--c-headerBg, #0D1119)',
  headerText: 'var(--c-headerText, #F4F6F9)',
  headerMuted: 'var(--c-headerMuted, #A2ABBC)',
  headerBorder: 'var(--c-headerBorder, rgba(255,255,255,.09))',
  headerSurface: 'var(--c-headerSurface, #161B26)',
  cardBg: 'var(--c-cardBg, #12161F)',
  border: 'var(--c-border, rgba(255,255,255,.1))',
  borderDark: 'var(--c-borderDark, rgba(255,255,255,.06))',
  text: 'var(--c-text, #F4F6F9)',
  textSecondary: 'var(--c-textSecondary, #C3CBD9)',
  textMuted: 'var(--c-textMuted, #98A2B5)',
  primary: 'var(--c-primary, #0D9488)',
  primaryHover: 'var(--c-primaryHover, #0F766E)',
  primaryLight: 'var(--c-primaryLight, rgba(13,148,136,0.16))',
  primaryText: 'var(--c-primaryText, #ffffff)',
  purple: 'var(--c-purple, #818CF8)',
  green: 'var(--c-green, #34D399)',
  amber: 'var(--c-amber, #FBBF24)',
  shadowSm: 'var(--c-shadowSm, 0 1px 2px rgba(0,0,0,.4))',
  shadowMd: 'var(--c-shadowMd, 0 10px 28px rgba(0,0,0,.5))',
  shadowLg: 'var(--c-shadowLg, 0 24px 64px rgba(0,0,0,.6))',
  waBg: 'var(--c-waBg, #0B0F16)',
  surface: 'var(--c-surface, #12161F)',
  surfaceAlt: 'var(--c-surfaceAlt, #0D1119)',
  hover: 'var(--c-hover, rgba(13,148,136,0.10))',
  waBgPattern: 'url("data:image/svg+xml,%3Csvg width=\'16\' height=\'16\' viewBox=\'0 0 16 16\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cpath d=\'M0 0h8v8H0z\' fill=\'%23ffffff\' fill-opacity=\'0.025\'/%3E%3C/svg%3E")',

  // Sidebar tokens — obsidian, no longer solid violet
  navBg: 'var(--c-navBg, #0D1119)',
  navBgAlt: 'var(--c-navBgAlt, #161B26)',
  navText: 'var(--c-navText, #F4F6F9)',
  navMuted: 'var(--c-navMuted, #C3CBD9)',
  navGroupLabel: 'var(--c-navGroupLabel, #8B94A6)',
  navBorder: 'var(--c-navBorder, rgba(255,255,255,.09))',
  navHover: 'var(--c-navHover, rgba(255,255,255,.09))',
  navActiveBg: 'var(--c-navActiveBg, rgba(13,148,136,.22))',
  navActiveText: 'var(--c-navActiveText, #ffffff)',
  navActiveBar: 'var(--c-navActiveBar, #2DD4BF)',

  radiusSm: 'var(--c-radiusSm, 10px)',
  radiusMd: 'var(--c-radiusMd, 14px)',
  radiusLg: 'var(--c-radiusLg, 20px)',
};

// Instagram module keeps its own brand palette — unchanged on purpose,
// it's a separate visual identity inside the app.
export const IG = {
  primary: '#E1306C',
  gradient: 'linear-gradient(135deg, #833AB4, #E1306C, #FCAF45)',
  sidebarBg: '#fafafa',
  accentBg: '#fdf2f8',
  border: '#f0d9e4',
  text: '#262626',
  textMuted: '#8e8e8e',
  cardBg: '#ffffff',
};

export const CHAT = {
  incomingBg: 'var(--c-incomingBg, #161B26)',
  incomingText: 'var(--c-incomingText, #EEF1F6)',
  outgoingBg: 'var(--c-outgoingBg, #103832)',
  outgoingText: 'var(--c-outgoingText, #D8FBF3)',
  chatBg: 'var(--c-chatBg, #0A0E14)',
  bubbleRadius: '10px',
  bubblePadding: '7px 9px 9px 10px',
  statusDelivered: 'var(--c-statusDelivered, #818CF8)',
  statusRead: 'var(--c-statusRead, #2DD4BF)',
  statusSent: 'var(--c-statusSent, #5C6675)',
};

// Display/heading font is intentionally different from the body font —
// that pairing is what makes the typography feel designed rather than default.
export const FONT = "'Inter', system-ui, -apple-system, sans-serif";
export const DISPLAY_FONT = "'Space Grotesk', 'Inter', system-ui, sans-serif";
export const MONO = "'IBM Plex Mono', 'DM Mono', monospace";

// Type scale — for use as new components/pages get redone, so hierarchy
// stays consistent instead of ad-hoc pixel values scattered everywhere.
export const TYPE = {
  display: { fontFamily: DISPLAY_FONT, fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.15 },
  h1: { fontFamily: DISPLAY_FONT, fontSize: 22, fontWeight: 600, letterSpacing: '-0.015em', lineHeight: 1.2 },
  h2: { fontFamily: DISPLAY_FONT, fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em', lineHeight: 1.3 },
  label: { fontFamily: FONT, fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' },
  body: { fontFamily: FONT, fontSize: 13.5, fontWeight: 400, letterSpacing: '-0.005em', lineHeight: 1.55 },
  small: { fontFamily: FONT, fontSize: 12, fontWeight: 500, letterSpacing: 0, lineHeight: 1.4 },
  mono: { fontFamily: MONO, fontSize: 13, fontWeight: 500, letterSpacing: '-0.01em' },
};

// Spacing scale (px) — 4px base unit
export const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 };

export function relativeTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = Math.floor((now - d) / 1000);
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

export function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

export function maskPhone(raw) {
  const s = String(raw ?? '');
  const digits = s.replace(/\D/g, '');
  if (digits.length <= 5) return s;
  return digits.slice(0, 2) + '*'.repeat(digits.length - 5) + digits.slice(-3);
}

export function darkenColor(hex, factor = 0.5) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '');
  if (!m) return '#374151';
  const n = parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 255) * factor);
  const g = Math.round(((n >> 8) & 255) * factor);
  const b = Math.round((n & 255) * factor);
  return `rgb(${r}, ${g}, ${b})`;
}

export function formatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}
