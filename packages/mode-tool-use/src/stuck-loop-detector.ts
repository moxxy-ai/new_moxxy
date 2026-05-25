/**
 * Sliding-window detector for "model keeps making the same tool call".
 *
 * When the same `(toolName, input)` pair appears `repeatThreshold` times in
 * the last `windowSize` calls, the model is almost certainly stuck —
 * polling a tool that returns the same thing, mis-handling an error, etc.
 * Bail early instead of burning through the iteration cap.
 */
export interface StuckLoopDetector {
  readonly windowSize: number;
  readonly repeatThreshold: number;
  /** Record the call. Returns the number of identical calls in the window. */
  record(toolName: string, input: unknown): number;
}

export function createStuckLoopDetector(
  opts: { windowSize?: number; repeatThreshold?: number } = {},
): StuckLoopDetector {
  const windowSize = opts.windowSize ?? 8;
  const repeatThreshold = opts.repeatThreshold ?? 3;
  const recent: string[] = [];
  return {
    windowSize,
    repeatThreshold,
    record(toolName, input) {
      const key = `${toolName}|${stableHash(input)}`;
      recent.push(key);
      if (recent.length > windowSize) recent.shift();
      return recent.filter((k) => k === key).length;
    },
  };
}

/**
 * Stable JSON-ish hash of a tool call's input. Key order is canonicalised
 * so {a:1,b:2} and {b:2,a:1} produce the same key.
 */
export function stableHash(input: unknown): string {
  return canonicalize(input);
}

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalize(v)).join(',') + '}';
}
