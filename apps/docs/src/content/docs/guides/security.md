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

Step 6 of the wizard asks whether to enable plugin-security. Accept and
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

The CLI ships five out of the box:

| Name | Strength | What it does |
|---|---|---|
| `none` | `'none'` | Passthrough — handler runs unmodified. Useful for benchmarking and as an explicit opt-out. |
| `inproc` | `'inproc'` | In-process: validates declared `fs`/`net` caps against the input, enforces `timeMs` via timer + abort. Does **not** stop the handler from doing fs/net it didn't declare. |
| `worker` | `'worker'` | `worker_threads`-based: re-imports the tool's `handlerModule` in a fresh JS thread with its own module cache + V8 heap. Enforces `memMb` via `resourceLimits`, `timeMs` + abort via `worker.terminate()`. Brokered fs/net/exec via async RPC. Main-thread closures and globals are **not** visible. |
| `subprocess` | `'subprocess'` | Spawns a Node child process per call. OS-level process boundary (own VM, own fds). Restrictable env via `caps.env`. Same async broker as worker, over NDJSON stdio. Slower startup (~80–150ms vs ~5–20ms) but stronger boundary. |
| `wasm` | `'wasm'` (experimental) | WebAssembly VM: zero ambient authority. Module can only call host functions it explicitly imports. Synchronous broker (sync fs + spawnSync, no fetch). Requires a wasm toolchain (AssemblyScript / Rust / TinyGo) to author handlers — authoring story is the friction, isolation is the strongest available. |

Further isolators register through the same SDK `Isolator` interface —
no plugin changes needed. See
[`.claude/agents/isolator-author.md`](https://github.com/moxxy-ai/new_moxxy/blob/main/.claude/agents/isolator-author.md)
for the implementation guide.

### When to pick `worker`

- The tool's input could be attacker-influenced (webhooks, untrusted
  prompts, anything reaching `dispatch_agent` from a low-trust channel).
- You want guaranteed termination on timeout — `inproc` can race a
  `Promise`, but a synchronous JS loop in the handler will still hang
  the main thread until the next yield point. `worker.terminate()`
  kills the thread immediately.
- You want each call to start from a clean module cache (no global
  state leaking between unrelated tool invocations).

### Making your tool worker-capable

The worker isolator re-imports the handler on the worker side, so the
handler must be addressable as a module + named export. Closures
captured at `defineTool(...)` time can't cross thread boundaries.

```ts
// my-tool-handler.ts — pure handler module
import { promises as fs } from 'node:fs';

export async function myToolHandler(input, ctx) {
  return await fs.readFile(input.file_path, 'utf8');
}
```

```ts
// my-tool.ts — defineTool with handlerModule reference
import { defineTool, z } from '@moxxy/sdk';
import { myToolHandler } from './my-tool-handler.js';

export const myTool = defineTool({
  name: 'my_tool',
  description: '...',
  inputSchema: z.object({ file_path: z.string() }),
  handler: myToolHandler,                      // used by `inproc` / `none`
  isolation: {
    capabilities: { fs: { read: ['$cwd/**'] }, timeMs: 30_000 },
    handlerModule: {
      // `import.meta.url` resolves correctly post-publish, regardless
      // of where the consumer installs the package.
      url: new URL('./my-tool-handler.js', import.meta.url).href,
      export: 'myToolHandler',
    },
  },
});
```

The single handler module powers both paths: in-process callers
invoke `myToolHandler` directly via the closure, and the worker
isolator imports the same module on its side. **No code duplication.**

Run `moxxy security audit` to confirm — tools with `handlerModule` set
get a `◊` marker:

```
DECLARED  · 1/12 worker-capable (handlerModule set)
  ◊ Read           → worker  fs:read(1) net:none time:30000ms
    Write          → inproc  fs:read(1) fs:write(1) net:none time:30000ms
    …
```

A tool without `handlerModule` denied at call time when configured for
worker isolation — the isolator has no way to actually run the handler
out-of-process and refuses to silently degrade.

