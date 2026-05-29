/**
 * Inline agent pickers in the composer toolbar.
 *
 *   [ Model: openai/gpt-4o ▾ ] [ Mode: tool-use ▾ ]
 *
 * The Model chip is a single entry point that opens a two-column
 * modal (providers on the left, models on the right). Switching a
 * provider hits the workspace's session over IPC (session.setProvider)
 * and resets the sticky model; picking a model commits it to the
 * chatStore for that workspace and is passed to every runTurn.
 *
 * The Mode chip stays as a flat native-select chip because there's no
 * sub-list to disclose — modes are flat.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from '@/lib/api';
import { chatStore } from '@/lib/chatStore';
import { Modal } from '@/lib/Modal';

interface ProviderInfo {
  readonly name: string;
  readonly models: ReadonlyArray<{ readonly name: string }>;
}

interface SessionInfo {
  readonly providers: ReadonlyArray<ProviderInfo>;
  readonly modes: ReadonlyArray<string>;
  readonly activeProvider: string | null;
  readonly activeMode: string | null;
}

export function AgentPicker({
  workspaceId,
  disabled,
}: {
  readonly workspaceId: string;
  readonly disabled: boolean;
}): JSX.Element | null {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const selectedModel = useSyncExternalStore(chatStore.subscribe, () =>
    chatStore.getModel(workspaceId),
  );

  const refresh = (): void => {
    void api()
      .invoke('session.info', { workspaceId })
      .then((raw) => setInfo(raw as SessionInfo | null))
      .catch(() => {});
  };

  useEffect(() => {
    let cancelled = false;
    void api()
      .invoke('session.info', { workspaceId })
      .then((raw) => {
        if (!cancelled) setInfo(raw as SessionInfo | null);
      })
      .catch(() => {});
    const off = api().subscribe('runner.info.changed', () => {
      if (!cancelled) refresh();
    });
    return () => {
      cancelled = true;
      off();
    };
    // refresh is stable enough for the lifetime of this workspaceId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  if (!info) return null;

  const onMode = async (next: string): Promise<void> => {
    // Optimistic flip so the chip updates instantly — the IPC fires
    // a fire-and-forget RPC to the runner, then the renderer relies
    // on a session.info refresh to confirm. Without this the chip
    // visibly snaps back to the old value for a beat.
    setInfo((cur) => (cur ? { ...cur, activeMode: next } : cur));
    try {
      await api().invoke('session.setMode', { workspaceId, mode: next });
      refresh();
    } catch {
      refresh();
    }
  };

  const onPickProviderModel = async (
    provider: string,
    model: string | null,
  ): Promise<void> => {
    if (provider !== info.activeProvider) {
      try {
        await api().invoke('session.setProvider', { workspaceId, provider });
      } catch {
        return;
      }
    }
    chatStore.setModel(workspaceId, model);
    setPickerOpen(false);
    refresh();
  };

  const modelLabel = selectedModel
    ? `${info.activeProvider ?? '—'}/${selectedModel}`
    : info.activeProvider ?? 'pick';

  return (
    <>
      <ChipButton
        label="Model"
        value={modelLabel}
        disabled={disabled}
        onClick={() => setPickerOpen(true)}
      />
      <ChipSelect
        label="Mode"
        value={info.activeMode ?? ''}
        options={[...info.modes]}
        disabled={disabled || info.modes.length === 0}
        onChange={(v) => void onMode(v)}
      />
      {pickerOpen && (
        <ProviderModelPicker
          providers={info.providers}
          activeProvider={info.activeProvider}
          activeModel={selectedModel}
          onPick={(p, m) => void onPickProviderModel(p, m)}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}

function ChipButton({
  label,
  value,
  disabled,
  onClick,
}: {
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '6px 10px',
        fontSize: 12.5,
        color: 'var(--color-text-muted)',
        border: '1px solid var(--color-card-border)',
        borderRadius: 10,
        background: '#fff',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <span style={{ color: 'var(--color-text-dim)' }}>{label}:</span>
      <span
        style={{
          fontWeight: 600,
          color: 'var(--color-text)',
          maxWidth: 180,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {value}
      </span>
      <span aria-hidden style={{ color: 'var(--color-text-dim)' }}>
        ▾
      </span>
    </button>
  );
}

function ChipSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly onChange: (next: string) => void;
}): JSX.Element {
  return (
    <label
      title={label}
      style={{
        position: 'relative',
        padding: '6px 10px',
        fontSize: 12.5,
        color: 'var(--color-text-muted)',
        border: '1px solid var(--color-card-border)',
        borderRadius: 10,
        background: '#fff',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <span style={{ color: 'var(--color-text-dim)' }}>{label}:</span>
      <span
        style={{
          fontWeight: 600,
          color: 'var(--color-text)',
          maxWidth: 120,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {value || '—'}
      </span>
      <span aria-hidden style={{ color: 'var(--color-text-dim)' }}>
        ▾
      </span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 0,
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

function ProviderModelPicker({
  providers,
  activeProvider,
  activeModel,
  onPick,
  onClose,
}: {
  readonly providers: ReadonlyArray<ProviderInfo>;
  readonly activeProvider: string | null;
  readonly activeModel: string | null;
  readonly onPick: (provider: string, model: string | null) => void;
  readonly onClose: () => void;
}): JSX.Element {
  // The provider highlighted in the left column. Defaults to the
  // workspace's active provider so the modal opens showing the
  // current model set. Decoupled from `activeProvider` because the
  // user may browse without committing.
  const [hoveredProvider, setHoveredProvider] = useState<string>(
    activeProvider ?? providers[0]?.name ?? '',
  );
  const [adminProviders, setAdminProviders] = useState<ReadonlyArray<string>>([]);
  useEffect(() => {
    let cancelled = false;
    void api()
      .invoke('settings.adminProviders')
      .then((list) => {
        if (!cancelled) setAdminProviders(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const canFetchLive = adminProviders.includes(hoveredProvider);
  // Per-provider cache of models fetched live from the provider's API.
  // We merge these with whatever the runner already advertised so the
  // user can refresh once and not lose the additions on tab switch.
  const [fetched, setFetched] = useState<Record<string, ReadonlyArray<string>>>(
    {},
  );
  const [fetchState, setFetchState] = useState<{
    provider: string | null;
    status: 'idle' | 'loading' | 'error';
    error?: string;
  }>({ provider: null, status: 'idle' });

  const advertised =
    providers.find((p) => p.name === hoveredProvider)?.models.map((m) => m.name) ?? [];
  const merged = Array.from(
    new Set([...advertised, ...(fetched[hoveredProvider] ?? [])]),
  ).sort();
  const currentModels = merged.map((name) => ({ name }));

  const onFetch = async (): Promise<void> => {
    setFetchState({ provider: hoveredProvider, status: 'loading' });
    try {
      const ids = await api().invoke('settings.fetchProviderModels', {
        provider: hoveredProvider,
      });
      setFetched((cur) => ({ ...cur, [hoveredProvider]: ids }));
      setFetchState({ provider: hoveredProvider, status: 'idle' });
    } catch (e) {
      setFetchState({
        provider: hoveredProvider,
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <Modal title="Pick provider & model" onClose={onClose} width={620}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '220px 1fr',
          gap: 0,
          border: '1px solid var(--color-card-border)',
          borderRadius: 12,
          overflow: 'hidden',
          minHeight: 280,
        }}
      >
        <ul
          role="listbox"
          aria-label="Providers"
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 6,
            background: '#f7f8fc',
            borderRight: '1px solid var(--color-card-border)',
            overflowY: 'auto',
            maxHeight: 360,
          }}
        >
          {providers.length === 0 && (
            <li
              style={{
                padding: '8px 10px',
                fontSize: 12,
                color: 'var(--color-text-dim)',
              }}
            >
              No providers
            </li>
          )}
          {providers.map((p) => {
            const isActive = p.name === activeProvider;
            const isHovered = p.name === hoveredProvider;
            return (
              <li key={p.name}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isHovered}
                  onClick={() => setHoveredProvider(p.name)}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '8px 10px',
                    fontSize: 13,
                    borderRadius: 8,
                    color: isHovered ? 'var(--color-text)' : 'var(--color-text-muted)',
                    background: isHovered ? '#fff' : 'transparent',
                    fontWeight: isHovered ? 600 : 500,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <span style={{ flex: 1 }}>{p.name}</span>
                  {isActive && (
                    <span
                      title="Active provider"
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: 'var(--color-green)',
                      }}
                    />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            background: '#fff',
            overflow: 'hidden',
          }}
        >
          <header
            style={{
              padding: '8px 10px',
              borderBottom: '1px solid var(--color-card-border)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span
              style={{
                flex: 1,
                fontSize: 11.5,
                fontWeight: 700,
                color: 'var(--color-text-dim)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              Models · {hoveredProvider || '—'}
            </span>
            {canFetchLive ? (
              <button
                type="button"
                onClick={() => void onFetch()}
                disabled={
                  !hoveredProvider ||
                  fetchState.status === 'loading'
                }
                title="Fetch the live model list from the provider's API"
                style={{
                  fontSize: 11.5,
                  padding: '4px 10px',
                  borderRadius: 8,
                  color: 'var(--color-primary-strong)',
                  border: '1px solid var(--color-primary-soft)',
                  background: 'var(--color-primary-soft)',
                  fontWeight: 600,
                  opacity:
                    fetchState.status === 'loading' || !hoveredProvider
                      ? 0.6
                      : 1,
                }}
              >
                {fetchState.provider === hoveredProvider &&
                fetchState.status === 'loading'
                  ? 'Fetching…'
                  : 'Fetch live'}
              </button>
            ) : (
              <span
                className="mono"
                title="Built-in provider — models ship with the moxxy CLI"
                style={{
                  fontSize: 10.5,
                  color: 'var(--color-text-dim)',
                  letterSpacing: '0.04em',
                }}
              >
                built-in
              </span>
            )}
          </header>
          <ul
            role="listbox"
            aria-label="Models"
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 6,
              overflowY: 'auto',
              maxHeight: 360,
            }}
          >
            <li>
              <button
                type="button"
                role="option"
                aria-selected={
                  hoveredProvider === activeProvider && activeModel === null
                }
                onClick={() => onPick(hoveredProvider, null)}
                style={modelRowStyle(
                  hoveredProvider === activeProvider && activeModel === null,
                )}
              >
                <span style={{ flex: 1, fontStyle: 'italic' }}>Default</span>
                <span style={{ fontSize: 11, color: 'var(--color-text-dim)' }}>
                  runner's config
                </span>
              </button>
            </li>
            {currentModels.length === 0 && (
              <li
                style={{
                  padding: '12px 10px',
                  fontSize: 12,
                  color: 'var(--color-text-dim)',
                }}
              >
                No models advertised by this provider. Tap{' '}
                <strong>Fetch live</strong> to query the provider's
                /v1/models endpoint.
              </li>
            )}
            {currentModels.map((m) => {
              const isCurrent =
                hoveredProvider === activeProvider && activeModel === m.name;
              return (
                <li key={m.name}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isCurrent}
                    onClick={() => onPick(hoveredProvider, m.name)}
                    style={modelRowStyle(isCurrent)}
                  >
                    <span
                      className="mono"
                      style={{
                        flex: 1,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {m.name}
                    </span>
                  </button>
                </li>
              );
            })}
            {fetchState.provider === hoveredProvider &&
              fetchState.status === 'error' && (
                <li
                  role="alert"
                  style={{
                    padding: '10px',
                    margin: '6px 4px 0',
                    fontSize: 11.5,
                    color: 'var(--color-red)',
                    background: '#fef2f2',
                    border: '1px solid #fecaca',
                    borderRadius: 8,
                  }}
                >
                  {fetchState.error}
                </li>
              )}
          </ul>
        </div>
      </div>
    </Modal>
  );
}

function modelRowStyle(active: boolean): React.CSSProperties {
  return {
    width: '100%',
    textAlign: 'left',
    padding: '8px 10px',
    fontSize: 13,
    borderRadius: 8,
    background: active ? 'var(--color-primary-soft)' : 'transparent',
    color: active ? 'var(--color-primary-strong)' : 'var(--color-text)',
    fontWeight: active ? 600 : 500,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  };
}
