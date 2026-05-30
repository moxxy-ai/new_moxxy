/**
 * Uppercase, letter-spaced caption that labels each rail section
 * ("Workspaces", "Menu"). Accepts a `style` override so callers can
 * tweak spacing without forking the component.
 */
export function SectionHeader({
  title,
  style,
}: {
  readonly title: string;
  readonly style?: React.CSSProperties;
}): JSX.Element {
  return (
    <div
      style={{
        padding: '8px 12px 6px',
        fontSize: 10.5,
        fontWeight: 600,
        color: 'var(--color-sidebar-text-dim)',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        ...style,
      }}
    >
      {title}
    </div>
  );
}
