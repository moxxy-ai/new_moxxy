---
title: Requirements
description: Declare plugin and block readiness so unavailable features fail closed and show useful diagnostics.
---

`requirements` is moxxy's availability contract. A plugin or block can say:
"I can be registered, activated, or executed only when these other pieces are
present and ready."

Use it for feature readiness, not ordering. Hook ordering follows plugin
registration order.

## Why it exists

Before `requirements`, a plugin could be loaded even when the provider, auth
state, binary, or companion plugin it needed was missing. That made features
show up in the UI and then fail late.

With `requirements`:

- a plugin with missing hard requirements is skipped before partial
  contributions are registered;
- provider, loop, compactor, and transcriber activation checks their
  requirements first;
- tool execution checks the tool's requirements before the handler runs;
- skipped plugins and missing readiness are visible in `moxxy doctor`;
- optional requirements can be reported without blocking availability.

## Requirement shape

```ts
import type { MoxxyRequirement } from '@moxxy/sdk';

const requirement: MoxxyRequirement = {
  kind: 'provider',
  name: 'openai-codex',
  state: 'active',
  hint: 'Switch provider to openai-codex.',
};
```

Fields:

| Field | Meaning |
|---|---|
| `kind` | What is required: `plugin`, `provider`, `tool`, `transcriber`, `loop`, `compactor`, `channel`, `agent`, `command`, or `runtime`. |
| `name` | The registry name, plugin package name, or runtime fact name. |
| `state` | `registered`, `active`, or `ready`. Defaults to `registered` for registry blocks and `ready` for runtime facts. |
| `version` | Optional exact version match. v1 does not do semver ranges. |
| `optional` | If true, the issue is diagnostic only and does not block readiness. |
| `reason` | Human-readable reason for maintainers. |
| `hint` | User-facing repair hint shown by diagnostics where possible. |

## State model

`registered` means the target exists in the relevant registry.

`active` means the target exists and is currently selected. This matters for
providers, modes, compactors, and transcribers.

`ready` means active for registry-backed blocks, or an explicitly set runtime
fact for `kind: 'runtime'`.

Runtime facts are named pieces of process state. Core does not know what they
mean; plugins and bootstrap code set or clear them:

```ts
session.requirements.setRuntime('auth:provider:openai-codex', 'ready');
session.requirements.clearRuntime('auth:provider:openai-codex');
```

Use runtime facts for state that is not represented by a registry entry:
OAuth login, a reachable sidecar, a local binary, a paired account, a mounted
workspace, or any other preflight result.

## Plugin-level requirements

Plugin-level requirements protect registration. If a hard requirement is
missing, the plugin is skipped and no partial tools/providers/hooks leak into
the session.

```ts
import { definePlugin } from '@moxxy/sdk';

export default definePlugin({
  name: '@acme/plugin-reports',
  requirements: [
    {
      kind: 'plugin',
      name: '@moxxy/plugin-memory',
      state: 'registered',
      hint: 'Enable @moxxy/plugin-memory.',
    },
  ],
  tools: [
    // ...
  ],
});
```

Skipped plugins are retained by the plugin host and surfaced by
`moxxy doctor`.

Use plugin-level requirements when the whole plugin cannot safely contribute
anything without the dependency. Do not use them for dependencies injected by
bootstrap closures when the plugin can still operate standalone.

## Block-level requirements

Most blocks can also declare their own requirements. This is the right place
when only one contribution needs extra readiness.

```ts
import { definePlugin, defineTranscriber } from '@moxxy/sdk';

export default definePlugin({
  name: '@acme/plugin-codex-stt',
  transcribers: [
    defineTranscriber({
      name: 'acme-codex-transcribe',
      requirements: [
        {
          kind: 'provider',
          name: 'openai-codex',
          state: 'active',
          hint: 'Switch provider to openai-codex.',
        },
        {
          kind: 'runtime',
          name: 'auth:provider:openai-codex',
          state: 'ready',
          hint: 'Run `moxxy login openai-codex`.',
        },
      ],
      createClient: () => ({
        name: 'acme-codex-transcribe',
        transcribe: async () => ({ text: '' }),
      }),
    }),
  ],
});
```

Enforcement points:

| Block | When requirements are checked |
|---|---|
| Plugin | Before registration. Missing hard requirements skip the plugin. |
| Provider | Before `session.providers.setActive(name)`. |
| Mode | Before `session.modes.setActive(name)`. |
| Compactor | Before `session.compactors.setActive(name)`. |
| Transcriber | Before `session.transcribers.setActive(name)`. |
| Tool | Before `session.tools.execute(...)` calls the handler. |

Channels, agents, and commands expose requirements in their definitions so
diagnostics and feature gates can inspect them. They are registry-backed
readiness checks.

## Checking readiness in UI and channels

Use the shared resolver instead of duplicating preflight logic:

```ts
const check = session.requirements.isReady('transcriber', 'openai-codex-transcribe');

if (!check.ready) {
  const hint = check.issues[0]?.hint ?? check.issues[0]?.message;
  // Hide the feature, disable the shortcut, or show a notice.
}
```

`isReady(kind, name)` checks that the target exists and also evaluates the
target's own nested requirements.

## Codex voice example

The Codex voice path uses requirements as a production example:

- `@moxxy/plugin-stt-whisper-codex` requires the Codex provider plugin to be
  registered.
- `openai-codex-transcribe` requires active provider `openai-codex`.
- It also requires runtime fact `auth:provider:openai-codex` to be `ready`.
- The TUI separately checks local capture readiness (`ffmpeg`) before showing
  `Ctrl+R voice`.

That means:

- with Anthropic active, `Ctrl+R voice` is not advertised and pressing the
  shortcut shows a clear notice;
- without Codex OAuth, the UI points the user to
  `moxxy login openai-codex`;
- without `ffmpeg`, local recording is unavailable but the TUI does not crash.

The transcriber still refreshes OAuth tokens at call time. Requirements improve
availability and UX, but they do not replace final handler-level validation.

## Optional requirements

Optional requirements do not block readiness:

```ts
{
  kind: 'runtime',
  name: 'sidecar:browser',
  state: 'ready',
  optional: true,
  hint: 'Start the browser sidecar for richer screenshots.',
}
```

Use this for enhancements. If the block cannot work without the dependency,
keep the requirement hard.

## Requirements vs `dependsOn`

`dependsOn` has been removed. It used to imply hook ordering and soft
dependency semantics in one field, which made availability ambiguous.

Use explicit registration order for hook order. Use `requirements` for
readiness and diagnostics.

## Author checklist

- Put requirements at plugin level only when the whole plugin must be skipped.
- Put requirements at block level when a single provider/tool/transcriber/etc.
  needs extra state.
- Prefer `runtime` facts for auth, local binaries, paired accounts, sidecars,
  and other process-local preflight results.
- Always include a short `hint` for user-fixable requirements.
- Keep final validation in the handler as well; readiness can change after a
  preflight.
- Run `moxxy doctor` to verify skipped plugins and missing runtime readiness
  are visible to the user.
