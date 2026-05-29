import { useState } from 'react';
import { useSettings, type SettingsApi } from '@/lib/settings';

interface SettingsPanelProps {
  readonly api?: SettingsApi;
}

export function SettingsPanel({ api }: SettingsPanelProps): JSX.Element {
  const fallback = useSettings();
  const settings = api ?? fallback;
  const [tab, setTab] = useState<'providers' | 'skills'>('providers');

  return (
    <div
      data-testid="settings-panel"
      style={{
        position: 'absolute',
        inset: 0,
        overflowY: 'auto',
        padding: '1.5rem 2rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'baseline', gap: '1rem' }}>
        <h1
          style={{
            margin: 0,
            fontSize: '1.25rem',
            fontWeight: 700,
            letterSpacing: 'var(--tracking-tight)',
          }}
        >
          Settings
        </h1>
        <nav style={{ display: 'flex', gap: '0.25rem' }}>
          {(['providers', 'skills'] as const).map((k) => (
            <button
              key={k}
              type="button"
              data-testid={`settings-tab-${k}`}
              data-active={tab === k}
              onClick={() => setTab(k)}
              style={{
                padding: '0.3rem 0.7rem',
                fontSize: '0.8rem',
                color: tab === k ? 'var(--color-text)' : 'var(--color-text-muted)',
                borderBottom:
                  tab === k
                    ? '2px solid var(--color-primary)'
                    : '2px solid transparent',
                background: 'transparent',
              }}
            >
              {k === 'providers' ? 'Providers' : 'Skills'}
            </button>
          ))}
        </nav>
      </header>

      {settings.error && (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: '0.5rem 0.75rem',
            background: 'color-mix(in oklab, var(--color-pink) 12%, transparent)',
            border: '1px solid var(--color-pink)',
            borderRadius: 'var(--radius-block)',
            fontSize: '0.85rem',
          }}
        >
          {settings.error}
        </p>
      )}

      {tab === 'providers' ? (
        <ProvidersPane api={settings} />
      ) : (
        <SkillsPane api={settings} />
      )}
    </div>
  );
}

