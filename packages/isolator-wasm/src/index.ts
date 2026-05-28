import { promises as fs, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import * as path from 'node:path';
import { definePlugin, type CapabilitySpec, type IsolatedToolCall, type Isolator, type Plugin } from '@moxxy/sdk';
import { checkAllCaps, pathInScope, buildBrokerEnv } from '@moxxy/plugin-security';

/**
 * WebAssembly Isolator. Runs wasm handlers in V8's wasm VM — the
 * strongest pure-JS sandbox: zero ambient authority. Wasm modules can
 * call only the host functions the isolator explicitly imports; no
 * `node:fs`, no `process.env`, no closures from the host.
 *
 * Capability mediation: host imports below. Modules opt in by declaring
 * them in their wasm import section. The host re-validates every
 * brokered op against `caps` before executing.
 *
 * --------------------------------------------------------------------
 * Calling convention (v1)
 * --------------------------------------------------------------------
 *
 * **Module exports** (required):
 *   - `memory: WebAssembly.Memory`
 *   - `alloc(size: i32) -> i32`
 *   - `<handler-name>(inputPtr: i32, inputLen: i32) -> i64`
 *     Return value packs `(outputPtr << 32) | outputLen`.
 *     Input + output are UTF-8 JSON.
 *
 * --------------------------------------------------------------------
 * Broker import surface (v1 — synchronous)
 * --------------------------------------------------------------------
 *
 * Wasm imports are synchronous from the module's perspective. Async
 * broker ops would break the type contract (the wasm side expects an
 * `i32` return). So the wasm broker uses **synchronous Node APIs**:
 * `readFileSync`, `writeFileSync`, `readdirSync`, `statSync`,
 * `spawnSync`. Network ops (`fetch`) have no safe sync equivalent in
 * Node and are intentionally NOT exposed under wasm — handlers that
 * need network should run under `worker` or `subprocess` isolators.
 *
 * Common ABI for every brokered import (i32 args + i32 return):
 *
 * ```
 * (inputPtr, inputLen, outPtrOut, outLenOut) -> i32
 * ```
 *
 * - `inputPtr/inputLen`: a UTF-8 string in memory describing the call's
 *   primary argument (file path / command name).
 * - `outPtrOut`, `outLenOut`: addresses where the host writes a
 *   `(resultPtr, resultLen)` pair as two i32s.
 * - Return: 0 on success, 1 on error. The result bytes at
 *   `(resultPtr, resultLen)` are the operation output (UTF-8 string,
 *   or for `read_file` the raw file contents) on success, or the
 *   error message bytes on failure.
 *
 * Ops whose payload doesn't fit "single input string + result bytes"
 * use a slightly extended ABI documented inline below.
 *
 * --------------------------------------------------------------------
 * What ships
 * --------------------------------------------------------------------
 *
 * - v1 calling convention, end-to-end (host marshals JSON → memory →
 *   handler → memory → JSON; tested with hand-encoded echo fixture).
 * - All five sync broker imports wired: read_file, write_file,
 *   readdir, stat, exec. Validate against caps; deny on out-of-scope.
 * - Zero ambient authority guaranteed by the wasm VM itself: modules
 *   without import declarations have no host-callable surface.
 *
 * **Authoring story.** Writing real wasm handlers requires a wasm
 * toolchain (AssemblyScript / Rust + wasm-bindgen / TinyGo). The
 * calling convention above is intentionally aligned with what those
 * toolchains produce by default. A wasm-authored handler recipe will
 * land alongside the first tool that actually adopts it.
 */

export interface WasmIsolatorOptions {
  /** Default wall-clock budget (ms) when caps.timeMs is omitted. */
  readonly defaultTimeMs?: number;
}

type WasmMemoryExports = {
  readonly memory: WebAssembly.Memory;
  readonly alloc: (size: number) => number;
  readonly [name: string]: WebAssembly.ExportValue;
};

const SUCCESS = 0;
const ERROR = 1;

export function createWasmIsolator(opts: WasmIsolatorOptions = {}): Isolator {
  const defaultTimeMs = opts.defaultTimeMs ?? 60_000;

  return {
    name: 'wasm',
    strength: 'wasm',
    async run(call, _handler, caps, signal) {
      if (!call.moduleRef) {
        throw new Error(
          `[security:wasm] tool '${call.toolName}' has no handlerModule declared; ` +
            `wasm isolation requires a .wasm module URL.`,
        );
      }

      const verdict = checkAllCaps(call.input, caps, call.cwd);
      if (!verdict.ok) throw new Error(`[security:wasm] ${verdict.reason}`);

      const timeMs = caps.timeMs ?? defaultTimeMs;
      const abortError = (): Error =>
        new Error(`[security:wasm] tool '${call.toolName}' aborted`);

      return await Promise.race([
        invoke(call, caps, signal),
        new Promise<never>((_resolve, reject) => {
          if (signal.aborted) {
            reject(abortError());
            return;
          }
          const timer = setTimeout(() => {
            reject(
              new Error(
                `[security:wasm] tool '${call.toolName}' exceeded ${timeMs}ms budget`,
              ),
            );
          }, timeMs);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(abortError());
            },
            { once: true },
          );
        }),
      ]);
    },
  };
}

