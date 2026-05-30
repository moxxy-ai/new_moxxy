/**
 * Renderer-side chat store — public entry point.
 *
 * The implementation is decomposed under `./chat-store/`:
 *   - `chat-store/state.ts`  — the {@link ChatSnapshot} view + internal slot
 *                              types, empty defaults, and snapshot builder.
 *   - `chat-store/usage.ts`  — provider_response token accounting
 *                              ({@link UsageSnapshot}).
 *   - `chat-store/store.ts`  — the `ChatStore` class + the {@link chatStore}
 *                              singleton.
 *
 * This module re-exports the same public surface consumers have always
 * imported from `./chatStore`, so it stays a stable barrel.
 */

export { chatStore } from './chat-store/store';
export { EMPTY_SNAPSHOT, type ChatSnapshot, type QueuedTurn } from './chat-store/state';
export { EMPTY_USAGE, type UsageSnapshot } from './chat-store/usage';
