import { AsyncLocalStorage } from 'node:async_hooks';
import type { Session } from '@moxxy/core';
import { newTurnId } from '@moxxy/core';
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolver,
  MoxxyEvent,
  PendingToolCall,
  PermissionContext,
  PermissionDecision,
  PermissionResolver,
  TurnId,
  UserPromptAttachment,
} from '@moxxy/sdk';
import { JsonRpcPeer } from './jsonrpc.js';
import type { Transport, TransportServer } from './transport.js';
import { createUnixSocketServer } from './unix-socket.js';
import { runnerSocketPath } from './socket-path.js';
import {
  RUNNER_PROTOCOL_VERSION,
  RunnerMethod,
  RunnerNotification,
  abortParamsSchema,
  attachParamsSchema,
  commandRunParamsSchema,
  mcpDetachParamsSchema,
  mcpEnableAndAttachParamsSchema,
  modeSetActiveParamsSchema,
  permissionAddAllowParamsSchema,
  providerSetActiveParamsSchema,
  runTurnParamsSchema,
  setResolverParamsSchema,
  transcribeParamsSchema,
  workflowRunParamsSchema,
  workflowSetEnabledParamsSchema,
  type AttachResult,
  type CommandRunResult,
  type RunTurnResult,
  type TranscribeResult,
} from './protocol.js';

/** One attached client and what it has opted into answering. */
interface ConnectedClient {
  readonly peer: JsonRpcPeer;
  role: string;
  attached: boolean;
  handlesPermission: boolean;
  handlesApproval: boolean;
  /** Turns this client started - aborted if it disconnects. */
  readonly turns: Set<TurnId>;
}

/** Carried through the turn's async context so resolvers can find the owner. */
interface TurnScope {
  readonly client: ConnectedClient;
  readonly turnId: TurnId;
}

/**
 * Exposes a {@link Session} over a transport so thin clients can attach.
 *
 * The server owns the Session and the agentic loop. Clients drive turns via
 * `runTurn`, observe everything through a broadcast event stream, and answer
 * `permission.check` / `approval.confirm` for the turns they started. Per-turn
 * routing rides on an `AsyncLocalStorage` scope established around each turn -
 * so a permission prompt raised deep inside a strategy is delivered back to
 * exactly the client that asked for the turn. Turns run *outside* any scope
 * (e.g. a self-hosting TUI calling `session.runTurn` directly) fall through to
 * the resolvers that were installed before the server wrapped the session.
 */
export class RunnerServer {
  private readonly clients = new Set<ConnectedClient>();
  private readonly turnControllers = new Map<TurnId, AbortController>();
  private readonly scope = new AsyncLocalStorage<TurnScope>();
  private readonly logUnsub: () => void;
  private readonly modesUnsub: () => void;
  /**
   * Resolvers for unscoped (local) turns - the fall-through path. Seeded from
   * whatever was installed before we wrapped the session, then kept current by
   * intercepting later `setPermissionResolver` / `setApprovalResolver` calls
   * (e.g. a self-hosting TUI mounting) so those don't clobber routing.
   */
  private fallbackPermission: PermissionResolver;
  private fallbackApproval: ApprovalResolver | null;
  private closed = false;

  constructor(
    private readonly session: Session,
    private readonly transport: TransportServer,
  ) {
    this.fallbackPermission = session.resolver;
    this.fallbackApproval = session.approvalResolver;
    this.installRoutingResolvers();
    this.transport.onConnection((t) => this.onConnection(t));
    this.logUnsub = session.log.subscribe((event) => this.broadcastEvent(event));
    // Mirror active-mode changes to clients — covers both the SetMode RPC and a
    // mode handing off to another mode post-turn (BMAD → tool-use).
    this.modesUnsub = session.modes.onActiveChange(() => this.broadcastInfo());
  }

  get address(): string {
    return this.transport.address;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.logUnsub();
    this.modesUnsub();
    for (const client of this.clients) client.peer.close();
    this.clients.clear();
    await this.transport.close();
  }

  // --- connection lifecycle ------------------------------------------------

