import { describe, expect, it } from 'vitest';
import { EventLog } from '@moxxy/core';
import { hasConversationStarted, shouldShowBootScreen } from './boot-gate.js';

describe('boot gate', () => {
  it('leaves the splash screen when another channel has already started the session', async () => {
    const log = new EventLog();

    await log.append({
      type: 'user_prompt',
      sessionId: 'session',
      turnId: 'turn',
      source: 'user',
      text: 'from office',
    });

    expect(hasConversationStarted(log)).toBe(true);
    expect(
      shouldShowBootScreen({
        hasSession: true,
        initialPrompt: null,
        resumed: false,
        externalConversationStarted: hasConversationStarted(log),
      }),
    ).toBe(false);
  });

  it('keeps the splash screen for a fresh session until a prompt exists', () => {
    const log = new EventLog();

    expect(hasConversationStarted(log)).toBe(false);
    expect(
      shouldShowBootScreen({
        hasSession: true,
        initialPrompt: null,
        resumed: false,
        externalConversationStarted: hasConversationStarted(log),
      }),
    ).toBe(true);
  });
});
