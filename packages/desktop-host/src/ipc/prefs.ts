/**
 * Desktop preferences (first-run + auth state).
 *
 * These are the desktop's *own* preferences (onboarding-complete,
 * Clerk identity, …) — distinct from the runner's session preferences.
 * Both handlers delegate to the `prefs` store, lazily imported so the
 * file isn't touched until the renderer asks.
 */

import { handle } from './shared';

export function registerPrefsHandlers(): void {
  // Desktop preferences -----------------------------------------------------
  handle('prefs.read', async () => {
    const { readPrefs } = await import('../prefs');
    return readPrefs();
  });
  handle('prefs.update', async (patch) => {
    const { updatePrefs } = await import('../prefs');
    return updatePrefs(patch);
  });
}
