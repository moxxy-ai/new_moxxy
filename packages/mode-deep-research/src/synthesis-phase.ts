import { runSingleShotTurn, type ModeContext, type ProviderMessage } from '@moxxy/sdk';

import { SYNTHESIS_SYSTEM_PROMPT } from './constants.js';

/**
 * Run the synthesis turn: single-shot stream that consumes the
 * per-subagent findings and produces the final structured writeup.
 * Returns the assembled text or null on error.
 */
export async function collectSynthesis(
  ctx: ModeContext,
  inputBody: string,
): Promise<string | null> {
  const messages: ProviderMessage[] = [
    {
      role: 'system',
      content: [{ type: 'text', text: SYNTHESIS_SYSTEM_PROMPT }],
    },
    {
      role: 'user',
      content: [{ type: 'text', text: inputBody }],
    },
  ];
  return runSingleShotTurn(ctx, messages, { maxTokens: 4096 });
}
