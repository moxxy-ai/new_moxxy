let fallbackCounter = 0;

/**
 * Globally-unique block id. Uses the platform crypto
 * (`globalThis.crypto.randomUUID`, present in Node 19+ and every modern
 * renderer), falling back to a timestamp+counter only if crypto is
 * somehow unavailable. Stable, collision-free ids survive clear/hydrate
 * and never clash across workspaces — unlike the old `${kind}-${seq}`
 * scheme that reset whenever the per-chat counter did.
 */
export function newBlockId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  fallbackCounter += 1;
  return `blk-${Date.now().toString(36)}-${fallbackCounter.toString(36)}`;
}
