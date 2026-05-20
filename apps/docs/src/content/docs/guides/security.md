---
title: Security & isolation
description: Opt-in per-tool capability isolation via @moxxy/plugin-security.
---

`@moxxy/plugin-security` is moxxy's pluggable isolation layer. Tools
declare what they need (filesystem paths, network hosts, env keys,
time/memory budgets); when enabled, an `Isolator` enforces those
bounds at every call. **Off by default** — your existing setup
behaves exactly as it does today until you turn it on.

## Why opt-in?

Capability isolation is a power-user knob. Forcing it on every install
would break tools that haven't yet declared their capabilities, and the
default OS-level isolation most users already rely on (`permissions` +
`PermissionResolver`) is sufficient for personal use. Plugin-security
exists for the cases where you need *more*: shared sessions, untrusted
prompts, embedded host environments, or just stricter hygiene.

## Enabling

### During `moxxy init`

Step 7 of the wizard asks whether to enable plugin-security. Accept and
the generated `moxxy.config.yaml` gains:

```yaml
security:
  enabled: true
```

### Manually

Add the block to `moxxy.config.ts` or `moxxy.config.yaml`:

```ts
import { defineConfig } from '@moxxy/config';

export default defineConfig({
  security: {
    enabled: true,
    isolator: 'inproc',           // default: 'inproc'
    // perTool: { Bash: 'subprocess' },         // override per tool
    // perPlugin: { '@moxxy/plugin-browser': 'worker' },
    // requireDeclaration: true,                // refuse undeclared tools
  },
});
```

That's it. On next launch, every tool with a declared `isolation` spec
runs through the configured isolator. Undeclared tools pass through
untouched (unless you set `requireDeclaration: true`, which denies them
at call time).

## Inspect the state

```sh
moxxy security status        # is it on?
moxxy security audit         # every tool + declared caps + resolved isolator
moxxy security isolators     # registered Isolator impls + their strength
```

`audit` is the most useful — it tells you exactly which tools have caps
declared and what they look like:

```
12 tools · 12 declared isolation · 171 undeclared

DECLARED
  Read           → inproc  fs:read(1) net:none time:30000ms
  Write          → inproc  fs:read(1) fs:write(1) net:none time:30000ms
  Bash           → inproc  req:inproc  fs:read(2) fs:write(2) net:any env(7) time:600000ms
  web_fetch      → inproc  net:any time:120000ms
  ...
```

## Declaring caps on your own tools

Add an `isolation` field to your `defineTool({...})` spec:

```ts
import { defineTool, z } from '@moxxy/sdk';

export const tool = defineTool({
  name: 'my_tool',
  description: '...',
  inputSchema: z.object({ file_path: z.string(), url: z.string() }),
  handler: async ({ file_path, url }, ctx) => { /* ... */ },
  isolation: {
    // Minimum acceptable isolator strength. The user's configured isolator
    // must be at least this strong; otherwise the call is denied.
    // Default: 'none' (any isolator OK).
    required: 'inproc',

    capabilities: {
      // Globs the handler may read / write. `$cwd` expands to the
      // ToolContext.cwd at call time. Inputs whose key looks like a
      // path field (file, file_path, dir, cwd, src, ...) are validated
      // against these globs.
      fs: {
        read: ['$cwd/**', '/tmp/**'],
        write: ['$cwd/**'],
      },

      // Network access. 'none' | 'any' | { mode: 'allowlist', hosts: [...] }.
      // URL-shaped input fields (url, uri, endpoint, href) are validated.
      net: { mode: 'allowlist', hosts: ['api.example.com', '*.example.com'] },

      // Allowed env keys. Honored by stronger isolators that can constrain
      // the env (e.g. subprocess); informational under inproc.
      env: ['PATH', 'HOME'],

      // Wall-clock budget. Enforced by every isolator via Promise.race +
      // ctx.signal abort.
      timeMs: 30_000,

      // Soft memory ceiling in MB. Honored by isolators that support it.
      memMb: 256,

      // Whether the tool may spawn subprocesses. Default: false.
      subprocess: false,
    },
  },
});
```

