export const COMMAND_SESSION_ACTION_SUBTYPE = 'command.session_action' as const;
export const COMMAND_STATE_CHANGED_SUBTYPE = 'command.state_changed' as const;

export type CommandOriginChannel = 'tui' | 'office' | (string & {});
export type CommandTarget = 'session';

export interface CommandSyncBasePayload {
  readonly command: string;
  readonly target: CommandTarget;
  readonly origin_channel: CommandOriginChannel;
  readonly origin_id: string;
  readonly notice?: string;
}

export interface CommandSessionActionPayload extends CommandSyncBasePayload {
  readonly action: 'new';
}

export interface CommandStateChangedPayload extends CommandSyncBasePayload {
  readonly action: 'model_changed' | 'loop_changed';
  readonly provider?: string;
  readonly model?: string;
  readonly loop?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasBasePayload(value: Record<string, unknown>): boolean {
  return (
    typeof value.command === 'string' &&
    value.command.trim().length > 0 &&
    value.target === 'session' &&
    typeof value.origin_channel === 'string' &&
    value.origin_channel.trim().length > 0 &&
    typeof value.origin_id === 'string' &&
    value.origin_id.trim().length > 0 &&
    (value.notice === undefined || typeof value.notice === 'string')
  );
}

export function isCommandSessionActionPayload(
  value: unknown,
): value is CommandSessionActionPayload {
  const record = asRecord(value);
  return Boolean(record && hasBasePayload(record) && record.action === 'new');
}

export function isCommandStateChangedPayload(
  value: unknown,
): value is CommandStateChangedPayload {
  const record = asRecord(value);
  if (!record || !hasBasePayload(record)) return false;
  if (record.action === 'model_changed') {
    return (
      (record.provider === undefined || typeof record.provider === 'string') &&
      typeof record.model === 'string' &&
      record.model.trim().length > 0
    );
  }
  if (record.action === 'loop_changed') {
    return typeof record.loop === 'string' && record.loop.trim().length > 0;
  }
  return false;
}
