import type { Session } from '@moxxy/core';
import type { MoxxyConfig } from '@moxxy/config';
import type { VaultStore } from '@moxxy/plugin-vault';
import { MoxxyError } from '@moxxy/sdk';
import { resolveProviderCredentials } from '../provider-credentials.js';
import type { BootStep } from './types.js';

type Logger = {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
};

export type CredentialResolver = (providerName: string) => Promise<Record<string, unknown>>;

export interface ActivateProviderArgs {
  readonly session: Session;
  readonly config: MoxxyConfig;
  readonly vault: VaultStore;
  readonly providerConfig: Record<string, unknown>;
  readonly skipKeyPrompt: boolean;
  readonly skipProviderActivation?: boolean;
  readonly tolerateNoProvider?: boolean;
  readonly onProgress?: (step: BootStep) => void;
  readonly progress: (step: BootStep) => void;
  readonly logger: Logger;
}

export interface ActivateProviderResult {
  readonly activated: { name: string; cfg: Record<string, unknown> } | null;
  readonly credentialResolver: CredentialResolver;
}

/**
 * Walk the configured primary + fallback providers, resolving
 * credentials and activating the first that works. Honors
 * `skipProviderActivation` (init flow), `tolerateNoProvider` (diagnostic
 * commands), and the TUI's progress callback for failure surfacing.
 *
 * On success, also installs `credentialResolver` + `readyProviders` on
 * the session so runtime provider switches can re-resolve credentials
 * before calling setActive.
 */
export async function activateProvider(args: ActivateProviderArgs): Promise<ActivateProviderResult> {
  const { session, config, vault, providerConfig, skipKeyPrompt, logger, progress, onProgress } = args;

  const primaryProvider = config.provider?.name ?? 'anthropic';
  const fallbacks = config.provider?.fallbacks ?? [];
  const candidates = [primaryProvider, ...fallbacks];

  let activated: { name: string; cfg: Record<string, unknown> } | null = null;
  let lastErr: unknown = null;

  if (args.skipProviderActivation) {
    logger.info('skipping provider activation (skipProviderActivation set)');
  } else {
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      // Only the FIRST candidate gets the interactive prompt — chaining
      // through fallbacks via prompts would be confusing.
      const interactive = i === 0 && !skipKeyPrompt && process.stdin.isTTY === true;
      try {
        const resolved = await resolveProviderCredentials(candidate, vault, {
          providerConfig: i === 0 ? providerConfig : {},
          interactive,
        });
        activated = { name: candidate, cfg: resolved };
        break;
      } catch (err) {
        lastErr = err;
        logger.warn('provider key resolution failed; trying fallback', {
          provider: candidate,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (!activated) {
    const errMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    if (args.tolerateNoProvider || args.skipProviderActivation) {
      logger.warn('no provider key resolvable; continuing without an active provider', {
        tried: candidates,
        err: errMsg,
      });
      progress({ kind: 'provider-failed', tried: candidates, error: errMsg });
    } else if (onProgress) {
      // Boot screen path: surface the failure to the UI instead of
      // throwing — the TUI's `phase === 'error'` branch shows it as a
      // checklist row + centered error block.
      progress({ kind: 'provider-failed', tried: candidates, error: errMsg });
      throw noProviderError(candidates, lastErr);
    } else {
      throw noProviderError(candidates, lastErr);
    }
  } else {
    session.providers.setActive(activated.name, activated.cfg);
    if (activated.name !== primaryProvider) {
      logger.warn('using fallback provider', { primary: primaryProvider, active: activated.name });
    }
    progress({ kind: 'provider-activated', name: activated.name });
  }

  // Probe each registered provider for credential readiness so the TUI
  // /model picker can flag unconfigured ones. Non-interactive — silent
  // failures leave the provider out of the ready set. The currently
  // activated provider is auto-included.
  const readyProviders = new Set<string>();
  if (activated) {
    readyProviders.add(activated.name);
    session.requirements.setRuntime(`auth:provider:${activated.name}`, 'ready');
  }
  for (const p of session.providers.list()) {
    if (readyProviders.has(p.name)) continue;
    try {
      await resolveProviderCredentials(p.name, vault, { interactive: false });
      readyProviders.add(p.name);
      session.requirements.setRuntime(`auth:provider:${p.name}`, 'ready');
    } catch {
      // not ready — leave out
      session.requirements.clearRuntime(`auth:provider:${p.name}`);
    }
  }
  (session as unknown as { readyProviders: Set<string> }).readyProviders = readyProviders;

  // Expose a credential resolver so runtime provider switches (TUI
  // /model picker, preference re-apply below) can re-resolve credentials
  // before calling setActive — otherwise the new provider gets
  // createClient({}) and OAuth-backed providers (openai-codex) throw
  // "no credentials" on the next turn.
  const credentialResolver: CredentialResolver = async (providerName) =>
    resolveProviderCredentials(providerName, vault, { interactive: false });
  (session as unknown as { credentialResolver: CredentialResolver }).credentialResolver = credentialResolver;

  return { activated, credentialResolver };
}

function noProviderError(candidates: ReadonlyArray<string>, lastErr: unknown): MoxxyError {
  // If the last attempt already produced a structured error, preserve it —
  // it's almost always more specific than the "tried N providers" wrapper.
  if (MoxxyError.isMoxxyError(lastErr)) return lastErr;
  const errMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  return new MoxxyError({
    code: 'PROVIDER_NOT_CONFIGURED',
    message: `No working provider credentials. Tried: ${candidates.join(', ')}.`,
    hint:
      'Run `moxxy init` in an interactive terminal, set the relevant API-key env var, ' +
      'or store the key in the vault. For OAuth providers, run `moxxy login <provider>`.',
    context: { tried: candidates.join(','), last_error: errMsg },
    cause: lastErr,
  });
}
