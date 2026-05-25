import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { asSessionId, asToolCallId, asTurnId, type ToolContext } from '@moxxy/sdk';
import { buildConfigPlugin } from './plugin.js';

let tmp: string;

const ctx: ToolContext = {
  sessionId: asSessionId('s'),
  turnId: asTurnId('t'),
  callId: asToolCallId('c'),
  cwd: '/tmp',
  signal: new AbortController().signal,
  log: { length: 0, at: () => undefined, slice: () => [], ofType: () => [], byTurn: () => [], toJSON: () => [] },
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
};

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mox-cfg-plug-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function tool(name: string) {
  const plugin = buildConfigPlugin({ cwd: tmp });
  const t = plugin.tools?.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

describe('buildConfigPlugin tools', () => {
  it('config_path returns null when no project file exists', async () => {
    const out = (await tool('config_path').handler({ scope: 'project' }, ctx)) as {
      scope: string;
      path: string | null;
    };
    expect(out.scope).toBe('project');
    expect(out.path).toBeNull();
  });

  it('config_path finds an existing moxxy.config.yaml in cwd', async () => {
    await fs.writeFile(path.join(tmp, 'moxxy.config.yaml'), 'mode: tool-use\n');
    const out = (await tool('config_path').handler({ scope: 'project' }, ctx)) as {
      path: string;
    };
    expect(out.path).toContain('moxxy.config.yaml');
  });

  it('config_show returns the raw text', async () => {
    await fs.writeFile(path.join(tmp, 'moxxy.config.yaml'), 'mode: tool-use\n');
    const out = (await tool('config_show').handler({ scope: 'project' }, ctx)) as {
      text: string;
    };
    expect(out.text).toContain('mode: tool-use');
  });

  it('config_get reads a value at a dot-path', async () => {
    await fs.writeFile(
      path.join(tmp, 'moxxy.config.yaml'),
      `provider:\n  model: sonnet\n  config:\n    apiKey: k\n`,
    );
    expect(await tool('config_get').handler({ scope: 'project', path: 'provider.model' }, ctx)).toBe('sonnet');
    expect(await tool('config_get').handler({ scope: 'project', path: 'provider.config.apiKey' }, ctx)).toBe('k');
  });

  it('config_set writes a value, preserving the rest of the file', async () => {
    await fs.writeFile(
      path.join(tmp, 'moxxy.config.yaml'),
      `mode: tool-use\nprovider:\n  name: anthropic\n  model: haiku\n`,
    );
    await tool('config_set').handler(
      { scope: 'project', path: 'provider.model', value: '"sonnet"' },
      ctx,
    );
    const text = await fs.readFile(path.join(tmp, 'moxxy.config.yaml'), 'utf8');
    expect(text).toContain('mode: tool-use');
    expect(text).toContain('name: anthropic');
    expect(text).toContain('model: sonnet');
  });

  it('config_set parses JSON values', async () => {
    await tool('config_set').handler(
      { scope: 'project', path: 'channels.http.allowedTools', value: '["Read","Glob"]' },
      ctx,
    );
    const text = await fs.readFile(path.join(tmp, 'moxxy.config.yaml'), 'utf8');
    expect(text).toMatch(/- Read/);
    expect(text).toMatch(/- Glob/);
  });

  it('config_set rejects writes that would violate the schema', async () => {
    await expect(
      tool('config_set').handler({ scope: 'project', path: 'provider.name', value: '42' }, ctx),
    ).rejects.toThrow(/invalid config/);
  });

  it('config_init creates a starter yaml when missing', async () => {
    const out = (await tool('config_init').handler({ scope: 'project' }, ctx)) as {
      created: boolean;
      path: string;
    };
    expect(out.created).toBe(true);
    const text = await fs.readFile(out.path, 'utf8');
    expect(text).toContain('provider:');
    expect(text).toContain('mode: tool-use');
  });

  it('config_init is a no-op when a file already exists', async () => {
    await fs.writeFile(path.join(tmp, 'moxxy.config.yaml'), 'mode: tool-use\n');
    const out = (await tool('config_init').handler({ scope: 'project' }, ctx)) as {
      created: boolean;
    };
    expect(out.created).toBe(false);
  });
});
