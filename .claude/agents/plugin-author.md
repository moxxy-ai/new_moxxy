---
name: plugin-author
description: Scaffold a new @moxxy/plugin-* package and wire it for auto-discovery.
---

# Plugin author — ship a new `@moxxy/plugin-*`

Plugins are TypeScript packages distributed under the `@moxxy/*` scope (or your own scope — discovery only requires the `moxxy.plugin.entry` field in `package.json`). They contribute `tools`, `providers`, `loopStrategies`, `compactors`, `channels`, `hooks`, and `agents` (subagent kinds) via `definePlugin` from `@moxxy/sdk`.

## Scaffolding

For a user-scope plugin (no workspace edits needed):

```sh
moxxy plugins new <name>          # creates ~/.moxxy/plugins/<name>/
moxxy plugins new <name> --here   # creates ./<name>/
moxxy plugins reload              # hot-load without restart
```

For a workspace plugin (shipped in the repo), create `packages/plugin-<thing>/`:

```jsonc
// packages/plugin-<thing>/package.json
{
  "name": "@moxxy/plugin-<thing>",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "moxxy": {
    "plugin": {
      "entry": "./src/index.ts"   // .ts in dev (jiti loader), ./dist/index.js in prod
    }
  },
  "dependencies": { "@moxxy/sdk": "workspace:*" },
  "devDependencies": {
    "@moxxy/tsconfig": "workspace:*",
    "@moxxy/vitest-preset": "workspace:*",
    "typescript": "^5.7.3",
    "vitest": "^2.1.8"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "clean": "rm -rf dist .turbo"
  }
}
```

```jsonc
// packages/plugin-<thing>/tsconfig.json
{ "extends": "@moxxy/tsconfig/lib.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*"], "exclude": ["dist", "node_modules", "src/**/*.test.ts"] }
```

```ts
// packages/plugin-<thing>/src/index.ts
import { definePlugin, defineTool, z } from '@moxxy/sdk';

const myTool = defineTool({
  name: 'my_tool',
  description: 'one sentence',
  inputSchema: z.object({ input: z.string() }),
  permission: { action: 'prompt' },
  handler: async ({ input }) => `echo: ${input}`,
});

export default definePlugin({
  name: '@moxxy/plugin-<thing>',
  version: '0.0.0',
  tools: [myTool],
});
```

## Wire it up

1. `pnpm install` from repo root — the workspace auto-links the new package.
2. Auto-discovery: `@moxxy/cli`'s `setup.ts` scans `cwd/node_modules` and `~/.moxxy/plugins/` for any `package.json#moxxy.plugin.entry` and loads them via the jiti loader. No central registration code.
3. Hot-load mid-session: `session.pluginHost.reload()` (or the `reload_plugins` built-in tool).

## Lifecycle hooks

```ts
export default definePlugin({
  name: '@moxxy/plugin-<thing>',
  hooks: {
    onInit:               async (ctx) => { /* setup */ },
    onTurnStart:          async (ctx) => { /* per-turn setup */ },
    onBeforeProviderCall: async (req) => ({ ...req, system: (req.system ?? '') + ' extra' }),
    onToolCall:           async (ctx) => ({ action: 'allow' }),  // or 'deny' | 'rewrite'
    onToolResult:         async (ctx) => ctx.result,
    onEvent:              async (e, ctx) => { /* observe — read only */ },
    onTurnEnd:            async (ctx) => { /* per-turn cleanup */ },
    onShutdown:           async (ctx) => { /* fires from Session.close() */ },
  },
});
```

- `onToolCall` short-circuits on first `deny`. `rewrite` mutates the input for downstream hooks + execution.
- `onBeforeProviderCall` is a fold — each plugin's returned request feeds the next.
- `onEvent` is fan-out and read-only. Throwing here is logged + swallowed.
- Hook timeout defaults to 5s (`hookTimeoutMs` on `Session`).
- `onShutdown` only fires when something calls `Session.close()` — channels' SIGINT handlers do this.

