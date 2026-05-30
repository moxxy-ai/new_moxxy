import { useState } from 'react';
import { useSettings } from '@/lib/useSettings';
import { Skeleton } from '@/lib/Skeleton';
import { Icon } from '@/lib/Icon';
import { TabHeader } from './TabHeader';
import { SkillsView } from './SkillsView';

type Tab = 'providers' | 'mcp' | 'skills' | 'vault';

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'providers', label: 'Providers' },
  { id: 'mcp', label: 'MCP' },
  { id: 'skills', label: 'Skills' },
  { id: 'vault', label: 'Vault' },
];

/**
 * Tabbed settings panel — providers, MCP servers, skills, vault. Each tab
 * reads its slice via `useSettings` and only the active tab does heavy work
 * (the IPC fan-out happens on refresh; tab switch just swaps the view).
 *
 * Providers / MCP / Vault share one list language: a leading icon tile, a
 * name + status subtitle in a flexible middle column, and a right-aligned
 * status dot / toggle / badge — so every row lines up on the same grid.
 */
export function SettingsPanel(): JSX.Element {
  const s = useSettings();
  const [tab, setTab] = useState<Tab>('providers');
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const providers = q ? s.providers.filter((p) => p.name.toLowerCase().includes(q)) : s.providers;
  const mcp = q ? s.mcp.filter((m) => m.name.toLowerCase().includes(q)) : s.mcp;
  const vault = q ? s.vault.filter((v) => v.name.toLowerCase().includes(q)) : s.vault;

  return (
    <main
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '28px 32px 40px',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <h1 style={{ margin: 0, fontSize: 21, fontWeight: 700, letterSpacing: '-0.01em' }}>
          Settings
        </h1>
        <nav
          style={{
            display: 'inline-flex',
            gap: 2,
            padding: 3,
            background: '#f1f2f9',
            borderRadius: 12,
          }}
        >
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                data-testid={`settings-tab-${t.id}`}
                data-active={active}
                onClick={() => {
                  setTab(t.id);
                  setQuery('');
                }}
                style={{
                  padding: '6px 15px',
                  fontSize: 13,
                  fontWeight: 600,
                  borderRadius: 9,
                  color: active ? 'var(--color-text)' : 'var(--color-text-muted)',
                  background: active ? '#fff' : 'transparent',
                  boxShadow: active ? '0 1px 3px rgba(15, 23, 42, 0.12)' : 'none',
                  transition: 'background 140ms, color 140ms',
                }}
              >
                {t.label}
              </button>
            );
          })}
        </nav>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn-chip"
          onClick={() => void s.refresh()}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--color-text-muted)',
            border: '1px solid var(--color-card-border)',
            borderRadius: 9,
            padding: '6px 12px',
            background: '#fff',
          }}
        >
          <Icon name="rotate" size={14} />
          Refresh
        </button>
      </header>

      {s.error && (
        <div
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            margin: 0,
            padding: '10px 14px',
            border: '1px solid color-mix(in oklab, var(--color-red) 30%, transparent)',
            background: 'color-mix(in oklab, var(--color-red) 8%, transparent)',
            borderRadius: 12,
            fontSize: 13,
            color: 'var(--color-red)',
          }}
        >
          <Icon name="x" size={15} />
          {s.error}
        </div>
      )}

      {s.loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Skeleton.Card />
          <Skeleton.Card />
          <Skeleton.Card />
        </div>
      ) : (
        <>
          {tab === 'providers' && (
            <ProvidersTab
              providers={providers}
              search={<SearchBox value={query} onChange={setQuery} placeholder="Search providers…" />}
            />
          )}
          {tab === 'mcp' && (
            <McpTab
              servers={mcp}
              onToggle={s.toggleMcp}
              search={<SearchBox value={query} onChange={setQuery} placeholder="Search MCP servers…" />}
            />
          )}
          {tab === 'skills' && <SkillsView s={s} />}
          {tab === 'vault' && (
            <VaultTab
              vault={vault}
              search={<SearchBox value={query} onChange={setQuery} placeholder="Search vault…" />}
              onAdd={s.setVaultKey}
              onRemove={s.removeVaultKey}
            />
          )}
        </>
      )}
    </main>
  );
}

// ---- tabs -----------------------------------------------------------------

