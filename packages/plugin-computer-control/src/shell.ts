import { spawn } from 'node:child_process';

export const IS_DARWIN = process.platform === 'darwin';

export interface ProcResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Spawn a process with array-form args (no shell). Returns stdout +
 * stderr + exit code. Optional `input` is written to stdin. Optional
 * `signal` propagates aborts from the tool ctx so a stuck `osascript`
 * dies with the turn instead of hanging the parent.
 *
 * Never use this with string interpolation into a single command —
 * each argument MUST be a separate array entry. The `bash -c` shape
 * would re-introduce the shell-injection risk this helper exists to
 * eliminate.
 */
export function runProcess(
  cmd: string,
  args: ReadonlyArray<string>,
  opts: {
    readonly input?: string | Buffer;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  } = {},
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0);
    let stderr = '';
    let settled = false;

    const onAbort = (): void => {
      if (settled) return;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          try {
            child.kill('SIGTERM');
          } catch {
            /* ignore */
          }
        }, opts.timeoutMs)
      : null;

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode: code ?? -1,
        stdout: stdout.toString('utf8'),
        stderr,
      });
    });

    if (opts.input !== undefined) {
      child.stdin.end(opts.input);
    } else {
      child.stdin.end();
    }
  });
}

/** Same as runProcess but returns the captured stdout as a Buffer.
 *  Used by the screenshot tool to preserve binary PNG bytes. */
export function runProcessBinary(
  cmd: string,
  args: ReadonlyArray<string>,
  opts: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<{ exitCode: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    let settled = false;

    const onAbort = (): void => {
      if (settled) return;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          try {
            child.kill('SIGTERM');
          } catch {
            /* ignore */
          }
        }, opts.timeoutMs)
      : null;

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: code ?? -1, stdout: Buffer.concat(chunks), stderr });
    });
  });
}

/** Throw a clear error when a tool is invoked on a non-darwin host. */
export function ensureDarwin(toolName: string): void {
  if (!IS_DARWIN) {
    throw new Error(
      `${toolName}: @moxxy/plugin-computer-control currently only supports macOS (process.platform = ${process.platform})`,
    );
  }
}
