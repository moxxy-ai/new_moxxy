---
title: '@moxxy/plugin-subagents'
description: dispatch_agent — spawn focused child sessions from a turn.
---

`@moxxy/plugin-subagents` adds a single tool — `dispatch_agent` — that
spawns a child session with its own loop, tools, and context. Without
this plugin installed, the model can't fan out; the normal single-loop
flow runs as usual.

## Install

```sh
pnpm add @moxxy/plugin-subagents
```

## Build

```ts
import { buildSubagentsPlugin } from '@moxxy/plugin-subagents';

const plugin = buildSubagentsPlugin({
  // Closure over the session's agent registry so freshly-installed kinds
  // become available on the next dispatch — no restart needed.
  getAgent: (name) => session.agents.get(name),
});
session.pluginHost.registerStatic(plugin);
```

If you don't pass `getAgent`, the tool falls back to the built-in
default kind for every dispatch.

## The tool

```text
dispatch_agent({
  prompt,           // focused, self-contained request
  agentType?,       // named AgentDef ("researcher", …); falls back to default
  label?,           // short label for progress events
  systemPrompt?,    // override the kind's system prompt
  model?,           // model id override
  mode?,    // "tool-use" | "plan-execute" | "bmad"
  allowedTools?,    // restrict the child to these tool names
})
```

`maxIterations` is intentionally absent from the model-facing schema —
the cap lives on the `AgentDef` itself or the spawner default (50).

## Where AgentDef kinds come from

Other plugins ship `AgentDef`s via `definePlugin({ agents })`. The tool
resolves them at handler-time, so a plugin installed mid-session is
usable on the next dispatch.

## Bundled skill

The plugin also bundles a "dispatch-agents" skill that triggers on
fan-out patterns ("for each X", "compare A and B in parallel") and
nudges the agent to use the tool instead of a single oversized loop.

## See also

- [Sub-agents guide](../guides/subagents) — when to spawn, registry, AgentDef.
- [Modes](../guides/modes) — pairing a child with `plan-execute` or `bmad`.
