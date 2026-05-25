---
title: '@moxxy/mode-plan-execute'
description: Plan-then-execute loop with an optional user-approval gate.
---

`@moxxy/mode-plan-execute` is a two-phase loop:

1. **Planning** — the model drafts a numbered plan. With a channel
   approval resolver (TUI / Telegram), the user can approve, redraft
   with feedback, or cancel.
2. **Execution** — a tool-use sub-loop runs each step.

Best for ambiguous or large requests where you want sign-off before
the agent touches code.

## Install

```sh
pnpm add @moxxy/mode-plan-execute
```

## Use

```ts
import { planExecuteModePlugin } from '@moxxy/mode-plan-execute';

session.pluginHost.registerStatic(planExecuteModePlugin);
session.modes.setActive('plan-execute');
```

Switch interactively with `/mode plan-execute`.

## Caps

| Cap | Default | Purpose |
|---|---|---|
| `MAX_PLAN_STEPS` | 8 | Refuse plans longer than this. |
| `MAX_REDRAFTS` | 3 | Maximum "redraft with feedback" iterations. |
| `maxIterationsPerStep` | 6 | Per-step tool-call cap inside the execution sub-loop. |

Caps prevent runaway plans without burning your token budget.

## Exports

- `planExecuteMode`, `planExecuteModePlugin`
- `PLAN_EXECUTE_MODE_NAME` — `'plan-execute'`
- `parsePlan(text)` — the numbered-step parser. Useful in tests.

## Events

The loop emits `plugin_event`s with subtypes `plan_created`,
`plan_step_started`, `plan_step_completed`, `plan_completed`. UIs use
these to render progress without parsing assistant text.

## See also

- [Modes guide](../guides/modes).