  private onConnection(transport: Transport): void {
    const peer = new JsonRpcPeer(transport);
    const client: ConnectedClient = {
      peer,
      role: 'unknown',
      attached: false,
      handlesPermission: false,
      handlesApproval: false,
      turns: new Set(),
    };
    this.clients.add(client);

    peer.handle(RunnerMethod.Attach, (raw) => this.handleAttach(client, raw));
    peer.handle(RunnerMethod.GetInfo, () => this.session.getInfo());
    peer.handle(RunnerMethod.RunTurn, (raw) => this.handleRunTurn(client, raw));
    peer.handle(RunnerMethod.Abort, (raw) => this.handleAbort(raw));
    peer.handle(RunnerMethod.SetResolver, (raw) => this.handleSetResolver(client, raw));
    peer.handle(RunnerMethod.ModeSetActive, (raw) => this.handleModeSetActive(raw));
    peer.handle(RunnerMethod.ProviderSetActive, (raw) => this.handleProviderSetActive(raw));
    peer.handle(RunnerMethod.PermissionAddAllow, (raw) => this.handlePermissionAddAllow(raw));
    peer.handle(RunnerMethod.CommandRun, (raw) => this.handleCommandRun(raw));
    peer.handle(RunnerMethod.Transcribe, (raw) => this.handleTranscribe(raw));
    peer.handle(RunnerMethod.McpListServers, () => this.handleMcpListServers());
    peer.handle(RunnerMethod.McpEnableAndAttach, (raw) =>
      this.handleMcpEnableAndAttach(raw),
    );
    peer.handle(RunnerMethod.McpDetach, (raw) => this.handleMcpDetach(raw));
    peer.handle(RunnerMethod.WorkflowList, () => this.handleWorkflowList());
    peer.handle(RunnerMethod.WorkflowSetEnabled, (raw) =>
      this.handleWorkflowSetEnabled(raw),
    );
    peer.handle(RunnerMethod.WorkflowRun, (raw) => this.handleWorkflowRun(raw));

    peer.onClose(() => this.onDisconnect(client));
  }

  private onDisconnect(client: ConnectedClient): void {
    this.clients.delete(client);
    // Tear down any turns this client was driving - there's no one left to
    // answer their prompts or consume their output.
    for (const turnId of client.turns) {
      this.turnControllers.get(turnId)?.abort('owning client disconnected');
    }
  }

  // --- request handlers ----------------------------------------------------

  private handleAttach(client: ConnectedClient, raw: unknown): AttachResult {
    const params = attachParamsSchema.parse(raw);
    if (params.protocolVersion !== RUNNER_PROTOCOL_VERSION) {
      throw new Error(
        `runner protocol mismatch: server v${RUNNER_PROTOCOL_VERSION}, client v${params.protocolVersion}`,
      );
    }
    client.role = params.role;
    client.attached = true;
    // Always replay the full history from seq 0, regardless of params.sinceSeq.
    // The client's mirror is a fresh EventLog whose `ingest` accepts only the
    // next-expected seq (contiguous from 0), so a partial replay starting at
    // sinceSeq>0 would drop every event and permanently desync the mirror.
    // `sinceSeq` stays on the wire for compatibility but is intentionally
    // ignored. This loop is fully synchronous, so no live event can interleave
    // before it finishes - every later event arrives exactly once via broadcast.
    for (const event of this.session.log.slice(0)) {
      client.peer.notify(RunnerNotification.Event, { event });
    }
    return {
      sessionId: this.session.id,
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      info: this.session.getInfo(),
    };
  }

