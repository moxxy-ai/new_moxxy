/**
 * Onboarding / install / provider-login handlers.
 *
 * These drive the first-run wizard: probing for the CLI + Node, running
 * `npm install -g @moxxy/cli`, saving a provider key, and the OAuth
 * login flows. Anything that successfully wires up a provider pokes the
 * active supervisor's {@link RunnerSupervisor.forceRetry} so the next
 * turn picks up the new credential without a relaunch.
 */

import { shell, BrowserWindow as BrowserWindowApi } from 'electron';

import type { RunnerPool } from '../runner-pool';
import { probeOnboarding, saveProviderKey } from '../onboarding';
import { installMoxxyCli, probeNode } from '../installer';
import { assertSafeExternalUrl } from '../security';
import { handle } from './shared';

export function registerOnboardingHandlers(pool: RunnerPool): void {
  // ---- Onboarding ----------------------------------------------------------

  handle('onboarding.status', () => probeOnboarding());
  handle('onboarding.probeNode', () => probeNode());
  handle('onboarding.installMoxxyCli', async () => {
    const target = BrowserWindowApi.getFocusedWindow() ?? BrowserWindowApi.getAllWindows()[0];
    if (!target) throw new Error('no window to stream install progress to');
    const code = await installMoxxyCli(target);
    if (code === 0) pool.active()?.forceRetry();
    return code;
  });
  handle('onboarding.openExternal', async ({ url }) => {
    assertSafeExternalUrl(url);
    await shell.openExternal(url);
  });
  handle('onboarding.saveProviderKey', async ({ provider, secret }) => {
    await saveProviderKey(provider, secret);
    const session = pool.active()?.remote();
    if (session) session.providers.setActive(provider);
  });
  handle('onboarding.providerAuthKind', async ({ provider }) => {
    // The only built-in OAuth provider today is openai-codex; admin-
    // registered providers in providers.json are all api-key. Keep
    // this list as the source of truth until the runner exposes
    // provider auth metadata over RPC.
    const OAUTH_PROVIDERS = new Set(['openai-codex']);
    return OAUTH_PROVIDERS.has(provider) ? 'oauth' : 'api-key';
  });
  handle('onboarding.runProviderLogin', async ({ provider }) => {
    const { runProviderLogin } = await import('../installer');
    const target = BrowserWindowApi.getFocusedWindow() ?? BrowserWindowApi.getAllWindows()[0];
    if (!target) throw new Error('no window to stream login progress to');
    const code = await runProviderLogin(provider, target);
    if (code === 0) pool.active()?.forceRetry();
    return code;
  });
}
