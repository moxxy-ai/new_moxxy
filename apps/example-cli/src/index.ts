/**
 * example-cli — full-wiring library-consumer demo.
 *
 * Distinct from @moxxy/cli (the `moxxy` binary). This shows how someone
 * embedding moxxy directly into their own TypeScript app would wire the
 * pieces: provider, default tools, loop strategy, compactor, vault, and
 * journal-based long-term memory.
 *
 * Runs deterministically — uses FakeProvider with two scripted turns to
 * demonstrate (a) saving a preference to LTM, then (b) recalling it.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defineProvider, definePlugin } from '@moxxy/sdk';
import {
  Session,
  autoAllowResolver,
  collectTurn,
  silentLogger,
} from '@moxxy/core';
import { toolUseModePlugin } from '@moxxy/mode-tool-use';
import { builtinToolsPlugin } from '@moxxy/tools-builtin';
import { summarizeCompactorPlugin } from '@moxxy/compactor-summarize';
import { buildVaultPlugin, deriveKey, generateSalt, createStaticKeySource } from '@moxxy/plugin-vault';
import { buildMemoryPlugin } from '@moxxy/plugin-memory';
import { FakeProvider, textReply, toolUseReply } from '@moxxy/testing';

export interface ExampleResult {
  readonly turns: number;
  readonly memorySaved: string;
  readonly recalledBody: string;
}

export async function runExample(opts: { homeDir?: string } = {}): Promise<ExampleResult> {
  const home = opts.homeDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'mox-example-')));
  const memDir = path.join(home, 'memory');
  const vaultPath = path.join(home, 'vault.json');

  // Two scripted turns, each one a complete loop iteration.
  // Turn 1: assistant calls memory_save → emits a confirming text.
  // Turn 2: assistant calls memory_recall → emits a synthesized answer.
  const provider = new FakeProvider({
    script: [
      toolUseReply(
        'memory_save',
        {
          name: 'team-prefers-trpc',
          type: 'preference',
          description: 'Team prefers tRPC over REST for new endpoints.',
          body: 'When generating a new API route, scaffold a tRPC procedure. Avoid REST controllers unless asked.',
        },
        'mem-save-1',
      ),
      textReply('Got it — saved that preference.'),
      toolUseReply('memory_recall', { query: 'API style preferences' }, 'mem-recall-1'),
      textReply('Your team prefers tRPC over REST for new endpoints.'),
    ],
  });

  // Build vault + memory with isolated home dir so the demo doesn't touch ~/.moxxy
  const { plugin: vaultPlugin } = buildVaultPlugin({
    filePath: vaultPath,
    keySource: createStaticKeySource(deriveKey('example-passphrase', generateSalt())),
  });
  const { plugin: memoryPlugin } = buildMemoryPlugin({ dir: memDir });

  const session = new Session({
    cwd: home,
    logger: silentLogger,
    permissionResolver: autoAllowResolver,
  });
  session.pluginHost.registerStatic(
    definePlugin({
      name: 'example-provider-shim',
      providers: [
        defineProvider({
          name: provider.name,
          models: [...provider.models],
          createClient: () => provider,
        }),
      ],
    }),
  );
  session.providers.setActive(provider.name);
  session.pluginHost.registerStatic(builtinToolsPlugin);
  session.pluginHost.registerStatic(toolUseModePlugin);
  session.pluginHost.registerStatic(summarizeCompactorPlugin);
  session.pluginHost.registerStatic(vaultPlugin);
  session.pluginHost.registerStatic(memoryPlugin);

  // Turn 1 — save a memory.
  const turn1 = await collectTurn(session, 'My team prefers tRPC over REST. Remember that for next time.');
  const saveResult = turn1.find((e) => e.type === 'tool_result' && e.callId === 'mem-save-1');
  if (saveResult?.type !== 'tool_result' || !saveResult.ok) {
    throw new Error('memory_save did not succeed');
  }

  // Turn 2 — recall it.
  const turn2 = await collectTurn(session, 'What style of API does my team prefer?');
  const recallResult = turn2.find((e) => e.type === 'tool_result' && e.callId === 'mem-recall-1');
  if (recallResult?.type !== 'tool_result' || !recallResult.ok) {
    throw new Error('memory_recall did not succeed');
  }
  const recalled = Array.isArray(recallResult.output)
    ? (recallResult.output as Array<{ body: string }>)[0]?.body ?? ''
    : '';
  const finalAssistant = turn2.find((e) => e.type === 'assistant_message');

  return {
    turns: 2,
    memorySaved: 'team-prefers-trpc',
    recalledBody: recalled || (finalAssistant?.type === 'assistant_message' ? finalAssistant.content : ''),
  };
}

const isEntrypoint = import.meta.url === `file://${process.argv[1]}`;
if (isEntrypoint) {
  runExample()
    .then((result) => {
      console.log('— example-cli summary —');
      console.log(`  turns:        ${result.turns}`);
      console.log(`  saved memory: ${result.memorySaved}`);
      console.log(`  recalled:     ${result.recalledBody.slice(0, 120)}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
