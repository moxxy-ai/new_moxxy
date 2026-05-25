---
title: '@moxxy/mode-tool-use'
description: Default Claude-Code-style loop — call provider, run tools, repeat until done.
---

`@moxxy/mode-tool-use` is the default mode. The model calls
tools; the loop runs them and feeds results back; the model emits a
final `assistant_message` to stop. Best for everything well-scoped.

## Install

```sh
pnpm add @moxxy/mode-tool-use
```

## Use

```ts
import { toolUseModePlugin } from '@moxxy/mode-tool-use';

session.pluginHost.registerStatic(toolUseModePlugin);
session.modes.setActive('tool-use');
```

## Exports

- `toolUseMode` — the `ModeDef`.
- `toolUseModePlugin` — the `Plugin` you register.
- `TOOL_USE_MODE_NAME` — the registered name (`'tool-use'`).
- `CollectedToolUse` — internal type re-exported for advanced wrappers.

## See also

- [Modes guide](../guides/modes) — comparison with `plan-execute` and `bmad`.
