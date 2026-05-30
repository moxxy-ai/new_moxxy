import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { api } from './api';
import type { ConnectionPhase, ConnectionSnapshot } from '@moxxy/desktop-ipc-contract';

/**
 * Module-level store of every supervised workspace's connection
 * phase. The main process pushes one `connection.changed` per
 * workspace; the renderer routes by id. The active workspace is
 * tracked separately because it changes via user action, not via
 * IPC.
 */
class ConnectionStore {
  private snapshots = new Map<string, ConnectionSnapshot>();
  private active: string | null = null;
  private hasEverConnected = false;
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private emit(): void {
    for (const l of this.listeners) l();
  }

  setSnapshot(workspaceId: string, snapshot: ConnectionSnapshot): void {
    this.snapshots.set(workspaceId, snapshot);
    if (snapshot.phase.phase === 'connected') this.hasEverConnected = true;
    this.emit();
  }

  setActive(workspaceId: string | null): void {
    if (this.active === workspaceId) return;
    this.active = workspaceId;
    this.emit();
  }

  get(workspaceId: string | null): ConnectionSnapshot | null {
    if (!workspaceId) return null;
    return this.snapshots.get(workspaceId) ?? null;
  }

  active$(): string | null {
    return this.active;
  }

  hasEver(): boolean {
    return this.hasEverConnected;
  }
}

export const connectionStore = new ConnectionStore();

export interface UseConnection {
  readonly snapshot: ConnectionSnapshot | null;
  readonly hasEverConnected: boolean;
  readonly retry: () => Promise<void>;
}

/**
 * Bridge component — primes the connection store on mount from
 * `connection.snapshotAll` and subscribes to per-workspace phase
 * changes. Render at the top of the React tree, like
 * {@link ChatStoreBridge}.
 */
export function ConnectionBridge(): null {
  useEffect(() => {
    let cancelled = false;
    void api()
      .invoke('connection.snapshotAll')
      .then((snapshots) => {
        if (cancelled) return;
        for (const s of snapshots) {
          const { workspaceId, ...snapshot } = s;
          connectionStore.setSnapshot(workspaceId, snapshot);
        }
      })
      .catch(() => {
        /* preload missing */
      });
    void api()
      .invoke('connection.activeWorkspace')
      .then((id) => {
        if (!cancelled) connectionStore.setActive(id);
      })
      .catch(() => {});

    const unsub = api().subscribe(
      'connection.changed',
      ({
        workspaceId,
        phase,
      }: {
        workspaceId: string;
        phase: ConnectionPhase;
      }) => {
        const prev = connectionStore.get(workspaceId);
        connectionStore.setSnapshot(workspaceId, {
          phase,
          cliPath: prev?.cliPath ?? null,
          attempts: prev?.attempts ?? 0,
          log: prev?.log ?? [],
        });
      },
    );

    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  return null;
}

export function useConnection(workspaceId: string | null): UseConnection {
  const snapshot = useSyncExternalStore(
    connectionStore.subscribe,
    () => connectionStore.get(workspaceId),
  );
  const hasEverConnected = useSyncExternalStore(
    connectionStore.subscribe,
    () => connectionStore.hasEver(),
  );

  const retry = useCallback(async () => {
    try {
      await api().invoke(
        'connection.retry',
        workspaceId ? { workspaceId } : undefined,
      );
    } catch {
      /* best-effort */
    }
  }, [workspaceId]);

  return { snapshot, hasEverConnected, retry };
}

/** Active workspace id maintained by the connection bridge. */
export function useActiveWorkspaceId(): string | null {
  return useSyncExternalStore(connectionStore.subscribe, () =>
    connectionStore.active$(),
  );
}

export function isConnected(phase: ConnectionPhase | undefined): boolean {
  return phase?.phase === 'connected';
}
