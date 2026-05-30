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
 *
 * This container owns the session.info fetch + optimistic mutations and
 * delegates the chips / modal to the focused modules under this dir.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from '@/lib/api';
import { chatStore } from '@/lib/chatStore';
import { ChipButton } from './ChipButton';
import { ChipSelect } from './ChipSelect';
import { ProviderModelPicker } from './ProviderModelPicker';
import type { SessionInfo } from './types';

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
      .then((raw) => setInfo(raw))
      .catch(() => {});
  };

  useEffect(() => {
    let cancelled = false;
    void api()
      .invoke('session.info', { workspaceId })
      .then((raw) => {
        if (!cancelled) setInfo(raw);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
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
