import { describe, expect, it } from 'vitest';
import {
  COMMAND_SESSION_ACTION_SUBTYPE,
  COMMAND_STATE_CHANGED_SUBTYPE,
  isCommandSessionActionPayload,
  isCommandStateChangedPayload,
} from './command-sync.js';

describe('command sync contract', () => {
  it('accepts a global session action payload', () => {
    expect(
      isCommandSessionActionPayload({
        command: '/new',
        action: 'new',
        target: 'session',
        origin_channel: 'tui',
        origin_id: 'tui-1',
        notice: 'new session',
      }),
    ).toBe(true);
    expect(COMMAND_SESSION_ACTION_SUBTYPE).toBe('command.session_action');
  });

  it('rejects malformed session action payloads', () => {
    expect(
      isCommandSessionActionPayload({
        command: '/new',
        action: 'new',
        target: 'office_agent',
        origin_channel: 'office',
        origin_id: 'office-1',
      }),
    ).toBe(false);
    expect(
      isCommandSessionActionPayload({
        command: '/new',
        action: 'new',
        target: 'session',
        origin_channel: 'office',
      }),
    ).toBe(false);
  });

  it('accepts model and loop state change payloads', () => {
    expect(
      isCommandStateChangedPayload({
        command: '/model openai::gpt-test',
        action: 'model_changed',
        target: 'session',
        origin_channel: 'office',
        origin_id: 'office-1',
        provider: 'openai',
        model: 'gpt-test',
      }),
    ).toBe(true);
    expect(
      isCommandStateChangedPayload({
        command: '/loop tool-use',
        action: 'loop_changed',
        target: 'session',
        origin_channel: 'tui',
        origin_id: 'tui-1',
        loop: 'tool-use',
      }),
    ).toBe(true);
    expect(COMMAND_STATE_CHANGED_SUBTYPE).toBe('command.state_changed');
  });
});
