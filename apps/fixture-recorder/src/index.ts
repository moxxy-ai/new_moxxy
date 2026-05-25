#!/usr/bin/env node
/**
 * fixture-recorder — drives a single moxxy turn against the real Anthropic
 * API and writes the recorded ProviderEvents to a JSONL fixture the test
 * harness can replay in CI.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... moxxy-record \
 *     --prompt "list files in cwd"  \
 *     --name list-files-demo        \
 *     --out packages/testing/__fixtures__ \
 *     --model claude-sonnet-4-6     \
 *     [--allow-tools Read,Glob]     \
 *     [--max-iterations 4]
 *
 * Notes:
 * - The recorder uses RecordedProvider in `record` mode so every Anthropic
 *   ProviderEvent is captured to the named fixture file.
 * - Subsequent test runs with MOXXY_FIXTURES=replay (the default) consume
 *   that fixture deterministically — zero tokens spent.
 */
import * as path from 'node:path';
import {
  Session,
  collectTurn,
  createAllowListResolver,
  createLogger,
  silentLogger,
} from '@moxxy/core';
import { AnthropicProvider, anthropicModels } from '@moxxy/plugin-provider-anthropic';
import { builtinToolsPlugin } from '@moxxy/tools-builtin';
import { toolUseModePlugin } from '@moxxy/mode-tool-use';
import { RecordedProvider } from '@moxxy/testing';
import { definePlugin, defineProvider } from '@moxxy/sdk';

interface Flags {
  prompt: string;
  name: string;
  out: string;
  model?: string;
  allowTools: string[];
  maxIterations?: number;
  verbose: boolean;
}

const HELP = `moxxy-record — record an Anthropic turn into a JSONL fixture

required:
  --prompt "..."      the user prompt to drive
  --name <id>         fixture base name (used in the filename)
  --out <dir>         directory to write fixtures into

optional:
  --model <model-id>            override default model
  --allow-tools <a,b,c>         comma-separated tool whitelist
  --max-iterations <n>          cap the loop
  --verbose                     debug logging
  --help                        this help

env:
  ANTHROPIC_API_KEY             required for the recorder
`;

export async function record(flags: Flags): Promise<{ fixtureFiles: string[]; events: number }> {
  const upstream = new AnthropicProvider({});
  const recorder = new RecordedProvider({
    mode: 'record',
    upstream,
    fixtureDir: path.resolve(flags.out),
    testName: flags.name,
  });

  const logger = flags.verbose ? createLogger({ minLevel: 'debug' }) : silentLogger;
  const session = new Session({
    cwd: process.cwd(),
    logger,
    permissionResolver: createAllowListResolver(flags.allowTools),
  });

  // Provider shim that returns our recording wrapper rather than a fresh client.
  session.pluginHost.registerStatic(
    definePlugin({
      name: 'recorder-provider-shim',
      providers: [
        defineProvider({
          name: 'anthropic-recording',
          models: [...anthropicModels],
          createClient: () => recorder,
        }),
      ],
    }),
  );
  session.providers.setActive('anthropic-recording');
  session.pluginHost.registerStatic(builtinToolsPlugin);
  session.pluginHost.registerStatic(toolUseModePlugin);

  const events = await collectTurn(session, flags.prompt, {
    model: flags.model,
    ...(flags.maxIterations ? { maxIterations: flags.maxIterations } : {}),
  });

  const { promises: fs } = await import('node:fs');
  const fixtures = (await fs.readdir(path.resolve(flags.out))).filter(
    (f) => f.startsWith(`${flags.name}.`) && f.endsWith('.json'),
  );
  return { fixtureFiles: fixtures.map((f) => path.resolve(flags.out, f)), events: events.length };
}

function parseFlags(argv: ReadonlyArray<string>): Flags | { help: true } {
  if (argv.length === 0) return { help: true };
  const flags: Partial<Flags> & { allowTools?: string[]; verbose?: boolean } = {
    allowTools: [],
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--verbose') flags.verbose = true;
    else if (a === '--prompt') flags.prompt = argv[++i];
    else if (a === '--name') flags.name = argv[++i];
    else if (a === '--out') flags.out = argv[++i];
    else if (a === '--model') flags.model = argv[++i];
    else if (a === '--max-iterations') flags.maxIterations = Number(argv[++i] ?? '0');
    else if (a === '--allow-tools') flags.allowTools = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else throw new Error(`unknown flag: ${a}`);
  }
  if (!flags.prompt) throw new Error('--prompt is required');
  if (!flags.name) throw new Error('--name is required');
  if (!flags.out) throw new Error('--out is required');
  return {
    prompt: flags.prompt,
    name: flags.name,
    out: flags.out,
    model: flags.model,
    allowTools: flags.allowTools ?? [],
    maxIterations: flags.maxIterations,
    verbose: flags.verbose ?? false,
  };
}

async function main(): Promise<number> {
  let parsed: Flags | { help: true };
  try {
    parsed = parseFlags(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n\n${HELP}`);
    return 2;
  }
  if ('help' in parsed) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write('ANTHROPIC_API_KEY is required\n');
    return 1;
  }
  const result = await record(parsed);
  process.stdout.write(
    `recorded ${result.events} events; fixtures:\n${result.fixtureFiles.map((f) => `  ${f}`).join('\n')}\n`,
  );
  return 0;
}

const isEntrypoint = import.meta.url === `file://${process.argv[1]}`;
if (isEntrypoint) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
