/**
 * Settings — providers, MCP servers, and skills.
 *
 * Provider listing comes in three flavours: the runner's *ready* set
 * (`settings.providers`), the onboarding *catalog* (built-ins +
 * admin-registered from providers.json), and live model discovery for
 * admin providers. MCP toggles and skill CRUD round out the settings
 * surface. Vault + desktop-prefs settings live in their own modules
 * (`./vault`, `./prefs`).
 */

import type { RunnerPool } from '../runner-pool';
import { handle, mustSession, resolveSupervisor } from './shared';

export function registerSettingsHandlers(pool: RunnerPool): void {
  // ---- Settings -----------------------------------------------------------

  handle('settings.fetchProviderModels', async ({ provider }) => {
    const { fetchProviderModels } = await import('../provider-discovery');
    return await fetchProviderModels(provider);
  });
  handle('settings.adminProviders', async () => {
    try {
      const { readFile } = await import('node:fs/promises');
      const { homedir } = await import('node:os');
      const path = await import('node:path');
      const body = await readFile(
        path.join(homedir(), '.moxxy', 'providers.json'),
        'utf8',
      );
      const json = JSON.parse(body) as { providers?: ReadonlyArray<{ name?: string }> };
      return (json.providers ?? [])
        .map((p) => p.name)
        .filter((n): n is string => typeof n === 'string');
    } catch {
      return [];
    }
  });
  handle('settings.providerCatalog', async () => {
    // Built-ins are always pickable. Admin-registered ones come from
    // providers.json so the onboarding dropdown reflects whatever the
    // user already added via `provider_add` (zai, openrouter, …).
    const builtins = ['anthropic', 'openai', 'openai-codex'];
    let admin: string[] = [];
    try {
      const { readFile } = await import('node:fs/promises');
      const { homedir } = await import('node:os');
      const path = await import('node:path');
      const body = await readFile(
        path.join(homedir(), '.moxxy', 'providers.json'),
        'utf8',
      );
      const json = JSON.parse(body) as {
        providers?: ReadonlyArray<{ name?: string }>;
      };
      admin = (json.providers ?? [])
        .map((p) => p.name)
        .filter((n): n is string => typeof n === 'string');
    } catch {
      /* missing or malformed providers.json → builtins only */
    }
    const seen = new Set<string>();
    return [...builtins, ...admin].filter((name) => {
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    });
  });
  handle('settings.providers', async (args) => {
    const sup = resolveSupervisor(pool, args?.workspaceId);
    const session = sup?.remote();
    if (!session) return [];
    const info = session.getInfo();
    const readySet = new Set(info.readyProviders ?? []);
    return info.providers.map((p) => ({
      name: p.name,
      ready: readySet.has(p.name),
    }));
  });
  handle('settings.mcpServers', async (args) => {
    const session = mustSession(pool, args?.workspaceId);
    if (!session.mcpAdmin) return [];
    return await session.mcpAdmin.listServers();
  });
  handle('settings.mcpToggle', async ({ workspaceId, name, enabled }) => {
    const session = mustSession(pool, workspaceId);
    if (!session.mcpAdmin) throw new Error('mcp admin not available');
    if (enabled) await session.mcpAdmin.enableAndAttach(name);
    else await session.mcpAdmin.detach(name);
  });
  handle('settings.skills', async () => {
    const { listSkills } = await import('../skills');
    return listSkills();
  });
  handle('settings.readSkill', async ({ name }) => {
    const { readSkill } = await import('../skills');
    return readSkill(name);
  });
  handle('settings.writeSkill', async ({ name, body }) => {
    const { writeSkill } = await import('../skills');
    await writeSkill(name, body);
  });
  handle('settings.deleteSkill', async ({ name }) => {
    const { deleteSkill } = await import('../skills');
    await deleteSkill(name);
  });
}
