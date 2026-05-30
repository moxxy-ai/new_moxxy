import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { writeMcpConfig } from '../config-io.js';
import { buildListServersTool } from './list.js';

describe('mcp_list_servers', () => {
  it('returns full persisted server details so GUI actions can test existing servers', async () => {
    const home = await mkdtemp(join(tmpdir(), 'moxxy-mcp-list-'));
    vi.stubEnv('HOME', home);
    try {
      await writeMcpConfig({
        servers: [
          {
            name: 'filesystem',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem'],
            env: { NODE_ENV: 'test' },
            cwd: '/tmp/project',
          },
          {
            name: 'docs',
            kind: 'http',
            url: 'https://mcp.example.test/mcp',
            headers: { Authorization: 'Bearer token' },
            disabled: true,
          },
        ],
      });

      const output = await buildListServersTool().handler({}, {} as never);

      expect(output).toEqual([
        {
          name: 'filesystem',
          kind: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
          env: { NODE_ENV: 'test' },
          cwd: '/tmp/project',
          disabled: false,
        },
        {
          name: 'docs',
          kind: 'http',
          url: 'https://mcp.example.test/mcp',
          headers: { Authorization: 'Bearer token' },
          disabled: true,
        },
      ]);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });
});
