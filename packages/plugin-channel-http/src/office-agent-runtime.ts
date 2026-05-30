import { EventLog, newSessionId, newTurnId, type Session } from '@moxxy/core';
import { asPluginId } from '@moxxy/sdk';
import type {
  EmittedEvent,
  EventLogReader,
  ModeContext,
  MoxxyEvent,
  ToolDef,
  ToolRegistry,
  TurnId,
  UserPromptAttachment,
} from '@moxxy/sdk';
import { eventToVirtualOfficeEnvelope, type VirtualOfficeEnvelope } from './virtual-office-events.js';
import type { HttpPermissionBroker } from './permission-broker.js';

const VIRTUAL_OFFICE_PLUGIN_ID = asPluginId('@moxxy/virtual-office');

export interface OfficeAgentCapabilities {
  run: boolean;
  stop: boolean;
  dismiss: boolean;
  reset: boolean;
}

export interface VirtualOfficeAgent {
  id: string;
  name: string;
  provider_id: string;
  model_id: string;
  status: 'idle' | 'running' | 'stopping' | 'error';
  persona: string | null;
  template: string;
  created_at: string;
  kind: 'session' | 'office_agent';
  origin: 'moxxy_session' | 'virtual_office';
  parent_id: string | null;
  capabilities: OfficeAgentCapabilities;
}

export interface OfficeAgentCreateInput {
  name?: string;
  agent_type?: string;
  instructions?: string;
  model?: string;
  allowed_tools?: string[];
}

export interface OfficeRunStart {
  agent_id: string;
  run_id: string | null;
  task: string;
  status: 'running';
  attachments?: ReadonlyArray<UserPromptAttachment>;
}

export interface OfficeRunOptions {
  systemPrompt?: string;
}

export interface OfficeAgentHistory {
  messages: Array<{
    role: 'user' | 'assistant';
    text: string;
    run_id: string | null;
    timestamp: number;
    attachments?: ReadonlyArray<UserPromptAttachment>;
  }>;
}

export interface OfficeGraveyardChatMessage {
  id: string;
  agentId: string;
  runId: string | null;
  state: 'done';
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
  attachments?: ReadonlyArray<UserPromptAttachment>;
}

export interface OfficeGraveyardLogItem {
  id: string;
  agentId: string;
  eventType: string;
  summary: string;
  severity: 'info' | 'warn' | 'error' | 'success' | 'progress';
  timestamp: number;
}

export interface OfficeGraveyardEntry {
  id: string;
  agentId: string;
  agentName: string | null;
  runId: string | null;
  outcome: 'completed' | 'failed' | 'stopped';
  timestamp: number;
  isSubagent: boolean;
  task: string | null;
  lastMessage: string | null;
  recentLogs: string[];
  chatHistory: OfficeGraveyardChatMessage[];
  logHistory: OfficeGraveyardLogItem[];
}

type Listener = (envelope: VirtualOfficeEnvelope) => void;

interface OfficeAgentState {
  readonly id: string;
  readonly sessionId: ReturnType<typeof newSessionId>;
  readonly createdAt: string;
  readonly log: EventLog;
  readonly name: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly instructions: string | null;
  readonly allowedTools: ReadonlyArray<string> | null;
  readonly events: VirtualOfficeEnvelope[];
  status: VirtualOfficeAgent['status'];
  activeController: AbortController | null;
  activeTurnId: string | null;
}

interface PersistedOfficeEnvelope {
  envelope: VirtualOfficeEnvelope;
  ts: number;
  entry: OfficeGraveyardEntry | null;
}

export class OfficeAgentRuntime {
  private readonly agents = new Map<string, OfficeAgentState>();
  private readonly archivedEntries: OfficeGraveyardEntry[];
  private readonly listeners = new Set<Listener>();
  private nextId: number;
  private nextSequence = 0;

  constructor(
    private readonly session: Session,
    private readonly logger?: { warn(msg: string, meta?: Record<string, unknown>): void },
    private readonly permissionBroker?: HttpPermissionBroker | null,
  ) {
    const persisted = readPersistedOfficeEnvelopes(session.log.toJSON());
    this.archivedEntries = [
      ...projectArchivedAgents(persisted),
      ...projectRuntimeSubagents(session.log.toJSON()),
    ].sort((a, b) => a.timestamp - b.timestamp);
    this.nextId = nextOfficeAgentId(persisted);
  }

