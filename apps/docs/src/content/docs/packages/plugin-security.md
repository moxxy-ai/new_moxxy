---
title: '@moxxy/plugin-security'
description: Pluggable capability isolation for tool calls. Off by default; opt-in per tool, per plugin, or globally.
---

`@moxxy/plugin-security` adds a capability-based sandbox layer on top of
the permission engine. Tools declare what they need (filesystem globs,
network hosts, env keys, wall-clock budget, memory ceiling); an
`Isolator` enforces those bounds at every call. The plugin is a no-op
until you flip `security.enabled: true` in config.

The SDK ships the declaration types (`CapabilitySpec`,
`ToolIsolationSpec`, `Isolator`, `ISOLATION_RANK`) so plugin authors
can declare isolation without taking a runtime dep on this plugin.
Enforcement only kicks in when `@moxxy/plugin-security` is loaded
*and* enabled.

## Install

```sh
pnpm add @moxxy/plugin-security
```

The `@moxxy/cli` binary registers it for you. Embedders use
`buildSecurityPlugin`:

```ts
import { buildSecurityPlugin } from '@moxxy/plugin-security';

const { plugin, registry, audit } = buildSecurityPlugin({
  config: {
    enabled: true,
    isolator: 'inproc',                  // default for any declared tool
    perTool: { 'Bash': 'subprocess' },   // override per tool
    perPlugin: { '@moxxy/plugin-mcp': 'worker' },
    requireDeclaration: false,           // deny tools that didn't declare?
  },
  toolRegistry: session.tools,
  isolators: [],                         // extras on top of `none` + `inproc`
});
session.pluginHost.registerStatic(plugin);
```

`audit()` returns a row per tool with its declared spec and the
isolator that would actually run it — useful for `moxxy security audit`.

## Declaring isolation on a tool

```ts
import { defineTool, z } from '@moxxy/sdk';

export const fetchTool = defineTool({
  name: 'web_fetch',
  description: 'Fetch a URL and return the body.',
  inputSchema: z.object({ url: z.string().url() }),
  isolation: {
    // Author's minimum acceptable strength. If the user picks a weaker
    // isolator, the security plugin denies the call rather than silently
    // running under-isolated.
    required: 'inproc',
    capabilities: {
      net: { mode: 'allowlist', hosts: ['*.example.com'] },
      fs: { read: ['$cwd/**'] },         // `$cwd` resolves at call time
      env: ['HOME'],                     // every other env var is masked
      timeMs: 30_000,                    // wall-clock budget; aborts via ctx.signal
      memMb: 256,                        // soft ceiling (honored where supported)
      subprocess: false,                 // may NOT spawn children
    },
  },
  permission: { action: 'prompt' },
  handler: async ({ url }) => { … },
});
```

The declaration is advisory until the user enables the security
plugin. With it enabled, every call to the tool funnels through the
configured isolator, which enforces the capabilities.

## Capability surface

| Field | Type | Effect |
|---|---|---|
| `fs.read` / `fs.write` | `string[]` of globs | Path access allowlist. `$cwd` prefix resolves to `ToolContext.cwd`. |
| `net.mode` | `'none' \| 'any' \| 'allowlist'` | Network policy. Allowlist takes a list of host patterns. |
| `env` | `string[]` | Env vars the tool may read. Informational under `inproc` (the handler shares the parent's `process.env`); enforceable by `subprocess`/`worker` isolators that can spawn with a restricted env. |
| `timeMs` | `number` | Wall-clock budget. Aborted via `ctx.signal`. Enforced by every isolator. |
| `memMb` | `number` | Soft memory ceiling. Honored by isolators that support it (e.g. `worker_threads` via `resourceLimits`). |
| `subprocess` | `boolean` | Whether the tool may spawn child processes. Default `false`. Informational under `inproc`. |

## Isolators

Built-in:

| Name | Strength | What it does |
|---|---|---|
| `none` | 0 | Passthrough — no enforcement. Used when `security.enabled: false` or when an author explicitly opts out. |
| `inproc` | 1 | In-process. Validates capabilities on entry (fs/net/env checks via `checkAllCaps`) and wraps execution in a `timeMs` deadline that aborts `ctx.signal`. Memory ceiling is not enforced. |

Stronger isolators (`worker` / `subprocess` / `vm` / `wasm` / `docker`)
implement the same `Isolator` interface — no SDK changes when adding
new ones. They register at plugin construction time by passing into
`buildSecurityPlugin({ isolators: [...] })`:

```ts
import { buildSecurityPlugin, type Isolator } from '@moxxy/plugin-security';

export const workerIsolator: Isolator = {
  name: 'worker',
  strength: 'worker',
  async run(call, handler, caps, signal) {
    // Marshal (input) → output across a worker_threads boundary,
    // applying caps before the call resolves.
  },
};

// At setup time:
const { plugin } = buildSecurityPlugin({
  config: { enabled: true, isolator: 'worker' },
  toolRegistry: session.tools,
  isolators: [workerIsolator],
});
```

See [`.claude/agents/isolator-author.md`](https://github.com/moxxy-ai/new_moxxy/blob/main/.claude/agents/isolator-author.md)
for the full author guide — particularly the section on **handler
marshalling**, which is the hard problem any out-of-process isolator
must solve before its strength claim is real.

## Per-tool / per-plugin overrides

Configure stricter isolation for specific tools without raising the
floor for everything:

```ts
// moxxy.config.ts
export default defineConfig({
  security: {
    enabled: true,
    isolator: 'inproc',          // default for declared tools
    perTool: {
      'Bash': 'subprocess',      // shell tools deserve their own process
      'web_fetch': 'worker',
    },
    perPlugin: {
      '@moxxy/plugin-mcp': 'worker',   // every MCP-sourced tool
    },
  },
});
```

Resolution order: `perTool` → `perPlugin` → global `isolator` → default
`inproc`.

## Strictness gate

`requireDeclaration: true` denies any tool call whose `ToolDef` has no
`isolation` spec. Useful for hardened production runs where you want
to refuse to call unknown / unaudited tools. Default `false` (tools
without declarations run in `none` mode and bypass enforcement).

## CLI

```sh
moxxy security status          # is the plugin enabled? which isolators are registered?
moxxy security audit           # per-tool report: declared spec + resolved isolator
moxxy security isolators       # list registered isolators with their strength
```

## When to enable

- **Production / always-on** (`moxxy serve --background` on a shared
  box) — turn it on. Webhook deliveries + scheduled fires are exactly
  the kind of unattended path where capability bounds pay rent.
- **Solo dev TUI** — usually unnecessary. The permission engine plus
  per-tool prompts already cover the threat model.
- **Mixed plugins** — turn it on if you install plugins you didn't
  author. `requireDeclaration: false` keeps your own un-isolated
  tools working while still enforcing bounds on plugins that opt in.

## See also

- `@moxxy/sdk` — `CapabilitySpec`, `Isolator`, `ISOLATION_RANK`.
- [`moxxy serve`](../guides/running-as-a-service) — pair always-on
  serve with `security.enabled: true` for unattended hardening.
