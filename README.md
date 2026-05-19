<p align="center">
  <a href="https://moxxy.dev">
    <img src="https://moxxy.ai/logo-gradient.svg" alt="moxxy" width="160" />
  </a>
</p>

<h1 align="center">moxxy</h1>

<p align="center">
  <strong>The agent framework where every block is swappable.</strong><br/>
  Bring your own model. Bring your own loop. Bring your own tools.
</p>

<p align="center">
  <a href="https://github.com/moxxy-ai/new_moxxy/actions/workflows/ci.yml">
    <img src="https://github.com/moxxy-ai/new_moxxy/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <a href="https://nodejs.org">
    <img src="https://img.shields.io/badge/node-%3E%3D20.10-brightgreen?logo=node.js&logoColor=white" alt="Node ≥20.10" />
  </a>
  <a href="https://www.typescriptlang.org">
    <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  </a>
  <a href="https://pnpm.io">
    <img src="https://img.shields.io/badge/pnpm-workspace-F69220?logo=pnpm&logoColor=white" alt="pnpm" />
  </a>
  <a href="#-license">
    <img src="https://img.shields.io/badge/license-TBD-lightgrey" alt="License" />
  </a>
  <a href="#-contributing">
    <img src="https://img.shields.io/badge/PRs-welcome-brightgreen" alt="PRs welcome" />
  </a>
</p>

<p align="center">
  <a href="#-installation">Install</a>
  &nbsp;·&nbsp;
  <a href="#-quickstart">Quickstart</a>
  &nbsp;·&nbsp;
  <a href="https://moxxy.dev">Docs</a>
  &nbsp;·&nbsp;
  <a href="#-channels">Channels</a>
  &nbsp;·&nbsp;
  <a href="#-developer-guide">Developer guide</a>
</p>

---

## ✨ Why moxxy?

Most agent frameworks lock you in. One LLM provider. One loop topology. One frontend. One opinionated way the agent should behave.

**moxxy doesn't.** Every block is a plugin. Swap Anthropic for OpenAI. Swap the default `tool-use` loop for `plan-execute` or `bmad`. Drive the agent from your terminal, from Telegram, from an HTTP endpoint — or all three at once, on the same Session.

|   |   |
|---|---|
| 🧩 **Truly modular** | Provider, loop strategy, tools, compactor, channel — everything is a swappable plugin. |
| 🔌 **Plug-and-play** | Install a package, it's auto-discovered. Hot-reload without restarting. |
| 🤖 **Multi-channel** | TUI, Telegram, HTTP — one Session, many surfaces. |
| 🔐 **Secrets done right** | Built-in AES-256-GCM vault. OS keychain by default, passphrase fallback. |
| 🧠 **Long-term memory** | Journal-based with vector recall. TF-IDF ships built-in; swap to OpenAI embeddings. |
| 🛠 **Type-safe SDK** | Zero-runtime-dep `@moxxy/sdk` is the contract. Author plugins with full IDE support. |
| ⏰ **Always-on** | `moxxy service install` turns any channel into a launchd / systemd background service. |
| 🪪 **Permissions** | Every tool call gated. Allow-always rules learned per tool over time. |

## 🚀 Installation

```sh
npm install -g @moxxy/cli
```

Or run it without installing:

```sh
npx @moxxy/cli init
```

**Requirements**: Node.js ≥ 20.10. An API key for a supported provider (Anthropic, OpenAI, or ChatGPT via OAuth).

## ⚡ Quickstart

```sh
moxxy init      # interactive: choose provider, paste API key (goes into the vault)
moxxy           # launch the interactive TUI
```

One-shot from the command line:

```sh
moxxy -p "summarize the README in three bullets"
```

Resume a previous conversation:

```sh
moxxy resume
```

That's it. `moxxy --help` lists every command; `moxxy <command> --help` shows per-command details.

## 📺 Channels

Run your agent through whatever surface fits the task:

| Channel | What it does | Command |
|---|---|---|
| **TUI** | Grok-style interactive terminal UI | `moxxy` |
| **Telegram** | Message your agent from anywhere; pairs with a 6-digit code | `moxxy telegram` |
| **HTTP** | `POST /v1/turn` with SSE streaming, bearer-token auth | `moxxy channels http` |
| **Cron** | Time-driven prompts (cron expressions or one-shot ISO timestamps) | `moxxy schedule add …` |

Keep them online 24/7 as background OS services:

```sh
moxxy service install telegram     # launchd on macOS, systemd --user on Linux
moxxy service status                # see what's running
moxxy service logs telegram         # tail the log
```

Logs land in `~/.moxxy/services/<name>.log`; units survive reboots.

## 🧩 What's in the box

- **Providers** — Anthropic, OpenAI, Codex (ChatGPT OAuth). Add your own with one `defineProvider({})`.
- **Loop strategies** — `tool-use` (default, Claude-Code-style), `plan-execute` (plan → validate → execute), `bmad` (analysis → planning → solutioning → implementation).
- **Built-in tools** — Read, Edit, Write, Bash, Grep, Glob, WebFetch, plus computer-control (macOS) and browser-session (Playwright).
- **MCP** — register any Model Context Protocol server as a tool source.
- **Skills** — prompt-only Markdown files. The agent can author new skills for itself when no existing skill fits.
- **Memory** — long-term journal + STM event-log selectors. TF-IDF vector recall built in; swap to OpenAI embeddings via `@moxxy/plugin-embeddings-openai`.
- **Vault** — AES-256-GCM at rest. Reference secrets in config as `${vault:KEY}`.

