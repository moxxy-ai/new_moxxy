/**
 * Latest-line subscription for the mini-text preview. Reads the freshest
 * line from the chat store — live (still-streaming) assistant text wins,
 * otherwise the last committed assistant / user message — and memoises by
 * content so the preview only re-renders when the visible line changes.
 */

import { useSyncExternalStore } from 'react';
import type { MoxxyEvent } from '@moxxy/sdk';
import { chatStore } from '@/lib/chatStore';

// ---- Types ---------------------------------------------------------------

export interface LatestBlock {
  readonly who: 'user' | 'assistant';
  readonly text: string;
}

// ---- Snapshot reading ----------------------------------------------------

const latestBlockCache = new Map<string, { key: string; block: LatestBlock }>();

function readLatestBlock(workspaceId: string | null): LatestBlock | null {
  if (!workspaceId) return null;
  const snap = chatStore.getChat(workspaceId);
  // Live assistant text (still streaming) wins — it's the freshest line.
  const candidate = latestLineFromSnapshot(snap);
  if (!candidate) {
    if (latestBlockCache.has(workspaceId)) latestBlockCache.delete(workspaceId);
    return null;
  }
  const key = `${candidate.who}:${candidate.text.length}:${candidate.text.slice(0, 64)}`;
  const cached = latestBlockCache.get(workspaceId);
  if (cached?.key === key) return cached.block;
  latestBlockCache.set(workspaceId, { key, block: candidate });
  return candidate;
}

function latestLineFromSnapshot(snap: {
  readonly events: ReadonlyArray<MoxxyEvent>;
  readonly streamingText: string;
}): LatestBlock | null {
  if (snap.streamingText.trim()) return { who: 'assistant', text: snap.streamingText };
  for (let i = snap.events.length - 1; i >= 0; i--) {
    const e = snap.events[i]!;
    if (e.type === 'assistant_message' && e.content.trim()) {
      return { who: 'assistant', text: e.content };
    }
    if (e.type === 'user_prompt' && e.text.trim()) {
      return { who: 'user', text: e.text };
    }
  }
  return null;
}

// ---- Hook ----------------------------------------------------------------

export function useLatestBlock(workspaceId: string | null): LatestBlock | null {
  return useSyncExternalStore(chatStore.subscribe, () =>
    readLatestBlock(workspaceId),
  );
}
