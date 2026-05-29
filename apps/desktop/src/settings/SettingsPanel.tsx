import { useEffect, useState } from 'react';
import { useSettings } from '@/lib/useSettings';
import { Skeleton } from '@/lib/Skeleton';
import { SkillsView } from './SkillsView';

type Tab = 'providers' | 'mcp' | 'skills' | 'vault';

/**
 * Tabbed settings panel — providers, MCP servers, skills, vault. Each
 * tab reads its slice via `useSettings` and only the active tab does
 * heavy work (the IPC fan-out happens on refresh; tab switch is just
 * filtering the rendered view).
 */
export function SettingsPanel(): JSX.Element {
  const s = useSettings();
  const [tab, setTab] = useState<Tab>('providers');

  return (
    <main
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '1.5rem 2rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'baseline', gap: '1rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700 }}>
          Settings
        </h1>
        <nav style={{ display: 'flex', gap: '0.25rem' }}>
          {(['providers', 'mcp', 'skills', 'vault'] as const).map((t) => (
            <button
              key={t}
              type="button"
              data-testid={`settings-tab-${t}`}
              data-active={tab === t}
              onClick={() => setTab(t)}
              style={{
                padding: '0.3rem 0.7rem',
                fontSize: '0.8rem',
                color: tab === t ? 'var(--color-text)' : 'var(--color-text-muted)',
                borderBottom:
                  tab === t
                    ? '2px solid var(--color-primary)'
                    : '2px solid transparent',
              }}
            >
              {t}
            </button>
          ))}
        </nav>
        <button
          type="button"
          onClick={() => void s.refresh()}
          style={{
            marginLeft: 'auto',
            fontSize: '0.75rem',
            color: 'var(--color-text-dim)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-block)',
            padding: '0.2rem 0.55rem',
          }}
        >
          Refresh
        </button>
      </header>
      {s.error && (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: '0.45rem 0.65rem',
            border: '1px solid var(--color-pink)',
            background: 'color-mix(in oklab, var(--color-pink) 12%, transparent)',
            borderRadius: 'var(--radius-block)',
            fontSize: '0.85rem',
          }}
        >
          {s.error}
        </p>
      )}
      {s.loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <Skeleton.Card />
          <Skeleton.Card />
          <Skeleton.Card />
        </div>
      ) : (
        <>
          {tab === 'providers' && <ProvidersTab providers={s.providers} />}
          {tab === 'mcp' && <McpTab servers={s.mcp} onToggle={s.toggleMcp} />}
          {tab === 'skills' && <SkillsView s={s} />}
          {tab === 'vault' && <VaultTab vault={s.vault} />}
        </>
      )}
    </main>
  );
}

function ProvidersTab({
  providers,
}: {
  readonly providers: ReturnType<typeof useSettings>['providers'];
}): JSX.Element {
  return (
    <List
      empty="No providers known to the connected runner."
      rows={providers.map((p) => ({
        key: p.name,
        title: p.name,
        subtitle: p.ready ? 'ready' : 'not ready',
        accent: p.ready ? 'var(--color-green)' : 'var(--color-text-dim)',
      }))}
    />
  );
}

function McpTab({
  servers,
  onToggle,
}: {
  readonly servers: ReadonlyArray<{ name: string; enabled: boolean; connected: boolean }>;
  readonly onToggle: (name: string, enabled: boolean) => Promise<void>;
}): JSX.Element {
  if (servers.length === 0) {
    return <p style={{ color: 'var(--color-text-dim)' }}>No MCP servers configured.</p>;
  }
  return (
    <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      {servers.map((srv) => (
        <li
          key={srv.name}
          data-testid={`mcp-row-${srv.name}`}
          style={{
            padding: '0.55rem 0.75rem',
            background: 'var(--color-bg-card)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-block)',
            display: 'grid',
            gridTemplateColumns: '1fr auto auto',
            gap: '0.5rem',
            alignItems: 'center',
          }}
        >
          <div>
            <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{srv.name}</div>
            <div
              className="mono"
              style={{ fontSize: '0.7rem', color: 'var(--color-text-dim)' }}
            >
              {srv.enabled ? 'enabled' : 'disabled'} · {srv.connected ? 'connected' : 'detached'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void onToggle(srv.name, !srv.enabled)}
            style={pill(srv.enabled ? 'var(--color-green)' : 'var(--color-text-dim)')}
          >
            {srv.enabled ? 'disable' : 'enable'}
          </button>
          <span />
        </li>
      ))}
    </ul>
  );
}

