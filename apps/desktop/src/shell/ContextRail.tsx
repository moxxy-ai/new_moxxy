/**
 * Middle column — "the agent at a glance."
 *
 * Five stacked zones (top to bottom):
 *
 *   1. Status bar — active pill + collapse handle.
 *   2. Hero — brand avatar + mode/provider, with quick `Workspace`
 *      footer line (clickable: opens the new-workspace folder picker,
 *      reuses the sidebar's flow).
 *   3. Workspace section — name + cwd (mono, truncated).
 *   4. Capabilities — what this agent can act on.
 *   5. References — where its data lives.
 *
 * The whole rail is white now; visual rhythm comes from uppercase
 * mini-headers + thin hairlines rather than nested cards.
 */

import { useDesks } from '@/lib/useDesks';
import { Icon } from '@/lib/Icon';

interface Props {
  readonly mode: string | null;
  readonly provider: string | null;
  readonly onClose: () => void;
}

export function ContextRail({ mode, provider, onClose }: Props): JSX.Element {
  const desks = useDesks();
  const active = desks.desks.find((d) => d.id === desks.activeId);
  const accent = active?.color ?? 'var(--color-primary)';

  return (
    <section className="col-rail">
      <StatusBar onClose={onClose} />
      <Hero mode={mode} provider={provider} accent={accent} />
      <Divider />

      <Section title="Workspace">
        {active ? (
          <>
            <Row
              icon={<ColorDot color={active.color} />}
              title={active.name}
              subtitle="Active workspace"
            />
            <Path text={active.cwd} />
          </>
        ) : (
          <Row
            icon={<Icon name="workspace" size={14} />}
            title="No workspace bound"
            subtitle="Create one in the sidebar"
          />
        )}
      </Section>
      <Divider />

      <Section title="Capabilities">
        <Capability icon="spark" title="Analyze data" sub="Tools + transcript history" />
        <Capability icon="edit" title="Author + edit files" sub="Scoped to the workspace cwd" />
        <Capability icon="rotate" title="Run workflows" sub="From the Workflows panel" />
        <Capability icon="mic" title="Voice in" sub="Hold the mic to dictate" />
      </Section>
      <Divider />

      <Section title="References">
        <RefRow icon="edit" label="Skills" path="~/.moxxy/skills" />
        <RefRow icon="plug" label="Vault" path="OS keychain" />
      </Section>
    </section>
  );
}

function StatusBar({ onClose }: { readonly onClose: () => void }): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        // Match the Chat header's height exactly so the two columns
        // share a single top rule.
        height: 64,
        padding: '0 16px',
        borderBottom: '1px solid var(--color-card-border)',
        position: 'sticky',
        top: 0,
        background: 'var(--color-card-bg)',
        zIndex: 1,
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: 'var(--color-green)',
          boxShadow: '0 0 6px rgba(16, 185, 129, 0.6)',
        }}
      />
      <span
        style={{
          fontSize: 11.5,
          fontWeight: 600,
          color: 'var(--color-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.07em',
        }}
      >
        Active agent
      </span>
      <span style={{ flex: 1 }} />
      <button
        type="button"
        aria-label="Collapse rail"
        onClick={onClose}
        style={iconBtnStyle}
      >
        <Icon name="chevron-right" size={14} style={{ transform: 'rotate(180deg)' }} />
      </button>
    </div>
  );
}

