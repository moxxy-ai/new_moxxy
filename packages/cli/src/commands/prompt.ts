import { collectTurn, createAllowListResolver, denyByDefaultResolver, runTurn } from '@moxxy/core';
import type { MoxxyEvent } from '@moxxy/sdk';
import { setupSession } from '../setup.js';
import { argvToSetupOptions, hasBoolFlag, stringFlag } from '../argv-helpers.js';
import { printError } from '../errors.js';
import type { ParsedArgv } from '../argv.js';

export async function runPromptCommand(argv: ParsedArgv): Promise<number> {
  const prompt = stringFlag(argv, 'p') ?? stringFlag(argv, 'prompt') ?? '';
  if (!prompt) {
    printError('-p/--prompt requires a non-empty string');
    return 2;
  }

  const stdinBuf = await readStdinIfPiped();
  const fullPrompt = stdinBuf ? `${prompt}\n\n${stdinBuf}` : prompt;

  const allowTools = parseList(argv.flags['allow-tools']);
  const allowAll = hasBoolFlag(argv, 'allow-all');
  const outputFormat = (stringFlag(argv, 'output-format') ?? 'text') as 'text' | 'json' | 'stream-json';
  const model = stringFlag(argv, 'model');

  // For --allow-all, derive the allow-list from the active session's tools
  // rather than hardcoding a stale snapshot. We boot the session first with
  // deny-by-default, look at tools, then swap to the all-tools resolver.
  // For the common case (no --allow-all) we can wire the resolver inline.
  let resolver = allowAll
    ? denyByDefaultResolver
    : allowTools.length > 0
      ? createAllowListResolver(allowTools)
      : denyByDefaultResolver;

  const session = await setupSession({
    ...argvToSetupOptions(argv),
    resolver,
  });

  if (allowAll) {
    const everyTool = session.tools.list().map((t) => t.name);
    session.setPermissionResolver(createAllowListResolver(everyTool));
  }

  let exitCode = 0;
  try {
    if (outputFormat === 'text') {
      for await (const event of runTurn(session, fullPrompt, model ? { model } : {})) {
        if (event.type === 'assistant_chunk') process.stdout.write(event.delta);
        if (event.type === 'tool_call_denied') {
          printError(`tool denied: ${event.reason}`);
          exitCode = 1;
        }
        if (event.type === 'error') {
          printError(event.message);
          exitCode = 1;
        }
      }
      process.stdout.write('\n');
    } else if (outputFormat === 'stream-json') {
      for await (const event of runTurn(session, fullPrompt, model ? { model } : {})) {
        process.stdout.write(JSON.stringify(event) + '\n');
        if (event.type === 'tool_call_denied' || event.type === 'error') exitCode = 1;
      }
    } else {
      const events = await collectTurn(session, fullPrompt, model ? { model } : {});
      process.stdout.write(JSON.stringify(events, null, 2) + '\n');
      if (events.some((e: MoxxyEvent) => e.type === 'tool_call_denied' || e.type === 'error')) exitCode = 1;
    }
  } catch (err) {
    printError(`fatal: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  return exitCode;
}

function parseList(v: unknown): string[] {
  if (typeof v !== 'string' || !v) return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

async function readStdinIfPiped(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text || null;
}
