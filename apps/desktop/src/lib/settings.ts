import { useCallback, useEffect, useState } from 'react';
import { invoke } from './tauri';

export interface ProviderConfig {
  readonly name: string;
  readonly configured: boolean;
}

export interface CustomProvider {
  readonly name: string;
  readonly baseURL: string;
  readonly defaultModel?: string;
  readonly kind?: string;
  readonly envVar?: string;
}

export interface ProvidersOverview {
  readonly known: ReadonlyArray<ProviderConfig>;
  readonly custom: ReadonlyArray<CustomProvider>;
}

export interface SettingsApi {
  readonly providers: ProvidersOverview;
  readonly skills: ReadonlyArray<string>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
  readonly saveApiKey: (provider: string, secret: string) => Promise<boolean>;
  readonly readSkill: (name: string) => Promise<string>;
  readonly writeSkill: (name: string, body: string) => Promise<boolean>;
}

/**
 * Bundles the desktop's settings commands into a single hook. Each
 * mutating call refreshes the list afterwards so the UI never shows
 * stale state. Errors are captured in `error`; mutating calls also
 * return a boolean for the caller to drive optimistic UI.
 */
const EMPTY_PROVIDERS: ProvidersOverview = { known: [], custom: [] };

export function useSettings(): SettingsApi {
  const [providers, setProviders] = useState<ProvidersOverview>(EMPTY_PROVIDERS);
  const [skills, setSkills] = useState<ReadonlyArray<string>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [p, s] = await Promise.all([
        invoke<ProvidersOverview>('settings_providers_list'),
        invoke<string[]>('settings_skills_list').catch(() => []),
      ]);
      setProviders({
        known: Array.isArray(p?.known) ? p.known : [],
        custom: Array.isArray(p?.custom) ? p.custom : [],
      });
      setSkills(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveApiKey = useCallback(
    async (provider: string, secret: string): Promise<boolean> => {
      try {
        await invoke('settings_set_api_key', { provider, secret });
        await refresh();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      }
    },
    [refresh],
  );

  const readSkill = useCallback(async (name: string): Promise<string> => {
    return invoke<string>('settings_skill_read', { name });
  }, []);

  const writeSkill = useCallback(
    async (name: string, body: string): Promise<boolean> => {
      try {
        await invoke('settings_skill_write', { name, body });
        await refresh();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      }
    },
    [refresh],
  );

  return {
    providers,
    skills,
    loading,
    error,
    refresh,
    saveApiKey,
    readSkill,
    writeSkill,
  };
}