**Declarations are advisory until the user enables the plugin.** The
field is safe to ship in any plugin — users who haven't enabled
security simply ignore it.

## Capability semantics

| Field | Type | Inproc enforcement |
|---|---|---|
| `fs.read` | `string[]` (globs, `$cwd`, `~/`) | Path-shaped input fields validated against globs |
| `fs.write` | `string[]` (globs) | Same |
| `net.mode` | `'none' \| 'any' \| 'allowlist'` | URL-shaped input fields validated against host allowlist |
| `net.hosts` | `string[]` | Exact host or `*.example.com` wildcard |
| `env` | `string[]` | Informational only (subprocess isolator will enforce) |
| `timeMs` | `number` | `Promise.race` + ctx.signal abort |
| `memMb` | `number` | Informational under inproc; honored by `worker_threads`+ |
| `subprocess` | `boolean` | Informational only |

**Path key detection** matches both snake_case and camelCase: `file`,
`file_path`, `filePath`, `outputDir`, `src_path`, etc. all decompose
into the same word tokens (`file`, `path`, `dir`, `src`). Generic
fields (`command`, `query`, `pattern`) are *not* scanned — opaque
strings are the tool's responsibility.

## Available isolators

Phase 1 ships two:

| Name | Strength | What it does |
|---|---|---|
| `none` | `'none'` | Passthrough — handler runs unmodified. Useful for benchmarking and as an explicit opt-out. |
| `inproc` | `'inproc'` | In-process: validates declared `fs`/`net` caps against the input, enforces `timeMs` via timer + abort. Does **not** stop the handler from doing fs/net it didn't declare. |

Stronger isolators register through the same SDK `Isolator` interface —
no plugin changes needed. The roadmap: `worker_threads`, `subprocess`,
`vm` (V8 isolate), `wasm` (WASI), `docker`. See
[`.claude/agents/isolator-author.md`](https://github.com/moxxy-ai/new_moxxy/blob/main/.claude/agents/isolator-author.md)
for the implementation guide.

## What inproc can't enforce

Be honest about the threat model. The in-process isolator's strength is
*declarative integrity* — it ensures tools don't quietly act outside
their stated bounds when those bounds are visible in the input. It
does **not**:

- Stop a malicious handler from `import('node:fs').then(fs => fs.readFileSync('/etc/passwd'))`. The handler runs in your process.
- Constrain opaque command strings (Bash's `command`, custom DSL inputs).
- Enforce memory ceilings or subprocess limits.
- Provide network-level isolation — the handler can `fetch()` to any host.

For those guarantees, you need an out-of-process isolator. The
infrastructure is in place for them to drop in behind the same
interface; check the audit output for `→ <isolator-name>` to confirm
which one is active for each tool.

## Per-tool / per-plugin overrides

```ts
security: {
  enabled: true,
  isolator: 'inproc',
  perTool: {
    Bash: 'subprocess',          // Bash needs stronger isolation
    memory_recall: 'none',       // we trust this one in-process
  },
  perPlugin: {
    '@moxxy/plugin-browser': 'worker',
  },
}
```

Resolution order: `perTool` > `perPlugin` > top-level `isolator` >
built-in default (`inproc`).

## Hardening: requireDeclaration

```ts
security: {
  enabled: true,
  requireDeclaration: true,
}
```

Any tool without an `isolation` field is denied at call time. Useful as
a forcing function once you've audited every tool you actually use.
Run `moxxy security audit` to see which tools are undeclared before
flipping this on — un-annotated MCP servers and third-party plugins
will refuse to run.

## See also

- [`.claude/agents/isolator-author.md`](https://github.com/moxxy-ai/new_moxxy/blob/main/.claude/agents/isolator-author.md) — author guide for new Isolator impls
- [`packages/plugin-security/src/cap-check.ts`](https://github.com/moxxy-ai/new_moxxy/blob/main/packages/plugin-security/src/cap-check.ts) — capability validation source
- [`packages/sdk/src/isolation.ts`](https://github.com/moxxy-ai/new_moxxy/blob/main/packages/sdk/src/isolation.ts) — SDK type definitions