function ProvidersTab({
  providers,
  search,
}: {
  readonly providers: ReturnType<typeof useSettings>['providers'];
  readonly search?: React.ReactNode;
}): JSX.Element {
  return (
    <Section
      title="Providers"
      count={providers.length}
      description="Model providers the runner can route to. Add a provider's key in the vault to activate it."
      search={search}
    >
      {providers.length === 0 ? (
        <EmptyState icon="spark" text="No providers known to the connected runner." />
      ) : (
        <CardList>
          {providers.map((p) => {
            const { bg, fg } = tintFor(p.name);
            return (
              <Row
                key={p.name}
                tile={
                  <Tile bg={bg} fg={fg}>
                    {p.name.slice(0, 1).toUpperCase()}
                  </Tile>
                }
                title={p.name}
                subtitle={p.ready ? 'Active · credentials resolved' : 'Inactive · add a key to use'}
                trailing={<StatusDot ok={p.ready} okLabel="Ready" offLabel="Inactive" />}
              />
            );
          })}
        </CardList>
      )}
    </Section>
  );
}

function McpTab({
  servers,
  onToggle,
  search,
}: {
  readonly servers: ReadonlyArray<{ name: string; enabled: boolean; connected: boolean }>;
  readonly onToggle: (name: string, enabled: boolean) => Promise<void>;
  readonly search?: React.ReactNode;
}): JSX.Element {
  return (
    <Section
      title="MCP servers"
      count={servers.length}
      description="Model Context Protocol servers. Toggle one on to attach its tools to the agent."
      search={search}
    >
      {servers.length === 0 ? (
        <EmptyState icon="plug" text="No MCP servers configured." />
      ) : (
        <CardList>
          {servers.map((srv) => (
            <Row
              key={srv.name}
              testId={`mcp-row-${srv.name}`}
              tile={
                <Tile bg="var(--color-primary-soft)" fg="var(--color-primary-strong)">
                  <Icon name="plug" size={18} />
                </Tile>
              }
              title={srv.name}
              subtitle={
                srv.connected
                  ? 'Connected · tools attached'
                  : srv.enabled
                    ? 'Enabled · not attached'
                    : 'Detached'
              }
              trailing={
                // The toggle reflects the LIVE attach state, not the persisted
                // `enabled` flag: detach only clears `connected`, so a switch
                // bound to `enabled` would stay on after disabling. On →
                // enableAndAttach, off → detach.
                <Switch
                  on={srv.connected}
                  label={`${srv.connected ? 'Disable' : 'Enable'} ${srv.name}`}
                  onClick={() => void onToggle(srv.name, !srv.connected)}
                />
              }
            />
          ))}
        </CardList>
      )}
    </Section>
  );
}

function VaultTab({
  vault,
  search,
  onAdd,
  onRemove,
}: {
  readonly vault: ReadonlyArray<{ name: string }>;
  readonly search?: React.ReactNode;
  readonly onAdd: (name: string, value: string) => Promise<void>;
  readonly onRemove: (name: string) => Promise<void>;
}): JSX.Element {
  const [adding, setAdding] = useState(false);
  return (
    <Section
      title="Vault"
      count={vault.length}
      description="Secrets stored by the moxxy CLI. Names only — values are encrypted at rest and never leave the host."
      search={search}
      actions={
        <button
          type="button"
          className="btn-cta"
          onClick={() => setAdding((v) => !v)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            padding: '8px 14px',
            fontSize: 13,
            fontWeight: 600,
            color: '#fff',
            background: 'var(--grad-cta)',
            borderRadius: 10,
          }}
        >
          <Icon name={adding ? 'x' : 'plus'} size={14} />
          {adding ? 'Close' : 'Add key'}
        </button>
      }
    >
      {adding && (
        <AddKeyForm
          existing={vault.map((v) => v.name)}
          onCancel={() => setAdding(false)}
          onSubmit={async (name, value) => {
            await onAdd(name, value);
            setAdding(false);
          }}
        />
      )}
      {vault.length === 0 ? (
        <EmptyState icon="lock" text="The vault is empty." />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: 10,
          }}
        >
          {vault.map((v) => (
            <VaultKeyCard key={v.name} name={v.name} onRemove={() => void onRemove(v.name)} />
          ))}
        </div>
      )}
    </Section>
  );
}

