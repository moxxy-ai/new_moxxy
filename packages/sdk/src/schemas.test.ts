import { describe, expect, it } from 'vitest';
import { moxxyPackageSchema, pluginManifestSchema, skillFrontmatterSchema } from './schemas.js';

describe('skillFrontmatterSchema', () => {
  it('accepts minimal valid frontmatter', () => {
    const parsed = skillFrontmatterSchema.parse({
      name: 'refactor-component',
      description: 'Splits a large React component into smaller files.',
    });
    expect(parsed.name).toBe('refactor-component');
  });

  it('accepts optional fields', () => {
    const parsed = skillFrontmatterSchema.parse({
      name: 'deploy',
      description: 'Deploy to staging.',
      triggers: ['deploy', 'ship'],
      'allowed-tools': ['Bash'],
      version: '1.0.0',
      tags: ['ops'],
    });
    expect(parsed.triggers).toEqual(['deploy', 'ship']);
  });

  it('rejects non-slug names', () => {
    expect(() =>
      skillFrontmatterSchema.parse({ name: 'Refactor Component', description: 'x' }),
    ).toThrow(/slug-like/);
    expect(() =>
      skillFrontmatterSchema.parse({ name: '-bad', description: 'x' }),
    ).toThrow();
  });

  it('rejects names exceeding length cap', () => {
    expect(() =>
      skillFrontmatterSchema.parse({ name: 'a'.repeat(121), description: 'x' }),
    ).toThrow();
  });

  it('rejects empty description', () => {
    expect(() => skillFrontmatterSchema.parse({ name: 'x', description: '' })).toThrow();
  });
});

describe('pluginManifestSchema', () => {
  it('accepts minimal manifest', () => {
    const parsed = pluginManifestSchema.parse({ entry: './src/index.ts' });
    expect(parsed.entry).toBe('./src/index.ts');
  });

  it('accepts kind as scalar or array', () => {
    expect(pluginManifestSchema.parse({ entry: 'a', kind: 'tools' }).kind).toBe('tools');
    expect(pluginManifestSchema.parse({ entry: 'a', kind: ['tools', 'hooks'] }).kind).toEqual([
      'tools',
      'hooks',
    ]);
  });

  it('accepts every public plugin kind, including transcriber/agent/command/ui', () => {
    expect(pluginManifestSchema.parse({ entry: 'a', kind: 'transcriber' }).kind).toBe(
      'transcriber',
    );
    expect(pluginManifestSchema.parse({ entry: 'a', kind: 'ui' }).kind).toBe('ui');
    expect(pluginManifestSchema.parse({ entry: 'a', kind: ['agent', 'command'] }).kind).toEqual([
      'agent',
      'command',
    ]);
  });

  it('accepts a ui plugin port', () => {
    const parsed = pluginManifestSchema.parse({
      entry: './serve.js',
      kind: 'ui',
      port: 17901,
    });

    expect(parsed.port).toBe(17901);
  });

  it('rejects invalid ui plugin ports', () => {
    for (const port of [0, 65536, 17901.5, '17901']) {
      expect(() => pluginManifestSchema.parse({ entry: 'a', kind: 'ui', port })).toThrow();
    }
  });

  it('rejects unknown kind', () => {
    expect(() => pluginManifestSchema.parse({ entry: 'a', kind: 'weird' })).toThrow();
  });
});

describe('moxxyPackageSchema', () => {
  it('accepts the full moxxy package block with plugin + requirements', () => {
    const parsed = moxxyPackageSchema.parse({
      plugin: { entry: './dist/index.js', kind: 'transcriber' },
      requirements: [
        {
          kind: 'plugin',
          name: '@moxxy/plugin-provider-openai-codex',
          state: 'registered',
          hint: 'Enable @moxxy/plugin-provider-openai-codex.',
        },
      ],
    });

    expect(parsed.plugin?.entry).toBe('./dist/index.js');
    expect(parsed.requirements).toEqual([
      {
        kind: 'plugin',
        name: '@moxxy/plugin-provider-openai-codex',
        state: 'registered',
        hint: 'Enable @moxxy/plugin-provider-openai-codex.',
      },
    ]);
  });

  it('accepts a moxxy block with only requirements (no plugin entry)', () => {
    const parsed = moxxyPackageSchema.parse({
      requirements: [{ kind: 'plugin', name: 'base' }],
    });
    expect(parsed.plugin).toBeUndefined();
    expect(parsed.requirements).toHaveLength(1);
  });
});
