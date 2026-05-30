import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('top-level CLI dispatcher', () => {
  it('registers marketplace instead of plugins', async () => {
    const source = await readFile(new URL('./bin.ts', import.meta.url), 'utf8');

    expect(source).toContain('marketplace');
    expect(source).not.toMatch(/\bplugins:\s*runPluginsCommand\b/);
    expect(source).not.toContain("['plugins',");
  });

  it('uses marketplace for the CI plugin smoke command', async () => {
    const workflow = await readFile(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');

    expect(workflow).toContain('node packages/cli/dist/bin.js marketplace list');
    expect(workflow).not.toContain('node packages/cli/dist/bin.js plugins list');
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
