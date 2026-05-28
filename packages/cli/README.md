<p align="center">
  <a href="https://moxxy.ai">
    <img src="https://moxxy.ai/logo-gradient.svg" alt="moxxy" width="160" />
  </a>
</p>

<h1 align="center">@moxxy/cli</h1>

<p align="center">
  <strong>The <code>moxxy</code> binary.</strong><br/>
  Interactive TUI, one-shot prompts, channels, scheduler, MCP, services — all the surfaces in one bundled command.
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
  <a href="#-installation">Install</a>
  &nbsp;·&nbsp;
  <a href="#-quickstart">Quickstart</a>
  &nbsp;·&nbsp;
  <a href="https://moxxy.ai">Docs</a>
  &nbsp;·&nbsp;
  <a href="#-commands">Commands</a>
  &nbsp;·&nbsp;
  <a href="#-channels">Channels</a>
  &nbsp;·&nbsp;
  <a href="#-services">Services</a>
</p>

---

## ✨ What this package is

`@moxxy/cli` is the published `moxxy` binary. It bundles the framework runtime, every built-in mode + provider + plugin, the Ink TUI channel, MCP support, the scheduler, webhooks, and the OS-service installer into a single executable.

If you want to **use** moxxy, install this. If you want to **author plugins**, depend on [`@moxxy/sdk`](https://www.npmjs.com/package/@moxxy/sdk) instead.

|   |   |
|---|---|
| 🧩 **Every block is a plugin** | Anthropic / OpenAI / ChatGPT-OAuth providers, five loop strategies, built-in Read/Edit/Write/Bash/Grep/Glob, MCP, memory, vault — all swappable. |
| 📺 **Multi-channel** | TUI, Telegram, HTTP, web, cron, webhooks — one session, many surfaces. |
| 🎙 **Voice in** | Telegram voice notes & `POST /v1/turn/audio` route through a `Transcriber` (Whisper plugin ships built-in). |
| 🔐 **Vault** | AES-256-GCM secrets at rest; reference as `${vault:KEY}` in config. |
| 🧠 **Long-term memory** | Journal-based with vector recall; TF-IDF built in, swap to OpenAI embeddings. |
| ⏰ **Always-on** | `moxxy service install` for per-channel launchd / systemd units, or `moxxy serve --background` for everything in one process. |
| 🪪 **Permission gating** | Every tool call gated; allow-always rules learned per tool. |
| 🛡 **Pluggable isolation** | Opt-in capability sandboxing (`inproc` shipped; `worker` / `subprocess` / `wasm` / `docker` drop-in). Off by default. |

## 🚀 Installation

```sh
npm install -g @moxxy/cli
```

Or run it without installing:

```sh
npx @moxxy/cli init
```

**Requirements**: Node.js ≥ 20.10. An API key for a supported provider (Anthropic, OpenAI) — or sign into ChatGPT via `moxxy login openai-codex`.

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

## 🧭 Commands

The `moxxy` CLI groups commands the same way `moxxy --help` does:

### Setup

| Command | What it does |
|---|---|
| `moxxy init` | Interactive first-time setup. Picks a provider, captures the key, writes it into the vault. |
| `moxxy login <provider>` | OAuth sign-in for providers that don't use API keys (e.g. `openai-codex`). |
| `moxxy login status` | Show stored OAuth credentials. |
| `moxxy login logout <provider>` | Remove stored OAuth credentials. |
| `moxxy doctor` | Diagnose your install — provider readiness, vault unlock, missing optional deps. |

### Run

| Command | What it does |
|---|---|
| `moxxy` | Default — start the Ink TUI. |
| `moxxy tui` | Same, explicit. |
| `moxxy -p "…"` (or `--prompt`) | One-shot prompt to stdout. |
| `moxxy resume [-s <id>]` | Resume a persisted session (interactive picker if no id). |
| `moxxy <channel>` | Start a registered channel by name. |
| `moxxy channels` | List registered channels + their subcommands. |
| `moxxy serve` | Start every channel + the scheduler + webhooks in one process. |

### Manage

| Command | What it does |
|---|---|
| `moxxy sessions list` / `delete` | Inspect or remove persisted sessions. |
| `moxxy skills list` / `new` / `audit` | Manage skill files (user / project / builtin / plugin scopes). |
| `moxxy plugins list` / `reload` / `new` | Manage the plugin host; reload picks up newly installed packages. |
| `moxxy mcp list` / `add` / `enable` / `disable` / `remove` | Manage MCP servers in `~/.moxxy/mcp.json`. |
| `moxxy perms list` / `add` / `remove` | Inspect or edit the persisted permission rules. |
| `moxxy memory journal` / `recall` | Read or query long-term memory. |
| `moxxy schedule add` / `list` / `remove` | Time-driven prompts (cron or one-shot ISO). |
| `moxxy security audit` / `status` / `isolators` | Inspect tool capability declarations and active isolator. |
| `moxxy service install` / `logs` / `status` / `uninstall` | Background OS services (launchd / systemd). |
| `moxxy self-update` | Update bundled plugins/skills/core safely. |

### Flags

| Flag | What it does |
|---|---|
| `--prompt, -p "…"` | One-shot input. |
| `--model <id>` | Override the default model for this invocation. |
| `--output-format <fmt>` | `text` \| `json` \| `stream-json` (one-shot output mode). |
| `--cwd <path>` | Set the agent's working directory. |
| `--config <path>` | Load a specific `moxxy.config.ts`. |
| `--no-color` | Disable ANSI colors. |
| `-h, --help` / `-v, --version` | Standard. |

### Environment

| Variable | What it does |
|---|---|
| `ANTHROPIC_API_KEY` | Default Anthropic provider key. |
| `OPENAI_API_KEY` | OpenAI provider key (and openai embeddings). |
| `MOXXY_VAULT_PASSPHRASE` | Headless vault unlock when no OS keychain is available. |
| `MOXXY_FIXTURES` | `record` \| `replay` — provider fixture mode (used by tests). |

## 📺 Channels

Run your agent through whatever surface fits the task:

| Channel | What it does | Command |
|---|---|---|
| **TUI** | Grok-style interactive terminal UI | `moxxy` |
| **Telegram** | Message your agent from anywhere; voice notes get transcribed and run as turns; pairs with a 6-digit code | `moxxy telegram` |
| **HTTP** | `POST /v1/turn` (JSON, SSE streaming) or `POST /v1/turn/audio` (raw bytes, iOS Shortcut friendly), bearer-token auth | `moxxy channels http` |
| **Cron** | Time-driven prompts (cron expressions or one-shot ISO timestamps) | `moxxy schedule add …` |
| **Webhooks** | External systems fire prompts on signed POST. HMAC + bearer + filter rules. | `moxxy serve` (auto-starts the listener) |

## ⏰ Services

Two ways to keep moxxy online 24/7:

```sh
# Per-channel units (one process each, independent crashes)
moxxy service install telegram     # launchd on macOS, systemd --user on Linux
moxxy service logs telegram         # tail the log

# Or: one process for everything, shared event log
moxxy serve --background            # every channel + scheduler + webhooks
moxxy serve --background --except http   # skip what you don't want
moxxy serve --status                # is it running?
```

Logs land in `~/.moxxy/services/<name>.log`; units survive reboots.

## ⚙ Configuration

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

## 🧩 What ships in the binary

The CLI bundles a complete out-of-the-box stack:

- **Providers**: Anthropic, OpenAI, ChatGPT-OAuth (via `openai-codex`).
- **Loop strategies**: `tool-use` (default Claude-Code-style), `plan-execute`, `bmad`, `developer`, `deep-research`.
- **Tools**: Read, Edit, Write, Bash, Grep, Glob, WebFetch, browser-session (Playwright, optional), computer-control (macOS).
- **MCP**: register any Model Context Protocol server as a tool source.
- **Skills**: prompt-only Markdown files; the agent can author new skills for itself.
- **Memory**: long-term journal + STM selectors; TF-IDF vector recall ships built in.
- **Vault**: AES-256-GCM secrets at rest, `${vault:KEY}` references in config.
- **Voice in**: `@moxxy/plugin-stt-whisper` for any audio-capable channel.
- **Webhooks**: signed HTTP listener + `cloudflared` / `ngrok` tunnel helper.
- **Security**: opt-in capability isolation (`inproc` built-in; `worker` / `subprocess` / `wasm` drop in).

For the full package map and the framework's internal architecture see the [root README](https://github.com/moxxy-ai/new_moxxy#-developer-guide).

## 📚 Docs

Full docs at **[docs.moxxy.ai](https://docs.moxxy.ai)**: concepts, recipes, plugin authoring, channel guides. Marketing site: [moxxy.ai](https://moxxy.ai).

## 🤝 Contributing

PRs welcome. Issue tracker + author guides live in the [moxxy monorepo](https://github.com/moxxy-ai/new_moxxy).

## 📝 License

TBD.
