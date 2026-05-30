import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeFileAtomic } from '@moxxy/sdk';

/**
 * User-level runtime preferences persisted at $MOXXY_HOME/preferences.json
 * or ~/.moxxy/preferences.json.
 * Distinct from `~/.moxxy/config.yaml` (user-edited, source of truth for
 * provider/plugin wiring) — this file is mutated by the TUI as the user
 * picks a model / loop strategy via slash commands, so it survives across
 * CLI invocations. A missing file or unreadable contents is a no-op:
 * preferences are best-effort, never load-blocking.
 */
export interface MoxxyPreferences {
  /** Active provider name (e.g. "openai", "anthropic"). */
  readonly providerName?: string;
  /** Active model id under that provider (e.g. "gpt-5.4-mini"). */
  readonly model?: string;
  /** Active loop strategy name (e.g. "tool-use", "plan-execute"). */
  readonly mode?: string;
}

export function preferencesPath(): string {
  return path.join(process.env.MOXXY_HOME ?? path.join(os.homedir(), '.moxxy'), 'preferences.json');
}

/**
 * Read preferences from disk. Returns an empty object when the file
 * doesn't exist or fails to parse — preferences are an optional layer,
 * never a hard dependency of session bootstrap.
 */
export async function loadPreferences(): Promise<MoxxyPreferences> {
  try {
    const raw = await fs.readFile(preferencesPath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') {
      return parsed as MoxxyPreferences;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Merge-and-write preferences. Reads the current file (if any), merges
 * the patch on top so we don't blow away unrelated fields, and writes
 * the result back atomically. Best-effort: a write failure logs to
 * stderr but does not throw — the user's pick still takes effect in
 * this session, just won't persist across invocations.
 */
export async function savePreferences(patch: Partial<MoxxyPreferences>): Promise<void> {
  const current = await loadPreferences();
  const next: MoxxyPreferences = { ...current, ...patch };
  const target = preferencesPath();
  try {
    await writeFileAtomic(target, JSON.stringify(next, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(
      `moxxy: failed to persist preferences to ${target}: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
