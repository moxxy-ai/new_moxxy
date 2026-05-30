import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { DesktopPrefs } from '@moxxy/desktop-ipc-contract';

export interface UsePrefs {
  readonly prefs: DesktopPrefs | null;
  readonly loading: boolean;
  readonly update: (patch: Partial<DesktopPrefs>) => Promise<void>;
}

/**
 * Hook around the desktop's `~/.moxxy/desktop/prefs.json`. Returns
 * null while the first read is in flight so callers can hold off
 * rendering UI that depends on the value (e.g. the first-run wizard
 * gate).
 */
export function usePrefs(): UsePrefs {
  const [prefs, setPrefs] = useState<DesktopPrefs | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void api()
      .invoke('prefs.read')
      .then((p) => {
        if (!cancelled) {
          setPrefs(p);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(async (patch: Partial<DesktopPrefs>): Promise<void> => {
    const next = await api().invoke('prefs.update', patch);
    setPrefs(next);
  }, []);

  return { prefs, loading, update };
}
