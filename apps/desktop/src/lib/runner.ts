import { useEffect, useState } from 'react';
import { invoke, subscribe } from './tauri';

/**
 * The sidecar's coarse-grained lifecycle, mirrored from Rust's
 * `SidecarStatus` enum.
 */
export type SidecarStatus = 'starting' | 'running' | 'crashed' | 'stopped';

/**
 * The boot task emits a free-form one-liner via `boot.stage` so the
 * UI can show progress ("adopting existing runner" / "starting moxxy
 * serve" / "waiting for runner" / "attaching bridge" / "runner ready").
 * Useful as the empty-state hint while the runner is coming up.
 */
export function useBootStage(): string | null {
  const [stage, setStage] = useState<string | null>(null);
  useEffect(() => {
    const unsub = subscribe<string>('boot.stage', setStage);
    return () => {
      void unsub.then((fn) => fn());
    };
  }, []);
  return stage;
}

const VALID_STATUSES: ReadonlySet<SidecarStatus> = new Set([
  'starting',
  'running',
  'crashed',
  'stopped',
]);

export function isSidecarStatus(value: unknown): value is SidecarStatus {
  return typeof value === 'string' && VALID_STATUSES.has(value as SidecarStatus);
}

/**
 * Subscribes to sidecar status changes from the Rust supervisor.
 * Always cleans up its subscription on unmount.
 */
export function useSidecarStatus(): SidecarStatus {
  const [status, setStatus] = useState<SidecarStatus>('starting');

  useEffect(() => {
    let cancelled = false;

    void invoke<SidecarStatus>('sidecar_status')
      .then((s) => {
        if (!cancelled && isSidecarStatus(s)) setStatus(s);
      })
      .catch(() => {
        // The Rust command isn't registered in tests — leave the default.
      });

    const unsubscribe = subscribe<SidecarStatus>('sidecar.status', (next) => {
      if (isSidecarStatus(next)) setStatus(next);
    });

    return () => {
      cancelled = true;
      void unsubscribe.then((fn) => fn());
    };
  }, []);

  return status;
}