  list(): VirtualOfficeAgent[] {
    return [this.sessionAgent(), ...[...this.agents.values()].map((agent) => this.snapshot(agent))];
  }

  get(id: string): VirtualOfficeAgent | null {
    if (id === 'session') return this.sessionAgent();
    const agent = this.agents.get(id);
    return agent ? this.snapshot(agent) : null;
  }

  async create(input: OfficeAgentCreateInput): Promise<VirtualOfficeAgent> {
    const { providerId, modelId } = activeProviderInfo(this.session);
    const id = `office-agent-${String(this.nextId++).padStart(4, '0')}`;
    const name = normalizeName(input.name) ?? input.agent_type ?? `agent-${id.slice(-4)}`;
    const agent: OfficeAgentState = {
      id,
      sessionId: newSessionId(),
      createdAt: new Date().toISOString(),
      log: new EventLog(),
      name,
      providerId,
      modelId: input.model ?? modelId,
      instructions: normalizeOptional(input.instructions),
      allowedTools: Array.isArray(input.allowed_tools) && input.allowed_tools.length > 0
        ? [...input.allowed_tools]
        : null,
      events: [],
      status: 'idle',
      activeController: null,
      activeTurnId: null,
    };
    this.agents.set(id, agent);
    this.permissionBroker?.registerAgentSession(String(agent.sessionId), id);
    const snapshot = this.snapshot(agent);
    await this.emitLifecycle(agent, 'office_agent.created', { agent: snapshot });
    return snapshot;
  }

  async dismiss(id: string): Promise<boolean> {
    if (id === 'session') return false;
    const agent = this.agents.get(id);
    if (!agent) return false;
    if (agent.activeController) {
      agent.activeController.abort('office agent dismissed');
    }
    const entry = this.archiveEntry(agent, 'stopped');
    await this.emitLifecycle(agent, 'office_agent.archived', { agent_id: id, entry });
    this.archivedEntries.push(entry);
    this.permissionBroker?.unregisterAgentSession(String(agent.sessionId));
    this.agents.delete(id);
    await this.emitLifecycle(null, 'office_agent.dismissed', { agent_id: id });
    return true;
  }

  async archiveLiveAgents(reason = 'session_closed'): Promise<void> {
    for (const agent of [...this.agents.values()]) {
      if (agent.activeController) {
        agent.activeController.abort(reason);
      }
      const entry = this.archiveEntry(agent, 'stopped');
      await this.emitLifecycle(agent, 'office_agent.archived', { agent_id: agent.id, reason, entry });
      this.archivedEntries.push(entry);
      this.permissionBroker?.unregisterAgentSession(String(agent.sessionId));
      this.agents.delete(agent.id);
    }
  }

  stop(id: string): 'stopped' | 'unsupported' | 'not_found' | 'not_running' {
    if (id === 'session') return 'unsupported';
    const agent = this.agents.get(id);
    if (!agent) return 'not_found';
    if (!agent.activeController || agent.status !== 'running') return 'not_running';
    agent.status = 'stopping';
    agent.activeController.abort('office agent stopped');
    void this.emitLifecycle(agent, 'office_agent.updated', { agent: this.snapshot(agent) });
    return 'stopped';
  }

  reset(id: string): VirtualOfficeAgent | null {
    if (id === 'session') return this.sessionAgent();
    const agent = this.agents.get(id);
    if (!agent) return null;
    if (agent.activeController) agent.activeController.abort('office agent reset');
    agent.log.clear();
    agent.status = 'idle';
    agent.activeController = null;
    agent.activeTurnId = null;
    agent.events.length = 0;
    const snapshot = this.snapshot(agent);
    void this.emitLifecycle(agent, 'office_agent.updated', { agent: snapshot });
    return snapshot;
  }

  history(id: string): OfficeAgentHistory | null {
    const agent = this.agents.get(id);
    if (!agent) return null;
    return { messages: messagesFromLog(agent.log, id) };
  }

  graveyard(): OfficeGraveyardEntry[] {
    return [...this.archivedEntries];
  }