## Agents — typed subagent kinds

A plugin can contribute one or more `AgentDef` entries. Each becomes dispatchable via `dispatch_agent({ agentType: <name>, prompt, ... })` from `@moxxy/plugin-subagents`. The `dispatch_agent` tool resolves the kind at call time and uses its `systemPrompt` / `allowedTools` / `loopStrategy` / `model` as defaults; caller-supplied spec fields win.

```ts
import { definePlugin, type AgentDef } from '@moxxy/sdk';

const researcher: AgentDef = {
  name: 'researcher',
  description: 'Web research subagent: fetches sources, returns a cited markdown summary.',
  systemPrompt:
    'You are a focused web researcher. Use web_fetch / browser_session to gather facts. ' +
    'Return a 200-word markdown summary with inline source URLs. Never fabricate citations.',
  allowedTools: ['web_fetch', 'browser_session'],
  // loopStrategy: 'tool-use',  // default; only set if you ship a custom loop
  // maxIterations: 30,
};

export default definePlugin({
  name: '@moxxy/agent-researcher',
  version: '0.0.0',
  agents: [researcher],
});
```

When this plugin is installed, the model can call `dispatch_agent({ agents: [{ agentType: 'researcher', prompt: '…' }] })` and the child runs with the researcher's system prompt + restricted tool set. Without `@moxxy/plugin-subagents` installed, the tool isn't registered and the kinds simply sit unused in the registry — graceful degradation by design.

Rules:
- **Name must be stable** — it's the key models pass. Use lowercase-with-dashes.
- **Description shows up in `/agents`** — write it for the operator, one sentence.
- **`allowedTools` is a hard restriction.** Children can't escape it even when the model asks. Use this to keep agents focused.
- **`systemPrompt` shapes the persona.** Pair concrete output format requirements with the tool list — the child has no parent context except this prompt.
- **Unknown agentType from the model falls back to the built-in `default`** — never breaks a turn. So shipping a new kind is purely additive.

## Plugins that need runtime services

Use a factory function closing over the deps. The pattern is used by `buildVaultPlugin`, `buildMemoryPlugin`, `buildTelegramPlugin`, `buildSynthesizeSkillPlugin`:

```ts
export function buildThingPlugin(opts: { vault: VaultStore }): Plugin {
  return definePlugin({
    name: '@moxxy/plugin-thing',
    tools: [
      defineTool({
        name: 'thing_secret',
        inputSchema: z.object({}),
        handler: async () => opts.vault.get('thing_token'),
      }),
    ],
  });
}
```

The CLI's `setup.ts` wires the factory; auto-discovered plugins use the no-arg `default export` form.

## Tests

```ts
import { describe, expect, it } from 'vitest';
import { collectTurn } from '@moxxy/core';
import { FakeProvider, createFakeSession, textReply } from '@moxxy/testing';
import myPlugin from './index.js';

it('does the thing', async () => {
  const provider = new FakeProvider({ script: [textReply('done')] });
  const session = createFakeSession({ provider });
  session.pluginHost.registerStatic(myPlugin);
  const events = await collectTurn(session, 'hi');
  expect(events.find((e) => e.type === 'assistant_message')).toBeDefined();
});
```

## Don't

- **Don't import from `@moxxy/core`** unless your plugin is a channel or otherwise needs `Session`, `runTurn`, `createDeferredPermissionResolver`, etc. Pure tool/provider/loop plugins consume only `@moxxy/sdk`.
- **Don't bypass the permission engine.** Use `permission: { action: 'prompt' }` (or `allow`/`deny` for system tools) on every tool with side effects.
- **Don't mutate inputs in `onBeforeProviderCall`.** Return a new request object — it's a pipeline.
- **Don't throw from `onEvent`.** Returns are ignored; throws are logged + swallowed. If you need to react, queue work and let it run async.
- **Don't reach across the runtime/event-log boundary.** State is derived from the event log via selectors. If you need new state, emit an event (or extend the SDK's event union).
