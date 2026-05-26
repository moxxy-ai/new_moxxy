import { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { runTurn, savePreferences, type Session as CoreSession } from '@moxxy/core';
import {
  asPluginId,
  readRequestBody,
  bearerTokenMatches,
  type ClientSession as Session,
  type CommandSessionActionPayload,
  type CommandStateChangedPayload,
  type MoxxyEvent,
} from '@moxxy/sdk';
import { OfficeAgentRuntime } from './office-agent-runtime.js';
import { eventToVirtualOfficeEnvelope } from './virtual-office-events.js';
import type { HttpPermissionBroker } from './permission-broker.js';

export const turnRequestSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
});

export type TurnRequest = z.infer<typeof turnRequestSchema>;

const commandRequestSchema = z.object({
  agent_id: z.string().min(1).default('session'),
  command: z.string().min(1),
  origin_id: z.string().min(1).optional(),
});

const permissionDecisionSchema = z.object({
  mode: z.enum(['allow', 'allow_session', 'allow_always', 'deny']),
  reason: z.string().optional(),
});

const COMMAND_SESSION_ACTION_SUBTYPE = 'command.session_action';
const COMMAND_STATE_CHANGED_SUBTYPE = 'command.state_changed';

export interface RouterContext {
  readonly session: Session;
  readonly authToken: string | null;
  readonly officeAgents?: OfficeAgentRuntime;
  readonly permissionBroker?: HttpPermissionBroker;
  readonly logger?: { warn(msg: string, meta?: Record<string, unknown>): void };
}

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, ctx: RouterContext) => Promise<void>;

/** Match HTTP request to a handler. Returns null if no route matches. */
export function routeRequest(req: IncomingMessage): RouteHandler | null {
  const rawUrl = req.url ?? '/';
  // Strip the query string before matching — `/v1/turn/audio?model=...`
  // is the same route as `/v1/turn/audio`. The handler reads query
  // params off req.url itself.
  const pathname = rawUrl.split('?')[0] ?? rawUrl;
  if (req.method === 'GET' && pathname === '/v1/health') return handleHealth;
  if (req.method === 'POST' && pathname === '/v1/turn') return handleTurn;
  if (req.method === 'POST' && pathname === '/v1/turn/stream') return handleTurnStream;
  if (req.method === 'POST' && pathname === '/v1/turn/audio') return handleTurnAudio;
  if (req.method === 'GET' && pathname === '/v1/session-selection') return handleSessionSelection;
  if (req.method === 'GET' && pathname === '/v1/providers') return handleProviders;
  if (req.method === 'GET' && /^\/v1\/providers\/[^/]+\/models$/.test(pathname)) return handleProviderModels;
  if (req.method === 'GET' && pathname === '/v1/graveyard') return handleGraveyard;
  if (req.method === 'GET' && pathname === '/v1/commands') return handleCommands;
  if (req.method === 'POST' && pathname === '/v1/commands') return handleRunCommand;
  if (req.method === 'GET' && pathname === '/v1/agents') return handleAgents;
  if (req.method === 'POST' && pathname === '/v1/agents') return handleCreateAgent;
  if (req.method === 'GET' && /^\/v1\/agents\/[^/]+$/.test(pathname)) return handleGetAgent;
  if (req.method === 'DELETE' && /^\/v1\/agents\/[^/]+$/.test(pathname)) return handleDeleteAgent;
  if (req.method === 'POST' && /^\/v1\/agents\/[^/]+\/runs$/.test(pathname)) return handleAgentRun;
  if (req.method === 'POST' && /^\/v1\/agents\/[^/]+\/stop$/.test(pathname)) return handleStopAgent;
  if (req.method === 'GET' && /^\/v1\/agents\/[^/]+\/history$/.test(pathname)) return handleAgentHistory;
  if (req.method === 'POST' && /^\/v1\/agents\/[^/]+\/reset$/.test(pathname)) return handleResetAgent;
  if (req.method === 'GET' && pathname === '/v1/events/stream') return handleVirtualOfficeEvents;
  if (req.method === 'POST' && /^\/v1\/permissions\/[^/]+\/decision$/.test(pathname)) return handlePermissionDecision;
  return null;
}