  startRun(
    id: string,
    task: string,
    attachments: ReadonlyArray<UserPromptAttachment> = [],
    options?: OfficeRunOptions,
  ): OfficeRunStart | 'not_found' | 'already_running' {
    if (id === 'session') return 'not_found';
    const agent = this.agents.get(id);
    if (!agent) return 'not_found';
    if (agent.status === 'running' || agent.status === 'stopping') return 'already_running';
    const turnId = newTurnId();
    const controller = new AbortController();
    agent.status = 'running';
    agent.activeController = controller;
    agent.activeTurnId = String(turnId);
    void this.emitLifecycle(agent, 'office_agent.updated', { agent: this.snapshot(agent) });

    const unsubscribe = agent.log.subscribe(async (event) => {
      const envelope = eventToVirtualOfficeEnvelope(event, id);
      if (!envelope) return;
      await this.recordEnvelope(agent, envelope, event.turnId);
    });

    void this.runAgentTurn(agent, turnId, task, attachments, controller.signal, options)
      .then(async (result) => {
        if (result !== 'completed') return;
        await this.recordEnvelope(agent, {
          agent_id: id,
          run_id: String(turnId),
          parent_run_id: null,
          sequence: this.nextSequence++,
          event_type: 'run.completed',
          payload: {},
          sensitive: false,
        }, turnId);
      })
      .catch((err) => {
        this.logger?.warn('office agent run failed', {
          agentId: id,
          err: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        unsubscribe();
        if (this.agents.get(id) !== agent) return;
        if (agent.activeController === controller) {
          agent.activeController = null;
          agent.activeTurnId = null;
          agent.status = agent.status === 'error' ? 'error' : 'idle';
          void this.emitLifecycle(agent, 'office_agent.updated', { agent: this.snapshot(agent) });
        }
      });

    return {
      agent_id: id,
      run_id: String(turnId),
      task,
      status: 'running',
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async runAgentTurn(
    agent: OfficeAgentState,
    turnId: ReturnType<typeof newTurnId>,
    task: string,
    attachments: ReadonlyArray<UserPromptAttachment>,
    signal: AbortSignal,
    options?: OfficeRunOptions,
  ): Promise<'completed' | 'failed'> {
    const effectiveSignal = AbortSignal.any([this.session.signal, signal]);
    await agent.log.append({
      type: 'user_prompt',
      sessionId: agent.sessionId,
      turnId,
      source: 'user',
      text: task,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    const mode = this.session.modes.getActive();
    const toolRegistry = agent.allowedTools
      ? buildAllowedToolsRegistry(this.session.tools as unknown as ToolRegistry, new Set(agent.allowedTools))
      : (this.session.tools as unknown as ToolRegistry);
    const systemPrompt = mergeSystemPrompt(agent.instructions, options?.systemPrompt);
    const ctx: ModeContext = {
      sessionId: agent.sessionId,
      turnId,
      model: agent.modelId,
      ...(systemPrompt ? { systemPrompt } : {}),
      provider: this.session.providers.getActive(),
      tools: toolRegistry,
      skills: this.session.skills,
      log: agent.log as unknown as EventLogReader,
      compactor: this.session.compactors.getActive(),
      cacheStrategy: this.session.cacheStrategies.getActive(),
      permissions: this.session.resolver,
      ...(this.session.approvalResolver ? { approval: this.session.approvalResolver } : {}),
      hooks: this.session.dispatcher,
      pluginHost: this.session.pluginHost,
      signal: effectiveSignal,
      emit: (event: EmittedEvent): Promise<MoxxyEvent> => agent.log.append(event),
    };
    const turnCtx = { ...this.session.appContext(), turnId, iteration: 0 };
    try {
      await this.session.dispatcher.dispatchTurnStart(turnCtx);
      for await (const _ of mode.run(ctx)) void _;
      await this.session.dispatcher.dispatchTurnEnd(turnCtx);
      return 'completed';
    } catch (err) {
      agent.status = effectiveSignal.aborted ? 'idle' : 'error';
      await agent.log.append({
        type: effectiveSignal.aborted ? 'abort' : 'error',
        sessionId: agent.sessionId,
        turnId,
        source: 'system',
        ...(effectiveSignal.aborted
          ? { reason: String(effectiveSignal.reason ?? 'aborted') }
          : { kind: 'fatal', message: err instanceof Error ? err.message : String(err) }),
      } as EmittedEvent);
      return 'failed';
    }
  }

  private sessionAgent(): VirtualOfficeAgent {
    const { providerId, modelId } = activeProviderInfo(this.session);
    return {
      id: 'session',
      name: 'session',
      provider_id: providerId,
      model_id: modelId,
      status: 'idle',
      persona: null,
      template: 'moxxy-session',
      created_at: new Date(0).toISOString(),
      kind: 'session',
      origin: 'moxxy_session',
      parent_id: null,
      capabilities: {
        run: true,
        stop: false,
        dismiss: false,
        reset: true,
      },
    };
  }

  private snapshot(agent: OfficeAgentState): VirtualOfficeAgent {
    return {
      id: agent.id,
      name: agent.name,
      provider_id: agent.providerId,
      model_id: agent.modelId,
      status: agent.status,
      persona: agent.instructions,
      template: 'office-agent',
      created_at: agent.createdAt,
      kind: 'office_agent',
      origin: 'virtual_office',
      parent_id: 'session',
      capabilities: {
        run: true,
        stop: true,
        dismiss: true,
        reset: true,
      },
    };
  }

  private async emitLifecycle(
    agent: OfficeAgentState | null,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const envelope = {
      agent_id: agent?.id ?? (typeof payload.agent_id === 'string' ? payload.agent_id : 'session'),
      run_id: null,
      parent_run_id: null,
      sequence: this.nextSequence++,
      event_type: eventType,
      payload,
      sensitive: false,
    };
    await this.recordEnvelope(agent, envelope, newTurnId());
  }

  private emit(envelope: VirtualOfficeEnvelope): void {
    for (const listener of [...this.listeners]) listener(envelope);
  }

  private async recordEnvelope(
    agent: OfficeAgentState | null,
    envelope: VirtualOfficeEnvelope,
    turnId: TurnId,
  ): Promise<void> {
    if (agent) agent.events.push(envelope);
    await this.session.log.append({
      type: 'plugin_event',
      sessionId: this.session.id,
      turnId,
      source: 'plugin',
      pluginId: VIRTUAL_OFFICE_PLUGIN_ID,
      subtype: officeSubtype(envelope.event_type),
      payload: { envelope, entry: readEntryPayload(envelope.payload) },
    });
    this.emit(envelope);
  }

  private archiveEntry(
    agent: OfficeAgentState,
    outcome: OfficeGraveyardEntry['outcome'],
  ): OfficeGraveyardEntry {
    return buildGraveyardEntryFromEnvelopes(agent.id, agent.name, agent.events, Date.now(), outcome, false);
  }
}

export function activeProviderInfo(session: Session): {
  providerId: string;
  modelId: string;
} {
  const activeName = session.providers.getActiveName();
  const providers = session.providers.list();
  const activeDef = providers.find((provider) => provider.name === activeName) ?? providers[0];
  return {
    providerId: activeDef?.name ?? activeName ?? 'none',
    modelId: activeDef?.models[0]?.id ?? 'default',
  };
}

function normalizeName(name: string | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 64);
}

function normalizeOptional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function mergeSystemPrompt(...parts: ReadonlyArray<string | null | undefined>): string | undefined {
  const text = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join('\n\n');
  return text || undefined;
}

function messagesFromLog(log: EventLog, agentId: string): OfficeAgentHistory['messages'] {
  const messages: OfficeAgentHistory['messages'] = [];
  for (const event of log.toJSON()) {
    if (event.type === 'user_prompt') {
      messages.push({
        role: 'user' as const,
        text: event.text,
        run_id: String(event.turnId),
        timestamp: event.ts,
        ...(event.attachments && event.attachments.length > 0 ? { attachments: event.attachments } : {}),
      });
      continue;
    }
    if (event.type === 'assistant_message') {
      messages.push({
        role: 'assistant' as const,
        text: event.content,
        run_id: String(event.turnId),
        timestamp: event.ts,
      });
    }
  }
  return messages.filter((message) => message.text.trim().length > 0 && agentId.length > 0);
}

function buildAllowedToolsRegistry(registry: ToolRegistry, allowed: ReadonlySet<string>): ToolRegistry {
  return {
    list(): ReadonlyArray<ToolDef> {
      return registry.list().filter((tool) => allowed.has(tool.name));
    },
    get(name: string): ToolDef | undefined {
      return allowed.has(name) ? registry.get(name) : undefined;
    },
    execute(name: string, input: unknown, signal: AbortSignal, opts?: Parameters<ToolRegistry['execute']>[3]): Promise<unknown> {
      if (!allowed.has(name)) throw new Error(`tool not allowed for office agent: ${name}`);
      return registry.execute(name, input, signal, opts);
    },
  };
}

function officeSubtype(eventType: string): string {
  if (eventType.startsWith('office_agent.')) return eventType;
  return `office_agent.${eventType.replace(/\./g, '_')}`;
}

function readEntryPayload(payload: Record<string, unknown>): OfficeGraveyardEntry | null {
  const entry = payload.entry;
  return isOfficeGraveyardEntry(entry) ? entry : null;
}

function readPersistedOfficeEnvelopes(events: ReadonlyArray<MoxxyEvent>): PersistedOfficeEnvelope[] {
  const out: PersistedOfficeEnvelope[] = [];
  for (const event of events) {
    if (event.type !== 'plugin_event') continue;
    if (String(event.pluginId) !== String(VIRTUAL_OFFICE_PLUGIN_ID)) continue;
    if (!event.payload || typeof event.payload !== 'object') continue;
    const payload = event.payload as Record<string, unknown>;
    const envelope = payload.envelope;
    if (!isVirtualOfficeEnvelope(envelope)) continue;
    out.push({
      envelope,
      ts: event.ts,
      entry: isOfficeGraveyardEntry(payload.entry) ? payload.entry : null,
    });
  }
  return out;
}

function projectArchivedAgents(persisted: ReadonlyArray<PersistedOfficeEnvelope>): OfficeGraveyardEntry[] {
  const grouped = new Map<string, PersistedOfficeEnvelope[]>();
  const archived = new Map<string, OfficeGraveyardEntry>();
  for (const item of persisted) {
    const agentId = item.envelope.agent_id;
    if (!agentId.startsWith('office-agent-')) continue;
    const list = grouped.get(agentId) ?? [];
    list.push(item);
    grouped.set(agentId, list);
    if (item.envelope.event_type === 'office_agent.archived' && item.entry) {
      archived.set(agentId, item.entry);
    }
  }

  const entries: OfficeGraveyardEntry[] = [];
  for (const [agentId, items] of grouped) {
    const archivedEntry = archived.get(agentId);
    if (archivedEntry) {
      entries.push(archivedEntry);
      continue;
    }
    const envelopes = items.map((item) => item.envelope);
    const name = readAgentName(envelopes) ?? agentId;
    const timestamp = items.at(-1)?.ts ?? Date.now();
    entries.push(buildGraveyardEntryFromEnvelopes(agentId, name, envelopes, timestamp, 'stopped', false));
  }
  return entries.sort((a, b) => a.timestamp - b.timestamp);
}

function projectRuntimeSubagents(events: ReadonlyArray<MoxxyEvent>): OfficeGraveyardEntry[] {
  const grouped = new Map<string, { envelopes: VirtualOfficeEnvelope[]; timestamps: number[] }>();
  for (const event of events) {
    if (event.type !== 'plugin_event') continue;
    if (String(event.pluginId) !== '@moxxy/subagents') continue;
    const envelope = eventToVirtualOfficeEnvelope(event, 'session');
    if (!envelope) continue;
    const current = grouped.get(envelope.agent_id) ?? { envelopes: [], timestamps: [] };
    current.envelopes.push(envelope);
    current.timestamps.push(event.ts);
    grouped.set(envelope.agent_id, current);
  }

  const entries: OfficeGraveyardEntry[] = [];
  for (const [agentId, item] of grouped) {
    const terminal = [...item.envelopes].reverse().find(
      (event) => event.event_type === 'subagent.completed' || event.event_type === 'subagent.failed',
    );
    if (!terminal) continue;
    const outcome = terminal.event_type === 'subagent.failed' ? 'failed' : 'completed';
    const timestamp = item.timestamps.at(-1) ?? Date.now();
    entries.push(buildGraveyardEntryFromEnvelopes(
      agentId,
      readSubagentName(item.envelopes) ?? agentId,
      item.envelopes,
      timestamp,
      outcome,
      true,
    ));
  }
  return entries.sort((a, b) => a.timestamp - b.timestamp);
}

function nextOfficeAgentId(persisted: ReadonlyArray<PersistedOfficeEnvelope>): number {
  let max = 0;
  for (const item of persisted) {
    const match = /^office-agent-(\d+)$/.exec(item.envelope.agent_id);
    if (!match) continue;
    max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

function buildGraveyardEntryFromEnvelopes(
  agentId: string,
  agentName: string | null,
  envelopes: ReadonlyArray<VirtualOfficeEnvelope>,
  timestamp: number,
  outcome: OfficeGraveyardEntry['outcome'],
  isSubagent: boolean,
): OfficeGraveyardEntry {
  const chatHistory = buildChatHistory(agentId, envelopes, timestamp);
  const logHistory = buildLogHistory(agentId, envelopes, timestamp);
  const runId = [...envelopes].reverse().find((event) => event.run_id)?.run_id ?? null;
  const task = [...chatHistory].reverse()
    .find((message) => message.role === 'user' && (!runId || message.runId === runId))?.text ?? null;
  const lastMessage = [...chatHistory].reverse().find((message) => message.text.trim())?.text ?? null;
  const recentLogs = logHistory.slice(-5).map((item) => item.summary);
  return {
    id: `${agentId}-${runId ?? 'no-run'}-${timestamp}`,
    agentId,
    agentName,
    runId,
    outcome,
    timestamp,
    isSubagent,
    task,
    lastMessage,
    recentLogs,
    chatHistory,
    logHistory,
  };
}

function buildChatHistory(
  agentId: string,
  envelopes: ReadonlyArray<VirtualOfficeEnvelope>,
  fallbackTs: number,
): OfficeGraveyardChatMessage[] {
  const messages: OfficeGraveyardChatMessage[] = [];
  envelopes.forEach((event, index) => {
    if (event.event_type === 'run.started') {
      const task = typeof event.payload.task === 'string' ? event.payload.task : '';
      if (!task.trim()) return;
      messages.push({
        id: `${agentId}:${event.run_id ?? 'run'}:user:${index}`,
        agentId,
        runId: event.run_id ?? null,
        state: 'done',
        role: 'user',
        text: task,
        timestamp: fallbackTs + index,
        ...readEnvelopeAttachments(event),
      });
      return;
    }
    if (event.event_type === 'subagent.spawned') {
      const task = typeof event.payload.prompt === 'string' ? event.payload.prompt : '';
      if (!task.trim()) return;
      messages.push({
        id: `${agentId}:${event.run_id ?? 'run'}:user:${index}`,
        agentId,
        runId: event.run_id ?? null,
        state: 'done',
        role: 'user',
        text: task,
        timestamp: fallbackTs + index,
      });
      return;
    }
    if (event.event_type === 'message.final') {
      const content = typeof event.payload.content === 'string' ? event.payload.content : '';
      if (!content.trim()) return;
      messages.push({
        id: `${agentId}:${event.run_id ?? 'run'}:assistant:${index}`,
        agentId,
        runId: event.run_id ?? null,
        state: 'done',
        role: 'assistant',
        text: content,
        timestamp: fallbackTs + index,
      });
    }
    if (event.event_type === 'subagent.completed' || event.event_type === 'subagent.failed') {
      const content =
        typeof event.payload.result === 'string'
          ? event.payload.result
          : typeof event.payload.error === 'string'
            ? event.payload.error
            : '';
      if (!content.trim()) return;
      messages.push({
        id: `${agentId}:${event.run_id ?? 'run'}:assistant:${index}`,
        agentId,
        runId: event.run_id ?? null,
        state: 'done',
        role: 'assistant',
        text: content,
        timestamp: fallbackTs + index,
      });
    }
  });
  return messages;
}

function readEnvelopeAttachments(event: VirtualOfficeEnvelope): { attachments?: ReadonlyArray<UserPromptAttachment> } {
  const raw = event.payload.attachments;
  if (!Array.isArray(raw)) return {};
  const attachments = raw.filter(isUserPromptAttachment);
  return attachments.length > 0 ? { attachments } : {};
}

function isUserPromptAttachment(value: unknown): value is UserPromptAttachment {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    (record.kind === 'stdin' || record.kind === 'file' || record.kind === 'image' || record.kind === 'audio') &&
    typeof record.content === 'string' &&
    (record.name === undefined || typeof record.name === 'string') &&
    (record.mediaType === undefined || typeof record.mediaType === 'string')
  );
}

function buildLogHistory(
  agentId: string,
  envelopes: ReadonlyArray<VirtualOfficeEnvelope>,
  fallbackTs: number,
): OfficeGraveyardLogItem[] {
  return envelopes.map((event, index) => ({
    id: `${agentId}:${event.sequence}:${index}`,
    agentId,
    eventType: event.event_type,
    summary: summarizeEnvelope(event),
    severity: event.event_type.endsWith('.failed') ? 'error' : 'info',
    timestamp: fallbackTs + index,
  }));
}

function summarizeEnvelope(event: VirtualOfficeEnvelope): string {
  const text = (key: string): string => (typeof event.payload[key] === 'string' ? String(event.payload[key]) : '');
  switch (event.event_type) {
    case 'run.started':
      return `Run started${text('task') ? `: ${text('task')}` : ''}`;
    case 'run.completed':
      return 'Run completed';
    case 'run.failed':
      return `Run failed${text('error') ? `: ${text('error')}` : ''}`;
    case 'message.final':
      return 'Message complete';
    case 'primitive.invoked':
      return `${text('name') || 'primitive'} invoked`;
    case 'primitive.completed':
      return `${text('name') || 'primitive'} done`;
    case 'primitive.failed':
      return `${text('name') || 'primitive'} failed`;
    case 'skill.invoked':
      return `Skill: ${text('skill_id') || text('name') || 'unknown'}`;
    case 'office_agent.created': {
      const name = readAgentName([event]);
      return `Office agent created${name ? `: ${name}` : ''}`;
    }
    case 'office_agent.archived':
      return 'Office agent archived';
    case 'office_agent.dismissed':
      return 'Office agent dismissed';
    case 'subagent.spawned':
      return `Subagent spawned${text('child_name') ? `: ${text('child_name')}` : ''}`;
    case 'subagent.completed':
      return `Subagent completed${text('child_name') ? `: ${text('child_name')}` : ''}`;
    case 'subagent.failed':
      return `Subagent failed${text('error') ? `: ${text('error')}` : ''}`;
    default:
      return event.event_type;
  }
}

function readAgentName(envelopes: ReadonlyArray<VirtualOfficeEnvelope>): string | null {
  for (const event of envelopes) {
    const agent = event.payload.agent;
    if (!agent || typeof agent !== 'object') continue;
    const name = (agent as Record<string, unknown>).name;
    if (typeof name === 'string' && name.trim()) return name;
  }
  return null;
}

function readSubagentName(envelopes: ReadonlyArray<VirtualOfficeEnvelope>): string | null {
  for (const event of envelopes) {
    const name = event.payload.child_name;
    if (typeof name === 'string' && name.trim()) return name;
    const label = event.payload.label;
    if (typeof label === 'string' && label.trim()) return label;
  }
  return null;
}

function isVirtualOfficeEnvelope(value: unknown): value is VirtualOfficeEnvelope {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.agent_id === 'string' &&
    (record.run_id === null || typeof record.run_id === 'string' || record.run_id === undefined) &&
    (record.parent_run_id === null || typeof record.parent_run_id === 'string' || record.parent_run_id === undefined) &&
    typeof record.sequence === 'number' &&
    typeof record.event_type === 'string' &&
    !!record.payload &&
    typeof record.payload === 'object' &&
    typeof record.sensitive === 'boolean'
  );
}

function isOfficeGraveyardEntry(value: unknown): value is OfficeGraveyardEntry {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.agentId === 'string' &&
    (record.agentName === null || typeof record.agentName === 'string') &&
    (record.runId === null || typeof record.runId === 'string') &&
    (record.outcome === 'completed' || record.outcome === 'failed' || record.outcome === 'stopped') &&
    typeof record.timestamp === 'number' &&
    typeof record.isSubagent === 'boolean' &&
    Array.isArray(record.recentLogs) &&
    Array.isArray(record.chatHistory) &&
    Array.isArray(record.logHistory)
  );
}
