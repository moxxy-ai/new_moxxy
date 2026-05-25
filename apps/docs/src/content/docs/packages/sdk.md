---
title: '@moxxy/sdk'
description: Typed public surface — event types, define* helpers, all the contracts plugin authors import.
---

`@moxxy/sdk` is the typed public surface of the framework. It has **zero internal dependencies** (only `zod` as a peer). Everything plugin authors need to write, type, and validate comes from here.

## What's exported

### Define* factories

- `definePlugin(spec)` — bundles tools, providers, modes, compactors, hooks
- `defineTool({name, description, inputSchema, handler, ...})` — one tool
- `defineProvider({name, models, createClient})` — an LLM backend
- `defineMode({name, run})` — a turn topology
- `defineCompactor({name, shouldCompact, compact})` — context-window management
- `definePermission(rule)` — declarative allow/deny/prompt rule
- `defineSkill({frontmatter, body})` — programmatic skill (Markdown remains canonical)

### Event types

`MoxxyEvent` discriminated union covers every appended event: `user_prompt`, `assistant_chunk`, `assistant_message`, `tool_call_requested`, `tool_call_approved`, `tool_call_denied`, `tool_result`, `skill_invoked`, `skill_created`, `plugin_registered`, `plugin_unregistered`, `mode_iteration`, `compaction`, `provider_request`, `provider_response`, `error`, `abort`, `plugin_event`.

### Interfaces

- `LLMProvider` — provider implementations
- `ModeContext`, `ModeDef` — modes
- `Channel`, `ChannelHandle` — frontends (TUI, Telegram, …)
- `EmbeddingProvider` — vector embedders (for memory recall)
- `PermissionResolver`, `PermissionRule`, `PermissionDecision`
- `EventLogReader` — read-only event log
- `ToolContext`, `ToolDef`, `ToolCompactPresentation` — tool authoring
- `LifecycleHooks`, `HookDispatcher` — hook contract

### Re-exports

- `z` — re-exported from `zod` so plugin authors don't need to install it
- Branded ID types: `EventId`, `TurnId`, `ToolCallId`, `SessionId`, `PluginId`, `SkillId`
- `skillFrontmatterSchema`, `pluginManifestSchema` — pre-built zod schemas

## Compact tool presentation (opt-in)

`ToolDef.compact` is an optional hint channels MAY use to aggregate
consecutive calls of a tool into a single "live block" in chat-like
surfaces (e.g. the TUI's `Ctrl+O` expand mechanism):

```ts
defineTool({
  name: 'Read',
  description: '…',
  inputSchema: z.object({ file_path: z.string(), … }),
  permission: { action: 'prompt' },
  compact: {
    verb: 'Reading',
    noun: { one: 'file', other: 'files' },
    previewKey: 'file_path',     // optional — which input field to show as preview
  },
  handler: async ({ file_path }) => { … },
});
```

A run of compact calls produces summaries like `Reading 3 files,
searching for 1 pattern…`. Tools without `compact` always render as
their own block. Bash, dispatch_agent, and MCP tools intentionally
omit it — their output matters per-call.

The hint is purely presentational. The event log, providers, and
permission engine see no difference between compact and verbose tools.

## Stability

Treat this package as a stable contract. Additive changes are minor versions; removing or renaming an export is a major. The dependency-cruiser CI check enforces that `@moxxy/sdk` never imports from sibling workspace packages.
