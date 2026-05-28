import * as os from 'node:os';
import * as path from 'node:path';
import { buildSynthesizeSkillPlugin, runTurn, type Session } from '@moxxy/core';
import { asPluginId, type Plugin } from '@moxxy/sdk';
import type { MoxxyConfig } from '@moxxy/config';
import { anthropicPlugin } from '@moxxy/plugin-provider-anthropic';
import { openaiPlugin } from '@moxxy/plugin-provider-openai';
import { openaiCodexPlugin } from '@moxxy/plugin-provider-openai-codex';
import { buildWhisperPlugin } from '@moxxy/plugin-stt-whisper';
import { buildWhisperCodexPlugin } from '@moxxy/plugin-stt-whisper-codex';
import { builtinToolsPlugin } from '@moxxy/tools-builtin';
import { toolUseModePlugin } from '@moxxy/mode-tool-use';
import { planExecuteModePlugin } from '@moxxy/mode-plan-execute';
import { bmadModePlugin } from '@moxxy/mode-bmad';
import { developerModePlugin } from '@moxxy/mode-developer';
import { deepResearchModePlugin } from '@moxxy/mode-deep-research';
import { summarizeCompactorPlugin } from '@moxxy/compactor-summarize';
import { stablePrefixCacheStrategyPlugin } from '@moxxy/cache-strategy-stable-prefix';
import {
  buildMemoryConsolidatePlugin,
  type MemoryStore,
} from '@moxxy/plugin-memory';
import { buildTelegramPlugin } from '@moxxy/plugin-telegram';
import { buildMcpAdminPluginWithApi } from '@moxxy/plugin-mcp';
import { cliPlugin } from '@moxxy/plugin-cli';
import { httpChannelPlugin } from '@moxxy/plugin-channel-http';
import { buildWebChannelPlugin } from '@moxxy/plugin-channel-web';
import { browserPlugin } from '@moxxy/plugin-browser';
import { buildSubagentsPlugin } from '@moxxy/plugin-subagents';
import { buildPluginsAdminPlugin } from '@moxxy/plugin-plugins-admin';
import { buildSelfUpdatePlugin } from '@moxxy/plugin-self-update';
import { buildProviderAdminPlugin } from '@moxxy/plugin-provider-admin';
import { buildUsageStatsPlugin } from '@moxxy/plugin-usage-stats';
import { commandsPlugin } from '@moxxy/plugin-commands';
import { buildViewPlugin } from '@moxxy/plugin-view';
import { computerControlPlugin } from '@moxxy/plugin-computer-control';
import { buildOauthPlugin } from '@moxxy/plugin-oauth';
import type { VaultStore } from '@moxxy/plugin-vault';
import {
  buildSchedulerPlugin,
  type SchedulerPoller,
  type ScheduleStore,
  type SchedulePromptRunner,
} from '@moxxy/plugin-scheduler';
import {
  buildWebhooksPlugin,
  type WebhookPromptRunner,
  type WebhookStore,
  type WebhookConfigStore,
} from '@moxxy/plugin-webhooks';
import {
  buildSecurityPlugin,
  type SecurityPluginHandle,
} from '@moxxy/plugin-security';
import { workerIsolator } from '@moxxy/isolator-worker';
import { subprocessIsolator } from '@moxxy/isolator-subprocess';
import { wasmIsolator } from '@moxxy/isolator-wasm';
import type { WorkflowStore } from '@moxxy/plugin-workflows';
import { BUILTIN_SKILLS_DIR_RESOLVED } from './builtin-skills-dir.js';
import { buildWorkflowsIntegration } from './workflows.js';

export interface BuiltinEntry {
  readonly name: string;
  readonly plugin: Plugin;
}

export interface BuiltinRequirementDecision {
  readonly hardRequirements: boolean;
  readonly reason: string;
}

