import { describe, expect, it } from 'vitest';
import { Session, silentLogger } from '@moxxy/core';
import { definePlugin, defineProvider } from '@moxxy/sdk';
import { activateProvider } from './activate-provider.js';

describe('activateProvider', () => {
  it('marks provider auth as ready after credentials resolve and provider activates', async () => {
    const session = new Session({ cwd: '/tmp', logger: silentLogger });
    session.pluginHost.registerStatic(
      definePlugin({
        name: '@test/provider',
        providers: [
          defineProvider({
            name: 'test-provider',
            models: [],
            createClient: () => ({
              name: 'test-provider',
              models: [],
              stream: async function* () {},
              countTokens: async () => 0,
            }),
          }),
        ],
      }),
    );

    await activateProvider({
      session,
      config: { provider: { name: 'test-provider' } },
      vault: {
        get: async () => null,
        set: async () => undefined,
      } as never,
      providerConfig: { apiKey: 'sk-test' },
      skipKeyPrompt: true,
      progress: () => undefined,
      logger: silentLogger,
    });

    expect(
      session.requirements.check([
        { kind: 'runtime', name: 'auth:provider:test-provider', state: 'ready' },
      ]),
    ).toEqual({ ready: true, issues: [] });
  });
});
