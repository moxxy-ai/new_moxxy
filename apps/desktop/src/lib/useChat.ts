import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { api } from './api';
import type { MoxxyEvent } from '@moxxy/sdk';
import { chatStore } from './chatStore';
import {
  chatReducer,
  initialChatState,
  type Block as ReducerBlock,
  type ChatAction as ReducerAction,
  type ChatState as ReducerState,
} from './chatReducer';

export type Block = ReducerBlock;
export type ChatAction = ReducerAction;
export type ChatState = ReducerState;

export interface UseChat {
  readonly blocks: ReadonlyArray<Block>;
  readonly activeTurnId: string | null;
  readonly sending: boolean;
  readonly error: string | null;
  readonly send: (prompt: string) => Promise<void>;
  readonly abort: () => Promise<void>;
  readonly clear: () => void;
}

// Test-only export of the pure reducer + initial state. Preserved so
// existing reducer tests keep working after the chatStore refactor.
// eslint-disable-next-line @typescript-eslint/naming-convention
export const __reducerForTest = {
  initial: () => initialChatState,
  apply: chatReducer,
};

/**
 * Bridge component — forwards `runner.event` / `runner.turn.complete`
 * from the main process into the workspace-keyed {@link chatStore}.
 * Mount once at the top of the tree.
 */
export function ChatStoreBridge(): null {
  useEffect(() => {
    const offEvent = api().subscribe(
      'runner.event',
      ({ workspaceId, event }: { workspaceId: string; event: MoxxyEvent }) => {
        chatStore.dispatch(workspaceId, { type: 'event', event });
      },
    );
    const offComplete = api().subscribe(
      'runner.turn.complete',
      ({
        workspaceId,
        turnId,
        error,
      }: {
        workspaceId: string;
        turnId: string;
        error: string | null;
      }) => {
        chatStore.dispatch(workspaceId, { type: 'turn_complete', turnId, error });
      },
    );
    return () => {
      offEvent();
      offComplete();
    };
  }, []);
  return null;
}

/**
 * Per-workspace chat handle. Send/abort/clear are bound to the
 * workspace so the UI can also target background workspaces (start
 * a follow-up turn in A while viewing B).
 */
export function useChat(workspaceId: string | null): UseChat {
  const state = useSyncExternalStore(chatStore.subscribe, () =>
    workspaceId ? chatStore.getChat(workspaceId) : initialChatState,
  );

  const send = useCallback(
    async (prompt: string): Promise<void> => {
      if (!workspaceId) return;
      const trimmed = prompt.trim();
      if (!trimmed) return;
      try {
        const { turnId } = await api().invoke('session.runTurn', {
          workspaceId,
          prompt: trimmed,
        });
        chatStore.dispatch(workspaceId, {
          type: 'send_started',
          turnId,
          prompt: trimmed,
        });
      } catch (e) {
        chatStore.dispatch(workspaceId, {
          type: 'send_failed',
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [workspaceId],
  );

  const abort = useCallback(async (): Promise<void> => {
    if (!workspaceId || !state.activeTurnId) return;
    try {
      await api().invoke('session.abortTurn', {
        workspaceId,
        turnId: state.activeTurnId,
      });
    } catch {
      /* best-effort */
    }
  }, [workspaceId, state.activeTurnId]);

  const clear = useCallback((): void => {
    if (!workspaceId) return;
    chatStore.dispatch(workspaceId, { type: 'clear' });
  }, [workspaceId]);

  return {
    blocks: state.blocks,
    activeTurnId: state.activeTurnId,
    sending: state.sending,
    error: state.error,
    send,
    abort,
    clear,
  };
}

/** Snapshot of workspace ids that currently carry unread activity. */
export function useUnreadWorkspaces(): ReadonlyArray<string> {
  return useSyncExternalStore(chatStore.subscribe, () =>
    chatStore.unreadWorkspaces(),
  );
}
