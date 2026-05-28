<p align="center">
  <a href="https://moxxy.ai">
    <img src="https://moxxy.ai/logo-gradient.svg" alt="moxxy" width="160" />
  </a>
</p>

<h1 align="center">@moxxy/sdk</h1>

<p align="center">
  <strong>Typed public surface for the moxxy framework.</strong><br/>
  Zero runtime deps. The contract every plugin, channel, and provider speaks.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@moxxy/sdk">
    <img src="https://img.shields.io/npm/v/@moxxy/sdk?logo=npm&logoColor=white" alt="npm" />
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
  <a href="#-what-the-sdk-gives-you">Surface</a>
  &nbsp;·&nbsp;
  <a href="#-authoring-a-plugin">Plugin guide</a>
</p>

---

## ✨ What this package is

`@moxxy/sdk` is the **typed contract** between moxxy and everything that plugs into it: providers, modes (loop strategies), tools, channels, compactors, cache strategies, isolators, transcribers, view renderers, tunnel providers, agents, commands, skills.

It exports:

- `define*({…})` factories — the only blessed way to author each kind of block.
- The `MoxxyEvent` union — every event the runtime can emit or replay.
- `ClientSession`, `SessionLike` — the views channels and modes see.
- Lifecycle hook signatures (`onTurnStart`, `onAssistantMessage`, …).
- Helper utilities that don't drag the runtime along — token accounting, compactor helpers, schema → JSON schema, tool gating, embedding cache, retryable-error classification.

It is the **only** moxxy package safe to depend on from a published plugin. `@moxxy/core` is the runtime — plugins never import it.

|   |   |
|---|---|
| 🧩 **Zero runtime deps** | The package builds without pulling anything into your bundle. `zod` is a `peerDependency`. |
| 🔌 **One contract, every block** | Same shape for tools, channels, providers, compactors, … — once you've written one plugin you know how to write the next. |
| 🛡 **Strict TypeScript** | Types-as-docs. `defineTool` is generic on its zod schema so handlers are fully inferred. |
| 🪶 **Type-only views** | `SessionLike` exposes what a channel needs without exposing the registry internals — keeps coupling honest. |
| 📜 **Event-log first** | Every block is reactive over a single typed event stream — no hidden globals, easy to record/replay. |

## 🚀 Installation

```sh
npm install @moxxy/sdk zod
# or: pnpm add @moxxy/sdk zod
# or: yarn add @moxxy/sdk zod
```

`zod` is declared as a `peerDependency` — the SDK doesn't ship it so your plugin and the host agree on one copy.

**Requirements**: Node.js ≥ 20.10. Strict TypeScript recommended.

## ⚡ Quickstart

A tool plugin in nine lines:

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

That's it. `moxxy plugins list` (or any TUI session) will see your tool on next launch.

## 🧩 What the SDK gives you

### `define*` factories

| Factory | Defines |
|---|---|
| `definePlugin` | A bundle of any of the below, the discoverable unit |
| `defineTool` | A callable tool, zod-typed input, optional `permission` / `isolation` / `compact` presentation |
| `defineProvider` | An LLM backend (Anthropic / OpenAI / custom) |
| `defineMode` | A loop strategy (`tool-use`, `plan-execute`, `bmad`, …) — the agent's iteration topology |
| `defineCompactor` | Context-window compaction strategy (summarise / drop / hybrid) |
| `defineCacheStrategy` | Where to place provider cache breakpoints |
| `defineChannel` | A user-facing surface (TUI / HTTP / Telegram / web / …) |
| `defineCommand` | A `/slash` command surfaced in every channel that hosts commands |
| `defineSkill` | A prompt-only Markdown skill (frontmatter + body) |
| `defineAgent` | A subagent kind dispatchable from the parent loop |
| `defineTranscriber` | A speech-to-text backend wired into every audio-capable channel |
| `definePermission` | A permission rule contributed to the resolver chain |
| `defineViewRenderer` | A target for the agent-authored UI primitives |
| `defineTunnelProvider` | A public-URL tunnel (cloudflared / ngrok / …) for HTTP channels |
| `defineIsolator` *(via `@moxxy/plugin-security`)* | A capability sandbox; the SDK exports the `Isolator` interface and the `ISOLATION_RANK` ordering |

