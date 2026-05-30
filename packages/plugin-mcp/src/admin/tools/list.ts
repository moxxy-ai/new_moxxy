import { defineTool, z, type ToolDef } from '@moxxy/sdk';
import { readMcpConfig } from '../config-io.js';

export function buildListServersTool(): ToolDef {
  return defineTool({
    name: 'mcp_list_servers',
    description:
      'List every MCP server currently registered in ~/.moxxy/mcp.json. Returns name + transport kind + connection details (command/url) for each.',
    inputSchema: z.object({}),
    handler: async () => {
      const cfg = await readMcpConfig();
      return cfg.servers.map((s) => {
        const base = {
          name: s.name,
          disabled: s.disabled === true,
        };
        if (s.kind === 'http' || s.kind === 'sse') {
          return {
            ...base,
            kind: s.kind,
            url: s.url,
            ...(s.headers ? { headers: s.headers } : {}),
          };
        }
        return {
          ...base,
          kind: 'stdio' as const,
          command: s.command,
          ...(s.args ? { args: s.args } : {}),
          ...(s.env ? { env: s.env } : {}),
          ...(s.cwd ? { cwd: s.cwd } : {}),
        };
      });
    },
  });
}
