import { runMarketplaceCommand as runMarketplaceBase } from '@moxxy/plugin-marketplace';
import type { ParsedArgv } from '../argv.js';
import { runPluginStartCommand } from './plugin-start.js';

export async function runMarketplaceCommand(argv: ParsedArgv): Promise<number> {
  return runMarketplaceBase(argv, {
    startUiPlugin: runPluginStartCommand,
  });
}