async function invoke(
  call: IsolatedToolCall,
  caps: CapabilitySpec,
  _signal: AbortSignal,
): Promise<unknown> {
  const bytes = await fetchWasmBytes(call.moduleRef!.url);
  const memoryHolder: MemoryHolder = { current: null };
  const env = buildWasmHostImports(memoryHolder, caps, call.cwd);
  // BufferSource cast: TS5+ types Uint8Array as <ArrayBufferLike>
  // which includes SharedArrayBuffer; WebAssembly.compile wants a
  // non-shared ArrayBuffer. Our bytes always come from a non-shared
  // ArrayBuffer (fs.readFile / Buffer.from / fetch arrayBuffer).
  const module = await WebAssembly.compile(bytes as unknown as BufferSource);
  const instance = await WebAssembly.instantiate(module, { env });
  const exports = instance.exports as WasmMemoryExports;
  if (!(exports.memory instanceof WebAssembly.Memory)) {
    throw new Error(`[security:wasm] module does not export 'memory'`);
  }
  memoryHolder.current = exports.memory;

  if (typeof exports.alloc !== 'function') {
    throw new Error(`[security:wasm] module does not export 'alloc(size: i32) -> i32'`);
  }
  const handler = exports[call.moduleRef!.export];
  if (typeof handler !== 'function') {
    throw new Error(
      `[security:wasm] export '${call.moduleRef!.export}' is ${typeof handler}, expected function`,
    );
  }

  const inputBytes = new TextEncoder().encode(JSON.stringify(call.input));
  const inputPtr = exports.alloc(inputBytes.length);
  new Uint8Array(exports.memory.buffer, inputPtr, inputBytes.length).set(inputBytes);

  const packed = (handler as (a: number, b: number) => bigint)(inputPtr, inputBytes.length);
  const outputPtr = Number((packed >> 32n) & 0xffff_ffffn);
  const outputLen = Number(packed & 0xffff_ffffn);

  if (outputLen === 0) return undefined;
  const outputBytes = new Uint8Array(exports.memory.buffer, outputPtr, outputLen);
  const outputJson = new TextDecoder().decode(outputBytes);
  if (outputJson === '') return undefined;
  return JSON.parse(outputJson);
}

// ---------------------------------------------------------------------------
// Wasm host imports (synchronous broker)
// ---------------------------------------------------------------------------

interface MemoryHolder {
  current: WebAssembly.Memory | null;
}

/**
 * Build the `env` import object for a wasm instance. Modules opt in
 * to each function by declaring it in their imports; modules that
 * don't import it have no host-callable surface for that op.
 *
 * Exported separately so the unit tests can exercise each bridge
 * without spinning up a real wasm instance.
 */
