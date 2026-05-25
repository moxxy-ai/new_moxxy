import type { ParsedArgv } from '../argv.js';
import { runPluginStartCommand } from './plugin-start.js';

const VIRTUAL_OFFICE_PACKAGE = '@moxxy/virtual-office-plugin';

export function buildOfficeStartArgv(argv: ParsedArgv): ParsedArgv {
  return {
    command: 'plugins',
    flags: {
      ...argv.flags,
      tui: true,
      open: true,
    },
    positional: ['start', VIRTUAL_OFFICE_PACKAGE],
  };
}

export async function runOfficeCommand(argv: ParsedArgv): Promise<number> {
  return runPluginStartCommand(buildOfficeStartArgv(argv));
}