## 📚 Docs

Full docs at **[moxxy.dev](https://moxxy.dev)** — concepts, recipes, plugin authoring, channel guides.

---

# 🛠 Developer guide

Everything below is for plugin authors, contributors, and folks embedding moxxy in their own TypeScript apps.

## Embedding the SDK

```ts
import { Session, runTurn, autoAllowResolver } from '@moxxy/core';
import { anthropicPlugin } from '@moxxy/plugin-provider-anthropic';
import { builtinToolsPlugin } from '@moxxy/tools-builtin';
import { toolUseLoopPlugin } from '@moxxy/loop-tool-use';

const session = new Session({ cwd: process.cwd(), permissionResolver: autoAllowResolver });
session.pluginHost.registerStatic(anthropicPlugin);
session.pluginHost.registerStatic(builtinToolsPlugin);
session.pluginHost.registerStatic(toolUseLoopPlugin);
session.providers.setActive('anthropic');

for await (const event of runTurn(session, 'list TS files in cwd')) {
  if (event.type === 'assistant_chunk') process.stdout.write(event.delta);
}
```

## Authoring a plugin

```ts
import { definePlugin, defineTool, z } from '@moxxy/sdk';

export default definePlugin({
  name: '@acme/moxxy-plugin-greet',
  tools: [
    defineTool({
      name: 'greet',
      description: 'Return a greeting for the given name.',
      inputSchema: z.object({ name: z.string() }),
      handler: ({ name }) => `Hello, ${name}!`,
    }),
  ],
});
```

Add a `"moxxy"` block to your `package.json` and moxxy auto-discovers it:

```json
{
  "moxxy": { "plugin": { "entry": "./dist/index.js", "kind": "tools" } }
}
```

Per-block author guides live in [`.claude/agents/`](.claude/agents/) — one per surface (skill, plugin, tool, channel, provider, loop strategy, compactor).

## Configuration

`moxxy.config.ts` at your project root:

```ts
import { defineConfig } from '@moxxy/config';

export default defineConfig({
  provider: {
    name: 'anthropic',
    model: 'claude-sonnet-4-6',
    config: { apiKey: '${vault:ANTHROPIC_API_KEY}' },   // resolved from the vault
  },
  loop: 'tool-use',
  plugins: {
    '@moxxy/loop-plan-execute': { enabled: false },     // disable per-plugin
  },
});
```

`${vault:NAME}` placeholders are resolved on session start. The vault unlocks via OS keychain (`keytar`) with a passphrase fallback (`MOXXY_VAULT_PASSPHRASE` for headless boxes).

## Architecture

```
@moxxy/sdk                          ← typed public surface (zero runtime deps)
@moxxy/core                         ← runtime: event log, registries, plugin host, permissions, skills
@moxxy/tools-builtin                ← Read / Edit / Write / Bash / Grep / Glob
@moxxy/loop-tool-use                ← default loop strategy
@moxxy/loop-plan-execute            ← plan-then-execute strategy
@moxxy/loop-bmad                    ← BMAD multi-persona loop
@moxxy/plugin-provider-anthropic    ← LLM provider
@moxxy/plugin-provider-openai       ← LLM provider
@moxxy/plugin-provider-openai-codex ← ChatGPT OAuth provider
@moxxy/plugin-mcp                   ← MCP servers as tool sources
@moxxy/plugin-vault                 ← encrypted secrets
@moxxy/plugin-memory                ← journal LTM + vector recall + STM selectors
@moxxy/plugin-embeddings-openai     ← neural embeddings (optional)
@moxxy/plugin-browser               ← headless Playwright sidecar + web_fetch
@moxxy/plugin-computer-control      ← macOS native input (screenshot, click, type, …)
@moxxy/plugin-oauth                 ← generic OAuth 2.0 + PKCE / device-code
@moxxy/plugin-cli                   ← Ink TUI + TuiChannel
@moxxy/plugin-telegram              ← TelegramChannel via grammy
@moxxy/plugin-channel-http          ← HTTP channel (POST /v1/turn + SSE)
@moxxy/plugin-scheduler             ← time-driven prompts
@moxxy/plugin-subagents             ← spawn sub-agents from a turn
@moxxy/compactor-summarize          ← default context-window compactor
@moxxy/cli                          ← the `moxxy` binary
@moxxy/config                       ← defineConfig + moxxy.config.ts loader
@moxxy/testing                      ← FakeProvider + record/replay harness
```

The hard invariant: `@moxxy/sdk` has zero internal deps; `@moxxy/core` doesn't import any plugin. Enforced in CI via `pnpm check:deps`.

## Repo layout

```
packages/        publishable @moxxy/* packages
apps/            runnable examples (example-basic, example-cli, fixture-recorder, docs)
tooling/         shared tsconfig + eslint + vitest preset
.claude/agents/  AI-agent author guides (skill, plugin, tool, channel, provider, …)
AGENTS.md        index for AI agents working in this repo
```

## Development

```sh
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm -r test           # 250+ tests across the workspace
pnpm check:deps        # architectural invariant check (SDK & core stay clean)
```

CI runs all of the above on every push + PR.

## 🤝 Contributing

PRs welcome. Open an issue first for anything non-trivial. Per-block author guides in [`.claude/agents/`](.claude/agents/) describe how to write skills, plugins, tools, channels, providers, loop strategies, and compactors.

## 📝 License

TBD.
