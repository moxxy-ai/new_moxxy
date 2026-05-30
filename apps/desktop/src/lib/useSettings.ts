import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { toErrorMessage } from './errors';
import type {
  McpServerEntry,
  ProviderEntry,
  SkillFile,
  VaultEntryName,
} from '@moxxy/desktop-ipc-contract';

export interface UseSettings {
  readonly providers: ReadonlyArray<ProviderEntry>;
  readonly mcp: ReadonlyArray<McpServerEntry>;
  readonly vault: ReadonlyArray<VaultEntryName>;
  readonly skills: ReadonlyArray<SkillFile>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
  readonly toggleMcp: (name: string, enabled: boolean) => Promise<void>;
  readonly readSkill: (name: string) => Promise<string>;
  readonly writeSkill: (name: string, body: string) => Promise<void>;
  readonly deleteSkill: (name: string) => Promise<void>;
  readonly setVaultKey: (name: string, value: string) => Promise<void>;
  readonly removeVaultKey: (name: string) => Promise<void>;
}

export function useSettings(): UseSettings {
  const [providers, setProviders] = useState<ReadonlyArray<ProviderEntry>>([]);
  const [mcp, setMcp] = useState<ReadonlyArray<McpServerEntry>>([]);
  const [vault, setVault] = useState<ReadonlyArray<VaultEntryName>>([]);
  const [skills, setSkills] = useState<ReadonlyArray<SkillFile>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [p, m, v, s] = await Promise.all([
        api().invoke('settings.providers').catch(() => []),
        api().invoke('settings.mcpServers').catch(() => []),
        api().invoke('settings.vaultEntries').catch(() => []),
        api().invoke('settings.skills').catch(() => []),
      ]);
      setProviders(p);
      setMcp(m);
      setVault(v);
      setSkills(s);
      setError(null);
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleMcp = useCallback(
    async (name: string, enabled: boolean): Promise<void> => {
      try {
        await api().invoke('settings.mcpToggle', { name, enabled });
        await refresh();
      } catch (e) {
        setError(toErrorMessage(e));
      }
    },
    [refresh],
  );

  const readSkill = useCallback(
    async (name: string): Promise<string> =>
      api().invoke('settings.readSkill', { name }),
    [],
  );
  const writeSkill = useCallback(
    async (name: string, body: string): Promise<void> => {
      try {
        await api().invoke('settings.writeSkill', { name, body });
        await refresh();
      } catch (e) {
        setError(toErrorMessage(e));
      }
    },
    [refresh],
  );

  const deleteSkill = useCallback(
    async (name: string): Promise<void> => {
      try {
        await api().invoke('settings.deleteSkill', { name });
        await refresh();
      } catch (e) {
        setError(toErrorMessage(e));
      }
    },
    [refresh],
  );

  const setVaultKey = useCallback(
    async (name: string, value: string): Promise<void> => {
      // Let the caller surface the error (the add form shows it inline),
      // but still refresh + re-throw so the list updates on success.
      await api().invoke('settings.vaultSet', { name, value });
      await refresh();
    },
    [refresh],
  );

  const removeVaultKey = useCallback(
    async (name: string): Promise<void> => {
      try {
        await api().invoke('settings.vaultDelete', { name });
        await refresh();
      } catch (e) {
        setError(toErrorMessage(e));
      }
    },
    [refresh],
  );

  return {
    providers,
    mcp,
    vault,
    skills,
    loading,
    error,
    refresh,
    toggleMcp,
    readSkill,
    writeSkill,
    deleteSkill,
    setVaultKey,
    removeVaultKey,
  };
}
