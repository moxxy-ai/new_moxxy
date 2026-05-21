import { describe, expect, it } from 'vitest';
import { Session, silentLogger } from '@moxxy/core';
import { definePlugin } from '@moxxy/sdk';
import type { MoxxyConfig } from '@moxxy/config';
import { registerPlugins } from './register-plugins.js';

describe('registerPlugins', () => {
  it('returns skipped plugins with unmet requirements', async () => {
    const session = new Session({ cwd: '/tmp', logger: silentLogger });
    const result = await registerPlugins(
      session,
      {} as MoxxyConfig,
      [
        {
          name: 'needs-base',
          plugin: definePlugin({
            name: 'needs-base',
            requirements: [
              {
                kind: 'plugin',
                name: 'base-plugin',
                hint: 'Enable base-plugin.',
              },
            ],
          }),
        },
      ],
      '/tmp',
      silentLogger,
      { discover: false },
    );

    expect(result.registered.size).toBe(0);
    expect(result.skipped).toMatchObject([
      {
        pluginName: 'needs-base',
        source: 'static',
        reason: 'unmet_requirements',
        message: 'Required plugin is not registered: base-plugin',
        hints: ['Enable base-plugin.'],
      },
    ]);
  });
});
