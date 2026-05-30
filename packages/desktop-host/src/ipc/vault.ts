/**
 * Vault secrets.
 *
 * Vault entries are global per-user (no workspaceId). Reads enumerate
 * the on-disk vault key names; writes / deletes go through the
 * in-process vault plugin, which shares the same file + key source the
 * runner reads — so a key added here is immediately resolvable as
 * `${vault:NAME}` without a relaunch.
 */

import { getInProcessPlugins, handle } from './shared';

export function registerVaultHandlers(): void {
  handle('settings.vaultEntries', async () => {
    const { readVaultKeys } = await import('../onboarding');
    const home = (await import('node:os')).homedir();
    const names = await readVaultKeys(home);
    return names.map((name) => ({ name }));
  });
  handle('settings.vaultSet', async ({ name, value }) => {
    // Writes to the same on-disk vault the runner reads (shared file +
    // key source via the in-process vault plugin), so a key added here is
    // immediately resolvable as ${vault:NAME}.
    await getInProcessPlugins().vault.set(name, value);
  });
  handle('settings.vaultDelete', async ({ name }) => {
    await getInProcessPlugins().vault.delete(name);
  });
}
