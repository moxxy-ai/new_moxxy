import {
  runMarketplaceCommand as runMarketplaceBase,
  type MarketplaceArgv,
} from '@moxxy/plugin-marketplace';
import type { ParsedArgv } from '../argv.js';
import { runPluginStartCommand } from './plugin-start.js';

export function toParsedArgv(argv: MarketplaceArgv): ParsedArgv {
  const flags: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(argv.flags)) {
    if (typeof value === 'string' || typeof value === 'boolean') {
      flags[key] = value;
    }
  }

  return {
    command: argv.command,
    positional: [...argv.positional],
    flags,
    passthrough: argv.passthrough ? [...argv.passthrough] : [],
  };
}

export async function runMarketplaceCommand(argv: ParsedArgv): Promise<number> {
  const marketplaceArgv: MarketplaceArgv = {
    command: argv.command,
    positional: argv.positional,
    flags: argv.flags,
    passthrough: argv.passthrough,
  };
  return runMarketplaceBase(marketplaceArgv, {
    startUiPlugin: (next) => runPluginStartCommand(toParsedArgv(next)),
  });
}
