import { describe, expect, it } from 'vitest';
import { runPluginsCommand } from './plugins.js';

function makeArgv(positional: string[] = []) {
  return {
    command: 'plugins',
    positional,
    flags: {},
  } as never;
}

describe('plugins command dispatch', () => {
  it('opens the interactive plugin catalog for bare `moxxy plugins` in a TTY', async () => {
    const calls: string[] = [];

    const code = await runPluginsCommand(makeArgv(), {
      isInteractive: () => true,
      runCatalog: async () => {
        calls.push('catalog');
        return 0;
      },
    });

    expect(code).toBe(0);
    expect(calls).toEqual(['catalog']);
  });
});