/** Inline add-key form — name + secret value, with light validation that
 *  mirrors the IPC schema so the user gets immediate feedback. */
function AddKeyForm({
  existing,
  onSubmit,
  onCancel,
}: {
  readonly existing: ReadonlyArray<string>;
  readonly onSubmit: (name: string, value: string) => Promise<void>;
  readonly onCancel: () => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const validName = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(trimmed) && !trimmed.includes('..');
  const exists = existing.includes(trimmed);
  const canSubmit = validName && !exists && value.length > 0 && !busy;

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed, value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 14,
        background: 'var(--color-card-bg)',
        border: '1px solid var(--color-card-border)',
        borderRadius: 14,
      }}
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="KEY_NAME (e.g. OPENAI_API_KEY)"
        className="mono"
        style={vaultInputStyle}
      />
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Secret value"
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
        }}
        style={vaultInputStyle}
      />
      {name.trim() && !validName && (
        <span style={{ fontSize: 11.5, color: 'var(--color-red)' }}>
          Use letters, digits, and . _ / - (no spaces or “..”).
        </span>
      )}
      {exists && (
        <span style={{ fontSize: 11.5, color: 'var(--color-amber)' }}>
          A key named “{trimmed}” already exists — saving overwrites it.
        </span>
      )}
      {error && <span style={{ fontSize: 11.5, color: 'var(--color-red)' }}>{error}</span>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button
          type="button"
          onClick={onCancel}
          style={{
            padding: '7px 13px',
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--color-text-muted)',
            border: '1px solid var(--color-card-border)',
            borderRadius: 9,
            background: '#fff',
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn-cta"
          onClick={() => void submit()}
          disabled={!(validName && value.length > 0) || busy}
          style={{
            padding: '7px 14px',
            fontSize: 12.5,
            fontWeight: 600,
            color: '#fff',
            background: 'var(--grad-cta)',
            borderRadius: 9,
            opacity: validName && value.length > 0 && !busy ? 1 : 0.5,
          }}
        >
          {busy ? 'Saving…' : exists ? 'Overwrite' : 'Save key'}
        </button>
      </div>
    </div>
  );
}

const vaultInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '9px 12px',
  fontSize: 13,
  color: 'var(--color-text)',
  background: '#fff',
  border: '1px solid var(--color-card-border)',
  borderRadius: 9,
  outline: 'none',
};

/** Password-manager-style credential tile: a key glyph, the secret name,
 *  and a masked value — distinct from the provider/MCP row list so the
 *  vault reads as "stored secrets," not "things to toggle." */
function VaultKeyCard({
  name,
  onRemove,
}: {
  readonly name: string;
  readonly onRemove: () => void;
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: '14px 15px',
        background: 'var(--color-card-bg)',
        border: '1px solid var(--color-card-border)',
        borderRadius: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <Tile bg="rgba(148, 163, 184, 0.16)" fg="var(--color-text-muted)">
          <Icon name="lock" size={15} />
        </Tile>
        <span
          className="mono"
          title={name}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--color-text)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {name}
        </span>
        <button
          type="button"
          className="btn-icon"
          aria-label={`Delete ${name}`}
          title="Delete key"
          onClick={onRemove}
          style={{
            width: 26,
            height: 26,
            flexShrink: 0,
            borderRadius: 7,
            color: 'var(--color-text-dim)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="x" size={14} />
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span
          aria-label="hidden value"
          style={{
            letterSpacing: '0.22em',
            fontSize: 15,
            lineHeight: 1,
            color: 'var(--color-text-dim)',
            userSelect: 'none',
          }}
        >
          ••••••••
        </span>
        <Badge>Encrypted</Badge>
      </div>
    </div>
  );
}

// ---- shared list primitives ----------------------------------------------

function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly placeholder: string;
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '9px 12px',
        background: '#fff',
        border: '1px solid var(--color-card-border)',
        borderRadius: 10,
      }}
    >
      <Icon name="search" size={15} style={{ color: 'var(--color-text-dim)', flexShrink: 0 }} />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          flex: 1,
          minWidth: 0,
          border: 'none',
          outline: 'none',
          background: 'transparent',
          fontSize: 13,
          color: 'var(--color-text)',
        }}
      />
    </div>
  );
}

