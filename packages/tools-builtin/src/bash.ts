import { spawn } from 'node:child_process';
import { defineTool, z } from '@moxxy/sdk';
import { clampString } from './util.js';

export const bashTool = defineTool({
  name: 'Bash',
  description: 'Run a shell command via /bin/sh. Respects the abort signal. Returns combined stdout/stderr with exit code.',
  inputSchema: z.object({
    command: z.string().min(1),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().max(600_000).optional().default(120_000),
    env: z.record(z.string(), z.string()).optional(),
  }),
  permission: { action: 'prompt' },
  // Bash is the highest-privilege built-in: it spawns a real shell.
  // Declared caps are *honest* — Bash genuinely needs subprocess + any
  // net + broad fs + a shell-friendly env subset. The `inproc` isolator
  // can only enforce the few fields it can introspect (`cwd` against
  // fs.read, `timeMs` against the wall clock); the command string is
  // opaque to in-process cap checks by design. A future `subprocess`
  // isolator that re-spawns Bash under a constrained env / cgroup would
  // enforce these caps for real.
  isolation: {
    required: 'inproc',
    capabilities: {
      subprocess: true,
      fs: { read: ['$cwd/**', '/tmp/**'], write: ['$cwd/**', '/tmp/**'] },
      net: { mode: 'any' },
      env: ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TERM'],
      timeMs: 600_000,
    },
  },
  async handler({ command, cwd, timeoutMs, env }, ctx) {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn('/bin/sh', ['-lc', command], {
        cwd: cwd ?? ctx.cwd,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let out = '';
      let err = '';
      child.stdout.on('data', (b: Buffer) => { out += b.toString('utf8'); });
      child.stderr.on('data', (b: Buffer) => { err += b.toString('utf8'); });

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Bash timed out after ${timeoutMs}ms: ${command}`));
      }, timeoutMs);

      const onAbort = (): void => {
        child.kill('SIGTERM');
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      child.on('error', (e: Error) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        const combined =
          (out ? `[stdout]\n${out.trimEnd()}\n` : '') +
          (err ? `[stderr]\n${err.trimEnd()}\n` : '') +
          `[exit ${code ?? 'null'}]`;
        resolve(clampString(combined, 200_000));
      });
    });
  },
});
