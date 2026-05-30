<p align="center">
  <a href="https://moxxy.ai">
    <img src="https://moxxy.ai/moxxy-head-256.png" alt="moxxy" width="128" />
  </a>
</p>

<h1 align="center">@moxxy/cli</h1>

<p align="center">
  The <code>moxxy</code> binary.<br/>
  An interactive TUI, one-shot prompts, channels, scheduler, MCP, and OS services in a single bundled command.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@moxxy/cli">
    <img src="https://img.shields.io/npm/v/@moxxy/cli?logo=npm&logoColor=white" alt="npm" />
  </a>
  <a href="https://nodejs.org">
    <img src="https://img.shields.io/badge/node-%3E%3D20.10-brightgreen?logo=node.js&logoColor=white" alt="Node ≥20.10" />
  </a>
  <a href="https://www.typescriptlang.org">
    <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  </a>
  <a href="https://github.com/moxxy-ai/new_moxxy/actions/workflows/ci.yml">
    <img src="https://github.com/moxxy-ai/new_moxxy/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
</p>

<p align="center">
  <a href="#installation">Install</a>
  &nbsp;·&nbsp;
  <a href="#quickstart">Quickstart</a>
  &nbsp;·&nbsp;
  <a href="https://moxxy.ai">Docs</a>
  &nbsp;·&nbsp;
  <a href="#commands">Commands</a>
  &nbsp;·&nbsp;
  <a href="#channels">Channels</a>
  &nbsp;·&nbsp;
  <a href="#services">Services</a>
</p>

---

## What this package is

`@moxxy/cli` is the published `moxxy` binary. It bundles the framework runtime, every built-in mode, every built-in provider, every built-in plugin, the Ink TUI channel, MCP support, the scheduler, webhooks, and the OS service installer into a single executable.

