import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { toErrorMessage } from './errors';
import type {
  ConnectionPhase,
  NodeProbe,
  OnboardingStatus,
} from '@moxxy/desktop-ipc-contract';

/**
 * Reactive onboarding state. Re-probes whenever the connection
 * phase changes so the wizard auto-advances after a successful
 * install / configure without the user pressing anything.
 */
export interface UseOnboarding {
  readonly status: OnboardingStatus | null;
  readonly node: NodeProbe | null;
  readonly loading: boolean;
  readonly install: InstallController;
  readonly refresh: () => Promise<void>;
  readonly openExternal: (url: string) => Promise<void>;
  readonly saveProviderKey: (args: {
    provider: string;
    secret: string;
  }) => Promise<void>;
}

interface InstallController {
  readonly running: boolean;
  readonly progress: ReadonlyArray<string>;
  readonly lastExitCode: number | null;
  readonly error: string | null;
  readonly run: () => Promise<number | null>;
  readonly reset: () => void;
}

export function useOnboarding(phase?: ConnectionPhase): UseOnboarding {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [node, setNode] = useState<NodeProbe | null>(null);
  const [loading, setLoading] = useState(true);

  const [progress, setProgress] = useState<string[]>([]);
  const [installing, setInstalling] = useState(false);
  const [lastExitCode, setLastExitCode] = useState<number | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [s, n] = await Promise.all([
        api().invoke('onboarding.status'),
        api().invoke('onboarding.probeNode'),
      ]);
      setStatus(s);
      setNode(n);
    } finally {
      setLoading(false);
    }
  }, []);

  // First run + on phase changes (a successful install transitions
  // the supervisor through `resolving-cli` → ... so this catches it).
  useEffect(() => {
    void refresh();
  }, [refresh, phase?.phase]);

  useEffect(() => {
    const unsub = api().subscribe('onboarding.install.progress', (line: string) => {
      setProgress((prev) => [...prev.slice(-499), line]);
    });
    return unsub;
  }, []);

  const run = useCallback(async (): Promise<number | null> => {
    setInstalling(true);
    setInstallError(null);
    setProgress([]);
    setLastExitCode(null);
    try {
      const code = await api().invoke('onboarding.installMoxxyCli');
      setLastExitCode(code);
      await refresh();
      return code;
    } catch (e) {
      setInstallError(toErrorMessage(e));
      return null;
    } finally {
      setInstalling(false);
    }
  }, [refresh]);

  const reset = useCallback(() => {
    setProgress([]);
    setLastExitCode(null);
    setInstallError(null);
  }, []);

  const openExternal = useCallback(async (url: string) => {
    await api().invoke('onboarding.openExternal', { url });
  }, []);

  const saveProviderKey = useCallback(
    async (args: { provider: string; secret: string }) => {
      await api().invoke('onboarding.saveProviderKey', args);
      await refresh();
    },
    [refresh],
  );

  return {
    status,
    node,
    loading,
    install: {
      running: installing,
      progress,
      lastExitCode,
      error: installError,
      run,
      reset,
    },
    refresh,
    openExternal,
    saveProviderKey,
  };
}
