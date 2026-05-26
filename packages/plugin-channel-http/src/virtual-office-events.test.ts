import { describe, expect, it } from 'vitest';
import { asEventId, asPluginId, asSessionId, asTurnId, type MoxxyEvent } from '@moxxy/sdk';
import { eventToVirtualOfficeEnvelope } from './virtual-office-events.js';

describe('eventToVirtualOfficeEnvelope', () => {
  it('maps command session actions for Virtual Office clients', () => {
    const event: MoxxyEvent = {
      id: asEventId('evt-1'),
      seq: 3,
      ts: 123,
      sessionId: asSessionId('sess-1'),
      turnId: asTurnId('turn-1'),
      source: 'plugin',
      type: 'plugin_event',
      pluginId: asPluginId('@moxxy/plugin-commands'),
      subtype: 'command.session_action',
      payload: {
        command: '/new',
        action: 'new',
        target: 'session',
        origin_channel: 'tui',
        origin_id: 'tui-1',
      },
    };

    expect(eventToVirtualOfficeEnvelope(event)).toEqual({
      agent_id: 'session',
      run_id: 'turn-1',
      parent_run_id: null,
      sequence: 3,
      event_type: 'command.session_action',
      payload: {
        command: '/new',
        action: 'new',
        target: 'session',
        origin_channel: 'tui',
        origin_id: 'tui-1',
      },
      sensitive: false,
    });
  });
});