### Types & events

```ts
import type {
  MoxxyEvent,           // discriminated union of every event in the log
  EventLogReader,       // stable view over the session's event log
  ClientSession,        // what channels and slash-commands see
  SessionLike,          // what modes / providers / tools see
  PendingToolCall,
  PermissionDecision,
  ApprovalRequest, ApprovalDecision,
  ToolDef, ProviderDef, ModeDef, CompactorDef, CacheStrategyDef,
  Plugin, PluginSpec,
  Skill, SkillDef, SkillFrontmatter, SkillScope,
} from '@moxxy/sdk';
```

### Helpers

- **`zodToJsonSchema`** — convert a zod schema to JSON Schema for provider tool calls.
- **`isRetryableError`** / **`toFriendlyError`** — classify provider errors uniformly.
- **`estimateContextTokens`**, **`runCompactionIfNeeded`** — compactor scaffolding.
- **`CachedEmbeddingProvider`** — wrap any `EmbeddingProvider` with on-disk caching.
- **`dispatchToolCall`** — invoke a tool through the full gating + permission + isolation pipeline.
- **`summarizeSessionTokensFromEvents`**, **`summarizeTokensByModel`** — pure token accounting over the event log.

### Lifecycle hooks

A plugin can declare optional hooks: `onSessionStart`, `onTurnStart`, `onAssistantMessage`, `onToolResult`, `onError`, `onCompact`, `onSessionEnd`. All are strongly typed and fire in plugin-registration order. The SDK exposes the hook context types; the runtime in `@moxxy/core` is responsible for actually invoking them.

## 🛠 Authoring a plugin

A tool plugin (minimum surface):

```ts
import { definePlugin, defineTool, z } from '@moxxy/sdk';

export default definePlugin({
  name: '@acme/moxxy-plugin-weather',
  tools: [
    defineTool({
      name: 'get_weather',
      description: 'Fetch current weather for a city.',
      inputSchema: z.object({ city: z.string() }),
      // Handler args are inferred from the zod schema.
      handler: async ({ city }, ctx) => {
        const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
        return res.json();
      },
      // Optional: gate the call, declare capabilities, customise compact display.
      permission: { action: 'prompt' },
      isolation: { capabilities: { net: { allow: ['wttr.in'] } } },
      compact: { verb: 'Reading weather', subject: ({ city }) => city },
    }),
  ],
});
```

A provider plugin:

```ts
import { definePlugin, defineProvider, type ProviderDef } from '@moxxy/sdk';

const myProvider: ProviderDef = defineProvider({
  name: 'my-llm',
  models: [{ id: 'flagship', contextWindow: 200_000 }],
  async *stream(ctx) { /* yield MoxxyEvent values */ },
});

export default definePlugin({
  name: '@acme/moxxy-provider-my-llm',
  providers: [myProvider],
});
```

A mode (loop strategy):

```ts
import { definePlugin, defineMode, type ModeContext, type MoxxyEvent } from '@moxxy/sdk';

async function* runMyMode(ctx: ModeContext): AsyncIterable<MoxxyEvent> {
  // emit events, call providers, dispatch tools — return when the turn ends.
}

export default definePlugin({
  name: '@acme/moxxy-mode-my',
  modes: [defineMode({
    name: 'my-mode',
    description: 'One-line summary surfaced in the /mode picker.',
    run: runMyMode,
  })],
});
```

Per-block author guides (skill, plugin, tool, channel, provider, loop strategy, compactor, cache strategy) live in the monorepo at [`.claude/agents/`](https://github.com/moxxy-ai/new_moxxy/tree/main/.claude/agents).

## 🏛 Architectural rules

- **`@moxxy/sdk` has zero internal deps.** Enforced in CI via `pnpm check:deps`.
- **`@moxxy/core` doesn't import any plugin.** Plugins flow into core through the SDK only.
- **Plugins never import `@moxxy/core`.** If you find yourself wanting to, the missing piece belongs in the SDK.

These three invariants are what keep the framework swappable.

## 📚 Docs

Full docs at **[docs.moxxy.ai](https://docs.moxxy.ai)** — concepts, plugin author guides, channel guides, recipes.

## 📝 License

TBD.
