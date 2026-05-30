/** Normalize a thrown value to a human-readable string. Replaces the
 *  `e instanceof Error ? e.message : String(e)` incantation that was
 *  scattered across the renderer's catch blocks. */
export function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