## The capability broker

Worker, subprocess, and wasm isolators all inject capability-mediated
proxies into the synthetic `ToolContext` they build for the handler:

```ts
ctx.fs?.readFile(filePath, { encoding: 'utf8' }): Promise<string>
ctx.fs?.writeFile(filePath, data): Promise<void>
ctx.fs?.readdir(dirPath): Promise<string[]>
ctx.fs?.stat(filePath): Promise<{ size, mtimeMs, isFile, isDirectory }>
ctx.fetch?(url, init): Promise<{ status, statusText, headers, body }>
ctx.exec?(command, args, opts): Promise<{ stdout, stderr, exitCode }>
```

Each call posts a `broker-request` message to the parent thread. The
parent re-validates the syscall against `caps.fs` / `caps.net` using
the same matcher the input cap-check uses, executes the syscall if
allowed, and posts a `broker-response` back. The handler awaits the
RPC like any normal `await`.

**Why this matters.** Input-level cap-check only sees the *input
fields* (`file_path`, `url`). The broker sees every *actual syscall*
the handler makes. A handler that decided to read a different file
than the one in the input would bypass input-level checks; the broker
catches that case.

**How to opt in as a tool author.** Pass through `ctx.fs.readFile`
instead of `node:fs.readFile`:

```ts
export async function myHandler(input, ctx) {
  const text = ctx.fs
    ? await ctx.fs.readFile(input.file_path, { encoding: 'utf8' })
    : (await import('node:fs')).promises.readFile(input.file_path, 'utf8');
  // ...
}
```

The ternary keeps the handler portable across isolators: under
`worker` you get brokering; under `none` / `inproc`, `ctx.fs` is
undefined and the handler falls back to direct `node:fs`.

## What each isolator can't enforce

Be honest about the threat model. Strengths stack — pick the weakest
that actually meets your need.

**`inproc` does NOT:**
- Stop a malicious handler from `import('node:fs').then(fs => fs.readFileSync('/etc/passwd'))`. The handler runs in your process.
- Constrain opaque command strings (Bash's `command`, custom DSL inputs).
- Enforce memory ceilings.
- Provide network-level isolation — the handler can `fetch()` to any host.

**`worker` adds:**
- Memory ceiling, true JS-state isolation (no closures or globals
  from the main thread), guaranteed termination on abort.
- **Brokered fs / fetch / exec** via `ctx.fs` / `ctx.fetch` /
  `ctx.exec`. Each call re-validated against `caps` on the parent.
- **Loader-hook layer** that blocks `node:fs`, `node:fs/promises`,
  `node:child_process`, `node:net`, `node:dgram`, `node:http`,
  `node:http2`, `node:https`, `node:tls` (and their bare-specifier
  aliases) from the handler's import graph. A handler cannot bypass
  the broker by reaching for Node APIs — the import throws at
  resolution time. Harmless modules (`node:path`, `node:url`,
  `node:buffer`, etc.) remain available.

**It still does NOT** mediate `process.env` — the worker inherits
the env at spawn. Tools that need env masking use `subprocess` with
`caps.env`.

**`subprocess` adds** OS-level process boundary (separate VM,
separate fd table, separate signal mask) and **restrictable env**
via `caps.env`. Same loader-hook layer as worker — `node:fs` and
friends are blocked from the handler's imports.

**`wasm` adds** zero ambient authority by construction — modules
have no access to Node APIs whatsoever; only the host functions
imported via the broker are reachable. The broker imports use
synchronous fs / `spawnSync`. **It still does NOT:**
- Support fetch — Node has no safe sync HTTP API. Wasm handlers
  needing network use `worker` or `subprocess` instead.
- Solve the authoring problem — wasm modules must be authored in a
  language that compiles to wasm. Calling convention documented in
  [`@moxxy/isolator-wasm`](/packages/isolator-wasm/); aligns with
  AssemblyScript / wasm-bindgen / TinyGo defaults.

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
