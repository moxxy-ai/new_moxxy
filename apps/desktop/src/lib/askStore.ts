import { useSyncExternalStore } from 'react';
import type { AskRequest, AskResponse } from '@moxxy/desktop-ipc-contract';
import { api } from './api';

/**
 * Pending interactive asks (permission / approval prompts the runner forwarded
 * via `ask.request`). The runner blocks until each is answered, so they queue;
 * the {@link AskSheet} shows the first one for the active workspace and the
 * next surfaces once it's answered.
 */

let asks: ReadonlyArray<AskRequest> = Object.freeze([]);
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export const askStore = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  getAll(): ReadonlyArray<AskRequest> {
    return asks;
  },
  add(req: AskRequest): void {
    if (asks.some((a) => a.requestId === req.requestId)) return;
    asks = Object.freeze([...asks, req]);
    emit();
  },
  /** Send the user's decision back to the runner and drop the ask. */
  respond(requestId: string, response: AskResponse): void {
    if (!asks.some((a) => a.requestId === requestId)) return;
    asks = Object.freeze(asks.filter((a) => a.requestId !== requestId));
    emit();
    void api().invoke('ask.respond', { requestId, response }).catch(() => {});
  },
};

/** Subscribe the store to incoming `ask.request` events. Call once at boot. */
export function wireAskBridge(): () => void {
  return api().subscribe('ask.request', (req: AskRequest) => askStore.add(req));
}

/** First pending ask for a workspace, or null. */
export function useActiveAsk(workspaceId: string | null): AskRequest | null {
  const all = useSyncExternalStore(askStore.subscribe, askStore.getAll);
  if (!workspaceId) return null;
  return all.find((a) => a.workspaceId === workspaceId) ?? null;
}
