import { EventLog } from '@moxxy/core';
import { asSkillId, z } from '@moxxy/sdk';
import type {
  AgentsClientView,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolver,
  ClientSession,
  CommandDef,
  CommandInfo,
  CommandsClientView,
  LLMProvider,
  ModeDef,
  ModelDescriptor,
  ModesClientView,
  MoxxyEvent,
  PermissionContext,
  PermissionDecision,
  PendingToolCall,
  PermissionResolver,
  PermissionsClientView,
  ProviderDef,
  ProviderInfo,
  ProvidersClientView,
  RequirementsClientView,
  RunTurnOptions,
  ScheduleCreateInput,
  ScheduleListOptions,
  SchedulerView,
  ScheduleUpdateInput,
  SessionId,
  SessionInfo,
  SessionLogReader,
  Skill,
  SkillInfo,
  SkillsClientView,
  ToolDef,
  ToolInfo,
  ToolsClientView,
  Transcriber,
  TranscribersClientView,
  TranscriptionResult,
  TurnId,
} from '@moxxy/sdk';
import { JsonRpcPeer } from './jsonrpc.js';
import type { Transport } from './transport.js';
import { connectUnixSocket } from './unix-socket.js';
import { runnerSocketPath } from './socket-path.js';
import {
  RUNNER_PROTOCOL_VERSION,
  RunnerMethod,
  RunnerNotification,
  type ApprovalConfirmParams,
  type AttachResult,
  type EventNotification,
  type InfoChangedNotification,
  type PermissionCheckParams,
  type RunTurnResult,
  type SchedulerCreateResult,
  type SchedulerDeleteResult,
  type SchedulerListResult,
  type SchedulerRunNowResult,
  type SchedulerSetEnabledResult,
  type SchedulerUpdateResult,
  type TurnCompleteNotification,
} from './protocol.js';

/**
 * Per-turn event pump. The notification handler feeds it; `runTurn` drains it.
 * De-dupes by seq so the "replay what's already mirrored" priming and the live
 * stream can't double-emit the same event.
 */
class TurnStream {
  private readonly queue: MoxxyEvent[] = [];
  private readonly waiters: Array<() => void> = [];
  private readonly seen = new Set<number>();
  private done = false;
  private error: string | undefined;

  push(event: MoxxyEvent): void {
    if (this.seen.has(event.seq)) return;
    this.seen.add(event.seq);
    this.queue.push(event);
    this.wake();
  }

  finish(error?: string): void {
    if (this.done) return;
    this.done = true;
    this.error = error;
    this.wake();
  }

  private wake(): void {
    this.waiters.shift()?.();
  }

  async *iterate(): AsyncIterable<MoxxyEvent> {
    while (true) {
      while (this.queue.length > 0) yield this.queue.shift() as MoxxyEvent;
      if (this.done) break;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    if (this.error) throw new Error(this.error);
  }
}

export interface RemoteSessionOptions {
  readonly socketPath?: string;
  /** Channel role attaching, for the runner's logs. */
  readonly role?: string;
  /** Replay history from this seq (default 0 = full conversation). */
  readonly sinceSeq?: number;
  /** Inject a transport (tests). Defaults to a unix-socket connection. */
  readonly transport?: Transport;
  /**
   * Retry the initial connect this many times (default 5) with linear backoff,
   * smoothing over the race where the runner is up per `isRunnerUp()` but the
   * socket isn't quite accepting yet (or is mid-restart).
   */
  readonly connectRetries?: number;
}

/**
 * Client-side proxy implementing {@link SessionLike} against a remote runner.
 * A channel handed a `RemoteSession` behaves exactly as if it held a local
 * `Session` - that interchangeability is the whole point of the split.
 *
 * State lives on the runner; this keeps a local mirror of the event log (fed
 * by the broadcast stream + an attach-time replay) so reads and `subscribe`
 * are instant, and proxies the rest over JSON-RPC. The runner calls *back* for
 * permission/approval decisions, which we answer from the resolvers a channel
 * installs.
 */
export class RemoteSession implements ClientSession {
  private readonly peer: JsonRpcPeer;
  private readonly mirror = new EventLog();
  private readonly turnStreams = new Map<TurnId, TurnStream>();
  // Registry facades - snapshot-backed reads, RPC-backed mutations. Assigned
  // in the constructor so each closes over `this` and re-reads `this.info`.
  readonly providers: ProvidersClientView;
  readonly modes: ModesClientView;
  readonly tools: ToolsClientView;
  readonly commands: CommandsClientView;
  readonly skills: SkillsClientView;
  readonly agents: AgentsClientView;
  readonly transcribers: TranscribersClientView;
  readonly requirements: RequirementsClientView;
  readonly permissions: PermissionsClientView;
  readonly scheduler: SchedulerView;
  /**
   * Turns that completed before their `runTurn` stream was registered. A fast
   * turn can finish on the runner before the client processes the `runTurn`
   * reply, so the `turn.complete` notification arrives with no stream to
   * finish. We record it here and apply it the moment the stream registers -
   * otherwise the stream would hang forever. Maps turnId -> error (or
   * undefined for a clean finish).
   */
  private readonly completedTurns = new Map<TurnId, string | undefined>();
  private permissionResolver: PermissionResolver | null = null;
  private approvalResolver: ApprovalResolver | null = null;
  private info: SessionInfo | null = null;

