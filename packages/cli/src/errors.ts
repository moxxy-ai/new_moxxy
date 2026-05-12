import { colors } from './colors.js';

/**
 * Single helper for stderr error output. Every CLI command should route
 * user-visible failures through this so the look is consistent and
 * automation can grep for the `error:` prefix.
 *
 * The message is colored when stdout/stderr is a TTY (see `colors.ts`).
 * Honors NO_COLOR.
 */
export function printError(message: string): void {
  process.stderr.write(colors.red('error: ') + message + '\n');
}

/** Same shape as `printError` but for warnings (yellow tag). */
export function printWarn(message: string): void {
  process.stderr.write(colors.yellow('warn: ') + message + '\n');
}
