---
name: dispatch-agents
description: Fan a task out to parallel subagents when the work breaks into N independent pieces.
triggers:
  - "find 3"
  - "find 5"
  - "find N"
  - "research 3"
  - "research 5"
  - "find multiple"
  - "compare across"
  - "compare these"
  - "for each of"
  - "in parallel"
  - "fan out"
  - "spawn agents"
  - "spawn subagents"
  - "audit each"
  - "summarize N"
  - "list 3"
  - "list 5"
  - "multi-source"
  - "multiple sources"
allowed-tools: [dispatch_agent]
---

# Dispatch subagents for parallel work

When the user's request naturally decomposes into N **independent** subtasks
that each need their own tool calls / context, spawn one subagent per subtask
with `dispatch_agent`. Each child runs in isolation, returns a focused result,
and the parent (you) composes the final reply.

## When to dispatch

Yes — fan out:
- "Find 5 recent articles about X" → 5 agents, each researching one angle.
- "Compare React, Vue, Svelte, Solid, Qwik" → 5 agents, each profiling one library.
- "For each of these files, suggest a refactor" → N agents, one per file.
- "Audit auth, db, and API for security issues" → 3 agents, one per area.

No — keep sequential:
- The subtasks depend on each other (output of A feeds B).
- The task is small enough that one tool round-trip would handle it.
- The user explicitly asked for one consolidated investigation.

## How to call

```
dispatch_agent({
  agents: [
    { prompt: "Find a recent article about X from a major US outlet", agentType: "researcher", label: "us-press" },
    { prompt: "Find a recent article about X from a European outlet",  agentType: "researcher", label: "eu-press" },
    { prompt: "Find a recent academic paper on X",                     agentType: "researcher", label: "academic" }
  ]
})
```

Rules:
- **One spec per independent subtask.** Don't bundle two requests into one prompt.
- **Use clear `label`s** — they appear in the user's progress display.
- **Pick `agentType` from the registered kinds** if any fit (see `/agents`).
  Unknown kinds silently fall back to the default; that's safe but you
  miss out on the specialized system prompt.
- **Omit `agentType` entirely** when no kind matches — the default
  generic agent works for most tasks.
- **Cap at 8 agents per call.** If the task wants more, batch it.

## After the agents return

You receive one result per spec, in input order. Each has `text` (the
agent's final message), `stopReason`, and optional `error`. Compose a
single user-facing reply that:

1. Synthesizes the findings (don't dump raw agent outputs verbatim).
2. Cites which agent contributed what when sources differ.
3. Flags any agent that errored or returned an empty result.

If most agents failed, fall back to doing the work yourself in the
current loop instead of retrying the spawn — the user shouldn't pay
twice for the same fan-out.

## Don't

- Don't spawn a subagent just to make a single tool call. Call the tool
  directly in the current loop — spawning has setup overhead.
- Don't fan out work that the user expected as a single deep
  investigation ("dig into X" ≠ "find 5 articles about X").
- Don't invent agent kinds. Either use a registered one or omit the field.