  private handleRunTurn(client: ConnectedClient, raw: unknown): RunTurnResult {
    const params = runTurnParamsSchema.parse(raw);
    const turnId = newTurnId();
    const controller = new AbortController();
    this.turnControllers.set(turnId, controller);
    client.turns.add(turnId);

    const opts = {
      turnId,
      signal: controller.signal,
      ...(params.model ? { model: params.model } : {}),
      ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
      ...(params.maxIterations ? { maxIterations: params.maxIterations } : {}),
      ...(params.attachments
        ? { attachments: params.attachments as ReadonlyArray<UserPromptAttachment> }
        : {}),
    };

    // Drive the turn in the background inside the per-turn scope. Events reach
    // clients via the log broadcast, so we only consume the iterable to run it
    // to completion and learn when it's done.
    void this.scope.run({ client, turnId }, async () => {
      let error: string | undefined;
      try {
        for await (const _event of this.session.runTurn(params.prompt, opts)) {
          void _event;
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      } finally {
        this.turnControllers.delete(turnId);
        client.turns.delete(turnId);
        this.broadcast(RunnerNotification.TurnComplete, {
          turnId,
          ...(error ? { error } : {}),
        });
      }
    });

    return { turnId };
  }

  private handleAbort(raw: unknown): Record<string, never> {
    const params = abortParamsSchema.parse(raw);
    this.turnControllers.get(params.turnId as TurnId)?.abort('client requested abort');
    return {};
  }

  private handleSetResolver(client: ConnectedClient, raw: unknown): Record<string, never> {
    const params = setResolverParamsSchema.parse(raw);
    if (params.permission !== undefined) client.handlesPermission = params.permission;
    if (params.approval !== undefined) client.handlesApproval = params.approval;
    return {};
  }

  private handleModeSetActive(raw: unknown): Record<string, never> {
    const { name } = modeSetActiveParamsSchema.parse(raw);
    // setActive fires onActiveChange → broadcastInfo (wired in the ctor), so
    // no explicit broadcast needed here.
    this.session.modes.setActive(name);
    return {};
  }

  private async handleProviderSetActive(raw: unknown): Promise<Record<string, never>> {
    const { name, config } = providerSetActiveParamsSchema.parse(raw);
    // Mirror the in-process picker: resolve credentials (the CLI stashes a
    // resolver on the session at boot), drop any cached instance, re-activate.
    const resolver = this.session.credentialResolver;
    const cfg = config ?? (resolver ? await resolver(name) : {});
    const def = this.session.providers.list().find((p) => p.name === name);
    if (def) this.session.providers.replace(def);
    this.session.providers.setActive(name, cfg);
    this.broadcastInfo();
    return {};
  }

  private async handlePermissionAddAllow(raw: unknown): Promise<Record<string, never>> {
    const { name, reason } = permissionAddAllowParamsSchema.parse(raw);
    await this.session.permissions.addAllow({ name, ...(reason ? { reason } : {}) });
    return {};
  }

  private async handleCommandRun(raw: unknown): Promise<CommandRunResult> {
    const { name, args, channel } = commandRunParamsSchema.parse(raw);
    const cmd = this.session.commands.get(name);
    if (!cmd) return { kind: 'error', message: `unknown command: /${name}` };
    const result = await cmd.handler({
      channel,
      sessionId: this.session.id,
      args,
      session: this.session,
    });
    // A command may have changed registries (e.g. /model-ish plugins).
    this.broadcastInfo();
    return result;
  }

  private async handleTranscribe(raw: unknown): Promise<TranscribeResult> {
    const params = transcribeParamsSchema.parse(raw);
    const audio = new Uint8Array(Buffer.from(params.audio, 'base64'));
    const opts = {
      ...(params.mimeType ? { mimeType: params.mimeType } : {}),
      ...(params.language ? { language: params.language } : {}),
      ...(params.prompt ? { prompt: params.prompt } : {}),
    };
    // Build an ordered list of candidates: the active transcriber
    // first (if any), then every other registered one — that way an
    // "active but uncredentialled" transcriber (e.g. plain Whisper
    // without OPENAI_API_KEY) doesn't shadow an OAuth-backed one
    // that would actually succeed. Identical to what the TUI does
    // by hardcoding to Codex, but agnostic to transcriber name.
    const candidates = this.transcribeCandidates();
    if (candidates.length === 0) throw new Error('no active transcriber on the runner');
    let lastErr: unknown = new Error('no active transcriber on the runner');
    for (const name of candidates) {
      try {
        const transcriber = this.session.transcribers.setActive(name);
        const result = await transcriber.transcribe(audio, opts);
        // Surface the change so remote clients observe activeTranscriber
        // tracking the one that actually worked.
        this.broadcastInfo();
        return result;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  /** Ordered candidate list for a transcribe call.
   *  - First the active one (if any) — respects an explicit host /
   *    user choice.
   *  - Then every other registered transcriber. */
  private transcribeCandidates(): ReadonlyArray<string> {
    const activeName = this.session.transcribers.getActiveName();
    const names = this.session.transcribers.list().map((d) => d.name);
    if (!activeName || !names.includes(activeName)) return names;
    return [activeName, ...names.filter((n) => n !== activeName)];
  }

  // --- MCP (delegates to session.mcpAdmin if the plugin is loaded) ----------

  private async handleMcpListServers(): Promise<unknown[]> {
    const admin = this.session.mcpAdmin;
    if (!admin) return [];
    return [...(await admin.listServers())];
  }

  private async handleMcpEnableAndAttach(
    raw: unknown,
  ): Promise<{ toolNames: ReadonlyArray<string> } | null> {
    const params = mcpEnableAndAttachParamsSchema.parse(raw);
    const admin = this.session.mcpAdmin;
    if (!admin) throw new Error('mcp admin not available on this runner');
    return admin.enableAndAttach(params.name);
  }

  private async handleMcpDetach(raw: unknown): Promise<boolean> {
    const params = mcpDetachParamsSchema.parse(raw);
    const admin = this.session.mcpAdmin;
    if (!admin) throw new Error('mcp admin not available on this runner');
    return admin.detach(params.name);
  }

  // --- Workflows (delegates to session.workflows if the plugin is loaded) ---

  private async handleWorkflowList(): Promise<unknown[]> {
    const view = this.session.workflows;
    if (!view) return [];
    return [...(await view.list())];
  }

  private async handleWorkflowSetEnabled(raw: unknown): Promise<void> {
    const params = workflowSetEnabledParamsSchema.parse(raw);
    const view = this.session.workflows;
    if (!view) throw new Error('workflows plugin not loaded');
    await view.setEnabled(params.name, params.enabled);
  }

  private async handleWorkflowRun(raw: unknown): Promise<unknown> {
    const params = workflowRunParamsSchema.parse(raw);
    const view = this.session.workflows;
    if (!view) throw new Error('workflows plugin not loaded');
    return view.run(params.name);
  }

  private broadcastInfo(): void {
    this.broadcast(RunnerNotification.InfoChanged, { info: this.session.getInfo() });
  }

  // --- resolver routing ----------------------------------------------------

  private installRoutingResolvers(): void {
    const permission: PermissionResolver = {
      name: 'runner-routing',
      check: (call, ctx) => this.resolvePermission(call, ctx),
    };
    this.session.setPermissionResolver(permission);

    const approval: ApprovalResolver = {
      name: 'runner-routing',
      confirm: (req) => this.resolveApproval(req),
    };
    this.session.setApprovalResolver(approval);

    // Redirect any later resolver installs into the fallback slots rather than
    // letting them replace the routing resolver. Without this, a self-hosting
    // TUI mounting after the runner started would overwrite routing, so an
    // attached client's approval prompt would surface on the host TUI.
    this.session.setApprovalResolver = (resolver: ApprovalResolver | null) => {
      this.fallbackApproval = resolver;
    };
    this.session.setPermissionResolver = (resolver: PermissionResolver) => {
      this.fallbackPermission = resolver;
    };
  }

  private async resolvePermission(
    call: PendingToolCall,
    ctx: PermissionContext,
  ): Promise<PermissionDecision> {
    const scope = this.scope.getStore();
    if (scope && scope.client.handlesPermission && !scope.client.peer.isClosed) {
      try {
        return await scope.client.peer.request<PermissionDecision>(RunnerMethod.PermissionCheck, {
          turnId: scope.turnId,
          call,
          ctx,
        });
      } catch {
        return { mode: 'deny', reason: 'permission client unavailable' };
      }
    }
    return this.fallbackPermission.check(call, ctx);
  }

  private async resolveApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    const scope = this.scope.getStore();
    if (scope) {
      if (scope.client.handlesApproval && !scope.client.peer.isClosed) {
        try {
          return await scope.client.peer.request<ApprovalDecision>(RunnerMethod.ApprovalConfirm, {
            turnId: scope.turnId,
            request,
          });
        } catch {
          return defaultApproval(request);
        }
      }
      // A scoped turn whose client doesn't handle approvals: don't pester an
      // unrelated fallback; take the default option (headless semantics).
      return defaultApproval(request);
    }
    // Unscoped turn (e.g. self-hosting TUI driving the session directly):
    // honour whatever resolver was installed before we wrapped the session.
    if (this.fallbackApproval) return this.fallbackApproval.confirm(request);
    return defaultApproval(request);
  }

  // --- fan-out -------------------------------------------------------------

  private broadcastEvent(event: MoxxyEvent): void {
    this.broadcast(RunnerNotification.Event, { event });
  }

  private broadcast(method: string, params: unknown): void {
    for (const client of this.clients) {
      if (client.attached && !client.peer.isClosed) client.peer.notify(method, params);
    }
  }
}

function defaultApproval(request: ApprovalRequest): ApprovalDecision {
  return { optionId: request.defaultOptionId ?? request.options[0]?.id ?? '' };
}

/**
 * Start a {@link RunnerServer} for `session`. Binds a unix-socket transport by
 * default (override with `socketPath`, or inject a `transport` for tests).
 */
export async function startRunnerServer(
  session: Session,
  opts: { readonly socketPath?: string; readonly transport?: TransportServer } = {},
): Promise<RunnerServer> {
  const transport =
    opts.transport ?? (await createUnixSocketServer(opts.socketPath ?? runnerSocketPath()));
  // DO NOT auto-activate any transcriber at boot. The TUI's
  // useVoiceInput depends on Codex specifically and would throw
  // "another transcriber is active" if we promoted something else
  // first. Active-transcriber selection is a per-client / per-flow
  // concern; the runner's handleTranscribe handles fallback at
  // request time instead.
  return new RunnerServer(session, transport);
}