export async function handleHealth(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok' }));
}

export async function handleSessionSelection(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  reply(res, 200, { status: 'ready', sessions: [] });
}

function checkAuth(req: IncomingMessage, expected: string | null): boolean {
  if (!expected) return true;
  // Constant-time compare of the full `Bearer <token>` header so the token
  // isn't recoverable byte-by-byte via response timing.
  return bearerTokenMatches(req.headers.authorization, `Bearer ${expected}`);
}

async function readBody(req: IncomingMessage, max = 64 * 1024): Promise<string> {
  return (await readRequestBody(req, max)).toString('utf8');
}

/** Audio uploads need a much larger cap than JSON; 10 MB covers a few
 *  minutes of Opus voice (Telegram caps voice notes at 50 MB, but
 *  realistic notes are well under that). */
const DEFAULT_AUDIO_MAX = 10 * 1024 * 1024;

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function pathPart(req: IncomingMessage, index: number): string {
  const pathname = (req.url ?? '/').split('?')[0] ?? '/';
  return decodeURIComponent(pathname.split('/')[index] ?? '');
}

function officeRuntime(ctx: RouterContext): OfficeAgentRuntime {
  if (ctx.officeAgents) return ctx.officeAgents;
  const mutable = ctx as RouterContext & { __officeAgents?: OfficeAgentRuntime };
  mutable.__officeAgents ??= new OfficeAgentRuntime(
    coreSession(ctx.session),
    ctx.logger,
    ctx.permissionBroker,
  );
  return mutable.__officeAgents;
}

function coreSession(session: Session): CoreSession {
  return session as unknown as CoreSession;
}

