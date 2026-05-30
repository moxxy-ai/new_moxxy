/**
 * The two-column provider/model modal opened by the Model chip.
 *
 *   [ provider list ] │ [ models for the hovered provider ]
 *
 * The left column lists providers (with an active dot); clicking one
 * "browses" it without committing. The right column lists that
 * provider's models — merging the runner-advertised set with any
 * models fetched live from the provider's /v1/models endpoint (only
 * offered for admin-registered, non-built-in providers). Picking a
 * model (or "Default") commits via the parent's onPick.
 */

import { useEffect, useState } from 'react';
import { toErrorMessage } from '@/lib/errors';
import { api } from '@/lib/api';
import { Modal } from '@/lib/Modal';
import type { ProviderInfo } from './types';

export function ProviderModelPicker({
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
    providers.find((p) => p.name === hoveredProvider)?.models.map((m) => m.id) ?? [];
  const merged = Array.from(
    new Set([...advertised, ...(fetched[hoveredProvider] ?? [])]),
  ).sort();
  const currentModels = merged.map((id) => ({ id }));

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
        error: toErrorMessage(e),
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
                hoveredProvider === activeProvider && activeModel === m.id;
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isCurrent}
                    onClick={() => onPick(hoveredProvider, m.id)}
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
                      {m.id}
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

// ---- styles ----

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
