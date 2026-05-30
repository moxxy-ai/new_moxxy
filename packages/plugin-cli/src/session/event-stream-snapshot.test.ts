import { describe, expect, it } from 'vitest';
import { EventLog } from '@moxxy/core';
import { snapshotDisplayEvents } from './use-event-stream.js';

describe('snapshotDisplayEvents', () => {
  it('includes prompts that were appended before the TUI chat mounted', async () => {
    const log = new EventLog();
    await log.append({
      type: 'user_prompt',
      sessionId: 'session',
      turnId: 'turn',
      source: 'user',
      text: 'from office',
    });
    await log.append({
      type: 'assistant_chunk',
      sessionId: 'session',
      turnId: 'turn',
      source: 'model',
      delta: 'partial',
    });

    expect(snapshotDisplayEvents(log).map((event) => event.type)).toEqual(['user_prompt']);
  });
});
