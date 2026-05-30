import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import {
  CODEX_TRANSCRIBER_NAME,
  checkCodexTranscriptionReady,
  formatCodexTranscriptionReadiness,
  resolveCodexTranscriber,
  runTurn,
  savePreferences,
  type Session as CoreSession,
} from '@moxxy/core';
import {
  asPluginId,
  readRequestBody,
  bearerTokenMatches,
  type ClientSession as Session,
  type CommandSessionActionPayload,
  type CommandStateChangedPayload,
  type ModelDescriptor,
  type MoxxyEvent,
  type ProviderDef,
  type UserPromptAttachment,
  type Workflow,
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

const IMAGE_ATTACHMENT_MAX = 10 * 1024 * 1024;
const MEDIA_PREVIEW_MAX = 10 * 1024 * 1024;
const AGENT_RUN_BODY_MAX =
  (4 * Math.ceil((IMAGE_ATTACHMENT_MAX * 4) / 3)) + (1024 * 1024);
const imageAttachmentSchema = z.object({
  kind: z.literal('image'),
  content: z.string().min(1),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  name: z.string().optional(),
}).superRefine((attachment, ctx) => {
  const size = Buffer.from(attachment.content, 'base64').length;
  if (size > IMAGE_ATTACHMENT_MAX) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'image attachment exceeds 10 MB',
      path: ['content'],
    });
  }
});

const agentRunRequestSchema = z.object({
  task: z.string().min(1),
  attachments: z.array(imageAttachmentSchema).max(4).optional(),
});

const commandRequestSchema = z.object({
  agent_id: z.string().min(1).default('session'),
  command: z.string().min(1),
  origin_id: z.string().min(1).optional(),
});

const vaultCreateRequestSchema = z.object({
  key_name: z.string().min(1),
  backend_key: z.string().min(1).optional(),
  value: z.string().min(1),
  policy_label: z.string().min(1).optional(),
});

const mcpServerCreateRequestSchema = z.object({
  id: z.string().min(1),
  transport: z.enum(['stdio', 'sse', 'streamable_http']),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string()).optional(),
  env: z.record(z.string()).optional(),
}).superRefine((value, ctx) => {
  if (value.transport === 'stdio' && !value.command) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'command is required for stdio MCP servers',
      path: ['command'],
    });
  }
  if (value.transport !== 'stdio' && !value.url) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'url is required for remote MCP servers',
      path: ['url'],
    });
  }
});

const workflowCreateRequestSchema = z.object({
  workflow: z.unknown(),
  scope: z.enum(['user', 'project']).optional(),
});

const workflowUpdateRequestSchema = z.object({
  workflow: z.unknown(),
});

const workflowDraftRequestSchema = z.object({
  intent: z.string().min(1),
});

const workflowValidateRequestSchema = z.object({
  workflow: z.unknown(),
});

const workflowEnabledRequestSchema = z.object({
  enabled: z.boolean(),
});

const scheduleSourceQuerySchema = z.enum(['all', 'manual', 'skill', 'workflow']).default('all');

const scheduleCreateRequestSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
  cron: z.string().optional(),
  runAt: z.union([z.number(), z.string()]).optional(),
  timeZone: z.string().optional(),
  channel: z.string().optional(),
  model: z.string().optional(),
  enabled: z.boolean().optional(),
});

