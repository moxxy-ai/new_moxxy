import type { ParsedArgv } from '../argv.js';

/**
 * How a channel command (tui / telegram / http / ...) should run against the
 * runner:
 *  - `standalone`: boot an in-process session and do NOT touch the socket
 *    (explicit `--standalone` opt-out, fully isolated)
 *  - `attach`: a runner is already up, connect to it as a thin client
 *  - `self-host`: no runner, boot a local session and open the socket so other
 *    clients can attach too (Option A)
 */
export type ClientMode = 'attach' | 'self-host' | 'standalone';

export function chooseClientMode(opts: {
  readonly standalone: boolean;
  readonly runnerUp: boolean;
}): ClientMode {
  if (opts.standalone) return 'standalone';
  return opts.runnerUp ? 'attach' : 'self-host';
}

/**
 * Forward channel-specific start flags (e.g. Telegram's `pair`), dropping the
 * well-known ones the launcher consumes itself.
 */
export function collectExtraFlags(argv: ParsedArgv): Record<string, unknown> {
  const reserved = new Set(['model', 'config', 'verbose', 'standalone', 'attach']);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(argv.flags)) {
    if (!reserved.has(k)) extra[k] = v;
  }
  return extra;
}
