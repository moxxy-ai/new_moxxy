/**
 * example-basic — the smallest possible moxxy embedding.
 *
 * Demonstrates:
 *   1. Building a Session
 *   2. Registering plugins (provider, tools, loop)
 *   3. Driving a single turn end-to-end
 *   4. Streaming events as the model + tools execute
 *   5. Inspecting the final event log
 *
 * Runs deterministically — no API key required, no network — because we
 * inject a FakeProvider with a scripted reply.
 */
import { defineProvider, definePlugin, defineTool, z } from '@moxxy/sdk';
import { Session, autoAllowResolver, collectTurn, silentLogger } from '@moxxy/core';
import { toolUseModePlugin } from '@moxxy/mode-tool-use';
import { builtinToolsPlugin } from '@moxxy/tools-builtin';
import { FakeProvider, textReply, toolUseReply } from '@moxxy/testing';

export async function runExample(): Promise<void> {
  // 1. Construct the fake provider with a two-step scripted turn:
  //    a) model asks to use a custom tool
  //    b) model summarizes the result
  const provider = new FakeProvider({
    script: [
      toolUseReply('greet', { name: 'world' }, 'call-1'),
      textReply('The greeting tool said "Hello, world!".'),
    ],
  });

  // 2. Boot a Session. The loop strategy is wired by the tool-use plugin.
  const session = new Session({
    cwd: process.cwd(),
    logger: silentLogger,
    permissionResolver: autoAllowResolver,
  });

  // 3. Register plugins — provider, default toolset, loop strategy, and an
  //    inline plugin that contributes our demo `greet` tool.
  session.pluginHost.registerStatic(
    definePlugin({
      name: 'example-provider-shim',
      providers: [defineProvider({
        name: 'fake',
        models: [...provider.models],
        createClient: () => provider,
      })],
    }),
  );
  session.providers.setActive('fake');
  session.pluginHost.registerStatic(builtinToolsPlugin);
  session.pluginHost.registerStatic(toolUseModePlugin);
  session.pluginHost.registerStatic(
    definePlugin({
      name: 'example-tools',
      tools: [
        defineTool({
          name: 'greet',
          description: 'Returns a greeting for the given name.',
          inputSchema: z.object({ name: z.string() }),
          handler: ({ name }) => `Hello, ${name}!`,
        }),
      ],
    }),
  );

  // 4. Drive the turn and collect every emitted event.
  const events = await collectTurn(session, 'use the greet tool');

  // 5. Inspect the result.
  console.log(`\n— event log (${events.length} events) —`);
  for (const e of events) {
    if (e.type === 'user_prompt') console.log(`  user: ${e.text}`);
    else if (e.type === 'tool_call_requested') console.log(`  tool_use: ${e.name}(${JSON.stringify(e.input)})`);
    else if (e.type === 'tool_result' && e.ok) console.log(`  tool_result: ${String(e.output)}`);
    else if (e.type === 'assistant_message') console.log(`  assistant: ${e.content}`);
  }
}

const isEntrypoint = import.meta.url === `file://${process.argv[1]}`;
if (isEntrypoint) {
  runExample().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
