import { describe, expect, it } from 'vitest';
import { buildInstallPluginTool } from './install.js';

describe('install_plugin tool', () => {
  const noopDeps = {
    reload: async (): Promise<void> => undefined,
    snapshot: () => ({
      tools: [],
      agents: [],
      providers: [],
      loops: [],
      compactors: [],
      channels: [],
    }),
  };

  it('validates package name format', async () => {
    const tool = buildInstallPluginTool(noopDeps);
    const result = tool.inputSchema.safeParse({ packageName: 'NOT VALID NAME' });
    expect(result.success).toBe(false);
  });

  it('accepts a scoped package', () => {
    const tool = buildInstallPluginTool(noopDeps);
    const result = tool.inputSchema.safeParse({ packageName: '@moxxy/agent-researcher' });
    expect(result.success).toBe(true);
  });

  it('accepts an optional version', () => {
    const tool = buildInstallPluginTool(noopDeps);
    const result = tool.inputSchema.safeParse({
      packageName: '@moxxy/agent-researcher',
      version: '1.2.3',
    });
    expect(result.success).toBe(true);
  });
});