  constructor(transport: Transport) {
    this.peer = new JsonRpcPeer(transport);

    // Server->client notifications.
    this.peer.on(RunnerNotification.Event, (params) => {
      const { event } = params as EventNotification;
      this.mirror.ingest(event);
      this.turnStreams.get(event.turnId)?.push(event);
    });
    this.peer.on(RunnerNotification.TurnComplete, (params) => {
      const { turnId, error } = params as TurnCompleteNotification;
      const stream = this.turnStreams.get(turnId as TurnId);
      if (stream) stream.finish(error);
      // Record regardless: the stream may not be registered yet (fast turn).
      else this.completedTurns.set(turnId as TurnId, error);
    });
    this.peer.on(RunnerNotification.InfoChanged, (params) => {
      this.info = (params as InfoChangedNotification).info;
    });

    // Server->client requests (the runner asks us to decide).
    this.peer.handle(RunnerMethod.PermissionCheck, (params) => {
      const { call, ctx } = params as PermissionCheckParams;
      if (!this.permissionResolver) {
        return { mode: 'deny', reason: 'no permission resolver on client' } satisfies PermissionDecision;
      }
      return this.permissionResolver.check(call as PendingToolCall, ctx as PermissionContext);
    });
    this.peer.handle(RunnerMethod.ApprovalConfirm, (params) => {
      const { request } = params as ApprovalConfirmParams;
      if (!this.approvalResolver) return defaultApproval(request);
      return this.approvalResolver.confirm(request);
    });

    // If the runner dies, fail any in-flight turns rather than hanging.
    this.peer.onClose(() => {
      for (const stream of this.turnStreams.values()) stream.finish('runner disconnected');
      this.turnStreams.clear();
    });

    this.providers = this.makeProvidersView();
    this.modes = this.makeModesView();
    this.tools = this.makeToolsView();
    this.commands = this.makeCommandsView();
    this.skills = this.makeSkillsView();
    this.agents = { list: () => [] };
    this.transcribers = this.makeTranscribersView();
    this.requirements = { check: () => ({ ready: false, issues: [] }) };
    this.permissions = this.makePermissionsView();
    this.scheduler = this.makeSchedulerView();
  }

  /**
   * Providers the runner has activated. Exposed as a plain field (the TUI
   * model-picker reads it via a structural cast, same as it does on a local
   * Session) so switching models isn't blocked by an empty "ready" set.
   */
  get readyProviders(): Set<string> {
    return new Set(this.info?.readyProviders ?? []);
  }

  /** Handshake. Resolves once history has been replayed into the mirror. */
  async attach(role: string, sinceSeq: number): Promise<void> {
    const result = await this.peer.request<AttachResult>(RunnerMethod.Attach, {
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      role,
      sinceSeq,
    });
    this.info = result.info;
  }

  get id(): SessionId {
    return this.requireInfo().sessionId;
  }

  get cwd(): string {
    return this.requireInfo().cwd;
  }

  get log(): SessionLogReader & { clear(): void } {
    // The mirror is a local EventLog - `clear()` resets THIS client's view
    // (used by /new) without touching the runner's shared history.
    return this.mirror;
  }

  getInfo(): SessionInfo {
    return this.requireInfo();
  }

