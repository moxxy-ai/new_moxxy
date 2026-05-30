import { promises as fs } from 'node:fs';
import type { BrokeredFs } from '@moxxy/sdk';
import { clampString, resolvePath } from './util.js';

/**
 * Pure handler module for the Read tool. Lives in its own file so the
 * worker_threads isolator (`@moxxy/isolator-worker`) can re-import it
 * on the worker side via the `handlerModule` reference declared in
 * `read.ts`.
 *
 * Closures can't cross thread boundaries; module exports can.
 */
export interface ReadInput {
  readonly file_path: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface ReadCtxLike {
  readonly cwd: string;
  /** Capability-mediated fs. Present when invoked under an isolator that
   *  brokers (`@moxxy/isolator-worker`); absent under `none` / `inproc`. */
  readonly fs?: BrokeredFs;
}

export async function readHandler(input: ReadInput, ctx: ReadCtxLike): Promise<string> {
  const { file_path, offset = 0, limit = 2000 } = input;
  const resolved = resolvePath(ctx.cwd, file_path);
  // Use the brokered fs when the isolator provides one. The broker
  // re-validates the path against the tool's declared `caps.fs.read`
  // on the parent side, so reads outside the cap are denied at the
  // boundary regardless of what's in the input. Without a broker
  // (inproc / none), fall back to direct `node:fs` — input-level
  // cap-check already screened the file_path.
  const text = ctx.fs
    ? await ctx.fs.readFile(resolved, { encoding: 'utf8' })
    : (await fs.readFile(resolved)).toString('utf8');
  const lines = text.split('\n');
  const sliced = lines.slice(offset, offset + limit);
  const numbered = sliced
    .map((line, i) => `${String(offset + i + 1).padStart(6, ' ')}\t${line}`)
    .join('\n');
  return clampString(numbered, 200_000);
}
