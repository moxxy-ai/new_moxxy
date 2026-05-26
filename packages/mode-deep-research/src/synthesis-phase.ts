import {
  collectProviderStream,
  runCompactionIfNeeded,
  usageEventFields,
  type ModeContext,
  type ProviderMessage,
} from '@moxxy/sdk';

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
  await runCompactionIfNeeded(ctx);

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

  await ctx.emit({
    type: 'provider_request',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'system',
    provider: ctx.provider.name,
    model: ctx.model,
  });

  const { text, usage, error } = await collectProviderStream(ctx, messages, {
    includeTools: false,
    maxTokens: 4096,
  });
  if (error) {
    await ctx.emit({
      type: 'error',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'system',
      kind: error.retryable ? 'retryable' : 'fatal',
      message: error.message,
    });
    return null;
  }

  await ctx.emit({
    type: 'provider_response',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'system',
    provider: ctx.provider.name,
    model: ctx.model,
    ...usageEventFields(usage),
  });

  return text;
}