function ProvidersPane({ api }: { readonly api: SettingsApi }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <section>
        <SectionHeader>Built-in</SectionHeader>
        <ul
          role="list"
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
          }}
        >
          {api.providers.known.map((p) => (
            <ProviderRow key={p.name} provider={p} api={api} />
          ))}
        </ul>
      </section>
      {api.providers.custom.length > 0 && (
        <section>
          <SectionHeader>Custom (from ~/.moxxy/providers.json)</SectionHeader>
          <ul
            role="list"
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: '0.5rem',
            }}
          >
            {api.providers.custom.map((p) => (
              <li
                key={p.name}
                data-testid={`custom-provider-${p.name}`}
                style={{
                  padding: '0.6rem 0.8rem',
                  border: '1px solid var(--color-border)',
                  background: 'var(--color-bg-card)',
                  borderRadius: 'var(--radius-block)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.2rem',
                }}
              >
                <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>
                  {p.name}
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: '0.7rem',
                    color: 'var(--color-text-dim)',
                  }}
                >
                  {p.baseURL}
                  {p.defaultModel ? ` · ${p.defaultModel}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function SectionHeader({
  children,
}: {
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <h2
      style={{
        margin: '0 0 0.4rem',
        fontSize: '0.7rem',
        color: 'var(--color-text-dim)',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
      }}
    >
      {children}
    </h2>
  );
}

function ProviderRow({
  provider,
  api,
}: {
  readonly provider: { name: string; configured: boolean };
  readonly api: SettingsApi;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (): Promise<void> => {
    if (!secret) return;
    setSaving(true);
    const ok = await api.saveApiKey(provider.name, secret);
    setSaving(false);
    if (ok) {
      setSecret('');
      setOpen(false);
    }
  };

  return (
    <li
      data-testid={`provider-row-${provider.name}`}
      data-configured={provider.configured}
      style={{
        padding: '0.6rem 0.8rem',
        border: '1px solid var(--color-border)',
        background: 'var(--color-bg-card)',
        borderRadius: 'var(--radius-block)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
        }}
      >
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: provider.configured
              ? 'var(--color-green)'
              : 'var(--color-text-dim)',
          }}
        />
        <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>
          {provider.name}
        </span>
        <button
          type="button"
          data-testid={`provider-edit-${provider.name}`}
          onClick={() => setOpen((o) => !o)}
          style={{
            marginLeft: 'auto',
            fontSize: '0.75rem',
            padding: '0.2rem 0.5rem',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-block)',
            color: 'var(--color-text-dim)',
          }}
        >
          {provider.configured ? 'Replace key' : 'Add key'}
        </button>
      </div>
      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          style={{ display: 'flex', gap: '0.4rem' }}
        >
          <input
            data-testid={`provider-secret-${provider.name}`}
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="API key"
            autoFocus
            style={{
              flex: 1,
              padding: '0.35rem 0.6rem',
              fontSize: '0.85rem',
              color: 'var(--color-text)',
              background: 'var(--color-bg)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-block)',
              fontFamily: 'var(--font-mono)',
            }}
          />
          <button
            type="submit"
            data-testid={`provider-save-${provider.name}`}
            disabled={!secret || saving}
            style={{
              padding: '0 0.7rem',
              fontSize: '0.85rem',
              color: 'var(--color-bg)',
              background: 'var(--color-primary)',
              borderRadius: 'var(--radius-block)',
              fontWeight: 600,
              opacity: !secret || saving ? 0.4 : 1,
            }}
          >
            {saving ? '…' : 'Save'}
          </button>
        </form>
      )}
    </li>
  );
}

function SkillsPane({ api }: { readonly api: SettingsApi }): JSX.Element {
  const [active, setActive] = useState<string | null>(null);
  const [body, setBody] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const select = async (name: string): Promise<void> => {
    setActive(name);
    setLoading(true);
    try {
      setBody(await api.readSkill(name));
    } catch (e) {
      setBody(`# error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const save = async (): Promise<void> => {
    if (!active) return;
    setSaving(true);
    await api.writeSkill(active, body);
    setSaving(false);
  };

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '220px 1fr',
        gap: '1rem',
        minHeight: 320,
      }}
    >
      <ul
        role="list"
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: '0.25rem',
        }}
      >
        {api.skills.length === 0 && (
          <li
            className="mono"
            style={{ fontSize: '0.75rem', color: 'var(--color-text-dim)' }}
          >
            No skills under ~/.moxxy/skills/
          </li>
        )}
        {api.skills.map((name) => (
          <li key={name}>
            <button
              type="button"
              data-testid={`skill-row-${name}`}
              data-active={active === name}
              onClick={() => void select(name)}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '0.35rem 0.5rem',
                fontSize: '0.8rem',
                color:
                  active === name
                    ? 'var(--color-text)'
                    : 'var(--color-text-muted)',
                background:
                  active === name
                    ? 'var(--color-bg-card-hover)'
                    : 'transparent',
                borderRadius: 'var(--radius-block)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {name}
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
            flex: 1,
            minHeight: 280,
            padding: '0.6rem 0.8rem',
            fontSize: '0.8rem',
            color: 'var(--color-text)',
            background: 'var(--color-bg-card)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-block)',
            fontFamily: 'var(--font-mono)',
            resize: 'vertical',
            outline: 'none',
          }}
        />
        <button
          type="button"
          data-testid="skill-save"
          disabled={!active || saving}
          onClick={() => void save()}
          style={{
            alignSelf: 'flex-end',
            padding: '0.4rem 0.9rem',
            background: 'var(--color-primary)',
            color: 'var(--color-bg)',
            borderRadius: 'var(--radius-block)',
            fontWeight: 600,
            opacity: !active || saving ? 0.4 : 1,
          }}
        >
          {saving ? '…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
