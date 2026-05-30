/**
 * Sidebar masthead — the pixel-art MoxxyAI mark plus the "Workspaces"
 * wordmark stacked beside it. Sits flush at the top of the dark rail.
 */
export function Logo(): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '18px 18px 14px',
      }}
    >
      <img
        src="/logo.png"
        alt="MoxxyAI Workspaces"
        width={32}
        height={32}
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          imageRendering: 'pixelated',
          flexShrink: 0,
        }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
        <span style={{ fontSize: 13.5, fontWeight: 700, letterSpacing: '-0.01em' }}>
          MoxxyAI
        </span>
        <span
          style={{
            fontSize: 10.5,
            color: 'var(--color-sidebar-text-dim)',
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}
        >
          Workspaces
        </span>
      </div>
    </div>
  );
}
