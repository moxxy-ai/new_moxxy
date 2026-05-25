---
title: '@moxxy/core'
description: The runtime — event log, plugin host, skill loader, permission engine.
---

`@moxxy/core` is the moxxy runtime. It depends on `@moxxy/sdk` and `@moxxy/tools-builtin` — nothing else internal. Plugins are loaded dynamically; core never imports them statically.

## What's exported

### Session

`Session` is the top-level container. Holds the event log, the registries (tools, providers, modes, compactors, skills), the permission engine and resolver, the hook dispatcher, and the plugin host.

```ts
import { Session, autoAllowResolver } from '@moxxy/core';

const session = new Session({
  cwd: process.cwd(),
  permissionResolver: autoAllowResolver,
});
```

### Loop driver

```ts
import { runTurn, collectTurn } from '@moxxy/core';

// Async iterable over every emitted event:
for await (const event of runTurn(session, 'do thing')) {
  console.log(event.type);
}

// Or collect them all:
const events = await collectTurn(session, 'do thing');
```

### Selectors

Pure folds over the event log:

- `selectMessages(log, opts?)` — projected provider message history (honors compactions)
- `selectPendingToolCalls(log)` — unresolved tool calls
- `selectCurrentTurn(log)` — the latest turn id
- `selectLoadedPlugins(log)` — registered plugin records
- `selectActiveSkillIds(log)` — skills invoked this session
- `estimateTokens(messages)` — rough char/4 token estimate
- `isToolCallResolved(callId, log)` — has the call been answered?
- `findEvent(log, type, predicate)` — search by type + predicate

### Skills

- `discoverSkills(opts)` — walk project/user/plugin/builtin directories
- `SkillRouter` — match a prompt against loaded skills
- `synthesizeSkill(session, intent, scope, opts)` — agent-driven skill creation
- `buildSynthesizeSkillPlugin(session)` — registers `synthesize_skill` + `reload_skills` tools

### Plugin host

- `PluginHost` — register plugins statically or via discovery; hot-reload
- `createPluginLoader({cwd})` — jiti-backed loader (loads `.ts` plugin entries directly in dev)
- `discoverPlugins(opts)` — scan `package.json#moxxy.plugin` across `node_modules` and parent dirs

### Permissions

- `PermissionEngine` — file-policy-backed allow/deny checker (`~/.moxxy/permissions.json`)
- `autoAllowResolver`, `denyByDefaultResolver`, `createAllowListResolver`, `createCallbackResolver` — pre-built resolvers
