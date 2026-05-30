/**
 * Desktop-app preferences (separate from the runner's own
 * ~/.moxxy/preferences.json). Stores anything that's purely about the
 * desktop's local UI state: whether the user has finished onboarding,
 * which Clerk user they were last signed in as, ui prefs, etc.
 *
 * Atomic write via tmp + rename so a crashed save can't corrupt the
 * file. Lives under ~/.moxxy/desktop/prefs.json next to desks.json.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export interface DesktopPrefs {
  /** True once the first-run wizard has been completed at least once. */
  onboardingComplete: boolean;
  /** Clerk user id, persisted so the desktop knows who last signed in.
   *  The actual Clerk session token lives in Clerk's own cookie store. */
  clerkUserId: string | null;
  /** Human-friendly display name for the signed-in user. */
  clerkDisplayName: string | null;
  /** Timestamp of the last successful sign-in. */
  signedInAt: number | null;
  /** Schema version. Bump when the shape changes incompatibly. */
  version: 1;
}

const DEFAULTS: DesktopPrefs = {
  onboardingComplete: false,
  clerkUserId: null,
  clerkDisplayName: null,
  signedInAt: null,
  version: 1,
};

function prefsPath(): string {
  return path.join(homedir(), '.moxxy', 'desktop', 'prefs.json');
}

function ensureDir(): void {
  const dir = path.dirname(prefsPath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function readPrefs(): DesktopPrefs {
  try {
    const body = readFileSync(prefsPath(), 'utf8');
    const parsed = JSON.parse(body) as Partial<DesktopPrefs>;
    if (parsed && typeof parsed === 'object') {
      return { ...DEFAULTS, ...parsed, version: 1 };
    }
  } catch {
    /* missing or malformed → defaults */
  }
  return { ...DEFAULTS };
}

export function writePrefs(next: DesktopPrefs): void {
  ensureDir();
  const tmp = prefsPath() + '.tmp';
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, prefsPath());
}

export function updatePrefs(patch: Partial<DesktopPrefs>): DesktopPrefs {
  const current = readPrefs();
  const next = { ...current, ...patch, version: 1 as const };
  writePrefs(next);
  return next;
}