export const BUILTIN_REQUIREMENT_DECISIONS: Readonly<Record<string, BuiltinRequirementDecision>> = {
  '@moxxy/plugin-provider-anthropic': { hardRequirements: false, reason: 'provider is independently activatable' },
  '@moxxy/plugin-provider-openai': { hardRequirements: false, reason: 'provider is independently activatable' },
  '@moxxy/plugin-provider-openai-codex': { hardRequirements: false, reason: 'provider owns its OAuth flow' },
  '@moxxy/plugin-provider-admin': { hardRequirements: false, reason: 'provider registry access is injected by bootstrap closure' },
  '@moxxy/tools-builtin': { hardRequirements: false, reason: 'core tool pack has no plugin dependency' },
  '@moxxy/mode-tool-use': { hardRequirements: false, reason: 'mode has no plugin dependency' },
  '@moxxy/mode-plan-execute': { hardRequirements: false, reason: 'mode has no plugin dependency' },
  '@moxxy/mode-bmad': { hardRequirements: false, reason: 'mode has no plugin dependency' },
  '@moxxy/mode-developer': { hardRequirements: false, reason: 'mode layers on tool-use; no hard plugin dependency' },
  '@moxxy/mode-deep-research': { hardRequirements: false, reason: 'mode needs @moxxy/plugin-subagents at runtime; surfaced as fatal error if absent' },
  '@moxxy/compactor-summarize': { hardRequirements: false, reason: 'compactor has no plugin dependency' },
  '@moxxy/cache-strategy-stable-prefix': { hardRequirements: false, reason: 'cache strategy has no plugin dependency' },
  '@moxxy/plugin-vault': { hardRequirements: false, reason: 'vault is the base secret store' },
  '@moxxy/plugin-stt-whisper': { hardRequirements: false, reason: 'generic Whisper backend; harmless without a configured provider' },
  '@moxxy/plugin-stt-whisper-codex': { hardRequirements: true, reason: 'requires Codex provider and OAuth readiness' },
  '@moxxy/plugin-memory': { hardRequirements: false, reason: 'memory store is created by bootstrap' },
  '@moxxy/memory-consolidate': { hardRequirements: true, reason: 'requires @moxxy/plugin-memory contributions' },
  '@moxxy/plugin-cli': { hardRequirements: false, reason: 'TUI channel is standalone' },
  '@moxxy/plugin-channel-http': { hardRequirements: false, reason: 'HTTP channel is standalone' },
  '@moxxy/plugin-channel-web': { hardRequirements: false, reason: 'web surface is standalone; token auto-generated' },
  '@moxxy/plugin-telegram': { hardRequirements: false, reason: 'vault is injected by bootstrap closure' },
  '@moxxy/plugin-browser': { hardRequirements: false, reason: 'browser runtime is diagnosed at tool/runtime level' },
  '@moxxy/plugin-computer-control': { hardRequirements: false, reason: 'platform constraints are handled by tools' },
  '@moxxy/plugin-oauth': { hardRequirements: false, reason: 'vault is injected by bootstrap closure' },
  '@moxxy/plugin-commands': { hardRequirements: false, reason: 'slash commands have no plugin dependency' },
  '@moxxy/plugin-view': { hardRequirements: false, reason: 'view renderer is seeded by core; the tool defers to the active renderer via closure' },
  '@moxxy/plugin-subagents': { hardRequirements: false, reason: 'agent registry is injected by closure' },
  '@moxxy/plugin-plugins-admin': { hardRequirements: false, reason: 'plugin host access is injected by closure' },
  '@moxxy/plugin-self-update': { hardRequirements: false, reason: 'plugin host / log access is injected by closure' },
  '@moxxy/plugin-mcp-admin': { hardRequirements: false, reason: 'tool and skill registries are injected by closure' },
  '@moxxy/synthesize-skill': { hardRequirements: false, reason: 'session access is injected by closure' },
  '@moxxy/plugin-scheduler': { hardRequirements: false, reason: 'runner and skills registry are injected by closure' },
  '@moxxy/plugin-webhooks': { hardRequirements: false, reason: 'runner is injected by closure' },
  '@moxxy/plugin-workflows': { hardRequirements: false, reason: 'store, runner, and registries are injected by closure' },
  '@moxxy/plugin-security': { hardRequirements: false, reason: 'disabled by default and configured at runtime' },
  '@moxxy/plugin-config': { hardRequirements: false, reason: 'config applier is injected by bootstrap closure' },
  '@moxxy/plugin-usage-stats': { hardRequirements: false, reason: 'records usage via lifecycle hooks; no plugin dependency' },
};

