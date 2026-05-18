import { readSessionIndex } from '@moxxy/core';
import type { ParsedArgv } from '../argv.js';
import { pickSessionToResume } from './sessions.js';
import { runTuiWithBootstrap } from './run-tui.js';
import { colors } from '../colors.js';

/**
 * `moxxy resume [-s <id>|<id>]` — resume a previously-persisted
 * session. Reads `~/.moxxy/sessions/index.json`, prompts the user (or
 * uses the explicit id), then mounts the TUI with the restored event
 * log seeded. The picker runs BEFORE Ink mounts (canonical-mode
 * readline) so it can't deadlock against raw-mode input.
 */
export async function runResumeCommand(argv: ParsedArgv): Promise<number> {
  const id = await pickSessionToResume(argv);
  if (!id) return 0;
  // Print a confirmation line before mounting Ink. On terminals that
  // don't use the alternate screen for Ink (or that scroll past the
  // TUI on exit), this is the only visible breadcrumb that the resume
  // succeeded — without it the picker output and the empty post-Ink
  // shell prompt make it look like "nothing happened".
  const index = await readSessionIndex();
  const meta = index.find((m) => m.id === id);
  const label = meta?.firstPrompt ?? colors.dim('(empty)');
  process.stdout.write(colors.dim(`resuming ${id} — `) + label + '\n');
  return runTuiWithBootstrap(argv, { resumeSessionId: id });
}
