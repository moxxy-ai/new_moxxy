/**
 * Inline style tokens + the keyframe stylesheet for the focus widget.
 *
 * Flat. Sharp-cornered. No transitions on the things that
 * resize/relayout (those caused the bounce on collapse). Kept in one
 * module so every stage component (inactive / active / mini-text) and
 * the shared primitives pull the same `style` record.
 */

// ---- Drag regions --------------------------------------------------------
// The whole window background is the OS drag region; interactive
// controls cut a no-drag hole over their own area.

export const drag = { WebkitAppRegion: 'drag' as const };
export const noDrag = { WebkitAppRegion: 'no-drag' as const };

// ---- Logo asset ----------------------------------------------------------
// Uses the logo served from public/. Fallback to a typed glyph if the
// image fails to load (offline / dist mis-copy) — see LogoMark.

export const ASSET_LOGO = './logo.png';

// ---- Panel tokens --------------------------------------------------------

const PANEL_BG = '#ffffff';
const PANEL_BORDER = '1px solid rgba(15, 23, 42, 0.14)';

// ---- Styles --------------------------------------------------------------

export const style: Record<string, React.CSSProperties> = {
  // ---- inactive --------------------------------------------------------
  inactiveRoot: {
    width: '100%',
    height: '100%',
    background: PANEL_BG,
    border: PANEL_BORDER,
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    // Whole window is the drag region; the inner button cuts a
    // no-drag hole over its area.
    cursor: 'grab',
    ...drag,
  },
  inactiveButton: {
    border: 'none',
    background: 'transparent',
    padding: 0,
    margin: 0,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    // z-index keeps the click target on top of any future overlay
    // chrome we might add (busy-state ring, etc.).
    position: 'relative',
    zIndex: 1,
    ...noDrag,
  },

  // ---- active ----------------------------------------------------------
  activeRoot: {
    width: '100%',
    height: '100%',
    background: PANEL_BG,
    border: PANEL_BORDER,
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    padding: '0 8px',
    position: 'relative',
    overflow: 'hidden',
    // Whole panel is the drag region; the brand button + action
    // row both opt out with no-drag + position:relative so they
    // sit on top of the drag layer.
    cursor: 'grab',
    ...drag,
  },
  activeBrand: {
    width: 36,
    height: 36,
    padding: 0,
    margin: 0,
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    position: 'relative',
    zIndex: 1,
    ...noDrag,
  },
  activeDivider: {
    width: 1,
    height: 26,
    background: 'rgba(15, 23, 42, 0.12)',
    margin: '0 6px',
    flexShrink: 0,
  },
  activeActions: {
    display: 'flex',
    gap: 2,
    marginLeft: 'auto',
    position: 'relative',
    zIndex: 1,
    ...noDrag,
  },
  actionBtn: {
    width: 34,
    height: 34,
    padding: 0,
    margin: 0,
    border: 'none',
    background: 'transparent',
    color: '#64748b',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ---- mini -----------------------------------------------------------
  panel: {
    width: '100%',
    height: '100%',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    background: PANEL_BG,
    border: PANEL_BORDER,
    overflow: 'hidden',
    ...noDrag,
  },
  miniHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 8px',
    borderBottom: '1px solid rgba(15, 23, 42, 0.08)',
    cursor: 'grab',
    ...drag,
  },
  headerButton: {
    width: 24,
    height: 24,
    padding: 0,
    background: 'transparent',
    border: 'none',
    color: '#64748b',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    ...noDrag,
  },
  miniTitle: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11.5,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: '#64748b',
    ...noDrag,
  },
  panelBody: {
    flex: 1,
    padding: '10px 14px',
    display: 'flex',
    alignItems: 'center',
    minHeight: 0,
  },
  lineRow: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
  },
  composer: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 10px',
    borderTop: '1px solid rgba(15, 23, 42, 0.08)',
    background: '#fff',
    ...noDrag,
  },
  input: {
    flex: 1,
    height: 32,
    padding: '0 10px',
    fontSize: 13,
    color: '#0f172a',
    background: '#f8fafc',
    border: '1px solid rgba(15, 23, 42, 0.12)',
    outline: 'none',
    fontFamily: 'inherit',
  },
  send: {
    width: 32,
    height: 32,
    border: 'none',
    background: 'linear-gradient(135deg, #ec4899, #d946ef)',
    color: '#fff',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
};

// ---- Keyframes -----------------------------------------------------------
// Injected once on module load so the spinner dots + mic-pulse
// animations resolve regardless of which stage mounts first.

if (typeof document !== 'undefined' && !document.getElementById('focus-keyframes')) {
  const styleTag = document.createElement('style');
  styleTag.id = 'focus-keyframes';
  styleTag.textContent = `
    @keyframes focus-thinking {
      0%, 100% { transform: translateY(0); opacity: 0.4; }
      50%      { transform: translateY(-3px); opacity: 1; }
    }
    /* Mic-button breathing ring — the inner gradient stays put,
     * the outer ring pulses to signal active recording. */
    @keyframes focus-mic-pulse {
      0%, 100% {
        box-shadow:
          0 0 0 4px rgba(255, 255, 255, 0.85),
          0 0 0 9px rgba(239, 68, 68, 0.35),
          0 14px 36px -6px rgba(239, 68, 68, 0.6),
          inset 0 -6px 14px rgba(190, 18, 60, 0.45),
          inset 0 4px 6px rgba(255, 255, 255, 0.55);
      }
      50% {
        box-shadow:
          0 0 0 4px rgba(255, 255, 255, 0.85),
          0 0 0 14px rgba(239, 68, 68, 0.12),
          0 14px 36px -6px rgba(239, 68, 68, 0.6),
          inset 0 -6px 14px rgba(190, 18, 60, 0.45),
          inset 0 4px 6px rgba(255, 255, 255, 0.55);
      }
    }
  `;
  document.head.appendChild(styleTag);
}
