import { C, FONT } from '../../constants.js';

export default function ModuleSwitch({ activeModule, onModuleChange }) {
 const options = [
    { id: 'whatsapp', label: 'WhatsApp' },
    { id: 'instagram', label: 'Instagram' },
    { id: 'email', label: '✉ Email' },
  ];

  return (
    <div style={{
      display: 'flex',
      background: C.headerSurface,
      border: `1px solid ${C.border}`,
      borderRadius: C.radiusMd,
      padding: 3,
      gap: 2,
    }}>
      {options.map(opt => {
        const active = activeModule === opt.id;
        return (
          <button
            key={opt.id}
            onClick={() => onModuleChange(opt.id)}
            style={{
              padding: '6px 16px',
              borderRadius: C.radiusSm,
              border: 'none',
              cursor: 'pointer',
              fontFamily: FONT,
              fontSize: 12.5,
              fontWeight: 700,
             background: active
                ? (opt.id === 'instagram' ? '#E1306C' : opt.id === 'email' ? '#16a34a' : C.primary)
                : 'transparent',
              color: active ? '#fff' : C.textSecondary,
              transition: 'all .15s',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}




