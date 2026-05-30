/**
 * Skeleton primitives — render a shimmery placeholder that matches the
 * shape of the content it stands in for. The shimmer comes from a CSS
 * animation defined in `styles.css` (`@keyframes moxxy-shimmer`).
 *
 * Use `<Skeleton.Line />` for a single text-line placeholder and
 * `<Skeleton.Row />` for a left-icon + label row (the desks/workflows
 * default shape).
 */

const baseStyle: React.CSSProperties = {
  display: 'inline-block',
  background:
    'linear-gradient(90deg, var(--color-bg-card) 0%, var(--color-bg-card-hover) 50%, var(--color-bg-card) 100%)',
  backgroundSize: '200% 100%',
  animation: 'moxxy-shimmer 1.4s ease-in-out infinite',
  borderRadius: 4,
};

function Line({
  width = '100%',
  height = 10,
  style,
}: {
  readonly width?: number | string;
  readonly height?: number;
  readonly style?: React.CSSProperties;
}): JSX.Element {
  return (
    <span
      aria-hidden
      style={{ ...baseStyle, width, height, ...style }}
    />
  );
}

function Row(): JSX.Element {
  return (
    <div
      aria-hidden
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        padding: '0.4rem 1rem',
      }}
    >
      <Line width={8} height={8} style={{ borderRadius: '50%' }} />
      <Line width="60%" />
    </div>
  );
}

function Card({ lines = 2 }: { readonly lines?: number }): JSX.Element {
  return (
    <div
      aria-hidden
      style={{
        padding: '0.65rem 0.85rem',
        background: 'var(--color-bg-card)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-block)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.4rem',
      }}
    >
      <Line width="40%" height={12} />
      {Array.from({ length: lines - 1 }).map((_, i) => (
        <Line key={i} width={`${30 + i * 20}%`} height={10} />
      ))}
    </div>
  );
}

export const Skeleton = { Line, Row, Card };