const scheduleUpdateRequestSchema = z.object({
  name: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  cron: z.string().nullable().optional(),
  runAt: z.union([z.number(), z.string()]).nullable().optional(),
  timeZone: z.string().nullable().optional(),
  channel: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

const scheduleEnabledRequestSchema = z.object({
  enabled: z.boolean(),
});

const deskIdSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/);

const deskStateSchema = z.object({
  version: z.number().int().min(1).default(1),
}).passthrough();

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
  if (req.method === 'GET' && pathname === '/v1/input-capabilities') return handleInputCapabilities;
  if (req.method === 'POST' && pathname === '/v1/transcriptions') return handleTranscription;
  if (req.method === 'GET' && pathname === '/v1/media/preview') return handleMediaPreview;
  if (req.method === 'GET' && pathname === '/v1/session-selection') return handleSessionSelection;
  if (req.method === 'GET' && pathname === '/v1/providers') return handleProviders;
  if (req.method === 'GET' && /^\/v1\/providers\/[^/]+\/models$/.test(pathname)) return handleProviderModels;
  if (req.method === 'GET' && pathname === '/v1/graveyard') return handleGraveyard;
  if (req.method === 'GET' && pathname === '/v1/commands') return handleCommands;
  if (req.method === 'POST' && pathname === '/v1/commands') return handleRunCommand;
  if (req.method === 'GET' && pathname === '/v1/schedules') return handleSchedulesList;
  if (req.method === 'POST' && pathname === '/v1/schedules') return handleScheduleCreate;
  if (req.method === 'POST' && /^\/v1\/schedules\/[^/]+\/enabled$/.test(pathname)) return handleScheduleSetEnabled;
  if (req.method === 'POST' && /^\/v1\/schedules\/[^/]+\/run$/.test(pathname)) return handleScheduleRun;
  if (req.method === 'PUT' && /^\/v1\/schedules\/[^/]+$/.test(pathname)) return handleScheduleUpdate;
  if (req.method === 'DELETE' && /^\/v1\/schedules\/[^/]+$/.test(pathname)) return handleScheduleDelete;
  if (req.method === 'GET' && pathname === '/v1/workflows') return handleWorkflowsList;
  if (req.method === 'GET' && pathname === '/v1/workflows/capabilities') return handleWorkflowsCapabilities;
  if (req.method === 'POST' && pathname === '/v1/workflows/draft') return handleWorkflowDraft;
  if (req.method === 'POST' && pathname === '/v1/workflows/validate') return handleWorkflowValidate;
  if (req.method === 'POST' && pathname === '/v1/workflows') return handleWorkflowCreate;
  if (req.method === 'POST' && /^\/v1\/desk\/[^/]+\/workflows\/office-flow\/run$/.test(pathname)) {
    return handleDeskOfficeFlowRun;
  }
  if (req.method === 'GET' && /^\/v1\/desk\/[^/]+$/.test(pathname)) return handleDeskGet;
  if (req.method === 'PUT' && /^\/v1\/desk\/[^/]+$/.test(pathname)) return handleDeskPut;
  if (req.method === 'POST' && /^\/v1\/workflows\/[^/]+\/enabled$/.test(pathname)) return handleWorkflowSetEnabled;
  if (req.method === 'POST' && /^\/v1\/workflows\/runs\/[^/]+\/reply$/.test(pathname)) {
    return handleWorkflowRunReply;
  }
  if (req.method === 'POST' && /^\/v1\/workflows\/[^/]+\/run$/.test(pathname)) return handleWorkflowRun;
  if (req.method === 'GET' && /^\/v1\/workflows\/[^/]+$/.test(pathname)) return handleWorkflowGet;
  if (req.method === 'PUT' && /^\/v1\/workflows\/[^/]+$/.test(pathname)) return handleWorkflowUpdate;
  if (req.method === 'DELETE' && /^\/v1\/workflows\/[^/]+$/.test(pathname)) return handleWorkflowDelete;
  if (req.method === 'GET' && pathname === '/v1/vault/secrets') return handleVaultListSecrets;
  if (req.method === 'POST' && pathname === '/v1/vault/secrets') return handleVaultCreateSecret;
  if (req.method === 'DELETE' && /^\/v1\/vault\/secrets\/[^/]+$/.test(pathname)) return handleVaultDeleteSecret;
  if (req.method === 'GET' && pathname === '/v1/agents') return handleAgents;
  if (req.method === 'POST' && pathname === '/v1/agents') return handleCreateAgent;
  if (req.method === 'GET' && /^\/v1\/agents\/[^/]+\/mcp$/.test(pathname)) return handleMcpListServers;
  if (req.method === 'POST' && /^\/v1\/agents\/[^/]+\/mcp$/.test(pathname)) return handleMcpAddServer;
  if (req.method === 'POST' && /^\/v1\/agents\/[^/]+\/mcp\/[^/]+\/test$/.test(pathname)) return handleMcpTestServer;
  if (req.method === 'DELETE' && /^\/v1\/agents\/[^/]+\/mcp\/[^/]+$/.test(pathname)) return handleMcpRemoveServer;
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

export async function handleInputCapabilities(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }

  const voice = checkCodexTranscriptionReady(ctx.session);
  const modelInfo = activeModelInfo(ctx.session);
  const codexRegistered = ctx.session.transcribers.has(CODEX_TRANSCRIBER_NAME);
  reply(res, 200, {
    voice: {
      ready: voice.ready,
      reason: voice.ready ? null : formatCodexTranscriptionReadiness(voice),
      transcriber: codexRegistered ? CODEX_TRANSCRIBER_NAME : ctx.session.transcribers.getActiveName(),
    },
    active_model: {
      provider_id: modelInfo.providerId,
      model_id: modelInfo.modelId,
      supports_images: modelInfo.model?.supportsImages === true,
      supports_audio: modelInfo.model?.supportsAudio === true,
    },
  });
}

