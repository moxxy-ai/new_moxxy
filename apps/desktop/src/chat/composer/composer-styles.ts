/** Style helper for the Composer's send / abort circle button — the
 *  background colour swaps (send vs. red abort) and the disabled state
 *  dims + drops the glow. */
export function sendBtn(bg: string, enabled: boolean): React.CSSProperties {
  return {
    width: 38,
    height: 38,
    borderRadius: 12,
    background: bg,
    color: '#fff',
    fontSize: 14,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    opacity: enabled ? 1 : 0.45,
    boxShadow: enabled ? '0 8px 20px -10px rgba(236, 72, 153, 0.55)' : 'none',
  };
}
