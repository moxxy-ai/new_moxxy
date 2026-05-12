import { definePlugin, type Plugin } from '@moxxy/sdk';
import type { McpClientLike, McpPluginOptions, McpServerConfig } from './types.js';
import { wrapMcpServerTools } from './wrap.js';

export type {
  McpClientLike,
  McpContentBlock,
  McpPluginOptions,
  McpServerConfig,
  McpToolDescriptor,
  SseServerConfig,
  StdioServerConfig,
  StreamableHttpServerConfig,
} from './types.js';
export { wrapMcpServerTools } from './wrap.js';
export { defaultToolNamePrefix } from './types.js';
export {
  buildMcpAdminPlugin,
  buildMcpAdminPluginWithApi,
  mcpConfigPath,
  readMcpConfig,
  removeServerFromConfig,
  setServerDisabled,
  writeMcpConfig,
  type McpAdminApi,
  type McpStoredConfig,
  type McpStoredServer,
} from './admin.js';

export interface CreateMcpPluginOptions extends McpPluginOptions {
  /**
   * Inject a custom client factory. Used by tests; production code uses the
   * default factory that imports `@modelcontextprotocol/sdk`.
   */
  readonly clientFactory?: (server: McpServerConfig, options: McpPluginOptions) => Promise<McpClientLike>;
}

export async function createMcpPlugin(opts: CreateMcpPluginOptions): Promise<Plugin> {
  const factory = opts.clientFactory ?? defaultClientFactory;
  const clients: McpClientLike[] = [];
  const tools = [] as Awaited<ReturnType<typeof wrapMcpServerTools>>;

  for (const server of opts.servers) {
    const client = await factory(server, opts);
    clients.push(client);
    const wrapped = await wrapMcpServerTools({
      server,
      client,
      toolNamePrefix: opts.toolNamePrefix,
    });
    tools.push(...wrapped);
  }

  return definePlugin({
    name: '@moxxy/plugin-mcp',
    version: '0.0.0',
    tools,
    hooks: {
      onShutdown: async () => {
        await Promise.allSettled(clients.map((c) => c.close()));
      },
    },
  });
}

export async function defaultClientFactory(
  server: McpServerConfig,
  options: McpPluginOptions = { servers: [] },
): Promise<McpClientLike> {
  const { Client } = (await import('@modelcontextprotocol/sdk/client/index.js')) as {
    Client: new (info: { name: string; version: string }, capabilities: { capabilities: Record<string, unknown> }) => McpClientUntyped;
  };
  const client = new Client(
    { name: options.clientName ?? 'moxxy', version: options.clientVersion ?? '0.0.0' },
    { capabilities: {} },
  );

  const transport = await createTransport(server);
  await (client as unknown as McpClientUntyped).connect(transport);

  return {
    async listTools() {
      const result = await (client as unknown as McpClientUntyped).listTools();
      return { tools: (result.tools ?? []) as ReadonlyArray<{ name: string; description?: string; inputSchema: unknown }> };
    },
    async callTool(args) {
      const result = await (client as unknown as McpClientUntyped).callTool(args);
      return {
        content: result.content as ReadonlyArray<{ type: string } & Record<string, unknown>> | undefined,
        isError: result.isError as boolean | undefined,
      } as never;
    },
    async close() {
      await (client as unknown as McpClientUntyped).close();
    },
  };
}

interface McpClientUntyped {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools?: unknown[] }>;
  callTool(args: { name: string; arguments: unknown }): Promise<{ content?: unknown[]; isError?: boolean }>;
  close(): Promise<void>;
}

async function createTransport(server: McpServerConfig): Promise<unknown> {
  const kind: 'stdio' | 'sse' | 'http' = server.kind ?? 'stdio';
  if (kind === 'stdio') {
    const stdioServer = server as { command: string; args?: ReadonlyArray<string>; env?: Record<string, string>; cwd?: string };
    const { StdioClientTransport } = (await import('@modelcontextprotocol/sdk/client/stdio.js')) as {
      StdioClientTransport: new (config: {
        command: string;
        args?: string[];
        env?: Record<string, string>;
        cwd?: string;
        stderr?: 'inherit' | 'pipe' | 'ignore' | 'overlapped' | number;
      }) => unknown;
    };
    // Set stderr to 'ignore' so spawned subprocesses (mcp-remote, etc.)
    // don't dump their boot logs into the moxxy TUI. The SDK defaults
    // to 'inherit' which clobbers the chat with proxy-status lines on
    // every boot. Set MOXXY_MCP_STDERR=inherit to opt back in for
    // debugging.
    const stderrMode: 'inherit' | 'ignore' =
      process.env.MOXXY_MCP_STDERR === 'inherit' ? 'inherit' : 'ignore';
    return new StdioClientTransport({
      command: stdioServer.command,
      args: stdioServer.args ? [...stdioServer.args] : undefined,
      env: stdioServer.env,
      cwd: stdioServer.cwd,
      stderr: stderrMode,
    });
  }
  const httpish = server as { url: string; headers?: Record<string, string> };
  if (kind === 'sse') {
    const { SSEClientTransport } = (await import('@modelcontextprotocol/sdk/client/sse.js')) as {
      SSEClientTransport: new (url: URL, opts?: { requestInit?: { headers?: Record<string, string> } }) => unknown;
    };
    return new SSEClientTransport(new URL(httpish.url), {
      requestInit: httpish.headers ? { headers: httpish.headers } : undefined,
    });
  }
  const { StreamableHTTPClientTransport } = (await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  )) as {
    StreamableHTTPClientTransport: new (url: URL, opts?: { requestInit?: { headers?: Record<string, string> } }) => unknown;
  };
  return new StreamableHTTPClientTransport(new URL(httpish.url), {
    requestInit: httpish.headers ? { headers: httpish.headers } : undefined,
  });
}
