---
title: '@moxxy/isolator-wasm'
description: WebAssembly Isolator for @moxxy/plugin-security. Zero ambient authority; sync capability broker.
---

`@moxxy/isolator-wasm` runs handlers as WebAssembly modules in V8's
wasm VM. **Zero ambient authority**: wasm modules can call only the
host functions the isolator explicitly imports. No `node:fs`, no
`process.env`, no closures from the host. Strongest pure-JS sandbox
available.

The authoring story is the friction — wasm modules must be written in
a language that compiles to wasm (AssemblyScript, Rust + wasm-bindgen,
TinyGo). The calling convention below aligns with what those toolchains
produce by default.

Registered by default in the `@moxxy/cli` builtin stack. Status:
**experimental** until a real production tool ships using it.

## Calling convention (v1)

Module exports (required):

```
memory: WebAssembly.Memory
alloc(size: i32) -> i32                                    ;; returns ptr
<handler-name>(inputPtr: i32, inputLen: i32) -> i64        ;; packed (outputPtr << 32) | outputLen
```

Input and output are UTF-8 JSON. The host:

1. JSON-encodes `IsolatedToolCall.input` and calls `alloc(len)` to
   reserve a buffer in linear memory.
2. Copies the encoded bytes into `memory` at the returned pointer.
3. Calls `<handler-name>(inputPtr, inputLen)`.
4. Unpacks the i64 return into `(outputPtr, outputLen)`.
5. Reads `outputLen` bytes from `memory` at `outputPtr` and `JSON.parse`s.

## Broker imports (synchronous)

Wasm imports are synchronous from the module's perspective. Async
broker ops would break the type contract (the wasm side expects an
`i32` return). So the wasm broker uses synchronous Node APIs:
`readFileSync`, `writeFileSync`, `readdirSync`, `statSync`, `spawnSync`.
**No `fetch`** — Node has no safe sync HTTP API. Handlers needing
network should use `worker` or `subprocess`.

Common ABI for brokered imports:

```
(inputPtr, inputLen, outPtrOut, outLenOut) -> i32
```

- `inputPtr/inputLen`: UTF-8 string in memory (e.g. a file path).
- `outPtrOut`, `outLenOut`: addresses where the host writes a
  `(resultPtr, resultLen)` pair as two i32s.
- Return: `0` success, `1` error. Result bytes are the op output or
  error message.

| Import | Caps required | Result format |
|---|---|---|
| `broker_fs_read_file` | `fs.read` covers path | raw file bytes |
| `broker_fs_write_file` | `fs.write` covers path | no result bytes (just rc) — ABI: `(pathPtr, pathLen, dataPtr, dataLen) -> i32` |
| `broker_fs_readdir` | `fs.read` covers path | entry names joined by `\n` |
| `broker_fs_stat` | `fs.read` covers path | JSON `{ size, mtimeMs, isFile, isDirectory }` |
| `broker_exec` | `subprocess: true` + optional `commands` allowlist | JSON `{ stdout, stderr, exitCode }` — ABI: `(cmdPtr, cmdLen, argvJsonPtr, argvJsonLen, outPtrOut, outLenOut) -> i32` |

A module that doesn't import a given function simply lacks access to
that op. V8 raises a `LinkError` only if a module declares an import
that the host didn't supply — so unused ops cost nothing.

## What it enforces

- **Zero ambient authority** — wasm modules have no Node APIs.
- **Cap-mediated broker calls** — every brokered op validated against
  the tool's declared `caps` on the host side.
- **Cap declarations on input** — same input-level pre-flight check
  as the other isolators.
- **Wall-clock** + **abort** via `Promise.race`.

## What it does NOT enforce

- **Infinite-loop protection** — V8 can't interrupt running wasm
  mid-execution. A handler that modes forever hangs until the wall-clock
  timer fires, then the wasm instance is discarded. The hanging call
  consumes thread time until it returns; this is a known wasm runtime
  limitation, not specific to moxxy.
- **Memory ceiling** — wasm modules manage their own linear memory.
  Caps' `memMb` is currently ignored under wasm (the module's own
  memory growth limits via `WebAssembly.Memory.grow` are the only knob).
  A future iteration may wrap `memory.grow` and enforce `caps.memMb`.

## Authoring a wasm handler

Real tools today need a wasm toolchain. AssemblyScript is the closest
to authoring in TypeScript; Rust + wasm-bindgen and TinyGo produce
similar calling conventions.

A handler in AssemblyScript-ish pseudocode:

```ts
// handler.ts (compiled to handler.wasm by AssemblyScript)
import { broker_fs_read_file } from 'env';

export function handle(inputPtr: i32, inputLen: i32): i64 {
  // Read input JSON
  const input = readMemoryAsString(inputPtr, inputLen);
  // ... process ...
  // Write output JSON to memory
  const outBytes = encode(JSON.stringify(result));
  const outPtr = alloc(outBytes.length);
  copyTo(outBytes, outPtr);
  return (i64(outPtr) << 32) | i64(outBytes.length);
}
```

When this lands as a real recipe (alongside the first wasm-authored
moxxy tool), it'll be documented in the docs guides directory.
