import type { EventLogReader, SubagentSpawner, ToolContext, ToolDef } from '@moxxy/sdk';
import type { Logger } from '../logger.js';
import { asToolCallId, asSessionId, asTurnId } from '@moxxy/sdk';
import { assertRequirementsReady, type RequirementChecker } from '../requirements.js';

export interface ToolRegistry {
  list(): ReadonlyArray<ToolDef>;
  get(name: string): ToolDef | undefined;
  has(name: string): boolean;
  register(tool: ToolDef): void;
  unregister(name: string): void;
  setRequirementChecker(checker: RequirementChecker): void;
  execute(name: string, input: unknown, signal: AbortSignal, opts?: ExecuteOptions): Promise<unknown>;
}

interface ExecuteOptions {
  readonly callId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly log?: EventLogReader;
  readonly logger?: Logger;
  readonly cwd?: string;
  /**
   * Optional spawner — passed by run-turn so multi-agent tools (e.g.
   * `dispatch_agent`) can fan work out from inside the tool-use loop.
   * Plain `tools.execute()` callers (tests, one-off scripts) may omit it.
   */
  readonly subagents?: SubagentSpawner;
}

export class ToolRegistryImpl implements ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();
  private readonly defaultLogger: Logger;
  private readonly defaultCwd: string;
  private requirementChecker?: RequirementChecker;

  constructor(opts: { logger: Logger; cwd: string }) {
    this.defaultLogger = opts.logger;
    this.defaultCwd = opts.cwd;
  }

  list(): ReadonlyArray<ToolDef> {
    return [...this.tools.values()];
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  setRequirementChecker(checker: RequirementChecker): void {
    this.requirementChecker = checker;
  }

  register(tool: ToolDef): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  async execute(
    name: string,
    input: unknown,
    signal: AbortSignal,
    opts: ExecuteOptions = {},
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    assertRequirementsReady(`tool: ${tool.name}`, tool.requirements, this.requirementChecker);
    // Use safeParse so a validation failure surfaces as a clean,
    // single-line error in the tool_result instead of the raw ZodError
    // (which JSON-stringifies into 20+ lines of red noise — observed
    // with memory_save and synthesize_skill). The formatted message tells
    // the model exactly which fields are off and why, so it can retry.
    const parseResult = tool.inputSchema.safeParse(input);
    if (!parseResult.success) {
      const issues = parseResult.error.issues
        .map((iss) => {
          const path = iss.path.length ? iss.path.join('.') : '(root)';
          return `${path}: ${iss.message}`;
        })
        .join('; ');
      throw new Error(`Invalid input for ${name}: ${issues}`);
    }
    const parsed = parseResult.data;

    const ctx: ToolContext = {
      sessionId: asSessionId(opts.sessionId ?? 'no-session'),
      turnId: asTurnId(opts.turnId ?? 'no-turn'),
      callId: asToolCallId(opts.callId ?? 'no-call'),
      cwd: opts.cwd ?? this.defaultCwd,
      signal,
      log: opts.log ?? emptyLog(),
      logger: opts.logger ?? this.defaultLogger,
      ...(opts.subagents ? { subagents: opts.subagents } : {}),
    };

    const result = await tool.handler(parsed, ctx);
    if (tool.outputSchema) return tool.outputSchema.parse(result);
    return result;
  }
}

function emptyLog(): EventLogReader {
  return {
    length: 0,
    at: () => undefined,
    slice: () => [],
    ofType: () => [],
    byTurn: () => [],
    toJSON: () => [],
  };
}
