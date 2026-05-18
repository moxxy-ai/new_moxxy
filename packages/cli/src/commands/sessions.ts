import * as readline from 'node:readline';
import { deleteSession, readSessionIndex, type SessionMeta } from '@moxxy/core';
import type { ParsedArgv } from '../argv.js';
import { helpRequested, stringFlag } from '../argv-helpers.js';
import { colors } from '../colors.js';

const HELP = `moxxy sessions — manage persisted sessions

  moxxy sessions list             list saved sessions, most-recent first
  moxxy sessions delete <id>      remove a session's JSONL + index entry
  moxxy sessions delete --empty   remove every session with 0 events
`;

export async function runSessionsCommand(argv: ParsedArgv): Promise<number> {
  const sub = argv.positional[0] ?? 'list';
  if (sub === 'help' || helpRequested(argv)) {
    process.stdout.write(HELP);
    return 0;
  }
  if (sub === 'list') {
    const all = await readSessionIndex();
    if (all.length === 0) {
      process.stdout.write(colors.dim('(no persisted sessions)\n'));
      return 0;
    }
    process.stdout.write(formatSessions(all));
    return 0;
  }
  if (sub === 'delete') {
    return runDelete(argv);
  }
  process.stderr.write(colors.red(`unknown 'sessions' subcommand: ${sub}\n${HELP}`));
  return 2;
}

async function runDelete(argv: ParsedArgv): Promise<number> {
  const all = await readSessionIndex();
  // `--empty` purges every zero-event session (the junk sessions
  // left behind by old probe runs before the bug was fixed).
  if (argv.flags['empty'] === true) {
    const targets = all.filter((m) => m.eventCount === 0);
    for (const m of targets) await deleteSession(m.id);
    process.stdout.write(
      colors.green(`removed ${targets.length} empty session${targets.length === 1 ? '' : 's'}\n`),
    );
    return 0;
  }
  const raw = argv.positional[1];
  if (!raw) {
    process.stderr.write(colors.red('usage: moxxy sessions delete <id> | --empty\n'));
    return 2;
  }
  const id = resolveId(raw, all);
  await deleteSession(id);
  process.stdout.write(colors.green(`removed ${id}\n`));
  return 0;
}

const RESUME_HELP = `moxxy resume — resume a previously-persisted session

  moxxy resume                 pick interactively from a numbered list
  moxxy resume -s <id>         resume the named session by id
  moxxy resume <id>            shorthand for the above
`;

/**
 * Resolves the session id the user wants to resume:
 *   1. `-s <id>` or `--session <id>` flag
 *   2. First positional argument
 *   3. Interactive picker (prints the index, reads a number from stdin)
 *
 * Returns null when the user cancels the picker or no sessions exist.
 */
export async function pickSessionToResume(argv: ParsedArgv): Promise<string | null> {
  if (argv.positional[0] === 'help' || helpRequested(argv)) {
    process.stdout.write(RESUME_HELP);
    return null;
  }
  const explicit = stringFlag(argv, 's') ?? stringFlag(argv, 'session') ?? argv.positional[0];
  if (explicit) {
    const all = await readSessionIndex();
    return resolveId(explicit, all);
  }

  const all = await readSessionIndex();
  if (all.length === 0) {
    process.stderr.write(colors.dim('(no persisted sessions to resume)\n'));
    return null;
  }
  process.stdout.write(formatSessions(all));
  process.stdout.write('\n' + colors.dim('Pick a session by number (Enter to cancel): '));
  const pick = await readNumber(all.length);
  if (pick == null) return null;
  return all[pick - 1]!.id;
}

function formatSessions(all: ReadonlyArray<SessionMeta>): string {
  const rows = all.map((m, i) => {
    const when = formatAgo(m.lastActivity);
    const events = `${m.eventCount} ev`;
    const prompt = m.firstPrompt ?? colors.dim('(empty)');
    const head = `${String(i + 1).padStart(3, ' ')}. ${colors.bold(m.id)}`;
    const tail = `${colors.dim(when)} · ${colors.dim(events)} · ${colors.dim(m.cwd)}`;
    return `${head}  ${prompt}\n     ${tail}\n`;
  });
  return rows.join('');
}

/**
 * Map a user-supplied identifier to a full session id. Accepts:
 *   - exact id  ("01KRXW85TZ1BDCT8Z1WRZ8TNZ7")
 *   - suffix    ("VVXQYF8CZ3")  ← the truncated form list used to show
 *   - prefix    ("01KRXW85")    ← copy-from-anywhere flavor
 *   - 1-based position from `sessions list`  ("1", "2", ...)
 *
 * Falls back to the raw input so the existing not-found error path
 * still fires with a meaningful message.
 */
function resolveId(input: string, all: ReadonlyArray<SessionMeta>): string {
  const trimmed = input.trim();
  // Numeric index into the list, 1-based to match `sessions list`.
  if (/^\d+$/.test(trimmed)) {
    const idx = Number.parseInt(trimmed, 10) - 1;
    if (idx >= 0 && idx < all.length) return all[idx]!.id;
  }
  if (all.some((m) => m.id === trimmed)) return trimmed;
  const suffix = all.filter((m) => m.id.endsWith(trimmed));
  if (suffix.length === 1) return suffix[0]!.id;
  const prefix = all.filter((m) => m.id.startsWith(trimmed));
  if (prefix.length === 1) return prefix[0]!.id;
  // Ambiguous or no match — return the raw input so the resume path
  // surfaces a clear "Session not found" with the user's typed string.
  return trimmed;
}

/**
 * Read a number 1..max from stdin (canonical mode). Returns null on
 * EOF, empty input, or anything unparseable — those all mean "cancel"
 * for our purposes.
 */
function readNumber(max: number): Promise<number | null> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.once('line', (line) => {
      rl.close();
      const n = Number.parseInt(line.trim(), 10);
      if (!Number.isFinite(n) || n < 1 || n > max) resolve(null);
      else resolve(n);
    });
    rl.once('close', () => resolve(null));
  });
}

function formatAgo(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86_400)}d ago`;
}