export async function handlePermissionDecision(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  if (!ctx.permissionBroker) {
    reply(res, 404, { error: 'not_found', message: 'interactive permissions are not enabled' });
    return;
  }

  let body: z.infer<typeof permissionDecisionSchema>;
  try {
    const raw = await readBody(req);
    body = permissionDecisionSchema.parse(JSON.parse(raw));
  } catch (err) {
    reply(res, 400, { error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
    return;
  }

  const requestId = pathPart(req, 3);
  const ok = await ctx.permissionBroker.decide(requestId, body);
  if (!ok) {
    reply(res, 404, { error: 'not_found', message: 'permission request not found' });
    return;
  }
  reply(res, 200, { ok: true });
}

interface OfficeCommandDescriptor {
  name: string;
  command: string;
  description: string;
  aliases?: ReadonlyArray<string>;
  supported: boolean;
  reason?: string;
}

const OFFICE_LOCAL_COMMANDS: ReadonlyArray<OfficeCommandDescriptor> = [
  { name: 'tools', command: '/tools', description: 'List the tools the active session can call', supported: true },
  { name: 'skills', command: '/skills', description: 'List discovered skills', supported: true },
  { name: 'agents', command: '/agents', description: 'Inspect live Office agents', supported: true },
  { name: 'model', command: '/model', description: 'List or switch provider + model', supported: true },
  { name: 'loop', command: '/loop', description: 'List or switch loop strategy', supported: true },
  { name: 'mcp', command: '/mcp', description: 'Inspect MCP tools exposed to the session', supported: true },
  {
    name: 'yolo',
    command: '/yolo',
    description: 'Toggle auto-approve mode',
    aliases: ['auto-approve'],
    supported: false,
    reason: 'auto-approve is an interactive TUI-only mode',
  },
  {
    name: 'expand',
    command: '/expand',
    description: 'Expand collapsed TUI scopes',
    supported: false,
    reason: 'expand/collapse are TUI display-only commands',
  },
  {
    name: 'collapse',
    command: '/collapse',
    description: 'Collapse expanded TUI scopes',
    supported: false,
    reason: 'expand/collapse are TUI display-only commands',
  },
  {
    name: 'queue',
    command: '/queue',
    description: 'Show queued TUI messages',
    supported: false,
    reason: 'Office sends tasks directly and does not use the TUI message queue',
  },
  {
    name: 'clear-queue',
    command: '/clear-queue',
    description: 'Drop queued TUI messages',
    supported: false,
    reason: 'Office sends tasks directly and does not use the TUI message queue',
  },
];

const UNSUPPORTED_REGISTRY_COMMANDS = new Map([
  ['exit', '/exit quits the terminal channel; stop Office from the terminal instead'],
  ['quit', '/quit quits the terminal channel; stop Office from the terminal instead'],
  ['q', '/q quits the terminal channel; stop Office from the terminal instead'],
]);

export async function handleProviders(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  const active = ctx.session.providers.getActiveName();
  reply(
    res,
    200,
    ctx.session.providers.list().map((provider) => ({
      id: provider.name,
      display_name: provider.name,
      enabled: !active || provider.name === active,
      api_base: null,
    })),
  );
}

export async function handleProviderModels(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  const providerId = pathPart(req, 3);
  const provider = ctx.session.providers.list().find((entry) => entry.name === providerId);
  if (!provider) {
    reply(res, 404, { error: 'not_found', message: `provider not found: ${providerId}` });
    return;
  }
  reply(
    res,
    200,
    provider.models.map((model) => ({
      provider_id: provider.name,
      model_id: model.id,
      display_name: model.id,
      metadata: {
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        supportsTools: model.supportsTools,
        supportsStreaming: model.supportsStreaming,
      },
    })),
  );
}

export async function handleGraveyard(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  reply(res, 200, officeRuntime(ctx).graveyard());
}

export async function handleCommands(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  reply(res, 200, buildCommandCatalog(ctx.session));
}

export async function handleRunCommand(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  let body: z.infer<typeof commandRequestSchema>;
  try {
    const raw = await readBody(req);
    body = commandRequestSchema.parse(raw.trim() ? JSON.parse(raw) : {});
  } catch (err) {
    reply(res, 400, { error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
    return;
  }

  const parsed = parseSlashCommand(body.command);
  if (!parsed) {
    reply(res, 400, { error: 'bad_request', message: 'command must start with /' });
    return;
  }
  const unsupported = unsupportedReason(parsed.name);
  if (unsupported) {
    reply(res, 409, { error: 'unsupported', message: unsupported });
    return;
  }

  try {
    const output = await executeOfficeCommand(
      parsed.name,
      parsed.args,
      body.agent_id,
      body.origin_id ?? createOfficeOriginId(),
      ctx,
    );
    if (output.kind === 'unsupported') {
      reply(res, 409, { error: 'unsupported', message: output.message });
      return;
    }
    reply(res, 200, output);
  } catch (err) {
    reply(res, 500, {
      error: 'command_failed',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

type OfficeCommandOutput =
  | { kind: 'text'; text: string }
  | { kind: 'notice'; message: string }
  | { kind: 'client_action'; action: 'reset_session' | 'reset_agent' | 'clear_agent_timeline'; agent_id: string; notice: string }
  | { kind: 'options'; title: string; options: Array<{ id: string; label: string; group?: string; current?: boolean; description?: string }> }
  | { kind: 'error'; message: string }
  | { kind: 'noop' }
  | { kind: 'unsupported'; message: string };

function buildCommandCatalog(session: Session): OfficeCommandDescriptor[] {
  const registry = session.commands
    .listForChannel('tui')
    .map((command) => {
      const unsupported = unsupportedReason(command.name);
      return {
        name: command.name,
        command: `/${command.name}`,
        description: command.description,
        ...(command.aliases ? { aliases: command.aliases } : {}),
        supported: !unsupported,
        ...(unsupported ? { reason: unsupported } : {}),
      };
    });
  const seen = new Set(registry.map((command) => command.name));
  const local = OFFICE_LOCAL_COMMANDS.filter((command) => !seen.has(command.name));
  return [...registry, ...local].sort((a, b) => a.name.localeCompare(b.name));
}

function parseSlashCommand(raw: string): { name: string; args: string } | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/')) return null;
  const [head = '', ...rest] = trimmed.split(/\s+/);
  const name = head.slice(1).trim();
  if (!name) return null;
  return { name, args: rest.join(' ').trim() };
}

function unsupportedReason(name: string): string | null {
  const direct = UNSUPPORTED_REGISTRY_COMMANDS.get(name);
  if (direct) return direct;
  const local = OFFICE_LOCAL_COMMANDS.find((command) =>
    command.name === name || command.aliases?.includes(name),
  );
  if (local && !local.supported) return local.reason ?? `/${name} is not supported in Office`;
  return null;
}

async function executeOfficeCommand(
  name: string,
  args: string,
  agentId: string,
  originId: string,
  ctx: RouterContext,
): Promise<OfficeCommandOutput> {
  switch (name) {
    case 'new': {
      if (agentId !== 'session') {
        return {
          kind: 'unsupported',
          message: '/new starts a new main session; use /clear for an Office Agent timeline',
        };
      }
      const notice = 'new session — conversation history cleared';
      ctx.session.log.clear();
      await appendCommandSessionAction(ctx.session, {
        command: '/new',
        action: 'new',
        target: 'session',
        origin_channel: 'office',
        origin_id: originId,
        notice,
      });
      return {
        kind: 'client_action',
        action: 'reset_session',
        agent_id: 'session',
        notice,
      };
    }
    case 'clear':
      return {
        kind: 'client_action',
        action: 'clear_agent_timeline',
        agent_id: agentId,
        notice: 'Chat and logs cleared for this agent.',
      };
    case 'help':
      return { kind: 'text', text: formatCommandHelp(buildCommandCatalog(ctx.session)) };
    case 'tools':
      return { kind: 'text', text: formatTools(ctx.session) };
    case 'skills':
      return { kind: 'text', text: formatSkills(ctx.session) };
    case 'agents':
      return { kind: 'text', text: formatAgents(officeRuntime(ctx).list()) };
    case 'model':
      return switchModelWithSync(ctx.session, args, originId);
    case 'loop':
      return switchLoopWithSync(ctx.session, args, originId);
    case 'mcp':
      return { kind: 'text', text: formatMcpTools(ctx.session) };
    default:
      return runRegistryCommand(ctx.session, name, args);
  }
}

function createOfficeOriginId(): string {
  return `office-${randomUUID()}`;
}

const COMMAND_PLUGIN_ID = asPluginId('@moxxy/plugin-commands');

async function appendCommandSessionAction(
  session: Session,
  payload: CommandSessionActionPayload,
): Promise<void> {
  const writable = coreSession(session);
  await writable.log.append({
    type: 'plugin_event',
    sessionId: writable.id,
    turnId: writable.startTurn().turnId,
    source: 'plugin',
    pluginId: COMMAND_PLUGIN_ID,
    subtype: COMMAND_SESSION_ACTION_SUBTYPE,
    payload,
  });
}

async function appendCommandStateChanged(
  session: Session,
  payload: CommandStateChangedPayload,
): Promise<void> {
  const writable = coreSession(session);
  await writable.log.append({
    type: 'plugin_event',
    sessionId: writable.id,
    turnId: writable.startTurn().turnId,
    source: 'plugin',
    pluginId: COMMAND_PLUGIN_ID,
    subtype: COMMAND_STATE_CHANGED_SUBTYPE,
    payload,
  });
}

async function runRegistryCommand(session: Session, name: string, args: string): Promise<OfficeCommandOutput> {
  const registered = session.commands.get(name);
  if (!registered) return { kind: 'error', message: `unknown command: /${name}` };
  const result = await registered.handler({
    channel: 'tui',
    sessionId: session.id,
    args,
    session,
  });
  if (result.kind === 'text' || result.kind === 'error' || result.kind === 'noop') return result;
  if (result.kind === 'session-action') {
    return {
      kind: 'unsupported',
      message: `/${name} returned channel action "${result.action}", which Office handles explicitly`,
    };
  }
  return { kind: 'noop' };
}

function formatCommandHelp(commands: ReadonlyArray<OfficeCommandDescriptor>): string {
  const longest = commands.reduce((max, command) => Math.max(max, command.name.length), 0);
  return commands
    .map((command) => {
      const disabled = command.supported ? '' : ` (${command.reason ?? 'unsupported'})`;
      return `/${command.name.padEnd(longest)}  ${command.description}${disabled}`;
    })
    .join('\n');
}

function formatTools(session: Session): string {
  const tools = session.tools.list();
  if (tools.length === 0) return 'no tools registered';
  return tools.map((tool) => `/${tool.name}`).join('\n');
}

function formatSkills(session: Session): string {
  const skills = session.skills.list();
  if (skills.length === 0) return 'no skills discovered';
  return skills
    .map((skill) => {
      const record = skill as unknown as Record<string, unknown>;
      return typeof record.name === 'string'
        ? record.name
        : typeof record.id === 'string'
          ? record.id
          : JSON.stringify(record);
    })
    .join('\n');
}

function formatAgents(agents: ReadonlyArray<{ id: string; name: string; kind: string; status: string }>): string {
  if (agents.length === 0) return 'no agents';
  return agents.map((agent) => `${agent.id}  ${agent.kind}  ${agent.status}  ${agent.name}`).join('\n');
}

function formatMcpTools(session: Session): string {
  const grouped = new Map<string, string[]>();
  for (const tool of session.tools.list()) {
    const match = /^mcp__([^_]+)__/.exec(tool.name);
    if (!match) continue;
    const list = grouped.get(match[1]!) ?? [];
    list.push(tool.name);
    grouped.set(match[1]!, list);
  }
  if (grouped.size === 0) return 'no MCP tools are registered in this session';
  return [...grouped.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([server, tools]) => `${server}: ${tools.length} tool${tools.length === 1 ? '' : 's'}\n${tools.map((tool) => `  ${tool}`).join('\n')}`)
    .join('\n');
}

async function switchModelWithSync(
  session: Session,
  args: string,
  originId: string,
): Promise<OfficeCommandOutput> {
  const target = resolveModelTarget(session, args);
  const output = await switchModel(session, args);
  if (output.kind === 'notice' && target) {
    await appendCommandStateChanged(session, {
      command: `/model ${target.providerId}::${target.modelId}`,
      action: 'model_changed',
      target: 'session',
      origin_channel: 'office',
      origin_id: originId,
      notice: output.message,
      provider: target.providerId,
      model: target.modelId,
    });
  }
  return output;
}

function resolveModelTarget(
  session: Session,
  args: string,
): { providerId: string; modelId: string } | null {
  const target = args.trim();
  if (!target) return null;
  const providers = session.providers.list();
  const activeProvider = session.providers.getActiveName();
  const activeDef = providers.find((provider) => provider.name === activeProvider) ?? providers[0];
  if (!activeDef) return null;
  const [rawProvider, rawModel] = target.includes('::')
    ? target.split('::', 2)
    : [activeDef.name, target];
  const providerId = rawProvider?.trim();
  const modelId = rawModel?.trim();
  return providerId && modelId ? { providerId, modelId } : null;
}

async function switchLoopWithSync(
  session: Session,
  args: string,
  originId: string,
): Promise<OfficeCommandOutput> {
  const target = args.trim();
  const output = await switchLoop(session, args);
  if (output.kind === 'notice' && target) {
    await appendCommandStateChanged(session, {
      command: `/loop ${target}`,
      action: 'loop_changed',
      target: 'session',
      origin_channel: 'office',
      origin_id: originId,
      notice: output.message,
      loop: target,
    });
  }
  return output;
}

async function switchModel(session: Session, args: string): Promise<OfficeCommandOutput> {
  const providers = session.providers.list();
  if (providers.length === 0) return { kind: 'error', message: 'no providers registered' };
  const activeProvider = session.providers.getActiveName();
  const activeDef = providers.find((provider) => provider.name === activeProvider) ?? providers[0]!;
  const activeModel = activeDef.models[0]?.id ?? 'default';

  if (!args.trim()) {
    return {
      kind: 'options',
      title: 'Switch model',
      options: providers.flatMap((provider) =>
        provider.models.map((model) => ({
          id: `${provider.name}::${model.id}`,
          label: model.id,
          group: provider.name,
          current: provider.name === activeDef.name && model.id === activeModel,
          ...(model.contextWindow ? { description: `${model.contextWindow} ctx` } : {}),
        })),
      ),
    };
  }

  const target = args.trim();
  const [rawProvider, rawModel] = target.includes('::')
    ? target.split('::', 2)
    : [activeDef.name, target];
  const providerId = rawProvider?.trim();
  const modelId = rawModel?.trim();
  const provider = providers.find((entry) => entry.name === providerId);
  const model = provider?.models.find((entry) => entry.id === modelId);
  if (!provider || !model || !providerId || !modelId) {
    return { kind: 'error', message: `unknown model: ${target}` };
  }

  const ready = (session as unknown as { readyProviders?: Set<string> }).readyProviders;
  if (ready && ready.size > 0 && !ready.has(providerId)) {
    return { kind: 'error', message: `${providerId} is not connected` };
  }

  if (providerId !== activeProvider) {
    const resolver = (session as unknown as {
      credentialResolver?: (name: string) => Promise<Record<string, unknown>>;
    }).credentialResolver;
    const cfg = resolver ? await resolver(providerId) : {};
    session.providers.replace(provider);
    session.providers.setActive(providerId, cfg);
  }
  await savePreferences({ providerName: providerId, model: modelId });
  return { kind: 'notice', message: `switched to ${providerId}::${modelId}` };
}

async function switchLoop(session: Session, args: string): Promise<OfficeCommandOutput> {
  const modes = session.modes.list();
  if (modes.length === 0) return { kind: 'error', message: 'no modes registered' };
  if (!args.trim()) {
    const active = session.modes.getActive().name;
    return {
      kind: 'options',
      title: 'Switch mode',
      options: modes.map((mode) => ({
        id: mode.name,
        label: mode.name,
        current: mode.name === active,
      })),
    };
  }
  const target = args.trim();
  session.modes.setActive(target);
  await savePreferences({ mode: target });
  return { kind: 'notice', message: `mode -> ${target}` };
}

export async function handleAgents(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  reply(res, 200, officeRuntime(ctx).list());
}

export async function handleCreateAgent(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  let body: unknown = {};
  try {
    const raw = await readBody(req);
    body = raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    reply(res, 400, { error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
    return;
  }
  const input = z.object({
    name: z.string().optional(),
    agent_type: z.string().optional(),
    instructions: z.string().optional(),
    model: z.string().optional(),
    allowed_tools: z.array(z.string()).optional(),
  }).parse(body);
  reply(res, 200, await officeRuntime(ctx).create(input));
}

export async function handleGetAgent(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  const agent = officeRuntime(ctx).get(pathPart(req, 3));
  if (!agent) {
    reply(res, 404, { error: 'not_found', message: 'agent not found' });
    return;
  }
  reply(res, 200, agent);
}

export async function handleDeleteAgent(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  const id = pathPart(req, 3);
  if (id === 'session') {
    reply(res, 409, { error: 'unsupported', message: 'the active moxxy session cannot be dismissed' });
    return;
  }
  const dismissed = await officeRuntime(ctx).dismiss(id);
  if (!dismissed) {
    reply(res, 404, { error: 'not_found', message: 'agent not found' });
    return;
  }
  reply(res, 200, { ok: true });
}

export async function handleStopAgent(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  const result = officeRuntime(ctx).stop(pathPart(req, 3));
  if (result === 'unsupported') {
    reply(res, 409, { error: 'unsupported', message: 'the active moxxy session cannot be stopped through this endpoint' });
    return;
  }
  if (result === 'not_found') {
    reply(res, 404, { error: 'not_found', message: 'agent not found' });
    return;
  }
  if (result === 'not_running') {
    reply(res, 409, { error: 'not_running', message: 'agent has no active run' });
    return;
  }
  reply(res, 200, { ok: true });
}

export async function handleAgentHistory(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  const id = pathPart(req, 3);
  if (id === 'session') {
    reply(res, 200, historyFromSessionLog(ctx.session, readHistoryLimit(req)));
    return;
  }
  const history = officeRuntime(ctx).history(id);
  if (!history) {
    reply(res, 404, { error: 'not_found', message: 'agent not found' });
    return;
  }
  reply(res, 200, history);
}

function readHistoryLimit(req: IncomingMessage): number {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const raw = Number(url.searchParams.get('limit') ?? 50);
  if (!Number.isInteger(raw) || raw < 1) return 50;
  return Math.min(raw, 500);
}

interface SessionHistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  content: string;
  run_id: string | null;
  timestamp: number;
  created_at: string;
}

function historyFromSessionLog(session: Session, limit: number): {
  messages: SessionHistoryMessage[];
} {
  const messages: SessionHistoryMessage[] = [];
  for (const event of session.log.toJSON()) {
    if (event.type === 'user_prompt') {
      messages.push({
        id: String(event.id),
        role: 'user',
        text: event.text,
        content: event.text,
        run_id: String(event.turnId),
        timestamp: event.ts,
        created_at: new Date(event.ts).toISOString(),
      });
      continue;
    }
    if (event.type === 'assistant_message') {
      messages.push({
        id: String(event.id),
        role: 'assistant',
        text: event.content,
        content: event.content,
        run_id: String(event.turnId),
        timestamp: event.ts,
        created_at: new Date(event.ts).toISOString(),
      });
    }
  }

  return { messages: messages.filter((message) => message.text.trim().length > 0).slice(-limit) };
}

export async function handleResetAgent(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  const id = pathPart(req, 3) || 'session';
  const agent = officeRuntime(ctx).reset(id);
  if (!agent) {
    reply(res, 404, { error: 'not_found', message: 'agent not found' });
    return;
  }
  reply(res, 200, { agent_name: agent.name, status: agent.status });
}

export async function handleAgentRun(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  let body: { task: string };
  try {
    const raw = await readBody(req);
    body = z.object({ task: z.string().min(1) }).parse(JSON.parse(raw));
  } catch (err) {
    reply(res, 400, { error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
    return;
  }

  const agentId = pathPart(req, 3) || 'session';
  if (agentId !== 'session') {
    const started = officeRuntime(ctx).startRun(agentId, body.task);
    if (started === 'not_found') {
      reply(res, 404, { error: 'not_found', message: 'agent not found' });
      return;
    }
    if (started === 'already_running') {
      reply(res, 409, { error: 'already_running', message: 'agent already has an active run' });
      return;
    }
    reply(res, 200, started);
    return;
  }

  void (async () => {
    try {
      for await (const event of runTurn(coreSession(ctx.session), body.task)) {
        void event;
      }
    } catch (err) {
      ctx.logger?.warn('http virtual office run failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  reply(res, 200, {
    agent_id: agentId,
    run_id: null,
    task: body.task,
    status: 'running',
  });
}

export async function handleVirtualOfficeEvents(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(': connected\n\n');

  const unsubscribe = ctx.session.log.subscribe((event) => {
    const envelope = eventToVirtualOfficeEnvelope(event, 'session');
    if (!envelope) return;
    res.write(`data: ${JSON.stringify(envelope)}\n\n`);
  });
  const unsubscribeOffice = officeRuntime(ctx).subscribe((envelope) => {
    res.write(`data: ${JSON.stringify(envelope)}\n\n`);
  });

  try {
    await new Promise<void>((resolve) => {
      res.once('close', resolve);
    });
  } finally {
    unsubscribe();
    unsubscribeOffice();
  }
}

export async function handleTurn(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }

  let body: TurnRequest;
  try {
    const raw = await readBody(req);
    body = turnRequestSchema.parse(JSON.parse(raw));
  } catch (err) {
    reply(res, 400, { error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
    return;
  }

  const events: MoxxyEvent[] = [];
  try {
    for await (const event of ctx.session.runTurn(body.prompt, {
      ...(body.model ? { model: body.model } : {}),
      ...(body.systemPrompt ? { systemPrompt: body.systemPrompt } : {}),
    })) {
      events.push(event);
    }
  } catch (err) {
    reply(res, 500, { error: 'turn_failed', message: err instanceof Error ? err.message : String(err) });
    return;
  }

  const finalAssistant = events.findLast?.((e) => e.type === 'assistant_message');
  const assistant =
    finalAssistant && finalAssistant.type === 'assistant_message' ? finalAssistant.content : '';
  reply(res, 200, { events, assistant });
}

/**
 * Audio-in turn. Designed for iOS Shortcuts and curl: the client POSTs
 * raw audio bytes with `Content-Type: audio/<format>`. Optional query
 * params (`model`, `language`, `systemPrompt`) tune the run.
 *
 * The session must have an active Transcriber registered (e.g. via
 * `@moxxy/plugin-stt-whisper`); without one the endpoint returns 503
 * rather than transparently dropping the audio.
 */
export async function handleTurnAudio(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }

  const transcriber = ctx.session.transcribers.tryGetActive();
  if (!transcriber) {
    reply(res, 503, {
      error: 'no_transcriber',
      message:
        'No active Transcriber on this session. Install @moxxy/plugin-stt-whisper (or another transcriber plugin) and activate it before POSTing audio.',
    });
    return;
  }

  const contentType = (req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('audio/')) {
    reply(res, 415, {
      error: 'unsupported_media_type',
      message: "Expected Content-Type: audio/* (e.g. audio/ogg, audio/m4a, audio/mpeg).",
    });
    return;
  }

  let bytes: Buffer;
  try {
    bytes = await readRequestBody(req, DEFAULT_AUDIO_MAX);
  } catch (err) {
    reply(res, 413, { error: 'payload_too_large', message: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (bytes.length === 0) {
    reply(res, 400, { error: 'empty_body', message: 'audio body is empty' });
    return;
  }

  // Pull tuning params off the query string — keeping them out of the
  // body lets the payload remain raw audio (cleanest curl / Shortcut flow).
  const url = new URL(req.url ?? '/', 'http://localhost');
  const model = url.searchParams.get('model') ?? undefined;
  const language = url.searchParams.get('language') ?? undefined;
  const promptHint = url.searchParams.get('prompt') ?? undefined;
  const systemPrompt = url.searchParams.get('systemPrompt') ?? undefined;

  let transcript: string;
  try {
    const result = await transcriber.transcribe(new Uint8Array(bytes), {
      mimeType: contentType,
      ...(language ? { language } : {}),
      ...(promptHint ? { prompt: promptHint } : {}),
    });
    transcript = result.text.trim();
  } catch (err) {
    ctx.logger?.warn('http audio transcription failed', { err: err instanceof Error ? err.message : String(err) });
    reply(res, 502, { error: 'transcription_failed', message: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!transcript) {
    reply(res, 422, { error: 'empty_transcript', message: 'transcriber returned empty text' });
    return;
  }

  const events: MoxxyEvent[] = [];
  try {
    for await (const event of ctx.session.runTurn(transcript, {
      ...(model ? { model } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
    })) {
      events.push(event);
    }
  } catch (err) {
    reply(res, 500, { error: 'turn_failed', message: err instanceof Error ? err.message : String(err) });
    return;
  }

  const finalAssistant = events.findLast?.((e) => e.type === 'assistant_message');
  const assistant =
    finalAssistant && finalAssistant.type === 'assistant_message' ? finalAssistant.content : '';
  reply(res, 200, { transcript, events, assistant });
}

export async function handleTurnStream(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }

  let body: TurnRequest;
  try {
    const raw = await readBody(req);
    body = turnRequestSchema.parse(JSON.parse(raw));
  } catch (err) {
    reply(res, 400, { error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  // Abort the turn when the client hangs up — without this the model keeps
  // generating (and billing) with nothing consuming the SSE stream.
  const controller = new AbortController();
  const onClose = (): void => controller.abort();
  res.on('close', onClose);

  const writeEvent = (event: MoxxyEvent): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    for await (const event of ctx.session.runTurn(body.prompt, {
      ...(body.model ? { model: body.model } : {}),
      ...(body.systemPrompt ? { systemPrompt: body.systemPrompt } : {}),
      signal: controller.signal,
    })) {
      writeEvent(event);
    }
    res.write('data: [DONE]\n\n');
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: err instanceof Error ? err.message : String(err) })}\n\n`);
  } finally {
    res.off('close', onClose);
    res.end();
  }
}
