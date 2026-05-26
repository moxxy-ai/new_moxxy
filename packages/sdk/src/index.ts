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
  ModeIterationEvent,
  CompactionEvent,
  ProviderRequestEvent,
  ProviderResponseEvent,
  ErrorEvent,
  AbortEvent,
  PluginEvent,
} from './events.js';

export type { EventLogReader } from './log.js';

export type {
  RunTurnOptions,
  SessionLogReader,
  SessionLike,
  SessionInfo,
  ProviderInfo,
  ToolInfo,
  SkillInfo,
  CommandInfo,
} from './session-like.js';

export type {
  ClientSession,
  ProvidersClientView,
  ModesClientView,
  ToolsClientView,
  CommandsClientView,
  SkillsClientView,
  AgentsClientView,
  TranscribersClientView,
  RequirementsClientView,
  PermissionsClientView,
} from './client-session.js';

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
  CacheHint,
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
export type { CacheStrategyDef, CacheStrategyContext } from './cache-strategy.js';
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
} from './mode-helpers.js';

export type { TokenBudget, CompactContext, CompactorDef } from './compactor.js';
export { estimateContextTokens, runCompactionIfNeeded } from './compactor-helpers.js';
export {
  runElisionIfNeeded,
  resolveElisionSettings,
  type ResolvedElisionSettings,
} from './elision-helpers.js';
export {
  computeElisionState,
  toolResultStub,
  conversationalStub,
  toolResultBytes,
  toolResultStubbed,
  conversationalStubbed,
  TINY_TURN_CHARS,
  type ElisionState,
} from './elision-state.js';
export {
  applyLazyTools,
  buildToolIndex,
  loadedToolNames,
  ALWAYS_ON_TOOLS,
  type GatedTools,
} from './tool-gating.js';

export {
  summarizeSessionTokens,
  summarizeSessionTokensFromEvents,
  usageEventFields,
  type SessionTokenSummary,
} from './token-accounting.js';

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
  ModeContext,
  ModeDef,
  ElisionSettings,
  ApprovalResolver,
  ApprovalRequest,
  ApprovalDecision,
  ApprovalOption,
} from './mode.js';

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
  defineMode,
  defineCompactor,
  defineCacheStrategy,
  defineChannel,
  definePermission,
  defineSkill,
  defineTranscriber,
} from './define.js';

export {
  skillFrontmatterSchema,
  pluginManifestSchema,
  moxxyPackageSchema,
  requirementSchema,
  type SkillFrontmatterInput,
  type PluginManifestInput,
  type MoxxyPackageInput,
} from './schemas.js';

export {
  getInstallHint,
  type InstallHint,
  type InstallTarget,
} from './install-hints.js';

export { z } from 'zod';
