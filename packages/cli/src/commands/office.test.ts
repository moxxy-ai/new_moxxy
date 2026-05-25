import { describe, expect, it } from 'vitest';
import { buildOfficeStartArgv } from './office.js';

describe('office shortcut command', () => {
  it('expands to virtual-office plugin start with tui and open enabled', () => {
    expect(buildOfficeStartArgv({
      command: 'office',
      flags: {},
      positional: [],
    })).toEqual({
      command: 'plugins',
      flags: {
        tui: true,
        open: true,
      },
      positional: ['start', '@moxxy/virtual-office-plugin'],
    });
  });

  it('preserves session and port flags for direct office starts', () => {
    expect(buildOfficeStartArgv({
      command: 'office',
      flags: {
        session: 'session-old',
        port: '18001',
        'api-port': '3738',
      },
      positional: [],
    })).toMatchObject({
      flags: {
        tui: true,
        open: true,
        session: 'session-old',
        port: '18001',
        'api-port': '3738',
      },
    });
  });
});
