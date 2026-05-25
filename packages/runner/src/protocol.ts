import { z } from 'zod';
import type {
  ApprovalDecision,
  ApprovalRequest,
  CommandOutput,
  MoxxyEvent,
  PendingToolCall,
  PermissionContext,
  PermissionDecision,
  SessionInfo,
  TranscriptionResult,
  UserPromptAttachment,
} from '@moxxy/sdk';

/**
 * Wire contract between the runner (server) and thin clients. Bumped when an
 * incompatible change lands; `attach` exchanges versions so a stale client
 * fails loudly instead of misbehaving.
 */
export const RUNNER_PROTOCOL_VERSION = 1;

/** Request methods. Client->server unless noted. */
export const RunnerMethod = {
  /** client->server: handshake; returns the initial info snapshot. */
  Attach: 'attach',
  /** client->server: re-fetch the registry snapshot. */
  GetInfo: 'getInfo',
  /** client->server: start a turn; returns its turnId. Events stream separately. */
  RunTurn: 'runTurn',
  /** client->server: abort an in-flight turn. */
  Abort: 'abort',
  /** client->server: declare which resolvers this client will answer. */
  SetResolver: 'setResolver',
  /** client->server: switch the active mode. */
  ModeSetActive: 'mode.setActive',
  /** client->server: switch the active provider (server resolves credentials). */
  ProviderSetActive: 'provider.setActive',
  /** client->server: persist an allow-always permission rule. */
  PermissionAddAllow: 'permission.addAllow',
  /** client->server: run a registered slash command on the runner. */
  CommandRun: 'command.run',
  /** client->server: transcribe audio using the runner's active transcriber. */
  Transcribe: 'transcribe',
  /** server->client: ask this client to decide a tool-call permission. */
  PermissionCheck: 'permission.check',
  /** server->client: ask this client to confirm an approval checkpoint. */
  ApprovalConfirm: 'approval.confirm',
} as const;
export type RunnerMethod = (typeof RunnerMethod)[keyof typeof RunnerMethod];

/** Notification methods (no reply). All server->client. */
export const RunnerNotification = {
  /** A new event was appended to the log. */
  Event: 'event',
  /** A turn finished (cleanly or with an error). */
  TurnComplete: 'turn.complete',
  /** The registry snapshot changed (plugin reload, mode switch, …). */
  InfoChanged: 'info.changed',
} as const;
export type RunnerNotification = (typeof RunnerNotification)[keyof typeof RunnerNotification];

// ---------------------------------------------------------------------------
// Request params / results
// ---------------------------------------------------------------------------

export interface AttachParams {
  readonly protocolVersion: number;
  /** Channel role attaching (e.g. 'tui', 'telegram') - informational/logging. */
  readonly role: string;
  /** Replay events from this seq on attach so a late client sees history. */
  readonly sinceSeq?: number;
}
export interface AttachResult {
  readonly sessionId: string;
  readonly protocolVersion: number;
  readonly info: SessionInfo;
}

export interface RunTurnParams {
  readonly prompt: string;
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly maxIterations?: number;
  readonly attachments?: ReadonlyArray<UserPromptAttachment>;
}
export interface RunTurnResult {
  readonly turnId: string;
}

export interface AbortParams {
  readonly turnId: string;
}

export interface SetResolverParams {
  /** This client will answer `permission.check` for the turns it owns. */
  readonly permission?: boolean;
  /** This client will answer `approval.confirm` for the turns it owns. */
  readonly approval?: boolean;
}

export interface ModeSetActiveParams {
  readonly name: string;
}

export interface ProviderSetActiveParams {
  readonly name: string;
  readonly config?: Record<string, unknown>;
}

export interface PermissionAddAllowParams {
  readonly name: string;
  readonly reason?: string;
}

export interface CommandRunParams {
  readonly name: string;
  readonly args: string;
  readonly channel: string;
}
export type CommandRunResult = CommandOutput;

export interface TranscribeParams {
  /** Base64-encoded audio bytes (JSON-safe transport of the binary). */
  readonly audio: string;
  readonly mimeType?: string;
  readonly language?: string;
  readonly prompt?: string;
}
export type TranscribeResult = TranscriptionResult;

export interface PermissionCheckParams {
  readonly turnId: string;
  readonly call: PendingToolCall;
  readonly ctx: PermissionContext;
}
export type PermissionCheckResult = PermissionDecision;

export interface ApprovalConfirmParams {
  readonly turnId: string;
  readonly request: ApprovalRequest;
}
export type ApprovalConfirmResult = ApprovalDecision;

// ---------------------------------------------------------------------------
// Notification payloads
// ---------------------------------------------------------------------------

export interface EventNotification {
  readonly event: MoxxyEvent;
}
export interface TurnCompleteNotification {
  readonly turnId: string;
  readonly error?: string;
}
export interface InfoChangedNotification {
  readonly info: SessionInfo;
}

// ---------------------------------------------------------------------------
// Inbound validation (control plane). The runner validates client->server
// request params before acting on them; large opaque payloads (events, info
// snapshots) ride through as typed pass-throughs since the transport already
// JSON round-trips them and they originate from our own server.
// ---------------------------------------------------------------------------

const attachmentSchema = z
  .object({
    kind: z.string(),
    content: z.string(),
    name: z.string().optional(),
    mediaType: z.string().optional(),
  })
  .passthrough();

export const attachParamsSchema = z.object({
  protocolVersion: z.number(),
  role: z.string(),
  sinceSeq: z.number().int().nonnegative().optional(),
});

export const runTurnParamsSchema = z.object({
  prompt: z.string(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  maxIterations: z.number().int().positive().optional(),
  attachments: z.array(attachmentSchema).optional(),
});

export const abortParamsSchema = z.object({ turnId: z.string() });

export const setResolverParamsSchema = z.object({
  permission: z.boolean().optional(),
  approval: z.boolean().optional(),
});

export const modeSetActiveParamsSchema = z.object({ name: z.string() });

export const providerSetActiveParamsSchema = z.object({
  name: z.string(),
  config: z.record(z.unknown()).optional(),
});

export const permissionAddAllowParamsSchema = z.object({
  name: z.string(),
  reason: z.string().optional(),
});

export const commandRunParamsSchema = z.object({
  name: z.string(),
  args: z.string(),
  channel: z.string(),
});

export const transcribeParamsSchema = z.object({
  audio: z.string(),
  mimeType: z.string().optional(),
  language: z.string().optional(),
  prompt: z.string().optional(),
});
