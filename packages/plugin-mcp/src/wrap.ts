import { z } from 'zod';
import { defineTool, type ToolDef } from '@moxxy/sdk';
import {
  defaultToolNamePrefix,
  type McpClientLike,
  type McpContentBlock,
  type McpServerConfig,
  type McpToolDescriptor,
} from './types.js';

/**
 * Hard cap on a single MCP tool call. The MCP SDK's `callTool` doesn't
 * accept an AbortSignal, so without a timeout a hung server (crashed
 * stdio child, dead websocket, blocked DB query) would hang the agent's
 * tool-use loop indefinitely — leaving a permanent pending dot in the UI
 * with no way to recover without killing moxxy. 5 minutes is enough room
 * for slow operations (image generation, large queries) but bounded.
 */
const MCP_CALL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Race the MCP call against (1) abort and (2) a hard timeout. Whichever
 * settles first wins. If the underlying callTool ever does resolve after
 * we've rejected, its result is silently discarded — the MCP SDK's
 * cleanup is the SDK's problem.
 */
async function runMcpCallWithFallback<T>(
  callPromise: Promise<T>,
  signal: AbortSignal,
  toolName: string,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = (): void => {
      settle(() => reject(new Error(`aborted MCP tool "${toolName}"`)));
    };
    const timer = setTimeout(() => {
      settle(() =>
        reject(new Error(`MCP tool "${toolName}" timed out after ${MCP_CALL_TIMEOUT_MS}ms`)),
      );
    }, MCP_CALL_TIMEOUT_MS);
    signal.addEventListener('abort', onAbort, { once: true });
    callPromise.then(
      (v) => settle(() => resolve(v)),
      (err: unknown) => settle(() => reject(err instanceof Error ? err : new Error(String(err)))),
    );
  });
}

export interface WrapOptions {
  readonly server: McpServerConfig;
  readonly client: McpClientLike;
  readonly toolNamePrefix?: (serverName: string, toolName: string) => string;
}

export async function wrapMcpServerTools(opts: WrapOptions): Promise<ToolDef[]> {
  const prefix = opts.toolNamePrefix ?? defaultToolNamePrefix;
  const list = await opts.client.listTools();
  return list.tools.map((descriptor) => wrapOneTool(descriptor, opts.server.name, opts.client, prefix));
}

/**
 * Build ToolDefs from CACHED descriptors without an open client. The
 * provided `getClient` factory is invoked the first time any tool runs;
 * the promise is cached so subsequent calls reuse the same connection.
 * Enables instant TUI boot — connections only happen when the model
 * actually invokes a tool from a given MCP server.
 */
export interface WrapLazyOptions {
  readonly server: McpServerConfig;
  readonly descriptors: ReadonlyArray<McpToolDescriptor>;
  readonly getClient: () => Promise<McpClientLike>;
  readonly toolNamePrefix?: (serverName: string, toolName: string) => string;
}

export function wrapMcpServerToolsLazy(opts: WrapLazyOptions): ToolDef[] {
  const prefix = opts.toolNamePrefix ?? defaultToolNamePrefix;
  return opts.descriptors.map((descriptor) =>
    wrapOneLazyTool(descriptor, opts.server.name, opts.getClient, prefix),
  );
}

function wrapOneLazyTool(
  descriptor: McpToolDescriptor,
  serverName: string,
  getClient: () => Promise<McpClientLike>,
  prefix: (s: string, t: string) => string,
): ToolDef {
  const wrappedName = prefix(serverName, descriptor.name);
  return defineTool({
    name: wrappedName,
    description: descriptor.description ?? `MCP tool ${descriptor.name} on server ${serverName}`,
    inputSchema: z.record(z.string(), z.unknown()),
    inputJsonSchema: descriptor.inputSchema ?? { type: 'object' },
    permission: { action: 'prompt' },
    handler: async (input, ctx) => {
      if (ctx.signal.aborted) throw new Error('aborted');
      // Lazy connection — pays the network/spawn cost only on first
      // call. Subsequent calls reuse the cached client.
      const client = await getClient();
      if (ctx.signal.aborted) throw new Error('aborted');
      const result = await runMcpCallWithFallback(
        client.callTool({ name: descriptor.name, arguments: input }),
        ctx.signal,
        wrappedName,
      );
      return renderResult(result.content, result.isError);
    },
  });
}

function wrapOneTool(
  descriptor: McpToolDescriptor,
  serverName: string,
  client: McpClientLike,
  prefix: (s: string, t: string) => string,
): ToolDef {
  const wrappedName = prefix(serverName, descriptor.name);
  return defineTool({
    name: wrappedName,
    description: descriptor.description ?? `MCP tool ${descriptor.name} on server ${serverName}`,
    inputSchema: z.record(z.string(), z.unknown()),
    inputJsonSchema: descriptor.inputSchema ?? { type: 'object' },
    permission: { action: 'prompt' },
    handler: async (input, ctx) => {
      if (ctx.signal.aborted) throw new Error('aborted');
      const result = await runMcpCallWithFallback(
        client.callTool({ name: descriptor.name, arguments: input }),
        ctx.signal,
        wrappedName,
      );
      return renderResult(result.content, result.isError);
    },
  });
}

function renderResult(content: ReadonlyArray<McpContentBlock> | undefined, isError?: boolean): string {
  const parts: string[] = [];
  for (const block of content ?? []) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'image') parts.push(`[image:${block.mimeType}]`);
    else if (block.type === 'resource') parts.push(`[resource]`);
  }
  const text = parts.join('\n');
  return isError ? `[error] ${text}` : text;
}
