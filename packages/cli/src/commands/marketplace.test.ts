import { describe, expect, it } from 'vitest';
import { toParsedArgv } from './marketplace.js';

describe('marketplace CLI adapter', () => {
  it('converts marketplace argv to the stricter CLI argv shape', () => {
    expect(
      toParsedArgv({
        command: 'marketplace',
        positional: ['open', '@moxxy/virtual-office-plugin'],
        flags: {
          open: true,
          port: '17901',
          metadata: { ignored: true },
          count: 3,
        },
      }),
    ).toEqual({
      command: 'marketplace',
      positional: ['open', '@moxxy/virtual-office-plugin'],
      flags: {
        open: true,
        port: '17901',
      },
      passthrough: [],
    });
  });

  it('forwards marketplace passthrough into the parsed argv', () => {
    expect(
      toParsedArgv({
        command: 'marketplace',
        positional: ['open', '@moxxy/virtual-office-plugin'],
        flags: {},
        passthrough: ['--theme', 'dark'],
      }),
    ).toEqual({
      command: 'marketplace',
      positional: ['open', '@moxxy/virtual-office-plugin'],
      flags: {},
      passthrough: ['--theme', 'dark'],
    });
  });
});