export interface BuildBuiltinsArgs {
  readonly session: Session;
  readonly rawConfig: MoxxyConfig;
  readonly vault: VaultStore;
  readonly vaultPlugin: Plugin;
  readonly memory: MemoryStore;
  readonly memoryPlugin: Plugin;
  readonly schedulerRunner: SchedulePromptRunner;
  readonly webhookRunner: WebhookPromptRunner;
  readonly logger: { warn(msg: string, meta?: Record<string, unknown>): void };
}

export interface BuiltBuiltinsCore {
  readonly entries: ReadonlyArray<BuiltinEntry>;
  readonly scheduler: { readonly store: ScheduleStore; readonly poller: SchedulerPoller };
  readonly webhooks: {
    readonly store: WebhookStore;
    readonly config: WebhookConfigStore;
    readonly stop: () => Promise<void>;
  };
  readonly security: SecurityPluginHandle;
  readonly workflows: { readonly store: WorkflowStore; readonly stop: () => void };
}

/**
 * Assemble the static builtin plugin list (everything except the
 * config plugin, which needs the rest as input). The returned `scheduler`
 * handle is surfaced upstream so the `moxxy schedule …` subcommands
 * can drive the store/poller without going through a model turn.
 */
export function buildBuiltinsCore(args: BuildBuiltinsArgs): BuiltBuiltinsCore {
  const { session, rawConfig, vault, vaultPlugin, memory, memoryPlugin, schedulerRunner, webhookRunner, logger } = args;

  // Shared handle linking the web surface to present_view: the web channel
  // publishes its live URL + view-id minter here on start; the view tool reads
  // it so it can return the public URL for the agent to relay on any channel.
  const viewSurface: { current: { url: string; nextViewId: () => string } | null } = { current: null };
  // Live web-surface controls (set when the surface starts) so the web_set_tunnel
  // tool can switch the tunnel without a restart.
  const webControls: { current: { retunnel(): Promise<string | null> } | null } = { current: null };

  const entries: BuiltinEntry[] = [
    { name: '@moxxy/plugin-provider-anthropic', plugin: anthropicPlugin },
    { name: '@moxxy/plugin-provider-openai', plugin: openaiPlugin },
    { name: '@moxxy/plugin-provider-openai-codex', plugin: openaiCodexPlugin },
    { name: '@moxxy/tools-builtin', plugin: builtinToolsPlugin },
    { name: '@moxxy/mode-tool-use', plugin: toolUseModePlugin },
    { name: '@moxxy/mode-plan-execute', plugin: planExecuteModePlugin },
    { name: '@moxxy/mode-bmad', plugin: bmadModePlugin },
    { name: '@moxxy/mode-developer', plugin: developerModePlugin },
    { name: '@moxxy/mode-deep-research', plugin: deepResearchModePlugin },
    { name: '@moxxy/compactor-summarize', plugin: summarizeCompactorPlugin },
    { name: '@moxxy/cache-strategy-stable-prefix', plugin: stablePrefixCacheStrategyPlugin },
    { name: '@moxxy/plugin-vault', plugin: vaultPlugin },
    { name: '@moxxy/plugin-stt-whisper', plugin: buildWhisperPlugin() },
    {
      name: '@moxxy/plugin-stt-whisper-codex',
      plugin: buildWhisperCodexPlugin({ vault }),
    },
    { name: '@moxxy/plugin-memory', plugin: memoryPlugin },
    {
      name: '@moxxy/memory-consolidate',
      plugin: buildMemoryConsolidatePlugin(memory, () => session.providers.getActive()),
    },
    { name: '@moxxy/plugin-cli', plugin: cliPlugin },
    // Cross-session token usage. onShutdown folds this run's provider_response
    // usage by provider/model into ~/.moxxy/usage.json (a forward-going
    // aggregate). Surfaced in the /usage panel; reset via /usage clear.
    { name: '@moxxy/plugin-usage-stats', plugin: buildUsageStatsPlugin() },
    { name: '@moxxy/plugin-channel-http', plugin: httpChannelPlugin },
    {
      name: '@moxxy/plugin-channel-web',
      plugin: buildWebChannelPlugin({
        getTunnel: () => session.tunnelProviders.getActive(),
        publishSurface: (s) => {
          viewSurface.current = s;
        },
        publishControls: (c) => {
          webControls.current = c;
        },
        getControls: () => webControls.current,
        tunnels: {
          list: () => session.tunnelProviders.list().map((p) => p.name),
          active: () => session.tunnelProviders.getActive()?.name ?? null,
          setActive: (n) => session.tunnelProviders.setActive(n),
          isAvailable: async (n) => {
            const p = session.tunnelProviders.list().find((x) => x.name === n);
            return p?.isAvailable ? p.isAvailable() : true;
          },
        },
        ...(typeof (rawConfig.channels as { web?: { tunnel?: unknown } } | undefined)?.web?.tunnel === 'string'
          ? { defaultTunnel: (rawConfig.channels as { web?: { tunnel?: string } }).web!.tunnel }
          : {}),
      }),
    },
    { name: '@moxxy/plugin-telegram', plugin: buildTelegramPlugin({ vault }) },
    { name: '@moxxy/plugin-browser', plugin: browserPlugin },
    // macOS-only computer control: screenshot, click, type, key,
    // open, clipboard, applescript. Plugin always registers (so the
    // model's tool list is stable across hosts); handlers throw a
    // clear "macOS only" error on Linux/Windows.
    { name: '@moxxy/plugin-computer-control', plugin: computerControlPlugin },
    // Generic OAuth 2.0 + PKCE client. Adds oauth_authorize /
    // oauth_get_token / oauth_clear_token tools that any skill can
    // chain (Google OAuth → MCP env, GitHub OAuth → API calls, …).
    { name: '@moxxy/plugin-oauth', plugin: buildOauthPlugin({ vault }) },
    // Universal slash commands (/info, /clear, /new, /exit, /help)
    // shared across every channel via session.commands. Disable to
    // hide them everywhere — channel-local commands keep working.
    { name: '@moxxy/plugin-commands', plugin: commandsPlugin },
    // Agent-authored UIs: present_view parses the model's JSX-like view-spec
    // (via the session's active, swappable view renderer) into a validated AST
    // that the web surface renders as interactive UI. The renderer is reached
    // through a closure since ToolContext exposes no session handle.
    {
      name: '@moxxy/plugin-view',
      plugin: buildViewPlugin({
        getRenderer: () => session.viewRenderers.getActive(),
        getSurface: () => viewSurface.current,
      }),
    },
    // Subagents are a swappable block: this plugin owns the
    // dispatch_agent tool and the auto-detection skill. Drop it
    // (`config.plugins['@moxxy/plugin-subagents'].enabled = false`) and
    // the model can't spawn children — the normal single-loop flow runs.
    // Agent kinds (researcher, code-reviewer, ...) come from OTHER plugins
    // via `PluginSpec.agents`; the closure here reads the live registry.
    {
      name: '@moxxy/plugin-subagents',
      plugin: buildSubagentsPlugin({
        getAgent: (name) => session.agents.get(name),
      }),
    },
    // Runtime plugin installer — exposes `install_plugin` to the model.
    // Hot-reloads via session.pluginHost.reload() so newly-npm-installed
    // packages drop into the active registries without restart. Drop this
    // plugin to lock the plugin set (e.g. for production deployments).
    {
      name: '@moxxy/plugin-plugins-admin',
      plugin: buildPluginsAdminPlugin({
        reload: () => session.pluginHost.reload(),
        snapshot: () => ({
          tools: session.tools.list().map((t) => t.name),
          agents: session.agents.list().map((a) => a.name),
          providers: session.providers.list().map((p) => p.name),
          modes: session.modes.list().map((l) => l.name),
          compactors: session.compactors.list().map((c) => c.name),
          channels: session.channels.list().map((c) => c.name),
        }),
      }),
    },
    // Self-update — exposes self_update_* tools so the model can author
    // and apply guardrailed, transactional changes to its OWN plugins /
    // skills (Tier 1, hot-reloaded) under ~/.moxxy. Every code write is
    // permission-gated; verify builds+tests+loads the change and a failed
    // modify auto-restores the previous version. Disable this plugin
    // (`config.plugins['@moxxy/plugin-self-update'].enabled = false`) to
    // lock the code base.
    {
      name: '@moxxy/plugin-self-update',
      plugin: buildSelfUpdatePlugin({
        moxxyDir: path.join(os.homedir(), '.moxxy'),
        reload: () => session.pluginHost.reload(),
        unload: (name) => session.pluginHost.unload(name),
        snapshot: () => ({
          tools: session.tools.list().map((t) => t.name),
          agents: session.agents.list().map((a) => a.name),
          providers: session.providers.list().map((p) => p.name),
          modes: session.modes.list().map((l) => l.name),
          compactors: session.compactors.list().map((c) => c.name),
          channels: session.channels.list().map((c) => c.name),
        }),
        skipped: () =>
          session.pluginHost.listSkipped().map((s) => ({
            pluginName: s.pluginName,
            ...(s.packageName ? { packageName: s.packageName } : {}),
            message: s.message,
          })),
        emit: (e) =>
          session.log
            .append({
              type: 'plugin_event',
              pluginId: asPluginId('@moxxy/plugin-self-update'),
              subtype: e.subtype,
              payload: e.payload,
              sessionId: e.sessionId,
              turnId: e.turnId,
              source: 'plugin',
            })
            .then(() => undefined),
        ...(typeof rawConfig.plugins?.['@moxxy/plugin-self-update']?.options?.maxTxnRetained === 'number'
          ? {
              maxTxnRetained: rawConfig.plugins['@moxxy/plugin-self-update'].options
                .maxTxnRetained as number,
            }
          : {}),
        // Tier-2 core-patching is on by default; set
        // options.allowCoreUpdate = false to hide the self_update_core_* tools.
        // options.repoUrl overrides the git source (needed if @moxxy/core's
        // published package.json lacks a `repository` field).
        coreUpdate: {
          enabled: rawConfig.plugins?.['@moxxy/plugin-self-update']?.options?.allowCoreUpdate !== false,
          ...(typeof rawConfig.plugins?.['@moxxy/plugin-self-update']?.options?.repoUrl === 'string'
            ? { repoUrlOverride: rawConfig.plugins['@moxxy/plugin-self-update'].options.repoUrl as string }
            : {}),
        },
      }),
    },
    // Provider admin tools (provider_add, provider_list, provider_remove,
    // provider_test). Persists OpenAI-compatible vendor registrations to
    // ~/.moxxy/providers.json; the plugin's onInit re-registers them on
    // every boot. Pairs with the `add-provider` skill which walks the
    // model through gathering baseURL + models + key.
    {
      name: '@moxxy/plugin-provider-admin',
      plugin: buildProviderAdminPlugin({ providerRegistry: session.providers }),
    },
    // Admin tools (mcp_add_server, mcp_list_servers, mcp_remove_server,
    // mcp_test_server) plus the boot-time lazy attach. Passing the
    // session's live tool registry enables both hot-attach for runtime
    // adds AND lazy stub registration in onInit for saved servers.
    (() => {
      const { plugin, api } = buildMcpAdminPluginWithApi({
        toolRegistry: session.tools,
        skillRegistry: session.skills,
        userSkillsDir: rawConfig.skills?.userDir,
      });
      // Stash the api on the session so the TUI / CLI can call
      // enableAndAttach + detach without going through the model. `mcpAdmin` is
      // a typed optional capability on Session (McpAdminView); McpAdminApi
      // structurally satisfies it.
      session.mcpAdmin = api;
      return { name: '@moxxy/plugin-mcp-admin', plugin };
    })(),
    {
      name: '@moxxy/synthesize-skill',
      // Thread the SAME directory set the boot scan uses so reload_skills
      // doesn't drop builtin/plugin skills when invoked at runtime.
      plugin: buildSynthesizeSkillPlugin(session, {
        builtinDir: BUILTIN_SKILLS_DIR_RESOLVED,
        ...(rawConfig.skills?.extraDirs ? { pluginDirs: rawConfig.skills.extraDirs } : {}),
        ...(rawConfig.skills?.projectDir ? { projectDir: rawConfig.skills.projectDir } : {}),
        ...(rawConfig.skills?.userDir ? { userDir: rawConfig.skills.userDir } : {}),
      }),
    },
  ];

  // Scheduler — fires recurring/one-shot prompts at user-defined times.
  // The runner reuses the active session for v1; scheduled prompts
  // appear in conversation history so the user sees what fired. An
  // isolated child-session runner is the obvious follow-up to avoid
  // context pollution.
  const { plugin: schedulerPlugin, store: scheduleStore, poller: schedulerPoller } =
    buildSchedulerPlugin({
      runner: schedulerRunner,
      skills: session.skills,
      logger,
    });
  entries.push({ name: '@moxxy/plugin-scheduler', plugin: schedulerPlugin });

  // Workflows — saved DAGs of skills/prompts/tools. Reuses the scheduler store
  // for time triggers (no new timer), the EventLog for afterWorkflow, and the
  // subagent spawner for step execution. Stashes a `WorkflowsView` on the
  // session (in onReady) backing the `/workflows` modal.
  const workflows = buildWorkflowsIntegration({ session, scheduleStore, logger });
  entries.push({ name: '@moxxy/plugin-workflows', plugin: workflows.plugin });

  // Webhooks — generic external-event triggers. Listens on its own port
  // (default 3738) and dispatches verified deliveries to runTurn via
  // the supplied runner. Agent-facing tools (webhook_create,
  // webhook_tunnel_start, webhook_setup_guide, …) let a non-technical
  // user walk through tunnel + provider setup in conversation.
  const {
    plugin: webhooksPlugin,
    store: webhookStore,
    config: webhookConfig,
    stop: stopWebhooks,
  } = buildWebhooksPlugin({
    runner: webhookRunner,
    logger,
  });
  entries.push({ name: '@moxxy/plugin-webhooks', plugin: webhooksPlugin });

  // Security plugin — always registered, but a no-op unless
  // `security.enabled: true` in the loaded config. Its onInit hook
  // fires AFTER every other plugin has registered, so it sees the
  // fully-populated tool registry when wrapping declared-isolation
  // tools. Tools without an `isolation` declaration pass through
  // untouched (unless `security.requireDeclaration` is set).
  const security = buildSecurityPlugin({
    config: {
      enabled: rawConfig.security?.enabled ?? false,
      ...(rawConfig.security?.isolator ? { isolator: rawConfig.security.isolator } : {}),
      ...(rawConfig.security?.perTool ? { perTool: rawConfig.security.perTool } : {}),
      ...(rawConfig.security?.perPlugin ? { perPlugin: rawConfig.security.perPlugin } : {}),
      ...(rawConfig.security?.requireDeclaration !== undefined
        ? { requireDeclaration: rawConfig.security.requireDeclaration }
        : {}),
    },
    toolRegistry: session.tools,
    resolvePluginForTool: null,
    // Register the worker_threads isolator so users can opt in via
    // `security: { isolator: 'worker' }`. It coexists with the built-in
    // `none` + `inproc` isolators; unused isolators have no runtime cost.
    isolators: [workerIsolator, subprocessIsolator, wasmIsolator],
  });
  entries.push({ name: '@moxxy/plugin-security', plugin: security.plugin });

  return {
    entries,
    scheduler: { store: scheduleStore, poller: schedulerPoller },
    webhooks: { store: webhookStore, config: webhookConfig, stop: stopWebhooks },
    security,
    workflows: { store: workflows.store, stop: workflows.stop },
  };
}

// runTurn is re-exported so scheduler-runner.ts and any other consumer
// can share the same dependency surface as the builtins.
export { runTurn };