  async *runTurn(prompt: string, opts: RunTurnOptions = {}): AsyncIterable<MoxxyEvent> {
    const result = await this.peer.request<RunTurnResult>(RunnerMethod.RunTurn, {
      prompt,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
      ...(opts.maxIterations ? { maxIterations: opts.maxIterations } : {}),
      ...(opts.attachments && opts.attachments.length > 0 ? { attachments: opts.attachments } : {}),
    });
    const turnId = result.turnId as TurnId;

    const stream = new TurnStream();
    this.turnStreams.set(turnId, stream);
    // Prime with anything already mirrored for this turn - a fast turn can land
    // events (and even complete) before this reply was processed.
    for (const event of this.mirror.byTurn(turnId)) stream.push(event);
    if (this.completedTurns.has(turnId)) {
      stream.finish(this.completedTurns.get(turnId));
      this.completedTurns.delete(turnId);
    }

    const onAbort = (): void => {
      void this.peer.request(RunnerMethod.Abort, { turnId }).catch(() => undefined);
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      yield* stream.iterate();
    } finally {
      this.turnStreams.delete(turnId);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  setPermissionResolver(resolver: PermissionResolver): void {
    this.permissionResolver = resolver;
    void this.peer.request(RunnerMethod.SetResolver, { permission: true }).catch(() => undefined);
  }

  setApprovalResolver(resolver: ApprovalResolver | null): void {
    this.approvalResolver = resolver;
    void this.peer
      .request(RunnerMethod.SetResolver, { approval: resolver != null })
      .catch(() => undefined);
  }

  async close(_reason?: string): Promise<void> {
    this.peer.close();
  }

  /**
   * Register a callback for when the link to the runner drops (runner stopped,
   * crashed, or socket closed). Channels use this to surface a disconnect and
   * exit cleanly rather than hang on a dead session. Fires at most once.
   */
  onClose(handler: () => void): void {
    this.peer.onClose(() => handler());
  }

  /** False once the runner link has dropped. */
  get connected(): boolean {
    return !this.peer.isClosed;
  }

  private requireInfo(): SessionInfo {
    if (!this.info) throw new Error('RemoteSession not attached yet - call connectRemoteSession()');
    return this.info;
  }

  // --- registry facades ----------------------------------------------------

  private makeProvidersView(): ProvidersClientView {
    return {
      getActive: () => {
        const info = this.requireInfo();
        const name = info.activeProvider ?? info.providers[0]?.name ?? 'unknown';
        return fakeProvider(name, info.providers.find((p) => p.name === name)?.models ?? []);
      },
      getActiveName: () => this.requireInfo().activeProvider,
      list: () => this.requireInfo().providers.map(fakeProviderDef),
      setActive: (name, config) => {
        void this.peer
          .request(RunnerMethod.ProviderSetActive, { name, ...(config ? { config } : {}) })
          .catch(() => undefined);
        const models = this.requireInfo().providers.find((p) => p.name === name)?.models ?? [];
        return fakeProvider(name, models);
      },
      // Provider re-instantiation happens server-side as part of setActive.
      replace: () => undefined,
    };
  }

  private makeModesView(): ModesClientView {
    return {
      list: () => this.requireInfo().modes.map(fakeMode),
      getActive: () => fakeMode(this.requireInfo().activeMode ?? 'unknown'),
      setActive: (name) => {
        void this.peer.request(RunnerMethod.ModeSetActive, { name }).catch(() => undefined);
      },
    };
  }

  private makeToolsView(): ToolsClientView {
    return {
      list: () => this.requireInfo().tools.map(fakeTool),
      get: (name) => {
        const info = this.requireInfo().tools.find((t) => t.name === name);
        return info ? fakeTool(info) : undefined;
      },
    };
  }

  private makeCommandsView(): CommandsClientView {
    const build = (info: CommandInfo): CommandDef => ({
      name: info.name,
      description: info.description,
      ...(info.aliases ? { aliases: info.aliases } : {}),
      ...(info.channels ? { channels: info.channels } : {}),
      ...(info.pendingNotice ? { pendingNotice: info.pendingNotice } : {}),
      // Execute the real command on the runner and apply its result locally.
      handler: (ctx) =>
        this.peer.request(RunnerMethod.CommandRun, {
          name: info.name,
          args: ctx.args,
          channel: ctx.channel,
        }),
    });
    return {
      get: (name) => {
        const info = this.requireInfo().commands.find(
          (c) => c.name === name || c.aliases?.includes(name),
        );
        return info ? build(info) : undefined;
      },
      listForChannel: (channel) =>
        this.requireInfo()
          .commands.filter((c) => !c.channels || c.channels.includes(channel))
          .map(build),
    };
  }

  private makeSkillsView(): SkillsClientView {
    return { list: () => this.requireInfo().skills.map(fakeSkill) };
  }

  private makeTranscribersView(): TranscribersClientView {
    // Transcription is a server-side capability; a thin client routes audio
    // through runTurn attachments instead. Report "none" so voice degrades
    // gracefully rather than pretending to have a local backend.
    // When the runner has an active transcriber, expose a proxy whose
    // transcribe() ships the audio to the runner over the `transcribe` RPC.
    // Channel code (`tryGetActive()?.transcribe(bytes)`) is unchanged - audio
    // input "just works" while attached, transcribed server-side.
    const proxy = (): Transcriber => ({
      name: this.info?.activeTranscriber ?? 'runner',
      transcribe: (audio, opts) => {
        const bytes = audio instanceof ArrayBuffer ? new Uint8Array(audio) : audio;
        return this.peer.request<TranscriptionResult>(RunnerMethod.Transcribe, {
          audio: Buffer.from(bytes).toString('base64'),
          ...(opts?.mimeType ? { mimeType: opts.mimeType } : {}),
          ...(opts?.language ? { language: opts.language } : {}),
          ...(opts?.prompt ? { prompt: opts.prompt } : {}),
        });
      },
    });
    return {
      getActiveName: () => this.info?.activeTranscriber ?? null,
      has: (name) => name === this.info?.activeTranscriber,
      getActive: () => {
        if (!this.info?.activeTranscriber) {
          throw new Error('no active transcriber on the runner');
        }
        return proxy();
      },
      tryGetActive: () => (this.info?.activeTranscriber ? proxy() : null),
      setActive: () => {
        throw new Error('switch the active transcriber on the runner, not the attached client');
      },
    };
  }

  private makePermissionsView(): PermissionsClientView {
    return {
      addAllow: async (rule) => {
        await this.peer
          .request(RunnerMethod.PermissionAddAllow, {
            name: rule.name,
            ...(rule.reason ? { reason: rule.reason } : {}),
          })
          .catch(() => undefined);
      },
    };
  }

  private makeSchedulerView(): SchedulerView {
    return {
      list: (options: ScheduleListOptions = {}) =>
        this.peer.request<SchedulerListResult>(RunnerMethod.SchedulerList, options),
      create: (input: ScheduleCreateInput) =>
        this.peer.request<SchedulerCreateResult>(RunnerMethod.SchedulerCreate, input),
      update: (id: string, input: ScheduleUpdateInput) =>
        this.peer.request<SchedulerUpdateResult>(RunnerMethod.SchedulerUpdate, { id, input }),
      setEnabled: (id: string, enabled: boolean) =>
        this.peer.request<SchedulerSetEnabledResult>(RunnerMethod.SchedulerSetEnabled, {
          id,
          enabled,
        }),
      delete: (id: string) =>
        this.peer.request<SchedulerDeleteResult>(RunnerMethod.SchedulerDelete, { id }),
      runNow: (id: string) =>
        this.peer.request<SchedulerRunNowResult>(RunnerMethod.SchedulerRunNow, { id }),
    };
  }
}

// --- snapshot -> display-object reconstruction --------------------------------
// The TUI reads display fields off these; behavioral fields (stream, run,
// handler, inputSchema) are stubbed because that work lives on the runner.

function fakeProvider(name: string, models: ReadonlyArray<ModelDescriptor>): LLMProvider {
  return {
    name,
    models,
    stream() {
      throw new Error('provider streaming runs on the runner');
    },
    async countTokens() {
      throw new Error('token counting runs on the runner');
    },
  };
}

function fakeProviderDef(info: ProviderInfo): ProviderDef {
  return {
    name: info.name,
    models: info.models,
    createClient: () => fakeProvider(info.name, info.models),
  };
}

function fakeMode(name: string): ModeDef {
  return {
    name,
    run() {
      throw new Error('modes run on the runner');
    },
  };
}

function fakeTool(info: ToolInfo): ToolDef {
  return {
    name: info.name,
    description: info.description,
    inputSchema: z.any(),
    ...(info.compact ? { compact: info.compact } : {}),
    handler() {
      throw new Error('tools execute on the runner');
    },
  };
}

function fakeSkill(info: SkillInfo): Skill {
  return {
    id: asSkillId(info.id),
    path: '',
    scope: 'plugin',
    frontmatter: { name: info.name, description: '' },
    body: '',
  };
}

function defaultApproval(request: ApprovalRequest): ApprovalDecision {
  return { optionId: request.defaultOptionId ?? request.options[0]?.id ?? '' };
}

/**
 * Connect to a running runner and return an attached {@link RemoteSession}.
 * Throws if no runner is listening (callers decide whether to self-host).
 */
export async function connectRemoteSession(
  opts: RemoteSessionOptions = {},
): Promise<RemoteSession> {
  const transport =
    opts.transport ??
    (await connectWithRetry(opts.socketPath ?? runnerSocketPath(), opts.connectRetries ?? 5));
  const session = new RemoteSession(transport);
  await session.attach(opts.role ?? 'client', opts.sinceSeq ?? 0);
  return session;
}

/** Connect, retrying with linear backoff to ride over a brief runner hiccup. */
async function connectWithRetry(socketPath: string, attempts: number): Promise<Transport> {
  let lastErr: unknown;
  for (let i = 0; i <= attempts; i++) {
    try {
      return await connectUnixSocket(socketPath);
    } catch (err) {
      lastErr = err;
      if (i < attempts) await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
  throw lastErr;
}
