/**
 * Shared polling primitive for OAuth-style "ask again later" modes. Handles
 * the gnarly bits — deadline math, abort-responsive sleep, interval bumps
 * for `slow_down`-style backpressure — so each device-flow dialect only has
 * to encode its HTTP shape, not the timing harness.
 *
 * Consumed by both `runDeviceCodeFlow` (RFC 8628) and the Codex device flow
 * (non-standard OpenAI endpoints). The polling fn returns `{done}` to finish
 * or `{pending}` to keep going, and may mutate `state.intervalMs` mid-flight
 * to apply a `slow_down` bump.
 */

export interface PollState {
  /** Mutable so the polling fn can bump on `slow_down`. */
  intervalMs: number;
}

export type PollOutcome<T> = { done: T } | { pending: true };

export interface PollUntilOpts {
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /**
   * Wait BEFORE the first call. RFC 8628 says clients SHOULD wait `interval`
   * before the first poll; some flows (e.g. Codex) poll immediately. Default
   * true to match the more conservative RFC behavior.
   */
  readonly leadingWait?: boolean;
  /** Used in timeout / abort error messages. */
  readonly label?: string;
}

export async function pollUntil<T>(
  fn: (state: PollState) => Promise<PollOutcome<T>>,
  opts: PollUntilOpts,
): Promise<T> {
  const state: PollState = { intervalMs: opts.intervalMs };
  const leadingWait = opts.leadingWait ?? true;
  const deadline = Date.now() + opts.timeoutMs;
  const label = opts.label ?? 'poll';

  let first = true;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error(`${label} aborted`);
    if (!first || leadingWait) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(state.intervalMs, remaining), opts.signal);
    }
    first = false;
    const result = await fn(state);
    if ('done' in result) return result.done;
  }
  throw new Error(`${label} timed out waiting for completion`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
