import React, { useEffect, useRef, useState } from 'react';
import type { MoxxyEvent, ClientSession as Session } from '@moxxy/sdk';

export interface EventStreamHandle {
  events: ReadonlyArray<MoxxyEvent>;
  setEvents: React.Dispatch<React.SetStateAction<ReadonlyArray<MoxxyEvent>>>;
  streamingDelta: string;
  setStreamingDelta: React.Dispatch<React.SetStateAction<string>>;
  streamingBufferRef: React.MutableRefObject<string>;
  /** Cancel any pending flush (used on /clear, /new, manual resets). */
  cancelStreamFlush: () => void;
}

/**
 * Subscribes to the session event log + throttles assistant_chunk
 * deltas. Some providers ship chunks 100×/s; without throttling each
 * one re-renders the entire markdown body. A ~30fps update cadence is
 * indistinguishable from chunk-frequency typing but keeps Ink's render
 * pipeline calm.
 */
export function useEventStream(session: Session): EventStreamHandle {
  const [events, setEvents] = useState<ReadonlyArray<MoxxyEvent>>([]);
  const [streamingDelta, setStreamingDelta] = useState('');
  const streamingBufferRef = useRef('');
  const streamFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleStreamFlush = React.useCallback(() => {
    if (streamFlushRef.current) return;
    streamFlushRef.current = setTimeout(() => {
      streamFlushRef.current = null;
      setStreamingDelta(streamingBufferRef.current);
    }, 33);
  }, []);

  const cancelStreamFlush = React.useCallback(() => {
    if (streamFlushRef.current) {
      clearTimeout(streamFlushRef.current);
      streamFlushRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      // Component unmount: cancel any pending streaming flush so we
      // don't try to setState on an unmounted tree.
      cancelStreamFlush();
    };
  }, [cancelStreamFlush]);

  useEffect(() => {
    const unsub = session.log.subscribe((event) => {
      // assistant_chunk events fire at provider-stream cadence (often
      // hundreds per turn). Don't push them into `events` — they render
      // to null in EventLine anyway, but every push triggers
      // `pairToolEvents` to re-walk the growing array (O(n²) over the
      // turn). The live buffer + throttled setState handles display.
      if (event.type === 'assistant_chunk') {
        streamingBufferRef.current += event.delta;
        scheduleStreamFlush();
        return;
      }
      setEvents((prev) => [...prev, event]);
      if (event.type === 'assistant_message') {
        // Cancel any pending flush — the message is in `events` now,
        // so leaving the streaming delta visible would double-render.
        cancelStreamFlush();
        streamingBufferRef.current = '';
        setStreamingDelta('');
      }
    });
    return unsub;
  }, [session, scheduleStreamFlush, cancelStreamFlush]);

  return {
    events,
    setEvents,
    streamingDelta,
    setStreamingDelta,
    streamingBufferRef,
    cancelStreamFlush,
  };
}
