import type { Session, SessionPersistence } from '@moxxy/core';
import type { PermissionResolver } from '@moxxy/sdk';
import type { MoxxyConfig } from '@moxxy/config';
import type { VaultStore } from '@moxxy/plugin-vault';
import type { MemoryStore } from '@moxxy/plugin-memory';
import type { SchedulerPoller, ScheduleStore } from '@moxxy/plugin-scheduler';
import type { WebhookConfigStore, WebhookStore } from '@moxxy/plugin-webhooks';
import type { SecurityPluginHandle } from '@moxxy/plugin-security';
import type { RegistrationResult } from './register-plugins.js';

export interface SetupOptions {
  readonly cwd: string;
  readonly verbose?: boolean;
  readonly providerConfig?: Record<string, unknown>;
  readonly resolver?: PermissionResolver;
  readonly model?: string;
  readonly configPath?: string;
  readonly skipUserConfig?: boolean;
  readonly disableKeytar?: boolean;
  /** Skip the interactive API-key prompt when no key is found. Useful for headless tooling that wants a hard error instead of a hang. */
  readonly skipKeyPrompt?: boolean;
  /**
   * If true, treat "no provider key resolvable" as a warning, not a fatal
   * error: setup completes and returns the session with no active provider.
   * Useful for diagnostic commands (`moxxy doctor`, `moxxy plugins list`)
   * that want to inspect everything else even when the user hasn't run init.
   */
  readonly tolerateNoProvider?: boolean;
  /**
   * Skip the provider-activation loop entirely. Used by `moxxy init`, which
   * is itself the place where keys get stored — running the activation
   * loop here would call `vault.get()` for every candidate, opening the
   * vault and triggering a passphrase prompt that hangs an interactive
   * wizard. The session returns with no active provider; callers wire
   * one up themselves (or accept that the session can't run turns yet).
   */
  readonly skipProviderActivation?: boolean;
  /**
   * Optional progress callback fired after each discrete boot phase. The
   * TUI uses this to render the live checklist on the bootstrap screen.
   * When set, `skipKeyPrompt` is forced true — Ink owns raw mode while
   * the boot screen is on-screen, so a `readline`-based prompt would
   * deadlock against the terminal.
   */
  readonly onProgress?: (step: BootStep) => void;
  /**
   * Resume a previously-persisted session by id. Loads its event log
   * from `~/.moxxy/sessions/<id>.jsonl` into the new Session, reusing
   * the original sessionId so subsequent persistence appends continue
   * the same file. Skip persistence entirely when this is null.
   */
  readonly resumeSessionId?: string;
  /** Disable session persistence (default: persistence is on). */
  readonly disableSessionPersistence?: boolean;
}

/**
 * Discrete boot phases reported via `SetupOptions.onProgress`. The TUI
 * pattern-matches on `kind` to render a checklist row; programmatic
 * callers can ignore everything except `kind: 'error'` and `kind: 'ready'`.
 */
export type BootStep =
  | { kind: 'config-loaded'; sources: number }
  | { kind: 'plugins-registered'; count: number; skipped?: number }
  | { kind: 'provider-activated'; name: string }
  | { kind: 'provider-failed'; tried: ReadonlyArray<string>; error: string }
  | { kind: 'prefs-applied' }
  | { kind: 'skills-loaded'; count: number }
  | { kind: 'init-hooks-done' }
  | { kind: 'ready' };

export interface SetupResult {
  readonly session: Session;
  readonly config: MoxxyConfig;
  readonly configSources: ReadonlyArray<{ scope: 'project' | 'user' | 'explicit'; path: string }>;
  readonly vault: VaultStore;
  readonly memory: MemoryStore;
  /** Scheduler store + poller, surfaced so the CLI subcommands
   *  (`moxxy schedule list|run`) can reach them without a model turn. */
  readonly scheduler: { readonly store: ScheduleStore; readonly poller: SchedulerPoller };
  /** Webhook trigger + config stores, surfaced for embedding hosts that
   *  want to list/edit triggers without going through a model turn.
   *  `stop` lets `moxxy serve --except webhooks` tear the listener down
   *  after boot without unloading the plugin entirely. */
  readonly webhooks: {
    readonly store: WebhookStore;
    readonly config: WebhookConfigStore;
    readonly stop: () => Promise<void>;
  };
  /** Session persistence handle. Null when `disableSessionPersistence` is set. */
  readonly persistence: SessionPersistence | null;
  /** Security plugin handle. `audit()` lists every tool's isolation
   *  status; `registry` exposes the available `Isolator` impls. The
   *  plugin itself is a no-op until `security.enabled: true`. */
  readonly security: SecurityPluginHandle;
  /** Static + discovered plugin registration summary, including skipped plugins with unmet requirements. */
  readonly pluginRegistration: RegistrationResult;
}
