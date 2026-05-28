import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Skill } from '@moxxy/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpServerConfig, McpToolDescriptor } from '../types.js';
import { createMcpUsageSkillWriter } from './skill.js';
import type { AdminSkillRegistryLike } from './types.js';

// Minimal block-scalar / sequence frontmatter parser — independent of the
// unit under test — so "well-formed YAML" is actually parsed and checked,
// not just regexed. Mirrors @moxxy/core's hand-rolled skill frontmatter
// reader (key: scalar, plus `key:` followed by `  - item` sequences).
function parseFrontmatter(raw: string): { fm: Record<string, unknown>; body: string } {
  expect(raw.startsWith('---\n')).toBe(true);
  const rest = raw.slice(4);
  const end = rest.indexOf('\n---\n');
  expect(end).toBeGreaterThan(-1);
  const fmText = rest.slice(0, end);
  const body = rest.slice(end + 5).replace(/^\n/, '');
  const fm: Record<string, unknown> = {};
  const lines = fmText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) throw new Error(`unparseable frontmatter line: ${JSON.stringify(line)}`);
    const [, key, val] = m;
    if (val) {
      fm[key!] = val;
    } else {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1]!)) {
        i++;
        items.push(lines[i]!.replace(/^\s+-\s*/, '').replace(/^"(.*)"$/, '$1'));
      }
      fm[key!] = items;
    }
  }
  return { fm, body };
}

const DESCRIPTORS: ReadonlyArray<McpToolDescriptor> = [
  { name: 'fetch', description: 'Fetch a URL', inputSchema: { type: 'object' } },
  { name: 'shell', description: undefined, inputSchema: { type: 'object' } },
];

const server: McpServerConfig = { kind: 'stdio', name: 'acme', command: 'noop' };

const fakeRegistry = (): AdminSkillRegistryLike & { registered: Skill[] } => {
  const registered: Skill[] = [];
  return {
    registered,
    register: (s) => registered.push(s),
    byName: (n) => registered.find((s) => s.frontmatter.name === n),
  };
};

describe('admin/skill (createMcpUsageSkillWriter)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'moxxy-mcp-skill-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a well-formed-YAML frontmatter file with the expected fields + body', async () => {
    const registry = fakeRegistry();
    const write = createMcpUsageSkillWriter({ skillRegistry: registry, userSkillsDir: dir });
    const result = await write(server, DESCRIPTORS);
    expect(result).not.toBeNull();
    expect(result!.skillName).toBe('acme-mcp');
    expect(result!.path).toBe(join(dir, 'acme-mcp.md'));

    const raw = await readFile(result!.path, 'utf8');
    const { fm, body } = parseFrontmatter(raw);
    expect(fm.name).toBe('acme-mcp');
    expect(fm.description).toBe('Use the acme MCP server (2 tools).');
    expect(fm.triggers).toEqual(['acme', 'acme mcp', 'use acme']);
    expect(fm['allowed-tools']).toEqual(['mcp__acme__fetch', 'mcp__acme__shell']);

    // Body documents each tool, namespacing it, and handles the missing
    // description gracefully.
    expect(body).toContain('mcp__acme__fetch` — Fetch a URL');
    expect(body).toContain('mcp__acme__shell` — (no description provided)');
    expect(body).toContain('## Available tools');
  });

  it('registers a Skill object mirroring the discovered file', async () => {
    const registry = fakeRegistry();
    const write = createMcpUsageSkillWriter({ skillRegistry: registry, userSkillsDir: dir });
    await write(server, DESCRIPTORS);
    expect(registry.registered).toHaveLength(1);
    const skill = registry.registered[0]!;
    expect(skill.id).toBe('user/acme-mcp');
    expect(skill.scope).toBe('user');
    expect(skill.path).toBe(join(dir, 'acme-mcp.md'));
    expect(skill.frontmatter.name).toBe('acme-mcp');
    expect(skill.frontmatter['allowed-tools']).toEqual(['mcp__acme__fetch', 'mcp__acme__shell']);
    expect(skill.body).toContain('## Available tools');
  });

  it('is a no-op (returns null, no re-register) when a skill of that name already exists', async () => {
    const registry = fakeRegistry();
    const write = createMcpUsageSkillWriter({ skillRegistry: registry, userSkillsDir: dir });
    await write(server, DESCRIPTORS);
    expect(registry.registered).toHaveLength(1);
    // A second attach for the same server must not clobber user edits.
    const second = await write(server, DESCRIPTORS);
    expect(second).toBeNull();
    expect(registry.registered).toHaveLength(1);
  });

  it('still writes the file (and returns a result) with no skill registry', async () => {
    const write = createMcpUsageSkillWriter({ skillRegistry: null, userSkillsDir: dir });
    const result = await write(server, DESCRIPTORS);
    expect(result).not.toBeNull();
    const raw = await readFile(result!.path, 'utf8');
    expect(raw).toContain('name: acme-mcp');
  });

  it('reflects the tool count and lists every tool in allowed-tools + body', async () => {
    const many: ReadonlyArray<McpToolDescriptor> = Array.from({ length: 5 }, (_, i) => ({
      name: `t${i}`,
      description: `does ${i}`,
      inputSchema: { type: 'object' },
    }));
    const write = createMcpUsageSkillWriter({ skillRegistry: null, userSkillsDir: dir });
    const result = await write(server, many);
    const raw = await readFile(result!.path, 'utf8');
    const { fm, body } = parseFrontmatter(raw);
    expect(fm.description).toBe('Use the acme MCP server (5 tools).');
    expect((fm['allowed-tools'] as string[])).toHaveLength(5);
    expect((fm['allowed-tools'] as string[])[4]).toBe('mcp__acme__t4');
    expect(body).toContain('mcp__acme__t4` — does 4');
    // The description's defensive 240-char cap holds for normal inputs.
    expect((fm.description as string).length).toBeLessThanOrEqual(240);
  });
});