export function buildWasmHostImports(
  memoryHolder: MemoryHolder,
  caps: CapabilitySpec,
  cwd: string,
): WebAssembly.ModuleImports {
  const memOf = (): WebAssembly.Memory => {
    const m = memoryHolder.current;
    if (!m) throw new Error('[security:wasm] memory not bound');
    return m;
  };

  const readStr = (ptr: number, len: number): string => {
    return new TextDecoder().decode(new Uint8Array(memOf().buffer, ptr, len));
  };

  const sendBytes = (outPtrOut: number, outLenOut: number, bytes: Uint8Array): void => {
    const region = reserveScratch(memOf(), bytes.length);
    new Uint8Array(memOf().buffer, region, bytes.length).set(bytes);
    writePtrPair(memOf(), outPtrOut, outLenOut, region, bytes.length);
  };

  const sendStr = (outPtrOut: number, outLenOut: number, s: string): void => {
    sendBytes(outPtrOut, outLenOut, new TextEncoder().encode(s));
  };

  const sendErr = (outPtrOut: number, outLenOut: number, message: string): number => {
    sendStr(outPtrOut, outLenOut, message);
    return ERROR;
  };

  return {
    /**
     * `broker_fs_read_file(pathPtr, pathLen, outPtrOut, outLenOut) -> i32`
     * Reads a file. Result bytes are the file contents.
     */
    broker_fs_read_file: (
      pathPtr: number,
      pathLen: number,
      outPtrOut: number,
      outLenOut: number,
    ): number => {
      const filePath = readStr(pathPtr, pathLen);
      if (!pathInScope(filePath, caps.fs, cwd, 'read')) {
        return sendErr(
          outPtrOut,
          outLenOut,
          `[broker:fs.readFile] path '${filePath}' is outside the tool's declared fs.read capability`,
        );
      }
      try {
        const bytes = readFileSync(filePath);
        sendBytes(outPtrOut, outLenOut, new Uint8Array(bytes));
        return SUCCESS;
      } catch (e) {
        return sendErr(outPtrOut, outLenOut, (e as Error).message);
      }
    },

    /**
     * `broker_fs_write_file(pathPtr, pathLen, dataPtr, dataLen) -> i32`
     * Writes UTF-8 bytes to a file. No out-pointer pair (no result data).
     * Returns 0 on success, 1 on cap-deny or IO error.
     */
    broker_fs_write_file: (
      pathPtr: number,
      pathLen: number,
      dataPtr: number,
      dataLen: number,
    ): number => {
      const filePath = readStr(pathPtr, pathLen);
      const data = readStr(dataPtr, dataLen);
      if (!pathInScope(filePath, caps.fs, cwd, 'write')) return ERROR;
      try {
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, data, 'utf8');
        return SUCCESS;
      } catch {
        return ERROR;
      }
    },

    /**
     * `broker_fs_readdir(pathPtr, pathLen, outPtrOut, outLenOut) -> i32`
     * Result bytes are entry names joined by `\n` (each is UTF-8).
     */
    broker_fs_readdir: (
      pathPtr: number,
      pathLen: number,
      outPtrOut: number,
      outLenOut: number,
    ): number => {
      const dirPath = readStr(pathPtr, pathLen);
      if (!pathInScope(dirPath, caps.fs, cwd, 'read')) {
        return sendErr(
          outPtrOut,
          outLenOut,
          `[broker:fs.readdir] path '${dirPath}' is outside the tool's declared fs.read capability`,
        );
      }
      try {
        const entries = readdirSync(dirPath);
        sendStr(outPtrOut, outLenOut, entries.join('\n'));
        return SUCCESS;
      } catch (e) {
        return sendErr(outPtrOut, outLenOut, (e as Error).message);
      }
    },

    /**
     * `broker_fs_stat(pathPtr, pathLen, outPtrOut, outLenOut) -> i32`
     * Result bytes are JSON `{ size, mtimeMs, isFile, isDirectory }`.
     */
    broker_fs_stat: (
      pathPtr: number,
      pathLen: number,
      outPtrOut: number,
      outLenOut: number,
    ): number => {
      const filePath = readStr(pathPtr, pathLen);
      if (!pathInScope(filePath, caps.fs, cwd, 'read')) {
        return sendErr(
          outPtrOut,
          outLenOut,
          `[broker:fs.stat] path '${filePath}' is outside the tool's declared fs.read capability`,
        );
      }
      try {
        const st = statSync(filePath);
        sendStr(
          outPtrOut,
          outLenOut,
          JSON.stringify({
            size: st.size,
            mtimeMs: st.mtimeMs,
            isFile: st.isFile(),
            isDirectory: st.isDirectory(),
          }),
        );
        return SUCCESS;
      } catch (e) {
        return sendErr(outPtrOut, outLenOut, (e as Error).message);
      }
    },

    /**
     * `broker_exec(cmdPtr, cmdLen, argvJsonPtr, argvJsonLen, outPtrOut, outLenOut) -> i32`
     *
     * Slightly extended ABI (6 args instead of 4) because exec needs
     * a structured argv. argv is a JSON-encoded `string[]`. Result
     * bytes are JSON `{ stdout, stderr, exitCode }`. spawnSync blocks
     * the event loop — acceptable inside a wasm broker call because
     * the wasm side is already blocking on the import return.
     */
    broker_exec: (
      cmdPtr: number,
      cmdLen: number,
      argvJsonPtr: number,
      argvJsonLen: number,
      outPtrOut: number,
      outLenOut: number,
    ): number => {
      if (!caps.subprocess) {
        return sendErr(
          outPtrOut,
          outLenOut,
          `[broker:exec] tool's capability spec does not include subprocess: true`,
        );
      }
      const command = readStr(cmdPtr, cmdLen);
      let argv: ReadonlyArray<string> = [];
      try {
        const json = readStr(argvJsonPtr, argvJsonLen);
        const parsed = JSON.parse(json) as unknown;
        if (Array.isArray(parsed)) argv = parsed.map(String);
      } catch (e) {
        return sendErr(outPtrOut, outLenOut, `[broker:exec] bad argv JSON: ${(e as Error).message}`);
      }
      const allowlist = caps.commands;
      if (allowlist && allowlist.length > 0) {
        const base = path.basename(command);
        if (!allowlist.includes(base) && !allowlist.includes(command)) {
          return sendErr(
            outPtrOut,
            outLenOut,
            `[broker:exec] command '${command}' is outside the tool's declared commands allowlist`,
          );
        }
      }
      try {
        const res = spawnSync(command, [...argv], {
          cwd,
          encoding: 'utf8',
          // Curate the child env through the tool's `caps.env` allowlist (or a
          // minimal default) instead of inheriting ALL of process.env — passing
          // no `env` would hand the child every API key/token/secret the host
          // holds. Mirrors the async broker's exec env curation.
          env: buildBrokerEnv(caps, undefined),
          // Surface the tool's wall-clock budget so a runaway child is killed
          // by spawnSync itself, not just the outer Promise.race timeout.
          ...(caps.timeMs !== undefined ? { timeout: caps.timeMs } : {}),
        });
        sendStr(
          outPtrOut,
          outLenOut,
          JSON.stringify({
            stdout: res.stdout ?? '',
            stderr: res.stderr ?? '',
            exitCode: res.status,
          }),
        );
        return SUCCESS;
      } catch (e) {
        return sendErr(outPtrOut, outLenOut, (e as Error).message);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Memory marshalling helpers (host side)
// ---------------------------------------------------------------------------

// Bump-pointer scratch allocator, keyed PER memory (i.e. per wasm invocation —
// each instantiation gets its own WebAssembly.Memory). A module-global offset
// here was a real bug: it persisted across invocations and only ever grew, so
// every later call started higher and forced unbounded memory.grow() / OOM.
const SCRATCH_BASE = 65536;
let scratchOffsets = new WeakMap<WebAssembly.Memory, number>();

function reserveScratch(memory: WebAssembly.Memory, size: number): number {
  const start = scratchOffsets.get(memory) ?? SCRATCH_BASE;
  const next = start + size;
  scratchOffsets.set(memory, next);
  const required = Math.ceil((next + 1) / 65536);
  const have = memory.buffer.byteLength / 65536;
  if (required > have) memory.grow(required - have);
  return start;
}

/**
 * Test-only helper to reset the scratch allocator between unit tests. State is
 * now per-memory, so a fresh memory already starts at the base; this just drops
 * the table for full isolation.
 */
export function _resetScratch(): void {
  scratchOffsets = new WeakMap();
}

function writePtrPair(
  memory: WebAssembly.Memory,
  outPtrOut: number,
  outLenOut: number,
  ptr: number,
  len: number,
): void {
  const view = new DataView(memory.buffer);
  view.setUint32(outPtrOut, ptr, true);
  view.setUint32(outLenOut, len, true);
}

// ---------------------------------------------------------------------------
// Module fetching
// ---------------------------------------------------------------------------

/**
 * Fetch wasm bytes from any URL the SDK's `handlerModule` shape might
 * carry: `file://`, `data:application/wasm;base64,…`, or http(s).
 */
export async function fetchWasmBytes(url: string): Promise<Uint8Array> {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    if (comma < 0) throw new Error(`[security:wasm] malformed data URL`);
    const meta = url.slice(5, comma);
    const data = url.slice(comma + 1);
    if (meta.includes('base64')) return new Uint8Array(Buffer.from(data, 'base64'));
    return new Uint8Array(Buffer.from(decodeURIComponent(data), 'binary'));
  }
  if (url.startsWith('file:')) {
    const filePath = fileURLToPath(url);
    return new Uint8Array(await fs.readFile(filePath));
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`[security:wasm] failed to fetch ${url}: ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Default singleton. Use `createWasmIsolator({...})` to tune. */
export const wasmIsolator: Isolator = createWasmIsolator();

/**
 * Auto-discovery entry: a user-installed copy registers the isolator via
 * `PluginSpec.isolators`. Inert until opted into with `security.isolator: 'wasm'`.
 */
const plugin: Plugin = definePlugin({
  name: '@moxxy/isolator-wasm',
  isolators: [wasmIsolator],
});
export default plugin;
