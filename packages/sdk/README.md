<p align="center">
  <a href="https://moxxy.ai">
    <img src="https://moxxy.ai/moxxy-head-256.png" alt="moxxy" width="128" />
  </a>
</p>

<h1 align="center">@moxxy/sdk</h1>

<p align="center">
  The typed public surface for the moxxy framework.<br/>
  Zero runtime dependencies. The contract every plugin, channel, and provider speaks.
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
  <a href="#installation">Install</a>
  &nbsp;·&nbsp;
  <a href="#quickstart">Quickstart</a>
  &nbsp;·&nbsp;
  <a href="https://moxxy.ai">Docs</a>
  &nbsp;·&nbsp;
  <a href="#what-the-sdk-gives-you">Surface</a>
  &nbsp;·&nbsp;
  <a href="#authoring-a-plugin">Plugin guide</a>
</p>

---

## What this package is

`@moxxy/sdk` is the typed contract between the moxxy runtime and everything that plugs into it. Providers, modes, tools, channels, compactors, cache strategies, isolators, transcribers, view renderers, tunnel providers, agents, commands, and skills all use it as their interface to the runtime.

The package exports:

- `define*` factories, the only blessed way to author each kind of block.
- The `MoxxyEvent` discriminated union, covering every event the runtime can emit or replay.
- `ClientSession` and `SessionLike`, the views channels and modes see.
- Lifecycle hook signatures (`onTurnStart`, `onAssistantMessage`, and so on).
- Small helper utilities that do not pull the runtime along: token accounting, compactor helpers, zod-to-JSON-Schema, tool gating, embedding caching, retryable-error classification.

It is the only moxxy package safe to depend on from a published plugin. `@moxxy/core` is the runtime, and plugins never import it.

## Why depend on the SDK

- **Zero runtime dependencies.** The package builds without pulling anything into your bundle. `zod` is declared as a peer dependency so your plugin and the host agree on one copy.
- **One contract, every block.** The shape is consistent across tools, channels, providers, compactors, and the rest. Once you have written one plugin you know how to write the next.
- **Strict TypeScript.** `defineTool` is generic on its zod schema so handler arguments are fully inferred. Types double as documentation.
- **Type-only views into the runtime.** `SessionLike` exposes only what a channel needs and keeps the rest of the registry private.
- **Event-log first.** Every block is reactive over a single typed event stream. No hidden globals, easy to record and replay.

## Installation

```sh
npm install @moxxy/sdk zod
# or: pnpm add @moxxy/sdk zod
# or: yarn add @moxxy/sdk zod
```

`zod` is a peer dependency. The SDK does not ship it.

Requirements: Node.js 20.10 or later. Strict TypeScript is recommended.

## Quickstart

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

Add a `"moxxy"` block to your `package.json` and moxxy auto-discovers it on the next launch:

```json
{
  "moxxy": { "plugin": { "entry": "./dist/index.js", "kind": "tools" } }
}
```

That is the whole setup. `moxxy plugins list` will show your tool on the next session start.

## What the SDK gives you

### `define*` factories

| Factory | Defines |
|---|---|
| `definePlugin` | A bundle of any of the below. The discoverable unit. |
| `defineTool` | A callable tool with a zod-typed input, optional `permission`, `isolation`, and `compact` display config. |
| `defineProvider` | An LLM backend such as Anthropic, OpenAI, or a custom service. |
| `defineMode` | A loop strategy. The agent's iteration topology (`tool-use`, `plan-execute`, `bmad`, and so on). |
| `defineCompactor` | A context-window compaction strategy (summarise, drop, hybrid). |
| `defineCacheStrategy` | Where to place provider cache breakpoints. |
| `defineChannel` | A user-facing surface (TUI, HTTP, Telegram, web). |
| `defineCommand` | A `/slash` command surfaced in every channel that hosts commands. |
| `defineSkill` | A prompt-only Markdown skill (frontmatter + body). |
| `defineAgent` | A subagent kind dispatchable from the parent loop. |
| `defineTranscriber` | A speech-to-text backend wired into every audio-capable channel. |
| `definePermission` | A permission rule contributed to the resolver chain. |
| `defineViewRenderer` | A target for the agent-authored UI primitives. |
| `defineTunnelProvider` | A public-URL tunnel for HTTP channels (cloudflared, ngrok). |
| `defineIsolator` (via `@moxxy/plugin-security`) | A capability sandbox. The SDK exports the `Isolator` interface and the `ISOLATION_RANK` ordering. |

### Types and events

```ts
import type {
  MoxxyEvent,            // the discriminated union of every event in the log
  EventLogReader,        // a stable view over the session's event log
  ClientSession,         // what channels and slash-commands see
  SessionLike,           // what modes, providers, and tools see
  PendingToolCall,
  PermissionDecision,
  ApprovalRequest, ApprovalDecision,
  ToolDef, ProviderDef, ModeDef, CompactorDef, CacheStrategyDef,
  Plugin, PluginSpec,
  Skill, SkillDef, SkillFrontmatter, SkillScope,
} from '@moxxy/sdk';
```

### Helpers

- `zodToJsonSchema` converts a zod schema to JSON Schema for provider tool calls.
- `isRetryableError` and `toFriendlyError` classify provider errors uniformly.
- `estimateContextTokens` and `runCompactionIfNeeded` are scaffolding for custom compactors.
- `CachedEmbeddingProvider` wraps any `EmbeddingProvider` with on-disk caching.
- `dispatchToolCall` invokes a tool through the full gating, permission, and isolation pipeline.
- `summarizeSessionTokensFromEvents` and `summarizeTokensByModel` give pure token accounting over the event log.

### Lifecycle hooks

A plugin can declare optional hooks: `onSessionStart`, `onTurnStart`, `onAssistantMessage`, `onToolResult`, `onError`, `onCompact`, and `onSessionEnd`. All are strongly typed and fire in plugin-registration order. The SDK exposes the hook context types. `@moxxy/core` invokes them at the right point in the loop.

## Authoring a plugin

A tool plugin with the minimum surface:

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
      handler: async ({ city }) => {
        const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
        return res.json();
      },
      // Optional: gate the call, declare capabilities, customise the compact display.
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
  // emit events, call providers, dispatch tools, return when the turn ends.
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

Per-block author guides for skill, plugin, tool, channel, provider, loop strategy, compactor, and cache strategy live in the monorepo at [`.claude/agents/`](https://github.com/moxxy-ai/new_moxxy/tree/main/.claude/agents).

## Architectural rules

Three invariants keep the framework swappable:

1. `@moxxy/sdk` has zero internal dependencies. Enforced in CI via `pnpm check:deps`.
2. `@moxxy/core` does not import any plugin. Plugins flow into core through the SDK only.
3. Plugins never import `@moxxy/core`. If you find yourself wanting to, the missing piece belongs in the SDK.

## Docs

Full documentation lives at [docs.moxxy.ai](https://docs.moxxy.ai): concepts, plugin author guides, channel guides, and recipes.

## License

MIT. See the repository root for the full text.
