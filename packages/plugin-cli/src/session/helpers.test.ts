import { describe, expect, it } from 'vitest';
import { Session, silentLogger } from '@moxxy/core';
import { defineProvider } from '@moxxy/sdk';
import { resolveActiveModel } from './helpers.js';

function sessionWithModels(models: string[]): Session {
  const session = new Session({ cwd: process.cwd(), logger: silentLogger });
  session.providers.register(
    defineProvider({
      name: 'openai-codex',
      models: models.map((id) => ({
        id,
        contextWindow: 300_000,
        supportsTools: true,
        supportsStreaming: true,
      })),
      createClient: () => {
        const provider = session.providers.list()[0]!;
        return {
          name: provider.name,
          models: provider.models,
          stream: async function* () {
            yield { type: 'message_end', stopReason: 'end_turn' } as const;
          },
          countTokens: async () => 0,
        };
      },
    }),
  );
  session.providers.setActive('openai-codex');
  return session;
}

describe('resolveActiveModel', () => {
  it('ignores a persisted model that is not offered by the active provider', () => {
    const session = sessionWithModels(['gpt-5.5']);

    expect(resolveActiveModel(session, null, 'fake-model')).toBe('gpt-5.5');
  });
});
