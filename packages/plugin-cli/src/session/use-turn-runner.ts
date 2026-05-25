import { useRef, useState } from 'react';
import type React from 'react';
import type { ClientSession as Session, UserPromptAttachment } from '@moxxy/sdk';
import type { EventStreamHandle } from './use-event-stream.js';

export interface QueuedMessage {
  text: string;
  attachments: UserPromptAttachment[];
}

export interface TurnRunnerOptions {
  session: Session;
  /** Resolved model id at turn-start time (override > prop > default). */
  resolveModel: () => string | undefined;
  stream: EventStreamHandle;
}

export interface TurnRunnerHandle {
  busy: boolean;
  busyRef: React.MutableRefObject<boolean>;
  busyStartedAt: number | null;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  setBusyStartedAt: React.Dispatch<React.SetStateAction<number | null>>;
  queueRef: React.MutableRefObject<QueuedMessage[]>;
  queueCount: number;
  setQueueCount: React.Dispatch<React.SetStateAction<number>>;
  turnControllerRef: React.MutableRefObject<AbortController | null>;
  runTurnWith: (text: string, attachments: UserPromptAttachment[]) => Promise<void>;
  /** Single-slot "next-up" message. When set, drain logic runs it ALONE
   *  before merging the rest of the queue. Surfaced as state so the UI
   *  can render it distinctly. */
  priorityMessage: QueuedMessage | null;
  /** Pop the head of the queue and mark it as the priority next-turn.
   *  No-op when the queue is empty. Returns whether anything moved. */
  forceSendFirst: () => boolean;
  /** Remove the head of the queue without running it. */
  dropFirst: () => boolean;
}

export function useTurnRunner(opts: TurnRunnerOptions): TurnRunnerHandle {
  const [busy, setBusy] = useState(false);
  // Wall-clock start of the active turn (epoch ms). Powers the spinner +
  // elapsed-time readout in the status bar. `null` between turns.
  const [busyStartedAt, setBusyStartedAt] = useState<number | null>(null);
  const queueRef = useRef<QueuedMessage[]>([]);
  const [queueCount, setQueueCount] = useState(0);
  // Single "send this next, alone" slot. Held in state (not just a ref)
  // so the QueueView re-renders when the user force-sends.
  const [priorityMessage, setPriorityMessage] = useState<QueuedMessage | null>(null);
  const busyRef = useRef(false);
  // Per-turn abort controller. Esc while busy aborts THIS turn without
  // poisoning the session's own controller, so the next prompt still
  // runs normally.
  const turnControllerRef = useRef<AbortController | null>(null);

  const runTurnWith = async (text: string, attachments: UserPromptAttachment[]): Promise<void> => {
    setBusy(true);
    busyRef.current = true;
    setBusyStartedAt(Date.now());
    opts.stream.cancelStreamFlush();
    opts.stream.streamingBufferRef.current = '';
    opts.stream.setStreamingDelta('');
    const effectiveModel = opts.resolveModel();
    // Fresh controller per turn so Esc cancels just this turn, not the
    // session.
    const controller = new AbortController();
    turnControllerRef.current = controller;
    try {
      for await (const _event of opts.session.runTurn(text, {
        ...(effectiveModel ? { model: effectiveModel } : {}),
        signal: controller.signal,
        ...(attachments.length > 0 ? { attachments } : {}),
      })) {
        void _event;
      }
    } catch (err) {
      // surfaced via error events; nothing extra to do
      void err;
    } finally {
      turnControllerRef.current = null;
      setBusy(false);
      busyRef.current = false;
      setBusyStartedAt(null);
      // Drain order:
      //   1. Priority slot (force-sent) runs ALONE so the user can land
      //      a single targeted follow-up without it merging with whatever
      //      else they typed.
      //   2. Remaining queue concatenates into one follow-up turn — the
      //      model sees accumulated input as one coherent prompt rather
      //      than N micro-turns.
      if (priorityMessage) {
        const p = priorityMessage;
        setPriorityMessage(null);
        await runTurnWith(p.text, p.attachments);
        return;
      }
      if (queueRef.current.length > 0) {
        const batch = queueRef.current.splice(0);
        setQueueCount(0);
        const joinedText = batch.map((b) => b.text).join('\n\n');
        const joinedAtts = batch.flatMap((b) => b.attachments);
        await runTurnWith(joinedText, joinedAtts);
      }
    }
  };

  const forceSendFirst = (): boolean => {
    if (queueRef.current.length === 0) return false;
    const first = queueRef.current.shift()!;
    setQueueCount(queueRef.current.length);
    setPriorityMessage(first);
    return true;
  };

  const dropFirst = (): boolean => {
    if (queueRef.current.length === 0) return false;
    queueRef.current.shift();
    setQueueCount(queueRef.current.length);
    return true;
  };

  return {
    busy,
    busyRef,
    busyStartedAt,
    setBusy,
    setBusyStartedAt,
    queueRef,
    queueCount,
    setQueueCount,
    turnControllerRef,
    runTurnWith,
    priorityMessage,
    forceSendFirst,
    dropFirst,
  };
}
