import { useDesks } from '@/lib/useDesks';
import { Icon } from '@/lib/Icon';

interface Props {
  readonly mode: string | null;
  readonly provider: string | null;
  readonly onClose: () => void;
}

/**
 * Middle column. Mirrors the reference design's three stacked cards:
 *
 *   1. Active agent — the runner's active mode + provider, with a
 *      configure shortcut.
 *   2. Capabilities — broad categories the agent can act on.
 *   3. Context — where the agent's data is coming from.
 *
 * Static for now; replaced by live runner state once SessionInfo
 * exposes those slots.
 */
export function ContextRail({ mode, provider, onClose }: Props): JSX.Element {
  const desks = useDesks();
  const active = desks.desks.find((d) => d.id === desks.activeId);

  return (
    <section className="col-rail">
      <Card>
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--color-text-muted)',
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: 'var(--color-green)',
              display: 'inline-block',
            }}
          />
          <span style={{ flex: 1 }}>Active agent</span>
          <SmallButton aria-label="Collapse rail" onClick={onClose}>
            <Icon name="chevron-right" size={14} style={{ transform: 'rotate(180deg)' }} />
          </SmallButton>
        </header>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, minWidth: 0 }}>
          <Avatar color={active?.color ?? '#818cf8'} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 13.5,
                fontWeight: 600,
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
                fontSize: 12,
                color: 'var(--color-text-dim)',
                marginTop: 2,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              title={provider ? `Powered by ${provider}` : 'Pick a provider in Settings.'}
            >
              {provider
                ? `Powered by ${provider}`
                : 'Pick a provider in Settings.'}
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader>Capabilities</CardHeader>
        <CapabilityRow icon="spark" title="Analyze data" sub="Tools + transcript history" />
        <CapabilityRow icon="edit" title="Author + edit files" sub="Workspace cwd: limited" />
        <CapabilityRow icon="rotate" title="Run workflows" sub="From the Workflows panel" />
        <CapabilityRow icon="mic" title="Voice in" sub="Hold the mic to dictate" />
      </Card>

      <Card>
        <CardHeader>Context</CardHeader>
        <ContextRow
          title="Workspace"
          value={active?.cwd ?? '—'}
          subtitle={active?.name ?? 'No workspace selected'}
        />
        <ContextRow
          title="Skills"
          value="~/.moxxy/skills"
          subtitle="Edit from Settings → Skills"
        />
        <ContextRow
          title="Vault"
          value="OS keychain"
          subtitle="Encrypted at rest"
        />
      </Card>
    </section>
  );
}

function Card({ children }: { readonly children: React.ReactNode }): JSX.Element {
  return (
    <section
      style={{
        padding: '6px 0 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        borderBottom: '1px solid var(--color-card-border)',
      }}
    >
      {children}
    </section>
  );
}

function CardHeader({
  children,
  badge,
}: {
  readonly children: React.ReactNode;
  readonly badge?: string;
}): JSX.Element {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 12.5,
        fontWeight: 600,
        color: 'var(--color-text-muted)',
      }}
    >
      {badge && (
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: 'var(--color-green)',
            display: 'inline-block',
          }}
        />
      )}
      {children}
    </header>
  );
}

function Avatar({ color }: { readonly color: string }): JSX.Element {
  return (
    <span
      aria-hidden
      style={{
        width: 38,
        height: 38,
        borderRadius: 10,
        background: `${color}1f`,
        color,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <Icon name="agent" size={20} />
    </span>
  );
}

function CapabilityRow({
  icon,
  title,
  sub,
}: {
  readonly icon: Parameters<typeof Icon>[0]['name'];
  readonly title: string;
  readonly sub: string;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '4px 0' }}>
      <span
        aria-hidden
        style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          background: 'var(--color-primary-soft)',
          color: 'var(--color-primary)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Icon name={icon} size={15} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 11.5, color: 'var(--color-text-dim)' }}>{sub}</div>
      </div>
    </div>
  );
}

function ContextRow({
  title,
  value,
  subtitle,
}: {
  readonly title: string;
  readonly value: string;
  readonly subtitle: string;
}): JSX.Element {
  return (
    <div
      style={{
        padding: '4px 0',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--color-text-dim)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        {title}
      </div>
      <div
        className="mono"
        style={{
          fontSize: 12,
          color: 'var(--color-text)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 11, color: 'var(--color-text-dim)' }}>{subtitle}</div>
    </div>
  );
}

function SmallButton({
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <button
      type="button"
      style={{
        width: 30,
        height: 30,
        borderRadius: 8,
        color: 'var(--color-text-dim)',
        border: '1px solid var(--color-card-border)',
        background: '#fff',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      {...rest}
    >
      {children}
    </button>
  );
}
