import type { z } from 'zod';
import type { EventLogReader } from './log.js';
import type { PermissionRule } from './permission.js';
import type { SessionId, ToolCallId, TurnId } from './ids.js';
import type { SubagentSpawner } from './subagent.js';
import type { ToolIsolationSpec } from './isolation.js';
import type { MoxxyRequirement } from './requirements.js';

/**
 * Capability-mediated filesystem operations injected by isolators that
 * support brokering. Handlers can opt in by checking `ctx.fs` at runtime
 * and using these instead of `node:fs`; the broker validates each call
 * against the tool's declared `caps.fs` spec on the parent side before
 * executing.
 *
 * When `ctx.fs` is undefined (the `none`/`inproc` paths today, or any
 * isolator that hasn't implemented a broker yet), handlers fall back to
 * unmediated direct fs access.
 */
export interface BrokeredFs {
  /** Read a UTF-8 file. Throws if the path is outside `caps.fs.read`. */
  readFile(filePath: string, opts?: { encoding?: BufferEncoding }): Promise<string>;
  /** Write a UTF-8 file (creates parent dirs). Throws if outside `caps.fs.write`. */
  writeFile(filePath: string, data: string): Promise<void>;
  /** List entries in a directory. Throws if outside `caps.fs.read`. */
  readdir(dirPath: string): Promise<ReadonlyArray<string>>;
  /** Stat a path. Throws if outside `caps.fs.read`. */
  stat(filePath: string): Promise<BrokeredStat>;
}

export interface BrokeredStat {
  readonly size: number;
  readonly mtimeMs: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

/**
 * Capability-mediated `fetch`. Same shape as the global, but validated
 * against `caps.net` on the parent side before the socket is opened.
 *
 * Returns a plain JSON-serializable response shape rather than the
 * standard `Response` object — that's the price of crossing a process
 * boundary cleanly.
 */
export interface BrokeredFetch {
  (url: string, init?: BrokeredFetchInit): Promise<BrokeredFetchResponse>;
}

export interface BrokeredFetchInit {
  readonly method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface BrokeredFetchResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * Capability-mediated subprocess `exec`. Validated against `caps.subprocess`
 * (must be true) and optional `caps.commands` allowlist on the parent side.
 * Collects stdout/stderr and the exit code; for streaming use cases the
 * broker layer will grow a separate streaming variant later.
 */
export interface BrokeredExec {
  (
    command: string,
    args?: ReadonlyArray<string>,
    opts?: BrokeredExecOpts,
  ): Promise<BrokeredExecResult>;
}

export interface BrokeredExecOpts {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface BrokeredExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

export interface ToolContext {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly callId: ToolCallId;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly log: EventLogReader;
  readonly logger: {
    debug(msg: string, meta?: Record<string, unknown>): void;
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
  /**
   * Spawner for child agents — present when the tool was invoked inside
   * a run-turn loop (the normal case). Tools that fan work out (e.g.
   * `dispatch_agent`) call `subagents.spawn(...)` to start a focused
   * child loop and stream its events back to the parent log.
   */
  readonly subagents?: SubagentSpawner;
  /**
   * Capability-mediated filesystem ops. Present only when the active
   * isolator implements a broker (currently `@moxxy/isolator-worker`).
   * Handlers that use this get their fs access checked against
   * `caps.fs` at every call, regardless of whether the path appeared
   * in the validated input. Absent → handler is on its own for fs
   * access (today's behavior).
   */
  readonly fs?: BrokeredFs;
  /**
   * Capability-mediated network. Present only when the active
   * isolator implements a broker. Validates every URL against
   * `caps.net` on the parent side. Returns a serializable response
   * shape so the same value crosses a process boundary intact.
   */
  readonly fetch?: BrokeredFetch;
  /**
   * Capability-mediated subprocess execution. Present only when the
   * active isolator implements a broker. Validated against
   * `caps.subprocess` + optional `caps.commands` allowlist.
   */
  readonly exec?: BrokeredExec;
}

/**
 * Optional presentation hint for compact rendering in TUI/chat surfaces.
 * When present, the channel may aggregate consecutive calls of this tool
 * into one "live block" with a verb+count summary, rather than rendering
 * each call separately. Opting in is per-tool: noisy small-output tools
 * (Read, Grep, Glob, Edit) benefit; tools with rich output (Bash,
 * dispatch_agent) generally don't.
 *
 * Channels MAY ignore this hint — it's purely presentational. The event
 * log and provider serialization don't see it.
 */
export interface ToolCompactPresentation {
  /** Present-participle verb used in summary, e.g. "Reading", "Searching for". */
  readonly verb: string;
  /** Noun for the count, pluralized e.g. `{ one: 'file', other: 'files' }`. */
  readonly noun: { readonly one: string; readonly other: string };
  /** Input field whose value previews the latest call (the line under the summary).
   *  e.g. `"file_path"` for Read so the preview shows the file just read. */
  readonly previewKey?: string;
}

export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly requirements?: ReadonlyArray<MoxxyRequirement>;
  readonly inputSchema: z.ZodTypeAny;
  /**
   * Optional native JSON Schema. When present, providers serializing tools to
   * their API should use this instead of converting `inputSchema` via zod.
   * Useful for tools originating from external systems (e.g., MCP) that already
   * carry a JSON Schema and where zod conversion would be lossy.
   */
  readonly inputJsonSchema?: unknown;
  readonly outputSchema?: z.ZodTypeAny;
  readonly permission?: PermissionRule;
  readonly handler: (input: unknown, ctx: ToolContext) => Promise<unknown> | unknown;
  /** Opt-in presentation hint. See `ToolCompactPresentation`. */
  readonly compact?: ToolCompactPresentation;
  /**
   * Optional capability declaration. Advisory unless the user enables
   * `@moxxy/plugin-security`, at which point the active `Isolator`
   * enforces these bounds at every call. See `ToolIsolationSpec`.
   */
  readonly isolation?: ToolIsolationSpec;
}
