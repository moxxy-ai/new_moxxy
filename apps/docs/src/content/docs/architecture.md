---
title: Architecture
description: The shape of moxxy — sdk, core, plugins, channels.
---

## The blocks

```
@moxxy/sdk             <— typed public surface (zero runtime deps)
@moxxy/core            <— runtime: event log, registries, plugin host, permissions
@moxxy/tools-builtin   <— Read/Edit/Write/Bash/Grep/Glob
@moxxy/mode-tool-use   <— default Claude Code-style mode
@moxxy/mode-plan-execute  <— alternate plan-then-execute strategy
@moxxy/plugin-provider-anthropic  <— LLM provider
@moxxy/plugin-mcp                 <— MCP servers as tool sources
@moxxy/plugin-vault    <— AES-256-GCM encrypted secrets
@moxxy/plugin-memory   <— journal LTM + STM helpers + vector recall
@moxxy/plugin-cli      <— Ink TUI components + TuiChannel
@moxxy/plugin-telegram <— TelegramChannel via grammy
@moxxy/plugin-channel-http <— HTTP channel (POST /v1/turn + audio)
@moxxy/plugin-scheduler   <— time-driven prompts
@moxxy/plugin-webhooks    <— external-event triggers (verified HTTP listener)
@moxxy/plugin-security    <— pluggable capability isolation (opt-in)
@moxxy/cli             <— the `moxxy` binary
@moxxy/chat-model      <— UI-neutral chat model (event→block fold + markdown AST); shared by the TUI + desktop
apps/desktop           <— Electron desktop app (@moxxy/desktop-host main process + @moxxy/desktop-ipc-contract IPC)
```

## State model

Every interaction appends to an immutable event log. Derived state (projected message history, pending tool calls, loaded plugins, …) is a pure fold over the log via selectors.

This shape gives you replay-debugging for free: dump a session log to JSON, feed it back through `replay()`, and you get the exact same derived state.

## Plugin model

Plugins are TypeScript code, distributed as `@moxxy/*` (or `@anyone/*`) npm packages, auto-discovered via `package.json#moxxy.plugin`. They contribute:

- **Tools** (`defineTool`) — actions the model can invoke
- **Providers** (`defineProvider`) — LLM backends
- **Modes** (`defineMode`) — how a turn unfolds
- **Compactors** (`defineCompactor`) — context-window management
- **Lifecycle hooks** — `onInit`, `onToolCall`, `onBeforeProviderCall`, …
- **Bundled skills** — Markdown files shipped with the plugin

Plugins and blocks can declare `requirements` for availability and readiness:
required plugins, active providers, runtime auth facts, registered
transcribers, and similar preflight state. The plugin host skips plugins with
missing hard requirements before partial contributions are registered, and
registries check block requirements before activation or execution. See
[Requirements](./guides/requirements).

## Channel model

A `Channel` is a bidirectional frontend that owns a Session: feeds user prompts in, renders assistant chunks + tool activity out, implements `PermissionResolver`. The TUI and Telegram are both Channels. Future Slack/Discord/HTTP channels slot in identically.

```ts
interface Channel<TStartOpts = unknown> {
  readonly name: string;
  readonly permissionResolver: PermissionResolver;
  start(opts: TStartOpts): Promise<ChannelHandle>;
}
```

## Skill model

Skills are prompt-only — Markdown files with YAML frontmatter, Claude Code-compatible. They live, in precedence order:

1. `./.moxxy/skills/**/*.md` (project, checked in)
2. `~/.moxxy/skills/**/*.md` (user; **default target for auto-synthesized skills**)
3. `<plugin>/skills/**/*.md` (bundled with a plugin)
4. `@moxxy/skills-builtin`

When a user prompt matches no existing skill, the loop invokes the built-in `synthesize_skill` tool: the agent drafts a new skill, the user approves, it's written to user-scope, the registry hot-reloads, and the next prompt routes through it.

## The hard invariant

- `@moxxy/sdk` has **zero internal dependencies**.
- `@moxxy/core` imports only from `@moxxy/sdk` and `@moxxy/tools-builtin`.
- `@moxxy/core` does **not** import any plugin.

These are enforced in CI via `pnpm check:deps` (dependency-cruiser). Plugins are allowed to import core (channel plugins like `plugin-telegram` use `runTurn`), but the reverse never holds.
