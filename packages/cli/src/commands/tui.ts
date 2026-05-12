import { createInteractivePermissionResolver, InteractiveSession } from '@moxxy/plugin-cli';
import { render } from 'ink';
import React from 'react';
import type { PendingToolCall, PermissionContext, PermissionDecision } from '@moxxy/sdk';
import { setupSession } from '../setup.js';
import { argvToSetupOptions, stringFlag } from '../argv-helpers.js';
import type { ParsedArgv } from '../argv.js';

export async function runTuiCommand(argv: ParsedArgv): Promise<number> {
  let promptHandler:
    | ((call: PendingToolCall, ctx: PermissionContext) => Promise<PermissionDecision>)
    | null = null;

  const resolver = createInteractivePermissionResolver({
    name: 'tui',
    prompt: async (call, ctx) => {
      if (!promptHandler) return { mode: 'deny', reason: 'TUI not ready' };
      return promptHandler(call, ctx);
    },
  });

  const session = await setupSession({
    ...argvToSetupOptions(argv),
    resolver,
  });

  const model = stringFlag(argv, 'model');
  const { waitUntilExit } = render(
    React.createElement(InteractiveSession, {
      session,
      registerInteractiveResolver: (handler) => {
        promptHandler = handler;
      },
      ...(model ? { model } : {}),
    }),
  );

  await waitUntilExit();
  return 0;
}
