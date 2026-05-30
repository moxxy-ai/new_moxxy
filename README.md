<p align="center">
  <a href="https://moxxy.ai">
    <img src="https://moxxy.ai/moxxy-head-256.png" alt="moxxy" width="128" />
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
  <a href="https://moxxy.ai">Docs</a>
  &nbsp;·&nbsp;
  <a href="#-channels">Channels</a>
  &nbsp;·&nbsp;
  <a href="#-developer-guide">Developer guide</a>
</p>

---

## ✨ Why moxxy?

Most agent frameworks lock you in. One LLM provider. One loop topology. One frontend. One opinionated way the agent should behave.

**moxxy doesn't.** Every block is a plugin. Swap Anthropic for OpenAI. Swap the default `tool-use` loop for `plan-execute` or `bmad`. Drive the agent from your terminal, from Telegram, from an HTTP endpoint, or all three at once on the same Session.

|   |   |
|---|---|
| 🧩 **Truly modular** | Every block is a swappable plugin: provider, loop strategy, tools, compactor, cache strategy, channel. |
| 🔌 **Plug-and-play** | Install a package, it's auto-discovered. Hot-reload without restarting. |
| 🤖 **Multi-channel** | TUI, Telegram, HTTP. One Session, many surfaces. |
| 🎙 **Voice in** | Send Telegram voice notes or POST raw audio to the HTTP channel. Whisper plugin ships with the framework; swap to Deepgram or local whisper.cpp by registering a different `Transcriber`. |
| 🔐 **Secrets done right** | Built-in AES-256-GCM vault. OS keychain by default, passphrase fallback. |
| 🧠 **Long-term memory** | Journal-based with vector recall. TF-IDF ships built-in; swap to OpenAI embeddings. |
| 🛠 **Type-safe SDK** | Zero-runtime-dep `@moxxy/sdk` is the contract. Author plugins with full IDE support. |
| ⏰ **Always-on** | `moxxy service install` turns any channel into a launchd / systemd background service, or `moxxy serve --background` runs everything in one shared-session process. |
| 🔔 **Webhooks** | Any external system can fire prompts: verified (HMAC / bearer), filtered (header + JSON-path include/exclude), idempotent. Auto-tunneled with `cloudflared` for a one-command public URL. |
| 🪪 **Permissions** | Every tool call gated. Allow-always rules learned per tool over time. |
| 🛡 **Pluggable isolation** | Opt-in capability sandboxing. Tools declare what they need (fs paths, hosts, time / memory); an `Isolator` enforces. `inproc` ships built-in; `worker` / `subprocess` / `wasm` / `docker` drop in behind the same interface. Off by default. |

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
| **Telegram** | Message your agent from anywhere; voice notes get transcribed and run as turns; pairs with a 6-digit code | `moxxy telegram` |
| **HTTP** | `POST /v1/turn` (JSON, SSE streaming) or `POST /v1/turn/audio` (raw bytes, iOS Shortcut friendly), bearer-token auth | `moxxy channels http` |
| **Cron** | Time-driven prompts (cron expressions or one-shot ISO timestamps) | `moxxy schedule add …` |
| **Webhooks** | External systems fire prompts on signed POST. HMAC + bearer + filter rules. | `moxxy serve` (auto-starts the listener) |

Keep them online 24/7 as background OS services. Two paths:

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

## 🧩 What's in the box

