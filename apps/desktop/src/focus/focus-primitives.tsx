/**
 * Cross-stage atoms shared by the focus widget: the brand LogoMark, the
 * pulsing thinking Dot, and the hover-aware ActionButton used in the
 * active action row. Each is intentionally tiny and self-contained so
 * the stage components (inactive / active / mini-text) can compose them
 * without re-declaring hover/fallback logic.
 */

import { useState } from 'react';
import { ASSET_LOGO, style } from './focus-styles';

// ---- LogoMark ------------------------------------------------------------
// Uses the logo served from public/. Fallback to a typed glyph if the
// image fails to load (offline / dist mis-copy).

export function LogoMark({ size = 24 }: { readonly size?: number }): JSX.Element {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        aria-hidden
        style={{
          width: size,
          height: size,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: Math.round(size * 0.7),
          fontWeight: 800,
          color: '#ec4899',
        }}
      >
        m
      </span>
    );
  }
  return (
    <img
      src={ASSET_LOGO}
      width={size}
      height={size}
      alt=""
      aria-hidden
      draggable={false}
      onError={() => setFailed(true)}
      style={{
        width: size,
        height: size,
        display: 'block',
        objectFit: 'cover',
      }}
    />
  );
}

// ---- Dot -----------------------------------------------------------------

export function Dot({ delay }: { readonly delay: number }): JSX.Element {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 5,
        height: 5,
        borderRadius: 5,
        background: '#ec4899',
        margin: '0 1px',
        animation: 'focus-thinking 1.2s ease-in-out infinite',
        animationDelay: `${delay}ms`,
      }}
    />
  );
}

// ---- ActionButton --------------------------------------------------------

export function ActionButton({
  onClick,
  children,
  variant,
  ...rest
}: {
  readonly onClick: () => void;
  readonly children: React.ReactNode;
  readonly variant?: 'danger';
  readonly 'aria-label': string;
}): JSX.Element {
  const [hover, setHover] = useState(false);
  let hoverStyle: React.CSSProperties | null = null;
  if (hover) {
    hoverStyle =
      variant === 'danger'
        ? { background: 'rgba(239, 68, 68, 0.12)', color: '#ef4444' }
        : { background: 'rgba(15, 23, 42, 0.06)', color: '#0f172a' };
  }
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ ...style.actionBtn, ...(hoverStyle ?? {}) }}
      aria-label={rest['aria-label']}
    >
      {children}
    </button>
  );
}
