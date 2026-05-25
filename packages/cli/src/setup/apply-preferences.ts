import { loadPreferences, type Session } from '@moxxy/core';
import type { CredentialResolver } from './activate-provider.js';

type Logger = {
  warn(msg: string, meta?: Record<string, unknown>): void;
};

/**
 * Apply persisted runtime preferences (~/.moxxy/preferences.json).
 * Order matters: provider must activate first (so its model list is
 * available for the model field), then loop. We silently skip any
 * pref that no longer references a registered plugin — a stale
 * preference from a previous moxxy version shouldn't break boot.
 *
 * Note: the persisted `model` is applied by the TUI / one-shot
 * entrypoints (they own which model gets passed to runTurn). We
 * surface it via the returned config so callers can pick it up.
 */
export async function applyPreferences(
  session: Session,
  credentialResolver: CredentialResolver,
  logger: Logger,
): Promise<void> {
  try {
    const prefs = await loadPreferences();
    if (prefs.providerName && session.providers.list().some((p) => p.name === prefs.providerName)) {
      try {
        if (session.providers.getActiveName() !== prefs.providerName) {
          // Resolve credentials before switching — otherwise OAuth-backed
          // providers (openai-codex) get createClient({}) and throw on
          // the next turn.
          const cfg = await credentialResolver(prefs.providerName);
          session.providers.setActive(prefs.providerName, cfg);
        }
      } catch (err) {
        logger.warn('failed to apply preferred provider', {
          providerName: prefs.providerName,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (prefs.mode && session.modes.list().some((s) => s.name === prefs.mode)) {
      try {
        session.modes.setActive(prefs.mode);
      } catch (err) {
        logger.warn('failed to apply preferred loop strategy', {
          mode: prefs.mode,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    // Preferences are best-effort; never block session boot on them.
    logger.warn('failed to load preferences', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
