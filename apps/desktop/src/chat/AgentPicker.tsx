/**
 * Inline provider / model / mode pickers that live in the composer
 * toolbar. Each renders as a small chip that opens a native select.
 *
 * - Provider + Mode are stored on the runner (session.setProvider /
 *   session.setMode); changes take effect immediately for the next
 *   turn.
 * - Model is sticky client-side per workspace in chatStore and is
 *   passed as an option to every runTurn (the runner has no per-
 *   session default-model setter, only per-turn override).
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from '@/lib/api';
import { chatStore } from '@/lib/chatStore';

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
  // Sticky model lives in the chat store so it survives renders and
  // doesn't drift between the picker and useChat.send().
  const selectedModel = useSyncExternalStore(chatStore.subscribe, () =>
    chatStore.getModel(workspaceId),
  );

  useEffect(() => {
    let cancelled = false;
    const refresh = (): void => {
      void api()
        .invoke('session.info', { workspaceId })
        .then((raw) => {
          if (!cancelled) setInfo(raw as SessionInfo | null);
        })
        .catch(() => {});
    };
    refresh();
    // Re-fetch when the runner's info changes so a freshly added
    // provider / mode shows up without a restart.
    const off = api().subscribe('runner.info.changed', refresh);
    return () => {
      cancelled = true;
      off();
    };
  }, [workspaceId]);

  if (!info) return null;

  const provider = info.providers.find((p) => p.name === info.activeProvider);
  const models = provider?.models ?? [];

  const onProvider = async (next: string): Promise<void> => {
    try {
      await api().invoke('session.setProvider', { workspaceId, provider: next });
      // Provider change resets sticky model — the model belonging to
      // the old provider isn't necessarily valid here.
      chatStore.setModel(workspaceId, null);
    } catch {
      /* surfaced via the chat error toast */
    }
  };
  const onMode = async (next: string): Promise<void> => {
    try {
      await api().invoke('session.setMode', { workspaceId, mode: next });
    } catch {
      /* swallow */
    }
  };
  const onModel = (next: string): void => {
    chatStore.setModel(workspaceId, next || null);
  };

  return (
    <>
      <PickerChip
        label="Provider"
        value={info.activeProvider ?? ''}
        options={info.providers.map((p) => p.name)}
        disabled={disabled}
        onChange={(v) => void onProvider(v)}
      />
      <PickerChip
        label="Model"
        value={selectedModel ?? ''}
        placeholder="default"
        options={models.map((m) => m.name)}
        disabled={disabled || models.length === 0}
        onChange={onModel}
      />
      <PickerChip
        label="Mode"
        value={info.activeMode ?? ''}
        options={[...info.modes]}
        disabled={disabled}
        onChange={(v) => void onMode(v)}
      />
    </>
  );
}

function PickerChip({
  label,
  value,
  options,
  placeholder,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: ReadonlyArray<string>;
  readonly placeholder?: string;
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
        {value || placeholder || '—'}
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
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
