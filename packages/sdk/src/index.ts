export type {
  EventId,
  TurnId,
  ToolCallId,
  SessionId,
  PluginId,
  SkillId,
} from './ids.js';
export { asEventId, asTurnId, asToolCallId, asSessionId, asPluginId, asSkillId } from './ids.js';

export type {
  EventBase,
  EventSource,
  MoxxyEvent,
  MoxxyEventType,
  MoxxyEventOfType,
  EmittedEvent,
  UserPromptEvent,
  UserPromptAttachment,
  AssistantChunkEvent,
  AssistantMessageEvent,
  ToolCallRequestedEvent,
  ToolCallApprovedEvent,
  ToolCallDeniedEvent,
  ToolResultEvent,
  SkillInvokedEvent,
  SkillCreatedEvent,
  PluginRegisteredEvent,
  PluginUnregisteredEvent,
  LoopIterationEvent,
  CompactionEvent,
  ProviderRequestEvent,
  ProviderResponseEvent,
  ErrorEvent,
  AbortEvent,
  PluginEvent,
} from './events.js';

export type { EventLogReader } from './log.js';

export type {
  PermissionMode,
  PermissionDecision,
  PermissionRule,
  PendingToolCall,
  PermissionContext,
  PermissionResolver,
} from './permission.js';

export type {
  ToolContext,
  ToolDef,
  ToolCompactPresentation,
  BrokeredFs,
  BrokeredStat,
  BrokeredFetch,
  BrokeredFetchInit,
  BrokeredFetchResponse,
  BrokeredExec,
  BrokeredExecOpts,
  BrokeredExecResult,
} from './tool.js';

export type {
  FsCapability,
  NetCapability,
  CapabilitySpec,
  IsolationStrength,
  ToolIsolationSpec,
  IsolatedToolCall,
  Isolator,
  HandlerModuleRef,
} from './isolation.js';
export { ISOLATION_RANK } from './isolation.js';

export type {
  SubagentSpec,
  SubagentResult,
  SubagentSpawner,
} from './subagent.js';


export type {
  ContentBlock,
  ProviderMessage,
  ProviderRequest,
  ProviderEvent,
  TokenUsage,
  ModelDescriptor,
  LLMProvider,
  ProviderDef,
  ProviderKeyValidation,
  ProviderVault,
  ProviderAuthContext,
  ProviderOAuthResult,
  ProviderOAuthStatus,
  ProviderAuthDescriptor,
} from './provider.js';
export { isRetryableError, toFriendlyError, zodToJsonSchema, type StopReason } from './provider-utils.js';
export {
  MoxxyError,
  classifyHttpStatus,
  classifyNetworkError,
  type MoxxyErrorCode,
  type MoxxyErrorInit,
} from './errors.js';
export {
  collectProviderStream,
  projectMessagesFromLog,
  buildSystemPromptWithSkills,
  type CollectedToolUse,
  type StreamResult,
  type ProjectMessagesOptions,
} from './loop-helpers.js';

export type { TokenBudget, CompactContext, CompactorDef } from './compactor.js';

export type { Skill, SkillDef, SkillFrontmatter, SkillScope, SkillSchedule } from './skill.js';

export type { AgentDef } from './agent.js';

export type {
  CommandDef,
  CommandContext,
  CommandOutput,
  CommandHandlerResult,
} from './command.js';

export type {
  ToolRegistry,
  SkillRegistry,
  PluginHostHandle,
  LoopContext,
  LoopStrategyDef,
  ApprovalResolver,
  ApprovalRequest,
  ApprovalDecision,
  ApprovalOption,
} from './loop.js';

export type {
  AppContext,
  TurnContext,
  ToolCallContext,
  ToolResultContext,
  ToolCallVerdict,
  ToolCallRequest,
  LifecycleHooks,
  HookDispatcher,
} from './hooks.js';

export type {
  PluginKind,
  PluginSpec,
  Plugin,
  PluginManifest,
  ResolvedPluginManifest,
} from './plugin.js';

export type {
  Channel,
  ChannelHandle,
  ChannelStartOptsBase,
  ChannelFactoryDeps,
  ChannelDef,
  ChannelAvailability,
  ChannelRegistry,
  ChannelSubcommand,
  ChannelSubcommandContext,
  ChannelCommandArgs,
} from './channel.js';
export type { EmbeddingProvider } from './embedding.js';
export { CachedEmbeddingProvider } from './embedding-cache.js';

export type {
  RequirementKind,
  RequirementState,
  MoxxyRequirement,
  RequirementIssue,
  RequirementCheck,
} from './requirements.js';

export type {
  Transcriber,
  TranscriberDef,
  TranscriptionResult,
  TranscriptionSegment,
  TranscribeOptions,
} from './transcriber.js';

export interface PluginLoader {
  load(manifest: import('./plugin.js').ResolvedPluginManifest): Promise<import('./plugin.js').Plugin>;
}

export {
  definePlugin,
  defineTool,
  defineProvider,
  defineLoopStrategy,
  defineCompactor,
  defineChannel,
  definePermission,
  defineSkill,
  defineTranscriber,
} from './define.js';

export {
  skillFrontmatterSchema,
  pluginManifestSchema,
  requirementSchema,
  type SkillFrontmatterInput,
  type PluginManifestInput,
} from './schemas.js';

export { z } from 'zod';
