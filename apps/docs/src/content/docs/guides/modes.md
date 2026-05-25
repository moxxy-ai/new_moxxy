---
title: Modes
description: tool-use vs plan-execute vs bmad — when to pick each.
---

A mode decides how a single user turn unfolds: how many provider
calls, in what order, with what gating. moxxy ships three.

| Strategy | Package | What it does |
|---|---|---|
| `tool-use` | `@moxxy/mode-tool-use` | Claude-Code-style: call provider, run any tools it asked for, feed results back, repeat until the model emits a final `assistant_message`. |
| `plan-execute` | `@moxxy/mode-plan-execute` | Two phases: planning (model drafts a numbered plan, optionally user-approved) → execution (a tool-use sub-loop per step). |
| `bmad` | `@moxxy/mode-bmad` | Four phases (Analysis → Planning → Solutioning → Implementation), each owned by a different persona, with optional approval gates between them. |

## tool-use

The default. Best for everything that's well-scoped: "edit this file",
"run this query", "find that bug".

```ts
session.modes.setActive('tool-use');
```

## plan-execute

Switch in when the request is ambiguous or large enough that you want
to see the model's plan before it touches your code.

The approval gate (TUI / Telegram) lets you `approve` / `redraft with
feedback` / `cancel`. Redrafting feeds your feedback back into the
planner; the cap is `MAX_REDRAFTS` (3). Caps prevent runaway plans:

- `MAX_PLAN_STEPS` — refuses plans with more steps than the cap (8).
- `maxIterationsPerStep` — per-step tool-call cap (6 by default).

Switch to it from the TUI / Telegram with `/mode plan-execute`.

## bmad

Inspired by BMAD-METHOD. Designed for "build me X" requests where the
hard part is articulating what X should be. Four sequential phases,
each with its own persona:

1. **Analysis** — Analyst → one-page PRD-style brief.
2. **Planning** — Product Manager → numbered stories with acceptance criteria.
3. **Solutioning** — Architect → short design + change list.
4. **Implementation** — Developer → tool-use sub-loop per story.

Between phases, an optional approval gate lets you approve / redraft /
cancel. Without a resolver (headless / non-TTY) the loop proceeds end
to end.

Use bmad when plan-execute under-specifies. The persona handoffs are
what makes it work for multi-stakeholder requests — UX, API design,
data model, implementation all get distinct treatment.

## Switching

Per session:

```ts
session.modes.setActive('plan-execute');
```

From the TUI / Telegram chat:

```
/mode tool-use
/mode plan-execute
/mode bmad
```

Per sub-agent (the parent stays on `tool-use`):

```text
dispatch_agent({ prompt: "...", mode: "bmad" })
```

## Writing your own

`defineMode({ name, run })` from `@moxxy/sdk`. `run` is an
async generator that yields `MoxxyEvent`s. The simplest possible loop
is "one provider call, no tools, terminate" — the three shipped
strategies are layered orchestration on top of that primitive.

See `packages/mode-tool-use/src/turn-iterator.ts` for the canonical
example.