Install this if you want to use moxxy. If you want to author plugins, depend on [`@moxxy/sdk`](https://www.npmjs.com/package/@moxxy/sdk) instead.

## What you get out of the box

- A complete agent stack with Anthropic, OpenAI, and ChatGPT (OAuth) providers.
- Five loop strategies: `tool-use` (default Claude-Code-style), `plan-execute`, `bmad`, `developer`, and `deep-research`.
- Built-in tools: Read, Edit, Write, Bash, Grep, Glob, WebFetch, computer-control (macOS), and browser-session (Playwright, optional).
- Multi-channel by design: TUI, Telegram, HTTP, web, cron, and webhooks. One session can drive several surfaces at once.
- Voice input on any audio-capable channel through `@moxxy/plugin-stt-whisper`.
- An encrypted vault (AES-256-GCM at rest) so secrets in config are referenced as `${vault:KEY}` and never written in plaintext.
- A long-term memory subsystem with a journal and vector recall. TF-IDF ships built-in. Swap to OpenAI embeddings via `@moxxy/plugin-embeddings-openai`.
- A permission resolver that gates every tool call and learns allow-always rules per tool.
- Opt-in capability isolation. Tools declare what they need and an isolator enforces it. `inproc` ships built-in. `worker`, `subprocess`, `wasm`, and Docker isolators drop in behind the same interface.
- A scheduler for cron expressions and one-shot ISO timestamps.
- A webhook listener with HMAC verification, header and JSON-path filters, and a `cloudflared` or `ngrok` tunnel helper.
- An OS service installer for launchd (macOS) and systemd (Linux), or a single `serve --background` process that runs every channel together.

## Installation

```sh
npm install -g @moxxy/cli
```

Or run it without installing:

```sh
npx @moxxy/cli init
```

Requirements: Node.js 20.10 or later. An API key for a supported provider (Anthropic, OpenAI), or sign into ChatGPT via `moxxy login openai-codex`.

## Quickstart

```sh
moxxy init      # interactive: choose provider, paste API key (stored in the vault)
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

`moxxy --help` lists every command. `moxxy <command> --help` shows per-command details.

## Commands

The CLI groups commands the same way `moxxy --help` does.

### Setup

| Command | What it does |
|---|---|
| `moxxy init` | Interactive first-time setup. Picks a provider, captures the key, writes it into the vault. |
| `moxxy login <provider>` | OAuth sign-in for providers that do not use API keys (for example `openai-codex`). |
| `moxxy login status` | Show stored OAuth credentials. |
| `moxxy login logout <provider>` | Remove stored OAuth credentials. |
| `moxxy doctor` | Diagnose your install: provider readiness, vault unlock, missing optional dependencies. |

### Run

| Command | What it does |
|---|---|
| `moxxy` | Default. Starts the Ink TUI. |
| `moxxy tui` | Same as above, explicit. |
| `moxxy -p "…"` (or `--prompt`) | One-shot prompt to stdout. |
| `moxxy resume [-s <id>]` | Resume a persisted session. Interactive picker if no id. |
| `moxxy <channel>` | Start a registered channel by name. |
| `moxxy channels` | List registered channels and their subcommands. |
| `moxxy serve` | Start every channel together with the scheduler and webhooks in one process. |

### Manage

| Command | What it does |
|---|---|
| `moxxy sessions list` and `delete` | Inspect or remove persisted sessions. |
| `moxxy skills list`, `new`, `audit` | Manage skill files across user, project, builtin, and plugin scopes. |
| `moxxy plugins list`, `reload`, `new` | Manage the plugin host. `reload` picks up newly installed packages. |
| `moxxy mcp list`, `add`, `enable`, `disable`, `remove` | Manage MCP servers in `~/.moxxy/mcp.json`. |
| `moxxy perms list`, `add`, `remove` | Inspect or edit the persisted permission rules. |
| `moxxy memory journal` and `recall` | Read or query long-term memory. |
| `moxxy schedule add`, `list`, `remove` | Time-driven prompts (cron or one-shot ISO). |
| `moxxy security audit`, `status`, `isolators` | Inspect tool capability declarations and the active isolator. |
| `moxxy service install`, `logs`, `status`, `uninstall` | Background OS services (launchd or systemd). |
| `moxxy self-update` | Update bundled plugins, skills, and core safely. |

### Flags

| Flag | What it does |
|---|---|
| `--prompt`, `-p "…"` | One-shot input. |
| `--model <id>` | Override the default model for this invocation. |
| `--output-format <fmt>` | `text`, `json`, or `stream-json` (one-shot output mode). |
| `--cwd <path>` | Set the agent's working directory. |
| `--config <path>` | Load a specific `moxxy.config.ts`. |
| `--no-color` | Disable ANSI colors. |
| `-h`, `--help`, `-v`, `--version` | Standard. |

### Environment

| Variable | What it does |
|---|---|
| `ANTHROPIC_API_KEY` | Default Anthropic provider key. |
| `OPENAI_API_KEY` | OpenAI provider key (also used by the openai embeddings plugin). |
| `MOXXY_VAULT_PASSPHRASE` | Headless vault unlock when no OS keychain is available. |
| `MOXXY_FIXTURES` | `record` or `replay`. Provider fixture mode used by tests. |

## Channels

Run your agent through whichever surface fits the task.

| Channel | What it does | Command |
|---|---|---|
| TUI | Grok-style interactive terminal UI. | `moxxy` |
| Telegram | Message the agent from anywhere. Voice notes get transcribed and run as turns. Pairs with a 6-digit code. | `moxxy telegram` |
| HTTP | `POST /v1/turn` (JSON, SSE streaming) and `POST /v1/turn/audio` (raw bytes, iOS Shortcut friendly), bearer-token auth. | `moxxy channels http` |
| Cron | Time-driven prompts. Cron expressions or one-shot ISO timestamps. | `moxxy schedule add …` |
| Webhooks | External systems fire prompts on signed POST. HMAC plus bearer plus filter rules. | `moxxy serve` (auto-starts the listener) |

## Services

Two ways to keep moxxy online 24/7.

Per-channel units, one process each so failures stay independent:

```sh
moxxy service install telegram     # launchd on macOS, systemd --user on Linux
moxxy service logs telegram         # tail the log
```

Or one process for everything, with a shared event log:

```sh
moxxy serve --background            # every channel plus the scheduler plus webhooks
moxxy serve --background --except http   # skip what you do not want
moxxy serve --status                # is it running?
```

Logs land in `~/.moxxy/services/<name>.log`. The units survive reboots.

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
  mode: 'tool-use',
  plugins: {
    '@moxxy/mode-plan-execute': { enabled: false },     // disable per-plugin
  },
});
```

`${vault:NAME}` placeholders resolve on session start. The vault unlocks via OS keychain (`keytar`) with a passphrase fallback (`MOXXY_VAULT_PASSPHRASE` for headless boxes).

## Docs

Full documentation lives at [docs.moxxy.ai](https://docs.moxxy.ai): concepts, recipes, plugin authoring, channel guides. The marketing site is at [moxxy.ai](https://moxxy.ai).

## Contributing

PRs welcome. The issue tracker and author guides live in the [moxxy monorepo](https://github.com/moxxy-ai/new_moxxy).

## License

MIT. See the repository root for the full text.