export async function handleTranscription(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }

  const readiness = checkCodexTranscriptionReady(ctx.session);
  if (!readiness.ready) {
    reply(res, 503, {
      error: 'voice_unavailable',
      message: formatCodexTranscriptionReadiness(readiness),
    });
    return;
  }

  const contentType = (req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('audio/')) {
    reply(res, 415, {
      error: 'unsupported_media_type',
      message: 'Expected Content-Type: audio/*.',
    });
    return;
  }

  let bytes: Buffer;
  try {
    bytes = await readBodyBytes(req, DEFAULT_AUDIO_MAX);
  } catch (err) {
    reply(res, 413, { error: 'payload_too_large', message: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (bytes.length === 0) {
    reply(res, 400, { error: 'empty_body', message: 'audio body is empty' });
    return;
  }

  let transcript: string;
  try {
    const result = await resolveCodexTranscriber(ctx.session).transcribe(new Uint8Array(bytes), {
      mimeType: contentType,
    });
    transcript = result.text.trim();
  } catch (err) {
    ctx.logger?.warn('http voice transcription failed', { err: err instanceof Error ? err.message : String(err) });
    reply(res, 502, { error: 'transcription_failed', message: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!transcript) {
    reply(res, 422, { error: 'empty_transcript', message: 'transcriber returned empty text' });
    return;
  }
  reply(res, 200, { transcript });
}

export async function handleMediaPreview(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }

  const source = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('source');
  const requestedPath = source ? localPathFromMediaSource(source) : null;
  if (!requestedPath) {
    reply(res, 400, {
      error: 'bad_request',
      message: 'source must be a file:// URL or an absolute local path',
    });
    return;
  }

  const contentType = mediaPreviewContentType(requestedPath);
  if (!contentType) {
    reply(res, 415, { error: 'unsupported_media_type', message: 'only png, jpg, jpeg, webp, and gif previews are supported' });
    return;
  }

  let resolvedPath: string;
  let fileInfo: Awaited<ReturnType<typeof stat>>;
  try {
    resolvedPath = await realpath(requestedPath);
    fileInfo = await stat(resolvedPath);
  } catch {
    reply(res, 404, { error: 'not_found', message: 'media file not found' });
    return;
  }

  if (!fileInfo.isFile()) {
    reply(res, 404, { error: 'not_found', message: 'media file not found' });
    return;
  }
  if (fileInfo.size > MEDIA_PREVIEW_MAX) {
    reply(res, 413, { error: 'payload_too_large', message: 'media preview exceeds 10 MB' });
    return;
  }

  const allowed = await referencedMediaRealpaths(ctx.session);
  if (!allowed.has(resolvedPath)) {
    reply(res, 403, { error: 'forbidden', message: 'media source is not referenced by this session' });
    return;
  }

  const bytes = await readFile(resolvedPath);
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': bytes.length,
    'cache-control': 'no-store',
  });
  res.end(bytes);
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

async function readBodyBytes(req: IncomingMessage, max: number): Promise<Buffer> {
  return readRequestBody(req, max);
}

/** Audio uploads need a much larger cap than JSON; 10 MB covers a few
 *  minutes of Opus voice (Telegram caps voice notes at 50 MB, but
 *  realistic notes are well under that). */
const DEFAULT_AUDIO_MAX = 10 * 1024 * 1024;

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const MEDIA_PREVIEW_EXT_RE = /\.(?:png|jpe?g|webp|gif)$/i;
const FILE_URL_IMAGE_RE = /file:\/\/(?:localhost)?\/[^\s'"<>)]*?\.(?:png|jpe?g|webp|gif)(?:[?#][^\s'"<>)]*)?/gi;
const ABSOLUTE_IMAGE_PATH_RE = /\/[^\n\r'"<>)]*?\.(?:png|jpe?g|webp|gif)/gi;

function mediaPreviewContentType(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return null;
  }
}

function localPathFromMediaSource(source: string): string | null {
  const trimmed = source.trim();
  if (trimmed.startsWith('file://')) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return null;
    }
  }
  const decoded = safeDecodeUri(trimmed);
  return path.isAbsolute(decoded) ? decoded : null;
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

async function referencedMediaRealpaths(session: Session): Promise<ReadonlySet<string>> {
  const sources = new Set<string>();
  const strings: string[] = [];
  collectStrings(session.log.toJSON(), strings);
  for (const text of strings) {
    for (const source of extractLocalMediaSources(text)) {
      sources.add(source);
    }
  }

  const realpaths = new Set<string>();
  for (const source of sources) {
    const localPath = localPathFromMediaSource(source);
    if (!localPath || !MEDIA_PREVIEW_EXT_RE.test(localPath)) continue;
    try {
      realpaths.add(await realpath(localPath));
    } catch {
      // Missing historical files should not prevent other referenced media
      // from being previewed.
    }
  }
  return realpaths;
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
}

function extractLocalMediaSources(text: string): string[] {
  const sources = new Set<string>();
  for (const match of text.matchAll(FILE_URL_IMAGE_RE)) {
    if (match[0]) sources.add(match[0]);
  }
  for (const match of text.matchAll(ABSOLUTE_IMAGE_PATH_RE)) {
    if (match[0]) sources.add(match[0]);
  }
  return [...sources];
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

function activeModelInfo(session: Session, providerId?: string, modelId?: string): {
  provider: ProviderDef | null;
  providerId: string;
  model: ModelDescriptor | null;
  modelId: string;
} {
  const activeName = session.providers.getActiveName();
  const providers = session.providers.list();
  const provider = providers.find((entry) => entry.name === providerId)
    ?? providers.find((entry) => entry.name === activeName)
    ?? providers[0]
    ?? null;
  const model = provider?.models.find((entry) => entry.id === modelId)
    ?? provider?.models[0]
    ?? null;
  return {
    provider,
    providerId: provider?.name ?? providerId ?? activeName ?? 'none',
    model,
    modelId: model?.id ?? modelId ?? 'default',
  };
}

type ImagePromptAttachment = UserPromptAttachment & {
  kind: 'image';
  content: string;
  mediaType: string;
  name?: string;
};

interface MaterializedImageAttachment {
  readonly name: string;
  readonly mediaType: string;
  readonly path: string;
}

function imageAttachments(attachments: ReadonlyArray<UserPromptAttachment> | undefined): ReadonlyArray<ImagePromptAttachment> {
  return (attachments ?? []).filter((attachment): attachment is ImagePromptAttachment => attachment.kind === 'image');
}

function supportsImageAttachments(session: Session, providerId?: string, modelId?: string): boolean {
  return activeModelInfo(session, providerId, modelId).model?.supportsImages === true;
}

async function imageAttachmentToolHint(
  session: Session,
  attachments: ReadonlyArray<UserPromptAttachment>,
): Promise<string | undefined> {
  const files = await materializeImageAttachmentsForTools(session, attachments);
  if (files.length === 0) return undefined;
  const lines = files.map((file, index) => `${index + 1}. ${file.name}: ${file.path} (${file.mediaType})`);
  return [
    'Virtual Office uploaded image attachments are also available as local file paths for tools:',
    ...lines,
    '',
    'Use these paths only when a tool or skill requires a local image path. The images are already attached inline for visual understanding.',
  ].join('\n');
}

async function materializeImageAttachmentsForTools(
  session: Session,
  attachments: ReadonlyArray<UserPromptAttachment>,
): Promise<ReadonlyArray<MaterializedImageAttachment>> {
  const images = imageAttachments(attachments);
  if (images.length === 0) return [];

  const dir = sessionMediaDir(session);
  await mkdir(dir, { recursive: true });

  const files: MaterializedImageAttachment[] = [];
  for (const [index, attachment] of images.entries()) {
    const filename = attachmentFilename(attachment, index);
    const filePath = path.join(dir, filename);
    await writeFile(filePath, Buffer.from(attachment.content, 'base64'), { flag: 'wx' });
    files.push({
      name: safeAttachmentDisplayName(attachment.name, filename),
      mediaType: attachment.mediaType,
      path: filePath,
    });
  }
  return files;
}

function sessionMediaDir(session: Session): string {
  return path.join(moxxyHome(), 'media', String(session.id));
}

function moxxyHome(): string {
  const configured = process.env.MOXXY_HOME?.trim();
  return configured ? configured : path.join(homedir(), '.moxxy');
}

function attachmentFilename(attachment: ImagePromptAttachment, index: number): string {
  const base = safeAttachmentBaseName(attachment.name, index);
  return `${String(index + 1).padStart(2, '0')}-${randomUUID()}-${base}${extensionForMediaType(attachment.mediaType)}`;
}

function safeAttachmentBaseName(name: string | undefined, index: number): string {
  const fallback = `image-${index + 1}`;
  const parsed = path.parse(path.basename(name ?? fallback)).name || fallback;
  const safe = parsed
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return safe || fallback;
}

function safeAttachmentDisplayName(name: string | undefined, fallback: string): string {
  const normalized = (name ?? fallback).replace(/\\/g, '/');
  return path.basename(normalized) || fallback;
}

function extensionForMediaType(mediaType: string): string {
  switch (mediaType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    case 'image/png':
    default:
      return '.png';
  }
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
        supportsImages: model.supportsImages === true,
        supportsAudio: model.supportsAudio === true,
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

function workflowsView(res: ServerResponse, ctx: RouterContext): NonNullable<Session['workflows']> | null {
  if (ctx.session.workflows) return ctx.session.workflows;
  reply(res, 404, { error: 'not_found', message: 'workflows are not available in this session' });
  return null;
}

function schedulerView(res: ServerResponse, ctx: RouterContext): NonNullable<Session['scheduler']> | null {
  if (ctx.session.scheduler) return ctx.session.scheduler;
  reply(res, 404, { error: 'not_found', message: 'scheduler is not available in this session' });
  return null;
}

function replyWorkflowError(res: ServerResponse, err: unknown): void {
  reply(res, 502, {
    error: 'workflow_failed',
    message: err instanceof Error ? err.message : String(err),
  });
}

function replyScheduleError(res: ServerResponse, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (message === 'read_only_schedule') {
    replyReadOnlySchedule(res);
    return;
  }
  if (message === 'schedule_not_found') {
    reply(res, 404, { error: 'not_found', message: 'schedule not found' });
    return;
  }
  reply(res, 502, { error: 'schedule_failed', message });
}

function replyReadOnlySchedule(res: ServerResponse): void {
  reply(res, 409, {
    error: 'read_only_schedule',
    message: 'Only manual schedules can be edited from Virtual Office.',
  });
}

async function scheduleForWrite(
  scheduler: NonNullable<Session['scheduler']>,
  id: string,
  res: ServerResponse,
): Promise<boolean> {
  const current = (await scheduler.list({ source: 'all', includeDisabled: true })).find((entry) => entry.id === id);
  if (!current) {
    reply(res, 404, { error: 'not_found', message: 'schedule not found' });
    return false;
  }
  if (current.source !== 'manual' || !current.editable) {
    replyReadOnlySchedule(res);
    return false;
  }
  return true;
}

export async function handleSchedulesList(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  const scheduler = schedulerView(res, ctx);
  if (!scheduler) return;
  let source: z.infer<typeof scheduleSourceQuerySchema>;
  try {
    const url = new URL(req.url ?? '/v1/schedules', 'http://localhost');
    source = scheduleSourceQuerySchema.parse(url.searchParams.get('source') ?? 'all');
  } catch (err) {
    reply(res, 400, { error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
    return;
  }
  const includeDisabled = new URL(req.url ?? '/v1/schedules', 'http://localhost')
    .searchParams.get('includeDisabled') === 'true';
  try {
    reply(res, 200, await scheduler.list({ source, includeDisabled }));
  } catch (err) {
    replyScheduleError(res, err);
  }
}

export async function handleScheduleCreate(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  const scheduler = schedulerView(res, ctx);
  if (!scheduler) return;
  let body: z.infer<typeof scheduleCreateRequestSchema>;
  try {
    const raw = await readBody(req);
    body = scheduleCreateRequestSchema.parse(raw.trim() ? JSON.parse(raw) : {});
  } catch (err) {
    reply(res, 400, { error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
    return;
  }
  try {
    reply(res, 200, await scheduler.create(body));
  } catch (err) {
    replyScheduleError(res, err);
  }
}

export async function handleScheduleUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  const scheduler = schedulerView(res, ctx);
  if (!scheduler) return;
  const id = pathPart(req, 3);
  let body: z.infer<typeof scheduleUpdateRequestSchema>;
  try {
    const raw = await readBody(req);
    body = scheduleUpdateRequestSchema.parse(raw.trim() ? JSON.parse(raw) : {});
  } catch (err) {
    reply(res, 400, { error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
    return;
  }
  try {
    if (!(await scheduleForWrite(scheduler, id, res))) return;
    const updated = await scheduler.update(id, body);
    if (!updated) {
      reply(res, 404, { error: 'not_found', message: 'schedule not found' });
      return;
    }
    reply(res, 200, updated);
  } catch (err) {
    replyScheduleError(res, err);
  }
}

export async function handleScheduleSetEnabled(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  const scheduler = schedulerView(res, ctx);
  if (!scheduler) return;
  const id = pathPart(req, 3);
  let body: z.infer<typeof scheduleEnabledRequestSchema>;
  try {
    const raw = await readBody(req);
    body = scheduleEnabledRequestSchema.parse(raw.trim() ? JSON.parse(raw) : {});
  } catch (err) {
    reply(res, 400, { error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
    return;
  }
  try {
    if (!(await scheduleForWrite(scheduler, id, res))) return;
    const updated = await scheduler.setEnabled(id, body.enabled);
    if (!updated) {
      reply(res, 404, { error: 'not_found', message: 'schedule not found' });
      return;
    }
    reply(res, 200, updated);
  } catch (err) {
    replyScheduleError(res, err);
  }
}

export async function handleScheduleDelete(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  const scheduler = schedulerView(res, ctx);
  if (!scheduler) return;
  const id = pathPart(req, 3);
  try {
    if (!(await scheduleForWrite(scheduler, id, res))) return;
    reply(res, 200, await scheduler.delete(id));
  } catch (err) {
    replyScheduleError(res, err);
  }
}

export async function handleScheduleRun(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  const scheduler = schedulerView(res, ctx);
  if (!scheduler) return;
  const id = pathPart(req, 3);
  try {
    const exists = (await scheduler.list({ source: 'all', includeDisabled: true })).some((entry) => entry.id === id);
    if (!exists) {
      reply(res, 404, { error: 'not_found', message: 'schedule not found' });
      return;
    }
    reply(res, 200, await scheduler.runNow(id));
  } catch (err) {
    replyScheduleError(res, err);
  }
}

export async function handleWorkflowsList(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  const workflows = workflowsView(res, ctx);
  if (!workflows) return;
  try {
    reply(res, 200, await workflows.list());
  } catch (err) {
    replyWorkflowError(res, err);
  }
}

export async function handleWorkflowsCapabilities(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  const workflows = workflowsView(res, ctx);
  if (!workflows) return;
  try {
    reply(res, 200, await workflows.capabilities());
  } catch (err) {
    replyWorkflowError(res, err);
  }
}

export async function handleWorkflowDraft(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  const workflows = workflowsView(res, ctx);
  if (!workflows) return;
  let body: z.infer<typeof workflowDraftRequestSchema>;
  try {
    const raw = await readBody(req);
    body = workflowDraftRequestSchema.parse(raw.trim() ? JSON.parse(raw) : {});
  } catch (err) {
    reply(res, 400, { error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
    return;
  }
  try {
    reply(res, 200, await workflows.draft(body.intent));
  } catch (err) {
    replyWorkflowError(res, err);
  }
}

export async function handleWorkflowValidate(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  const workflows = workflowsView(res, ctx);
  if (!workflows) return;
  let body: z.infer<typeof workflowValidateRequestSchema>;
  try {
    const raw = await readBody(req);
    body = workflowValidateRequestSchema.parse(raw.trim() ? JSON.parse(raw) : {});
  } catch (err) {
    reply(res, 400, { error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
    return;
  }
  try {
    reply(res, 200, await workflows.validate(body.workflow));
  } catch (err) {
    replyWorkflowError(res, err);
  }
}

export async function handleWorkflowCreate(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  const workflows = workflowsView(res, ctx);
  if (!workflows) return;
  let body: z.infer<typeof workflowCreateRequestSchema>;
  try {
    const raw = await readBody(req);
    body = workflowCreateRequestSchema.parse(raw.trim() ? JSON.parse(raw) : {});
  } catch (err) {
    reply(res, 400, { error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
    return;
  }
  try {
    reply(res, 200, await workflows.create(body.workflow as Workflow, body.scope ?? 'user'));
  } catch (err) {
    replyWorkflowError(res, err);
  }
}

export async function handleWorkflowGet(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  const workflows = workflowsView(res, ctx);
  if (!workflows) return;
  try {
    const detail = await workflows.get(pathPart(req, 3));
    if (!detail) {
      reply(res, 404, { error: 'not_found', message: 'workflow not found' });
      return;
    }
    reply(res, 200, detail);
  } catch (err) {
    replyWorkflowError(res, err);
  }
}

export async function handleWorkflowUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  const workflows = workflowsView(res, ctx);
  if (!workflows) return;
  let body: z.infer<typeof workflowUpdateRequestSchema>;
  try {
    const raw = await readBody(req);
    body = workflowUpdateRequestSchema.parse(raw.trim() ? JSON.parse(raw) : {});
  } catch (err) {
    reply(res, 400, { error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
    return;
  }
  try {
    reply(res, 200, await workflows.update(pathPart(req, 3), body.workflow as Workflow));
  } catch (err) {
    replyWorkflowError(res, err);
  }
}

export async function handleWorkflowDelete(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  const workflows = workflowsView(res, ctx);
  if (!workflows) return;
  try {
    const result = await workflows.delete(pathPart(req, 3));
    reply(res, result.ok ? 200 : 409, result);
  } catch (err) {
    replyWorkflowError(res, err);
  }
}

export async function handleWorkflowSetEnabled(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  const workflows = workflowsView(res, ctx);
  if (!workflows) return;
  let body: z.infer<typeof workflowEnabledRequestSchema>;
  try {
    const raw = await readBody(req);
    body = workflowEnabledRequestSchema.parse(raw.trim() ? JSON.parse(raw) : {});
  } catch (err) {
    reply(res, 400, { error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
    return;
  }
  try {
    await workflows.setEnabled(pathPart(req, 3), body.enabled);
    reply(res, 200, { ok: true });
  } catch (err) {
    replyWorkflowError(res, err);
  }
}

const workflowRunRequestSchema = z.object({
  inputs: z.record(z.unknown()).optional(),
});

export async function handleWorkflowRun(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  const workflows = workflowsView(res, ctx);
  if (!workflows) return;
  let body: z.infer<typeof workflowRunRequestSchema> = {};
  try {
    const raw = await readBody(req);
    if (raw.trim()) body = workflowRunRequestSchema.parse(JSON.parse(raw));
  } catch (err) {
    reply(res, 400, { error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
    return;
  }
  try {
    reply(res, 200, await workflows.run(pathPart(req, 3), body.inputs));
  } catch (err) {
    replyWorkflowError(res, err);
  }
}

const workflowRunReplySchema = z.object({
  message: z.string().min(1),
});

export async function handleWorkflowRunReply(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  const workflows = workflowsView(res, ctx);
  if (!workflows?.reply) {
    reply(res, 404, { error: 'not_found', message: 'workflow reply is not available in this session' });
    return;
  }
  let body: z.infer<typeof workflowRunReplySchema>;
  try {
    const raw = await readBody(req);
    body = workflowRunReplySchema.parse(raw.trim() ? JSON.parse(raw) : {});
  } catch (err) {
    reply(res, 400, { error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
    return;
  }
  try {
    reply(res, 200, await workflows.reply(pathPart(req, 4), body.message));
  } catch (err) {
    replyWorkflowError(res, err);
  }
}

const deskOfficeFlowRunRequestSchema = z.object({
  workflow: z.unknown(),
  inputs: z.record(z.unknown()).optional(),
});

export async function handleDeskOfficeFlowRun(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  const workflows = workflowsView(res, ctx);
  if (!workflows?.runInline) {
    reply(res, 404, { error: 'not_found', message: 'desk office-flow runs are not available in this session' });
    return;
  }
  let body: z.infer<typeof deskOfficeFlowRunRequestSchema>;
  try {
    const raw = await readBody(req);
    body = deskOfficeFlowRunRequestSchema.parse(raw.trim() ? JSON.parse(raw) : {});
  } catch (err) {
    reply(res, 400, { error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
    return;
  }
  try {
    reply(res, 200, await workflows.runInline(body.workflow as Workflow, body.inputs));
  } catch (err) {
    replyWorkflowError(res, err);
  }
}

export async function handleDeskGet(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }

  let filePath: string;
  try {
    filePath = deskStatePath(ctx.session, pathPart(req, 3));
  } catch (err) {
    reply(res, 400, { error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
    return;
  }

  try {
    const raw = await readFile(filePath, 'utf8');
    reply(res, 200, deskStateSchema.parse(JSON.parse(raw)));
  } catch (err) {
    if (isMissingFileError(err)) {
      reply(res, 200, createSeedDeskState());
      return;
    }
    reply(res, 502, { error: 'desk_failed', message: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleDeskPut(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }

  let filePath: string;
  try {
    filePath = deskStatePath(ctx.session, pathPart(req, 3));
  } catch (err) {
    reply(res, 400, { error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
    return;
  }

  let state: z.infer<typeof deskStateSchema>;
  try {
    const raw = await readBody(req, 2 * 1024 * 1024);
    state = deskStateSchema.parse(raw.trim() ? JSON.parse(raw) : {});
  } catch (err) {
    reply(res, 400, { error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
    return;
  }

  try {
    await writeDeskState(filePath, state);
    reply(res, 200, state);
  } catch (err) {
    reply(res, 502, { error: 'desk_failed', message: err instanceof Error ? err.message : String(err) });
  }
}

function createSeedDeskState(): z.infer<typeof deskStateSchema> {
  return { version: 1 };
}

export function workspaceDeskId(cwd: string): string {
  return createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
}

function deskStatePath(session: Session, deskId: string): string {
  const parsed = deskIdSchema.parse(deskId);
  return path.join(moxxyHome(), 'desk', workspaceDeskId(session.cwd), `desk-${parsed}.json`);
}

const deskWriteLocks = new Map<string, Promise<void>>();

async function writeDeskState(filePath: string, state: z.infer<typeof deskStateSchema>): Promise<void> {
  const previous = deskWriteLocks.get(filePath) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${randomUUID()}.tmp`;
      await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await rename(tmp, filePath);
    });
  deskWriteLocks.set(filePath, next);
  try {
    await next;
  } finally {
    if (deskWriteLocks.get(filePath) === next) deskWriteLocks.delete(filePath);
  }
}

function isMissingFileError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ENOENT';
}

class AdminToolUnavailableError extends Error {
  constructor(readonly toolName: string) {
    super(`admin tool is not registered: ${toolName}`);
    this.name = 'AdminToolUnavailableError';
  }
}

async function executeSessionTool(ctx: RouterContext, toolName: string, input: unknown): Promise<unknown> {
  const session = coreSession(ctx.session);
  if (!session.tools.has(toolName)) {
    throw new AdminToolUnavailableError(toolName);
  }
  return session.tools.execute(toolName, input, new AbortController().signal, {
    sessionId: session.id,
    turnId: 'office-admin',
    log: session.log,
    logger: session.logger,
    cwd: session.cwd,
  });
}

function replyAdminToolError(res: ServerResponse, err: unknown): void {
  if (err instanceof AdminToolUnavailableError) {
    reply(res, 404, {
      error: 'not_found',
      message: `${err.toolName} is not available in this session`,
    });
    return;
  }
  reply(res, 502, {
    error: 'action_failed',
    message: err instanceof Error ? err.message : String(err),
  });
}

export async function handleVaultListSecrets(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  try {
    const raw = await executeSessionTool(ctx, 'vault_list', {});
    const entries = Array.isArray(raw) ? raw.map((entry) => vaultSecretFromEntry(entry)) : [];
    reply(res, 200, entries);
  } catch (err) {
    replyAdminToolError(res, err);
  }
}

export async function handleVaultCreateSecret(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  let body: z.infer<typeof vaultCreateRequestSchema>;
  try {
    const raw = await readBody(req);
    body = vaultCreateRequestSchema.parse(raw.trim() ? JSON.parse(raw) : {});
  } catch (err) {
    reply(res, 400, { error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
    return;
  }

  const backendKey = body.backend_key ?? body.key_name;
  const tags = body.policy_label ? [body.policy_label] : undefined;
  try {
    await executeSessionTool(ctx, 'vault_set', {
      name: backendKey,
      value: body.value,
      ...(tags ? { tags } : {}),
    });
    reply(res, 200, vaultSecretFromEntry({
      name: backendKey,
      tags: tags ?? [],
      createdAt: new Date().toISOString(),
    }, body.key_name));
  } catch (err) {
    replyAdminToolError(res, err);
  }
}

export async function handleVaultDeleteSecret(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  try {
    await executeSessionTool(ctx, 'vault_delete', { name: pathPart(req, 4) });
    reply(res, 200, { ok: true });
  } catch (err) {
    replyAdminToolError(res, err);
  }
}

export async function handleMcpListServers(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  try {
    const raw = await executeSessionTool(ctx, 'mcp_list_servers', {});
    const servers = Array.isArray(raw) ? raw.map((server) => mcpServerFromToolOutput(server)) : [];
    reply(res, 200, { servers });
  } catch (err) {
    replyAdminToolError(res, err);
  }
}

export async function handleMcpAddServer(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  let body: z.infer<typeof mcpServerCreateRequestSchema>;
  try {
    const raw = await readBody(req);
    body = mcpServerCreateRequestSchema.parse(raw.trim() ? JSON.parse(raw) : {});
  } catch (err) {
    reply(res, 400, { error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
    return;
  }

  const toolInput = mcpToolInputFromCreateRequest(body, true);
  try {
    await executeSessionTool(ctx, 'mcp_add_server', toolInput);
    reply(res, 200, mcpServerFromToolOutput({
      name: body.id,
      kind: toolInput.kind,
      command: body.command,
      args: body.args,
      url: body.url,
      headers: body.headers,
      env: body.env,
      disabled: false,
    }));
  } catch (err) {
    replyAdminToolError(res, err);
  }
}

export async function handleMcpRemoveServer(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  try {
    await executeSessionTool(ctx, 'mcp_remove_server', { name: pathPart(req, 5) });
    reply(res, 200, { ok: true });
  } catch (err) {
    replyAdminToolError(res, err);
  }
}

export async function handleMcpTestServer(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }
  const serverId = pathPart(req, 5);
  try {
    const raw = await executeSessionTool(ctx, 'mcp_list_servers', {});
    const servers = Array.isArray(raw) ? raw : [];
    const server = servers.find((entry) => mcpServerFromToolOutput(entry).id === serverId);
    if (!server) {
      reply(res, 404, { error: 'not_found', message: `MCP server not found: ${serverId}` });
      return;
    }

    const result = await executeSessionTool(ctx, 'mcp_test_server', mcpToolInputFromToolOutput(server, false));
    reply(res, 200, mcpTestResultFromToolOutput(serverId, result));
  } catch (err) {
    replyAdminToolError(res, err);
  }
}

function vaultSecretFromEntry(entry: unknown, keyNameOverride?: string): {
  id: string;
  key_name: string;
  backend_key: string;
  policy_label?: string | null;
  created_at?: string;
} {
  const record = objectRecord(entry);
  const name = stringValue(record.name) ?? stringValue(record.backend_key) ?? stringValue(record.id) ?? keyNameOverride ?? 'unknown';
  const keyName = keyNameOverride ?? stringValue(record.key_name) ?? name;
  const backendKey = stringValue(record.backend_key) ?? name;
  const tags = stringArray(record.tags);
  const policy = stringValue(record.policy_label) ?? (tags.length > 0 ? tags.join(', ') : undefined);
  const createdAt = stringValue(record.created_at) ?? stringValue(record.createdAt);
  return {
    id: backendKey,
    key_name: keyName,
    backend_key: backendKey,
    ...(policy ? { policy_label: policy } : {}),
    ...(createdAt ? { created_at: createdAt } : {}),
  };
}

interface OfficeMcpServer {
  readonly id: string;
  readonly transport: 'stdio' | 'sse' | 'streamable_http';
  readonly enabled: boolean;
  readonly command?: string;
  readonly args?: string[];
  readonly url?: string;
  readonly headers?: Record<string, string>;
  readonly env?: Record<string, string>;
  readonly cwd?: string;
}

type McpToolInput = {
  name: string;
  kind: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  autoSkill?: boolean;
};

function mcpServerFromToolOutput(value: unknown): OfficeMcpServer {
  const record = objectRecord(value);
  const id = stringValue(record.id) ?? stringValue(record.name) ?? 'unknown';
  const transport = officeMcpTransport(stringValue(record.transport) ?? stringValue(record.kind));
  const disabled = record.disabled === true;
  const enabled = typeof record.enabled === 'boolean' ? record.enabled : !disabled;
  return {
    id,
    transport,
    enabled,
    ...optionalProp('command', stringValue(record.command)),
    ...optionalProp('args', stringArrayOrUndefined(record.args)),
    ...optionalProp('url', stringValue(record.url)),
    ...optionalProp('headers', stringRecord(record.headers)),
    ...optionalProp('env', stringRecord(record.env)),
    ...optionalProp('cwd', stringValue(record.cwd)),
  };
}

function mcpToolInputFromCreateRequest(
  body: z.infer<typeof mcpServerCreateRequestSchema>,
  autoSkill: boolean,
): McpToolInput {
  return {
    name: body.id,
    kind: toolMcpKind(body.transport),
    ...optionalProp('command', body.command),
    ...optionalProp('args', body.args),
    ...optionalProp('env', body.env),
    ...optionalProp('url', body.url),
    ...optionalProp('headers', body.headers),
    autoSkill,
  };
}

function mcpToolInputFromToolOutput(value: unknown, autoSkill: boolean): McpToolInput {
  const server = mcpServerFromToolOutput(value);
  return {
    name: server.id,
    kind: toolMcpKind(server.transport),
    ...optionalProp('command', server.command),
    ...optionalProp('args', server.args),
    ...optionalProp('env', server.env),
    ...optionalProp('cwd', server.cwd),
    ...optionalProp('url', server.url),
    ...optionalProp('headers', server.headers),
    autoSkill,
  };
}

function mcpTestResultFromToolOutput(serverId: string, value: unknown): {
  status: 'ok' | 'error';
  server_id: string;
  tools?: string[];
  error?: string;
} {
  const record = objectRecord(value);
  const ok = record.ok !== false;
  const tools = Array.isArray(record.tools)
    ? record.tools.map(toolNameFromResult).filter((tool): tool is string => Boolean(tool))
    : undefined;
  const error = stringValue(record.error);
  return {
    status: ok ? 'ok' : 'error',
    server_id: serverId,
    ...(tools ? { tools } : {}),
    ...(error ? { error } : {}),
  };
}

function toolNameFromResult(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const record = objectRecord(value);
  return stringValue(record.name) ?? null;
}

function officeMcpTransport(value: string | undefined): OfficeMcpServer['transport'] {
  if (value === 'sse') return 'sse';
  if (value === 'http' || value === 'streamable_http') return 'streamable_http';
  return 'stdio';
}

function toolMcpKind(value: OfficeMcpServer['transport']): McpToolInput['kind'] {
  return value === 'streamable_http' ? 'http' : value;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringArrayOrUndefined(value: unknown): string[] | undefined {
  const values = stringArray(value);
  return values.length > 0 ? values : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  if (entries.length === 0 && Object.keys(value).length > 0) return undefined;
  return Object.fromEntries(entries);
}

function optionalProp<TKey extends string, TValue>(
  key: TKey,
  value: TValue | undefined,
): { [K in TKey]?: TValue } {
  return value === undefined ? {} : { [key]: value } as { [K in TKey]?: TValue };
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
    .filter((command) => !unsupportedReason(command.name))
    .map((command) => {
      return {
        name: command.name,
        command: `/${command.name}`,
        description: command.description,
        ...(command.aliases ? { aliases: command.aliases } : {}),
        supported: true,
      };
    });
  const seen = new Set(registry.map((command) => command.name));
  const local = OFFICE_LOCAL_COMMANDS.filter((command) => command.supported && !seen.has(command.name));
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
  attachments?: ReadonlyArray<UserPromptAttachment>;
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
        ...(event.attachments && event.attachments.length > 0 ? { attachments: event.attachments } : {}),
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
  let body: z.infer<typeof agentRunRequestSchema>;
  try {
    const raw = await readBody(req, AGENT_RUN_BODY_MAX);
    body = agentRunRequestSchema.parse(JSON.parse(raw));
  } catch (err) {
    reply(res, 400, { error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
    return;
  }

  const agentId = pathPart(req, 3) || 'session';
  const attachments = body.attachments ?? [];
  if (agentId !== 'session') {
    const runtime = officeRuntime(ctx);
    const agent = runtime.get(agentId);
    if (!agent) {
      reply(res, 404, { error: 'not_found', message: 'agent not found' });
      return;
    }
    if (imageAttachments(attachments).length > 0 && !supportsImageAttachments(ctx.session, agent.provider_id, agent.model_id)) {
      reply(res, 400, {
        error: 'unsupported_attachments',
        message: `model ${agent.provider_id}::${agent.model_id} does not support image attachments`,
      });
      return;
    }
    let toolSystemPrompt: string | undefined;
    try {
      toolSystemPrompt = await imageAttachmentToolHint(ctx.session, attachments);
    } catch (err) {
      ctx.logger?.warn('http virtual office attachment materialization failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      reply(res, 500, {
        error: 'attachment_materialization_failed',
        message: 'failed to prepare image attachments for tools',
      });
      return;
    }
    const started = runtime.startRun(
      agentId,
      body.task,
      attachments,
      toolSystemPrompt ? { systemPrompt: toolSystemPrompt } : undefined,
    );
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

  if (imageAttachments(attachments).length > 0 && !supportsImageAttachments(ctx.session)) {
    const modelInfo = activeModelInfo(ctx.session);
    reply(res, 400, {
      error: 'unsupported_attachments',
      message: `model ${modelInfo.providerId}::${modelInfo.modelId} does not support image attachments`,
    });
    return;
  }

  let toolSystemPrompt: string | undefined;
  try {
    toolSystemPrompt = await imageAttachmentToolHint(ctx.session, attachments);
  } catch (err) {
    ctx.logger?.warn('http virtual office attachment materialization failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    reply(res, 500, {
      error: 'attachment_materialization_failed',
      message: 'failed to prepare image attachments for tools',
    });
    return;
  }

  void (async () => {
    try {
      for await (const event of runTurn(coreSession(ctx.session), body.task, {
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(toolSystemPrompt ? { systemPrompt: toolSystemPrompt } : {}),
      })) {
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
    ...(attachments.length > 0 ? { attachments } : {}),
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
