---
title: Authoring a plugin
description: Build a @moxxy/plugin-* package that contributes tools, providers, or hooks.
---

## Skeleton

Create a new package under your workspace (or as a standalone npm package):

```jsonc
// packages/plugin-greet/package.json
{
  "name": "@acme/moxxy-plugin-greet",
  "type": "module",
  "main": "./dist/index.js",
  "moxxy": {
    "plugin": {
      "entry": "./src/index.ts",
      "kind": "tools"
    }
  },
  "dependencies": { "@moxxy/sdk": "*" }
}
```

```ts
// src/index.ts
import { definePlugin, defineTool, z } from '@moxxy/sdk';

export default definePlugin({
  name: '@acme/moxxy-plugin-greet',
  version: '0.0.0',
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

That's it. Install it in any project that uses moxxy and it auto-discovers via `package.json#moxxy.plugin`.

## Lifecycle hooks

```ts
export default definePlugin({
  name: '@acme/moxxy-plugin-audit',
  hooks: {
    onInit: async (ctx) => { /* one-time setup */ },
    onToolCall: async ({ call }) => {
      if (call.name === 'Bash' && /rm -rf/.test(String(call.input.command))) {
        return { action: 'deny', reason: 'destructive command blocked' };
      }
      return { action: 'allow' };
    },
    onEvent: async (event) => { /* observe — read only */ },
  },
});
```

Hook ordering follows plugin registration order. Use `requirements` to describe availability/readiness, not hook ordering. `onToolCall` short-circuits on first deny.

## Don't

- **Don't import from `@moxxy/core`** unless you're writing a channel. Plugins should depend only on `@moxxy/sdk`. The dependency-cruiser CI guard enforces the reverse (core can't import you), but importing core from a leaf plugin makes you tightly coupled to runtime internals.
- **Don't use `z.any()` for tool inputs.** The model sees your schema; loose schemas waste tokens and produce flaky tool calls.
- **Don't forget `ctx.signal`** in long-running handlers (Bash, network). Channels can abort sessions; tools must cooperate.
