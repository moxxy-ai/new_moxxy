import type { ParsedArgv } from './argv.js';
import { setupSession, setupSessionWithConfig, type SetupOptions, type SetupResult } from './setup.js';
import type { Session } from '@moxxy/core';

/**
 * Anything that exposes a `flags` record is enough — callers that don't have
 * a full `ParsedArgv` (e.g., a sub-handler with no positional context) can
 * pass `{ flags: {} }` without a cast.
 */
export type ArgvLike = Pick<ParsedArgv, 'flags'>;

/**
 * Translate the standard CLI flag set into `SetupOptions`. Every command
 * should use this so `--verbose`, `--config`, `--model` behave the same way
 * everywhere.
 */
export function argvToSetupOptions(argv: ArgvLike, overrides: Partial<SetupOptions> = {}): SetupOptions {
  return {
    cwd: process.cwd(),
    verbose: hasBoolFlag(argv, 'verbose'),
    model: stringFlag(argv, 'model'),
    configPath: stringFlag(argv, 'config'),
    ...overrides,
  };
}

export async function bootSession(argv: ArgvLike, overrides: Partial<SetupOptions> = {}): Promise<Session> {
  return setupSession(argvToSetupOptions(argv, overrides));
}

export async function bootSessionWithConfig(
  argv: ArgvLike,
  overrides: Partial<SetupOptions> = {},
): Promise<SetupResult> {
  return setupSessionWithConfig(argvToSetupOptions(argv, overrides));
}

/**
 * Did the user pass `--<name>` (boolean form, not "<name>=value")?
 * Returns true for `--verbose`, false for `--verbose=false` or no flag.
 */
export function hasBoolFlag(argv: ArgvLike, name: string): boolean {
  const v = argv.flags[name];
  return v === true;
}

/** Read a string-valued flag with consistent coercion across commands. */
export function stringFlag(argv: ArgvLike, name: string): string | undefined {
  const v = argv.flags[name];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Universal `--help` / `-h` predicate. Every command's first line should be
 * `if (helpRequested(argv)) { print HELP; return 0; }`.
 */
export function helpRequested(argv: ArgvLike): boolean {
  return hasBoolFlag(argv, 'help') || hasBoolFlag(argv, 'h');
}

/** Universal `--yes` / `-y` confirmation predicate for destructive ops. */
export function confirmedYes(argv: ArgvLike): boolean {
  return hasBoolFlag(argv, 'yes') || hasBoolFlag(argv, 'y');
}
