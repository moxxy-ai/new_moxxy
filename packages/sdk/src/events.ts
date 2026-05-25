import type { EventId, PluginId, SessionId, SkillId, ToolCallId, TurnId } from './ids.js';

export type EventSource = 'user' | 'model' | 'tool' | 'plugin' | 'system' | 'compactor';

export interface EventBase {
  readonly id: EventId;
  readonly seq: number;
  readonly ts: number;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly causationId?: EventId;
  readonly source: EventSource;
}

export interface UserPromptAttachment {
  readonly kind: 'stdin' | 'file' | 'image' | 'audio';
  /**
   * Inline payload. For images this is base64-encoded bytes; for audio it
   * is either base64-encoded bytes (when the channel hands raw audio
   * straight through to a model with `supportsAudio`) or the transcript
   * (when the channel pre-transcribed via the session's Transcriber).
   * Channels SHOULD set `name` to disambiguate the two; `mediaType` is
   * required when carrying raw audio bytes.
   */
  readonly content: string;
  /** Human-readable label, e.g. the file path, `image.png`, or `voice.ogg`. */
  readonly name?: string;
  /** MIME type — required for images and raw audio so providers translate correctly. */
  readonly mediaType?: string;
}

export interface UserPromptEvent extends EventBase {
  readonly type: 'user_prompt';
  readonly text: string;
  readonly attachments?: ReadonlyArray<UserPromptAttachment>;
}

export interface AssistantChunkEvent extends EventBase {
  readonly type: 'assistant_chunk';
  readonly delta: string;
}

export interface AssistantMessageEvent extends EventBase {
  readonly type: 'assistant_message';
  readonly content: string;
  readonly stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error';
}

export interface ToolCallRequestedEvent extends EventBase {
  readonly type: 'tool_call_requested';
  readonly callId: ToolCallId;
  readonly name: string;
  readonly input: unknown;
  readonly skillContext?: SkillId;
}

export interface ToolCallApprovedEvent extends EventBase {
  readonly type: 'tool_call_approved';
  readonly callId: ToolCallId;
  readonly decidedBy: 'policy' | 'resolver' | 'hook';
  readonly mode: 'allow' | 'allow_session' | 'allow_always';
}

export interface ToolCallDeniedEvent extends EventBase {
  readonly type: 'tool_call_denied';
  readonly callId: ToolCallId;
  readonly decidedBy: 'policy' | 'resolver' | 'hook';
  readonly reason: string;
}

export interface ToolResultEvent extends EventBase {
  readonly type: 'tool_result';
  readonly callId: ToolCallId;
  readonly ok: boolean;
  readonly output?: unknown;
  readonly error?: { message: string; kind: 'aborted' | 'threw' | 'denied' | 'timeout' };
}

export interface SkillInvokedEvent extends EventBase {
  readonly type: 'skill_invoked';
  readonly skillId: SkillId;
  readonly name: string;
  readonly reason: 'trigger_match' | 'classifier' | 'manual' | 'load_skill_tool';
}

export interface SkillCreatedEvent extends EventBase {
  readonly type: 'skill_created';
  readonly skillId: SkillId;
  readonly name: string;
  readonly path: string;
  readonly scope: 'user' | 'project';
  readonly originatingPrompt: string;
}

export interface PluginRegisteredEvent extends EventBase {
  readonly type: 'plugin_registered';
  readonly pluginId: PluginId;
  readonly name: string;
  readonly version: string;
  readonly kind: ReadonlyArray<'tools' | 'provider' | 'mode' | 'compactor' | 'mcp' | 'cli' | 'hooks'>;
}

export interface PluginUnregisteredEvent extends EventBase {
  readonly type: 'plugin_unregistered';
  readonly pluginId: PluginId;
  readonly name: string;
  readonly reason: 'reload' | 'shutdown' | 'disabled';
}

export interface ModeIterationEvent extends EventBase {
  readonly type: 'mode_iteration';
  readonly strategy: string;
  readonly iteration: number;
  readonly routing?: 'resolved' | 'unresolved' | 'synthesized';
}

export interface CompactionEvent extends EventBase {
  readonly type: 'compaction';
  readonly compactor: string;
  readonly replacedRange: readonly [number, number];
  readonly summary: string;
  readonly tokensSaved: number;
}

export interface ProviderRequestEvent extends EventBase {
  readonly type: 'provider_request';
  readonly provider: string;
  readonly model: string;
  readonly inputTokens?: number;
}

export interface ProviderResponseEvent extends EventBase {
  readonly type: 'provider_response';
  readonly provider: string;
  readonly model: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
}

export interface ErrorEvent extends EventBase {
  readonly type: 'error';
  readonly kind: 'retryable' | 'fatal' | 'tool_threw' | 'hook_failed' | 'provider_failed';
  readonly message: string;
  readonly sourceEventId?: EventId;
  readonly attempt?: number;
}

export interface AbortEvent extends EventBase {
  readonly type: 'abort';
  readonly reason: string;
}

export interface PluginEvent extends EventBase {
  readonly type: 'plugin_event';
  readonly pluginId: PluginId;
  readonly subtype: string;
  readonly payload: unknown;
}

export type MoxxyEvent =
  | UserPromptEvent
  | AssistantChunkEvent
  | AssistantMessageEvent
  | ToolCallRequestedEvent
  | ToolCallApprovedEvent
  | ToolCallDeniedEvent
  | ToolResultEvent
  | SkillInvokedEvent
  | SkillCreatedEvent
  | PluginRegisteredEvent
  | PluginUnregisteredEvent
  | ModeIterationEvent
  | CompactionEvent
  | ProviderRequestEvent
  | ProviderResponseEvent
  | ErrorEvent
  | AbortEvent
  | PluginEvent;

export type MoxxyEventType = MoxxyEvent['type'];
export type MoxxyEventOfType<T extends MoxxyEventType> = Extract<MoxxyEvent, { type: T }>;

export type EmittedEvent = MoxxyEvent extends infer E
  ? E extends MoxxyEvent
    ? Omit<E, 'id' | 'seq' | 'ts'> & { ts?: number }
    : never
  : never;
