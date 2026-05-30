import { useState } from 'react';
import { useSettings } from '@/lib/useSettings';
import { Skeleton } from '@/lib/Skeleton';
import { Icon } from '@/lib/Icon';
import { SkillsView } from './SkillsView';
import { ProvidersTab } from './ProvidersTab';
import { McpTab } from './McpTab';
import { VaultTab } from './VaultTab';
import { AboutTab } from './AboutTab';
import { SearchBox } from './settings-primitives';

type Tab = 'providers' | 'mcp' | 'skills' | 'vault' | 'about';

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'providers', label: 'Providers' },
  { id: 'mcp', label: 'MCP' },
  { id: 'skills', label: 'Skills' },
  { id: 'vault', label: 'Vault' },
  { id: 'about', label: 'About' },
];

/**
 * Tabbed settings panel — providers, MCP servers, skills, vault. Each tab
 * reads its slice via `useSettings` and only the active tab does heavy work
 * (the IPC fan-out happens on refresh; tab switch just swaps the view).
 *
 * Providers / MCP / Vault share one list language: a leading icon tile, a
 * name + status subtitle in a flexible middle column, and a right-aligned
 * status dot / toggle / badge — so every row lines up on the same grid.
 *
 * This is the tab shell: it owns the segmented nav, the per-tab search filter,
 * and the loading / error chrome, then renders the active tab component.
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

      {/* About is independent of the runner-backed settings slice — render
          it without the shared loading / error chrome below. */}
      {tab === 'about' && <AboutTab />}

      {tab !== 'about' && s.error && (
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

      {tab === 'about' ? null : s.loading ? (
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
