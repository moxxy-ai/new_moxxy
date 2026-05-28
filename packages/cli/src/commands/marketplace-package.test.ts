import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('@moxxy/plugin-marketplace package manifest', () => {
  it('is a private cli plugin package', async () => {
    const pkg = JSON.parse(
      await readFile(new URL('../../../plugin-marketplace/package.json', import.meta.url), 'utf8'),
    ) as {
      name?: string;
      private?: boolean;
      moxxy?: { plugin?: { entry?: string; kind?: string } };
    };

    expect(pkg.name).toBe('@moxxy/plugin-marketplace');
    expect(pkg.private).toBe(true);
    expect(pkg.moxxy?.plugin).toEqual({
      entry: './dist/index.js',
      kind: 'cli',
    });
  });
});