function Section({
  title,
  count,
  description,
  actions,
  search,
  children,
}: {
  readonly title: string;
  readonly count?: number;
  readonly description?: string;
  readonly actions?: React.ReactNode;
  readonly search?: React.ReactNode;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <TabHeader
        title={title}
        {...(count !== undefined ? { count } : {})}
        {...(description ? { description } : {})}
        {...(actions ? { actions } : {})}
      />
      {search}
      {children}
    </section>
  );
}

function CardList({ children }: { readonly children: React.ReactNode }): JSX.Element {
  return (
    <ul
      role="list"
      style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      {children}
    </ul>
  );
}

function Row({
  tile,
  title,
  subtitle,
  trailing,
  mono,
  testId,
}: {
  readonly tile: React.ReactNode;
  readonly title: string;
  readonly subtitle?: string;
  readonly trailing?: React.ReactNode;
  readonly mono?: boolean;
  readonly testId?: string;
}): JSX.Element {
  return (
    <li
      {...(testId ? { 'data-testid': testId } : {})}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '13px 16px',
        background: 'var(--color-card-bg)',
        border: '1px solid var(--color-card-border)',
        borderRadius: 14,
      }}
    >
      {tile}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          className={mono ? 'mono' : undefined}
          style={{
            fontSize: 14,
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
          <div style={{ marginTop: 2, fontSize: 12, color: 'var(--color-text-dim)' }}>{subtitle}</div>
        )}
      </div>
      {trailing}
    </li>
  );
}

function Tile({
  children,
  bg,
  fg,
}: {
  readonly children: React.ReactNode;
  readonly bg: string;
  readonly fg: string;
}): JSX.Element {
  return (
    <span
      aria-hidden
      style={{
        width: 38,
        height: 38,
        flexShrink: 0,
        borderRadius: 11,
        background: bg,
        color: fg,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 15,
        fontWeight: 700,
      }}
    >
      {children}
    </span>
  );
}

function StatusDot({
  ok,
  okLabel,
  offLabel,
}: {
  readonly ok: boolean;
  readonly okLabel: string;
  readonly offLabel: string;
}): JSX.Element {
  return (
    <span
      style={{
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 12.5,
        fontWeight: 600,
        color: ok ? 'var(--color-text-muted)' : 'var(--color-text-dim)',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: ok ? 'var(--color-green)' : 'var(--color-card-border-strong)',
          boxShadow: ok ? '0 0 0 3px rgba(16, 185, 129, 0.16)' : 'none',
        }}
      />
      {ok ? okLabel : offLabel}
    </span>
  );
}

/** iOS-style toggle — the MCP attach/detach control. */
function Switch({
  on,
  onClick,
  label,
}: {
  readonly on: boolean;
  readonly onClick: () => void;
  readonly label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      style={{
        flexShrink: 0,
        width: 42,
        height: 24,
        padding: 2,
        borderRadius: 999,
        background: on ? 'var(--color-primary)' : 'var(--color-card-border-strong)',
        display: 'inline-flex',
        alignItems: 'center',
        transition: 'background 160ms ease',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 2px rgba(15, 23, 42, 0.35)',
          transform: on ? 'translateX(18px)' : 'translateX(0)',
          transition: 'transform 160ms ease',
        }}
      />
    </button>
  );
}

function Badge({ children }: { readonly children: React.ReactNode }): JSX.Element {
  return (
    <span
      style={{
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 10.5,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        padding: '3px 9px',
        borderRadius: 999,
        background: 'rgba(148, 163, 184, 0.16)',
        color: 'var(--color-text-muted)',
      }}
    >
      {children}
    </span>
  );
}

function EmptyState({
  icon,
  text,
}: {
  readonly icon: Parameters<typeof Icon>[0]['name'];
  readonly text: string;
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
        padding: '44px 20px',
        border: '1px dashed var(--color-card-border)',
        borderRadius: 14,
        color: 'var(--color-text-dim)',
      }}
    >
      <Icon name={icon} size={22} />
      <p style={{ margin: 0, fontSize: 13 }}>{text}</p>
    </div>
  );
}

/** Deterministic soft tint per provider name, so each tile is distinct
 *  but on-brand (pastel bg, saturated fg from the same hue). */
function tintFor(name: string): { bg: string; fg: string } {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return { bg: `hsl(${h} 72% 95%)`, fg: `hsl(${h} 55% 42%)` };
}
