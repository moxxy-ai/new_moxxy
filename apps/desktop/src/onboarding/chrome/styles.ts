/**
 * Shared inline style tokens for the onboarding chrome and steps — the
 * input / button / picker / auth-card `React.CSSProperties` consts every
 * step reuses so the wizard's controls stay visually identical. A
 * dependency leaf (no React component code), imported by both the
 * primitives and the individual step components.
 */

export const inputStyle: React.CSSProperties = {
  padding: '10px 12px',
  fontSize: 14,
  color: 'var(--color-text)',
  background: '#fff',
  border: '1px solid var(--color-card-border)',
  borderRadius: 10,
  outline: 'none',
};

export const primaryBtnStyle: React.CSSProperties = {
  padding: '10px 18px',
  fontSize: 14,
  fontWeight: 600,
  color: '#fff',
  background: 'var(--grad-cta)',
  border: 'none',
  borderRadius: 10,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  boxShadow: '0 10px 20px -12px rgba(236, 72, 153, 0.55)',
};

export const secondaryBtnStyle: React.CSSProperties = {
  padding: '10px 18px',
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--color-text-muted)',
  background: 'transparent',
  border: '1px solid var(--color-card-border)',
  borderRadius: 10,
};

export const pickerBtnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 12px',
  fontSize: 13,
  color: 'var(--color-text)',
  background: '#f7f8fc',
  border: '1px dashed var(--color-card-border-strong)',
  borderRadius: 10,
  textAlign: 'left',
  width: '100%',
};

// ---- Auth styles ----------------------------------------------------------

/** Outer wrapper that draws our card chrome so the SignIn component
 *  (whose own card is now hidden via appearance.elements.card) sits
 *  inside the same chrome as every other onboarding step. overflow
 *  stays visible so the embedded button's box-shadow halo isn't
 *  clipped at the card edge. */
export const authCardStyle: React.CSSProperties = {
  padding: '20px 18px 18px',
  background: 'var(--color-card-bg)',
  border: '1px solid var(--color-card-border)',
  borderRadius: 12,
  overflow: 'visible',
};