- **Providers**: Anthropic, OpenAI, Codex (ChatGPT OAuth). Add your own with one `defineProvider({})`.
- **Loop strategies**: `tool-use` (default, Claude-Code-style), `plan-execute` (plan → validate → execute), `bmad` (analysis → planning → solutioning → implementation), `developer` (guardrailed tool-use → verify → commit-with-diff-preview gate), `deep-research` (plan queries → parallel subagent fan-out → cited synthesis).
- **Built-in tools**: Read, Edit, Write, Bash, Grep, Glob, WebFetch, plus computer-control (macOS) and browser-session (Playwright).
- **Prompt caching**: `@moxxy/cache-strategy-stable-prefix` places deterministic cache breakpoints (static tools/system/stable-prefix + a rolling tail) so the inner iterations of a turn read the prompt from cache instead of paying full price. A `CacheStrategy` is provider-neutral (Anthropic `cache_control` today); swap it or disable caching with the `none` strategy. Inspect savings live with `/usage`.
- **MCP**: register any Model Context Protocol server as a tool source.
- **Skills**: prompt-only Markdown files. The agent can author new skills for itself when no existing skill fits.
- **Memory**: long-term journal + STM event-log selectors. TF-IDF vector recall built in; swap to OpenAI embeddings via `@moxxy/plugin-embeddings-openai`.
- **Webhooks**: `@moxxy/plugin-webhooks` ships a verified HTTP listener, include/exclude filters (headers + JSON paths), delivery idempotency, and a `cloudflared`/`ngrok` tunnel helper. Vendor-neutral — the agent walks the user through provider specifics conversationally.
- **Voice in (STT)**: `@moxxy/plugin-stt-whisper` ships an OpenAI Whisper `Transcriber`. Wire it once and every channel with audio input (Telegram voice notes, HTTP `/v1/turn/audio`) routes through it. Swap to Deepgram, AssemblyAI, or a local `whisper.cpp` by registering a different `Transcriber`.
- **Vault**: AES-256-GCM at rest. Reference secrets in config as `${vault:KEY}`.
- **Security / isolation**: `@moxxy/plugin-security` — opt-in capability sandboxing. Tools declare an `isolation: { capabilities }` spec on `defineTool({...})` (fs path globs, net host allowlist, env keys, `timeMs`, `memMb`); when enabled, an `Isolator` enforces those bounds at every call. Ships `none` (passthrough) and `inproc` (in-process caps + timeout) isolators; stronger modes (`worker_threads`, subprocess, wasm, Docker, …) register through the same SDK interface. Off by default — enable via `moxxy init` or `security.enabled: true`. Inspect with `moxxy security audit|status|isolators`.

## 📚 Docs

