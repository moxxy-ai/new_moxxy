/**
 * Renderer-side handle to the typed `window.moxxy` surface installed
 * by the preload script. We re-export through a function so tests can
 * inject a fake — the renderer never references `window.moxxy`
 * directly except via this module.
 */

import type { MoxxyApi } from '@moxxy/desktop-ipc-contract';

let override: MoxxyApi | null = null;

export function api(): MoxxyApi {
  if (override) return override;
  if (typeof window !== 'undefined' && (window as { moxxy?: MoxxyApi }).moxxy) {
    return (window as unknown as { moxxy: MoxxyApi }).moxxy;
  }
  throw new Error(
    'window.moxxy is not installed — preload script did not run, ' +
      'or tests need to call __setApiOverride()',
  );
}

export function __setApiOverride(fake: MoxxyApi | null): void {
  override = fake;
}