function Hero({
  mode,
  provider,
  accent,
}: {
  readonly mode: string | null;
  readonly provider: string | null;
  readonly accent: string;
}): JSX.Element {
  return (
    <div
      style={{
        padding: '20px 18px 18px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        gap: 12,
        background: `radial-gradient(ellipse at top, ${hexToRgba(accent, 0.07)}, transparent 70%)`,
      }}
    >
      <div
        aria-hidden
        style={{
          position: 'relative',
          width: 96,
          height: 96,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <span
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: '50%',
            background: `radial-gradient(circle at center, ${hexToRgba(accent, 0.18)}, transparent 70%)`,
          }}
        />
        <img
          src="/avatar.png"
          alt=""
          width={88}
          height={88}
          style={{
            position: 'relative',
            imageRendering: 'pixelated',
            filter: 'drop-shadow(0 8px 10px rgba(236, 72, 153, 0.22))',
          }}
        />
      </div>
      <div style={{ width: '100%' }}>
        <div
          style={{
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: '-0.01em',
            color: 'var(--color-text)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
          title={mode ?? 'Default agent'}
        >
          {mode ?? 'Default agent'}
        </div>
        <div
          style={{
            marginTop: 2,
            fontSize: 12,
            color: 'var(--color-text-dim)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
          title={provider ?? ''}
        >
          {provider ? `Powered by ${provider}` : 'Pick a provider in the composer'}
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <section style={{ padding: '14px 16px 16px' }}>
      <header
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          color: 'var(--color-text-dim)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          marginBottom: 10,
        }}
      >
        {title}
      </header>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>
    </section>
  );
}

function Row({
  icon,
  title,
  subtitle,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly subtitle?: string;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span
        aria-hidden
        style={{
          width: 26,
          height: 26,
          borderRadius: 8,
          background: 'var(--color-primary-soft)',
          color: 'var(--color-primary-strong)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--color-text)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {title}
        </div>
        {subtitle && (
          <div style={{ fontSize: 11.5, color: 'var(--color-text-dim)' }}>{subtitle}</div>
        )}
      </div>
    </div>
  );
}

function Path({ text }: { readonly text: string }): JSX.Element {
  return (
    <div
      className="mono"
      title={text}
      style={{
        fontSize: 11.5,
        color: 'var(--color-text-muted)',
        background: '#f7f8fc',
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid var(--color-card-border)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {text}
    </div>
  );
}

function ColorDot({ color }: { readonly color: string }): JSX.Element {
  return (
    <span
      aria-hidden
      style={{
        width: 12,
        height: 12,
        borderRadius: '50%',
        background: color,
        boxShadow: `0 0 0 3px ${hexToRgba(color, 0.18)}`,
      }}
    />
  );
}

function Capability({
  icon,
  title,
  sub,
}: {
  readonly icon: Parameters<typeof Icon>[0]['name'];
  readonly title: string;
  readonly sub: string;
}): JSX.Element {
  return <Row icon={<Icon name={icon} size={14} />} title={title} subtitle={sub} />;
}

function RefRow({
  icon,
  label,
  path,
}: {
  readonly icon: Parameters<typeof Icon>[0]['name'];
  readonly label: string;
  readonly path: string;
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 8px',
        borderRadius: 8,
        transition: 'background 120ms ease',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-sidebar-bg-hover)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <span
        aria-hidden
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          background: 'var(--color-primary-soft)',
          color: 'var(--color-primary-strong)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Icon name={icon} size={12} />
      </span>
      <span
        style={{
          fontSize: 12.5,
          fontWeight: 600,
          color: 'var(--color-text)',
        }}
      >
        {label}
      </span>
      <span
        className="mono"
        title={path}
        style={{
          flex: 1,
          textAlign: 'right',
          fontSize: 11,
          color: 'var(--color-text-dim)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {path}
      </span>
    </div>
  );
}

function Divider(): JSX.Element {
  return (
    <hr
      style={{
        border: 'none',
        borderTop: '1px solid var(--color-card-border)',
        margin: '0 16px',
      }}
    />
  );
}

const iconBtnStyle: React.CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 7,
  color: 'var(--color-text-dim)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px solid var(--color-card-border)',
  background: '#fff',
};

/** Convert a CSS hex (#rrggbb or a var) into an rgba string. When the
 *  input doesn't look like a hex we fall back to the colour itself
 *  (caller will get something like `var(--…)` which the alpha helper
 *  can't tint — that's fine for the radial fades). */
function hexToRgba(input: string, alpha: number): string {
  if (!input.startsWith('#') || input.length !== 7) {
    return `rgba(236, 72, 153, ${alpha})`;
  }
  const r = parseInt(input.slice(1, 3), 16);
  const g = parseInt(input.slice(3, 5), 16);
  const b = parseInt(input.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