Full docs at **[docs.moxxy.ai](https://docs.moxxy.ai)**: concepts, recipes, plugin authoring, channel guides. Marketing site: [moxxy.ai](https://moxxy.ai).

---

# 🛠 Developer guide

Everything below is for plugin authors, contributors, and folks embedding moxxy in their own TypeScript apps.

## Embedding the SDK

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

Per-block author guides live in [`.claude/agents/`](.claude/agents/), one per surface (skill, plugin, tool, channel, provider, loop strategy, compactor, cache strategy).

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
    '@moxxy/mode-plan-execute': { enabled: false },     // disable per-plugin
  },
});
```

`${vault:NAME}` placeholders are resolved on session start. The vault unlocks via OS keychain (`keytar`) with a passphrase fallback (`MOXXY_VAULT_PASSPHRASE` for headless boxes).

## Architecture

```
@moxxy/sdk                          ← typed public surface (zero runtime deps)
@moxxy/core                         ← runtime: event log, registries, plugin host, permissions, skills
@moxxy/tools-builtin                ← Read / Edit / Write / Bash / Grep / Glob
@moxxy/mode-tool-use                ← default loop strategy (Claude Code-style)
@moxxy/mode-plan-execute            ← plan-then-execute strategy
@moxxy/mode-developer               ← implement → verify → commit strategy
@moxxy/mode-bmad                    ← BMAD multi-persona strategy
@moxxy/mode-deep-research           ← multi-query research + synthesis strategy
@moxxy/plugin-provider-anthropic    ← LLM provider
@moxxy/plugin-provider-openai       ← LLM provider
@moxxy/plugin-provider-openai-codex ← ChatGPT OAuth provider
@moxxy/plugin-provider-admin        ← register OpenAI-compatible providers at runtime
@moxxy/plugin-mcp                   ← MCP servers as tool sources
@moxxy/plugin-vault                 ← encrypted secrets
@moxxy/plugin-memory                ← journal LTM + vector recall + STM selectors
@moxxy/plugin-embeddings-openai     ← neural embeddings (optional)
@moxxy/plugin-embeddings-transformers ← on-device embeddings via transformers.js
@moxxy/plugin-stt-whisper           ← OpenAI Whisper Transcriber (voice in)
@moxxy/plugin-stt-whisper-codex     ← Whisper Transcriber via the ChatGPT OAuth creds
@moxxy/plugin-browser               ← headless Playwright sidecar + web_fetch
@moxxy/plugin-computer-control      ← macOS native input (screenshot, click, type, …)
@moxxy/plugin-oauth                 ← generic OAuth 2.0 + PKCE / device-code
@moxxy/plugin-cli                   ← Ink TUI + TuiChannel
@moxxy/plugin-telegram              ← TelegramChannel via grammy (text + voice)
@moxxy/plugin-channel-http          ← HTTP channel (POST /v1/turn, /v1/turn/stream, /v1/turn/audio)
@moxxy/plugin-scheduler             ← time-driven prompts
@moxxy/plugin-webhooks              ← external-event triggers (verified HTTP listener + tunnels)
@moxxy/plugin-workflows             ← swappable DAG engine: chain skills/prompts/tools into saved, schedulable pipelines
@moxxy/plugin-security              ← opt-in capability isolation (Isolator interface + none/inproc impls)
@moxxy/isolator-worker              ← worker_threads Isolator (memory + time + JS-state isolation)
@moxxy/isolator-subprocess          ← subprocess Isolator (kernel-enforced process boundary)
@moxxy/isolator-wasm                ← WebAssembly Isolator (zero ambient authority; experimental)
@moxxy/plugin-subagents             ← spawn sub-agents from a turn
@moxxy/plugin-commands              ← built-in slash commands (/info, /clear, /compact, …)
@moxxy/plugin-self-update           ← agent edits its own plugins/skills (Tier 1) + core (Tier 2)
@moxxy/plugin-plugins-admin         ← install / list / remove @moxxy plugins at runtime
@moxxy/plugin-usage-stats           ← per-session token + cost accounting
@moxxy/compactor-summarize          ← default context-window compactor
@moxxy/cache-strategy-stable-prefix ← default prompt-cache strategy (deterministic breakpoints; `none` opts out)
@moxxy/runner                       ← bare session runner; channels attach over a unix socket (JSON-RPC)
@moxxy/cli                          ← the `moxxy` binary
@moxxy/config                       ← defineConfig + moxxy.config.ts loader
@moxxy/testing                      ← FakeProvider + record/replay harness
@moxxy/chat-model                   ← UI-neutral chat model (event→block fold + markdown AST + chunked log); shared by the TUI and desktop
apps/desktop                        ← Electron desktop app (attaches to @moxxy/runner)
@moxxy/desktop-ipc-contract         ← typed desktop IPC boundary (channels + payloads + Zod validation)
@moxxy/desktop-host                 ← desktop Electron main process (runner pool/supervisor, IPC, NDJSON chat log, security)
```

The hard invariant: `@moxxy/sdk` has zero internal deps; `@moxxy/core` doesn't import any plugin. Enforced in CI via `pnpm check:deps`.

## Repo layout

```
packages/        publishable @moxxy/* packages
apps/            runnable examples (example-basic, example-cli, fixture-recorder, docs)
tooling/         shared tsconfig + eslint + vitest preset
.claude/agents/  AI-agent author guides (skill, plugin, tool, channel, provider, compactor, cache strategy, …)
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

PRs welcome. Open an issue first for anything non-trivial. Per-block author guides in [`.claude/agents/`](.claude/agents/) describe how to write skills, plugins, tools, channels, providers, loop strategies, compactors, and cache strategies.

## 📝 License

TBD.
