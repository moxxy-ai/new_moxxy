import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('top-level CLI dispatcher', () => {
  it('registers marketplace instead of plugins', async () => {
    const source = await readFile(new URL('./bin.ts', import.meta.url), 'utf8');

    expect(source).toContain('marketplace');
    expect(source).not.toMatch(/\bplugins:\s*runPluginsCommand\b/);
    expect(source).not.toContain("['plugins',");
  });

  it('does not register Virtual Office as a built-in command', async () => {
    const source = await readFile(new URL('./bin.ts', import.meta.url), 'utf8');

    expect(source).not.toContain("commands/office");
    expect(source).not.toMatch(/\boffice:\s*runOfficeCommand\b/);
    expect(source).not.toContain("['moxxy office'");
    expect(source).not.toContain("['moxxy --office'");
    expect(source).not.toContain("['office [--session <id>]'");
    expect(source).not.toContain("['--office'");
  });
});
