---
title: Introduction
description: moxxy — a block-based agentic loop framework for TypeScript.
---

**moxxy** is a TypeScript framework for building agentic modes where every block — provider, mode, tool, compactor, channel — is swappable. Skills (Markdown + frontmatter) and plugins (npm packages) compose around a tiny, deterministic core.

## Why

Existing agent frameworks lock you into one LLM provider, one loop topology, one frontend, one set of opinions about how the agent should behave. moxxy starts from a typed contract — `@moxxy/sdk` — and lets you plug everything else in.

- Providers are plugins (`@moxxy/plugin-provider-anthropic`, `@moxxy/plugin-provider-openai`, `@moxxy/plugin-provider-openai-codex` for the ChatGPT-OAuth backend).
- Modes are plugins (`@moxxy/mode-tool-use`, `@moxxy/mode-plan-execute`, `@moxxy/mode-bmad`).
- The CLI / TUI / Telegram bot / HTTP server are all `Channel` implementations.
- Skills are prompt-only Markdown files the agent can author for itself.

## A 30-second tour

```sh
pnpm add @moxxy/cli              # or use the binary directly: pnpm dlx moxxy
moxxy --help

# One-shot, headless:
ANTHROPIC_API_KEY=sk-... moxxy -p "list TS files in cwd" --allow-tools Read,Glob

# Interactive TUI:
moxxy

# Telegram channel: send /start to your bot in Telegram first,
# then paste the 6-digit code the bot DMs you into the moxxy terminal:
moxxy channels telegram pair

# Install channels as background OS units (launchd / systemd --user):
moxxy service install telegram
moxxy service install scheduler
```

Or embed the SDK directly:

```ts
import { Session, runTurn, autoAllowResolver } from '@moxxy/core';
import { anthropicPlugin } from '@moxxy/plugin-provider-anthropic';
import { builtinToolsPlugin } from '@moxxy/tools-builtin';
import { toolUseModePlugin } from '@moxxy/mode-tool-use';

const session = new Session({ cwd: process.cwd(), permissionResolver: autoAllowResolver });
session.pluginHost.registerStatic(anthropicPlugin);
session.pluginHost.registerStatic(builtinToolsPlugin);
session.pluginHost.registerStatic(toolUseModePlugin);
session.providers.setActive('anthropic');

for await (const event of runTurn(session, 'list TS files')) {
  if (event.type === 'assistant_chunk') process.stdout.write(event.delta);
}
```

See [Quickstart](./quickstart) for a full setup, or [Architecture](./architecture) for how the pieces fit together.