function SkillsTab({
  s,
}: {
  readonly s: ReturnType<typeof useSettings>;
}): JSX.Element {
  const [active, setActive] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!active) return;
    setLoading(true);
    void s.readSkill(active).then((b) => {
      setBody(b);
      setLoading(false);
    });
  }, [active, s]);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: '1rem' }}>
      <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {s.skills.length === 0 && (
          <li
            className="mono"
            style={{ fontSize: '0.75rem', color: 'var(--color-text-dim)' }}
          >
            No skills under ~/.moxxy/skills/
          </li>
        )}
        {s.skills.map((skill) => (
          <li key={skill.name}>
            <button
              type="button"
              data-testid={`skill-${skill.name}`}
              data-active={active === skill.name}
              onClick={() => setActive(skill.name)}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '0.35rem 0.6rem',
                fontSize: '0.8rem',
                color: active === skill.name ? 'var(--color-text)' : 'var(--color-text-muted)',
                background: active === skill.name ? 'var(--color-bg-card-hover)' : 'transparent',
                borderRadius: 'var(--radius-block)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {skill.name}
            </button>
          </li>
        ))}
      </ul>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <textarea
          data-testid="skill-editor"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={!active || loading}
          placeholder={active ? '' : 'Pick a skill to edit'}
          style={{
            minHeight: 320,
            padding: '0.6rem 0.75rem',
            fontSize: '0.8rem',
            background: 'var(--color-bg-card)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-block)',
            color: 'var(--color-text)',
            fontFamily: 'var(--font-mono)',
            resize: 'vertical',
            outline: 'none',
          }}
        />
        <button
          type="button"
          disabled={!active}
          onClick={() => active && void s.writeSkill(active, body)}
          style={pill('var(--color-primary)')}
        >
          Save
        </button>
      </div>
    </div>
  );
}

function VaultTab({
  vault,
}: {
  readonly vault: ReadonlyArray<{ name: string }>;
}): JSX.Element {
  return (
    <>
      <p style={{ color: 'var(--color-text-dim)', fontSize: '0.85rem', margin: 0 }}>
        Vault entries (names only — encrypted at rest by the moxxy CLI).
      </p>
      <List
        empty="Vault is empty."
        rows={vault.map((v) => ({
          key: v.name,
          title: v.name,
          subtitle: 'encrypted',
          accent: 'var(--color-text-dim)',
        }))}
      />
    </>
  );
}

function List({
  rows,
  empty,
}: {
  readonly rows: ReadonlyArray<{ key: string; title: string; subtitle: string; accent: string }>;
  readonly empty: string;
}): JSX.Element {
  if (rows.length === 0) {
    return <p style={{ color: 'var(--color-text-dim)' }}>{empty}</p>;
  }
  return (
    <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      {rows.map((r) => (
        <li
          key={r.key}
          style={{
            padding: '0.55rem 0.75rem',
            background: 'var(--color-bg-card)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-block)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.6rem',
          }}
        >
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: r.accent,
            }}
          />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>{r.title}</div>
            <div
              className="mono"
              style={{ fontSize: '0.7rem', color: 'var(--color-text-dim)' }}
            >
              {r.subtitle}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function pill(bg: string): React.CSSProperties {
  return {
    fontSize: '0.75rem',
    padding: '0.3rem 0.7rem',
    color: 'var(--color-bg)',
    background: bg,
    borderRadius: 'var(--radius-block)',
    fontWeight: 600,
  };
}
