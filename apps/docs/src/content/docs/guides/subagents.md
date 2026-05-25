---
title: Sub-agents
description: Spawning focused child agents from a turn via dispatch_agent.
---

`@moxxy/plugin-subagents` adds a single tool — `dispatch_agent` — that
spawns a child session with its own loop, tools, and context. The
parent agent uses it to fan out research, refactors, or any work that
should run in isolation without polluting the main conversation.

## Without the plugin

Without `@moxxy/plugin-subagents` installed, `dispatch_agent` doesn't
exist and the model runs single-loop as usual. There's no fallback
path that emulates spawning — sub-agents are an explicit opt-in.

## The tool

```text
dispatch_agent({
  prompt,         // focused, self-contained request
  agentType?,     // named AgentDef ("researcher", "code-reviewer", …)
  label?,         // short label for progress events
  systemPrompt?,  // override the kind's system prompt
  model?,         // model id override
  mode?,  // "tool-use" (default), "plan-execute", "bmad"
  allowedTools?,  // restrict the child to these tool names
})
```

Implementation: `packages/plugin-subagents/src/dispatch-agent.ts`.

`maxIterations` is intentionally absent from the model-facing schema —
models tend to hallucinate small numbers (4, 5, 10), which fails
legitimate research tasks. The cap lives on the `AgentDef` itself or
on the spawner default (50).

## AgentDef kinds

Other plugins ship `AgentDef`s via their own `definePlugin({ agents })`.
The dispatch tool looks them up at call time against the session's
agent registry, so a freshly-installed kind is available on the next
dispatch — no restart needed.

```ts
definePlugin({
  name: '@acme/moxxy-agents-research',
  agents: [
    defineAgent({
      name: 'researcher',
      description: 'Reads docs / source, returns a concise summary.',
      systemPrompt: '...',
      allowedTools: ['Read', 'Grep', 'Glob', 'web_fetch'],
      maxIterations: 30,
      mode: 'tool-use',
    }),
  ],
});
```

## Auto-detection skill

The plugin also bundles a "dispatch-agents" skill that triggers on
fan-out patterns ("for each X, …", "compare A and B in parallel"),
nudging the agent to use `dispatch_agent` instead of one giant
single-loop pass.

## Registry

The live registry is visible via `/agents` in the TUI / Telegram chat.
Each entry shows its name, description, and the mode it
defaults to. Unknown `agentType` arguments fall back to the built-in
default kind — `dispatch_agent` never fails over a missing kind.

## When to use it

- Fan-out: "review every file in src/auth/" → one child per file.
- Isolation: a probe that shouldn't leak its mistakes back into the
  parent's context window.
- Specialized modes: research with `bmad`, planning with `plan-execute`,
  while the parent stays on `tool-use`.
