/**
 * The onboarding wizard Shell — the fixed two-column frame (branded
 * sidebar with the step list + progress, scrolling content pane) that
 * wraps whichever step is current. Stateless: it renders the passed step
 * list, highlights `currentIndex`, and slots `children` into the pane.
 */

import { Icon } from '@/lib/Icon';

export function Shell({
  steps,
  currentIndex,
  children,
}: {
  readonly steps: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly currentIndex: number;
  readonly children: React.ReactNode;
}): JSX.Element {
  const idx = currentIndex;
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--color-app-bg)',
        display: 'grid',
        gridTemplateColumns: '320px 1fr',
        overflow: 'hidden',
      }}
    >
      <aside
        style={{
          background: 'var(--color-card-bg)',
          borderRight: '1px solid var(--color-card-border)',
          padding: '24px 22px',
          display: 'flex',
          flexDirection: 'column',
          gap: 22,
        }}
      >
        <header style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img
            src="/logo.png"
            alt=""
            aria-hidden
            width={32}
            height={32}
            style={{ imageRendering: 'pixelated', borderRadius: 8 }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>MoxxyAI</span>
            <span
              style={{
                fontSize: 10.5,
                color: 'var(--color-text-dim)',
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
              }}
            >
              Workspaces
            </span>
          </div>
        </header>
        <h1 style={{ margin: 0, fontSize: 19, fontWeight: 700 }}>
          Let&rsquo;s get you set up.
        </h1>
        <p style={{ margin: 0, color: 'var(--color-text-muted)', fontSize: 13.5 }}>
          A few quick steps and you&rsquo;ll have your own AI workspace running locally.
        </p>
        <ol
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {steps.map((s, i) => {
            const done = i < idx;
            const current = i === idx;
            return (
              <li
                key={s.id}
                aria-current={current ? 'step' : undefined}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '7px 10px',
                  borderRadius: 9,
                  background: current ? 'var(--color-primary-soft)' : 'transparent',
                  color: current
                    ? 'var(--color-primary-strong)'
                    : done
                      ? 'var(--color-text-muted)'
                      : 'var(--color-text-dim)',
                  fontWeight: current ? 600 : 500,
                  fontSize: 13,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 999,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: done
                      ? 'var(--color-green)'
                      : current
                        ? 'var(--color-primary)'
                        : 'var(--color-card-border)',
                    color: '#fff',
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  {done ? <Icon name="check" size={12} /> : i + 1}
                </span>
                {s.label}
              </li>
            );
          })}
        </ol>
        <span style={{ flex: 1 }} />
        <footer
          className="mono"
          style={{ fontSize: 10.5, color: 'var(--color-text-dim)' }}
        >
          You can run through this again from Settings → About at any time.
        </footer>
      </aside>
      <main
        style={{
          display: 'grid',
          placeItems: 'center',
          padding: '24px 32px',
          overflowY: 'auto',
        }}
      >
        <div style={{ width: '100%', maxWidth: 540 }}>{children}</div>
      </main>
    </div>
  );
}
