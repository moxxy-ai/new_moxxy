import { randomUUID } from 'node:crypto';
import {
  asPluginId,
  type ClientSession as Session,
  type CommandSessionActionPayload,
  type CommandStateChangedPayload,
  type EmittedEvent,
  type MoxxyEvent,
  type TurnId,
} from '@moxxy/sdk';

const COMMAND_PLUGIN_ID = asPluginId('@moxxy/plugin-commands');
const COMMAND_SESSION_ACTION_SUBTYPE = 'command.session_action';
const COMMAND_STATE_CHANGED_SUBTYPE = 'command.state_changed';

export function createTuiCommandOriginId(): string {
  return `tui-${randomUUID()}`;
}

export async function appendCommandSessionAction(
  session: Session,
  payload: CommandSessionActionPayload,
): Promise<void> {
  const writable = writableSession(session);
  if (!writable) return;
  await writable.log.append({
    type: 'plugin_event',
    sessionId: writable.id,
    turnId: writable.startTurn().turnId,
    source: 'plugin',
    pluginId: COMMAND_PLUGIN_ID,
    subtype: COMMAND_SESSION_ACTION_SUBTYPE,
    payload,
  });
}

export async function appendCommandStateChanged(
  session: Session,
  payload: CommandStateChangedPayload,
): Promise<void> {
  const writable = writableSession(session);
  if (!writable) return;
  await writable.log.append({
    type: 'plugin_event',
    sessionId: writable.id,
    turnId: writable.startTurn().turnId,
    source: 'plugin',
    pluginId: COMMAND_PLUGIN_ID,
    subtype: COMMAND_STATE_CHANGED_SUBTYPE,
    payload,
  });
}

type WritableCommandSession = Session & {
  readonly log: Session['log'] & {
    append(event: EmittedEvent): Promise<MoxxyEvent>;
  };
  startTurn(): { turnId: TurnId };
};

function writableSession(session: Session): WritableCommandSession | null {
  const candidate = session as unknown as Partial<WritableCommandSession>;
  return typeof candidate.startTurn === 'function' &&
    typeof candidate.log?.append === 'function'
    ? candidate as WritableCommandSession
    : null;
}

export function getExternalCommandSessionAction(
  event: MoxxyEvent,
  ownOriginId: string,
): CommandSessionActionPayload | null {
  if (event.type !== 'plugin_event') return null;
  if (event.subtype !== COMMAND_SESSION_ACTION_SUBTYPE) return null;
  if (!isCommandSessionActionPayload(event.payload)) return null;
  return event.payload.origin_id === ownOriginId ? null : event.payload;
}

export function getExternalCommandStateChanged(
  event: MoxxyEvent,
  ownOriginId: string,
): CommandStateChangedPayload | null {
  if (event.type !== 'plugin_event') return null;
  if (event.subtype !== COMMAND_STATE_CHANGED_SUBTYPE) return null;
  if (!isCommandStateChangedPayload(event.payload)) return null;
  return event.payload.origin_id === ownOriginId ? null : event.payload;
}

function isCommandSessionActionPayload(value: unknown): value is CommandSessionActionPayload {
  return isCommandPayloadBase(value) && (value as Record<string, unknown>).action === 'new';
}

function isCommandStateChangedPayload(value: unknown): value is CommandStateChangedPayload {
  if (!isCommandPayloadBase(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.action === 'model_changed') return typeof record.model === 'string';
  if (record.action === 'loop_changed') return typeof record.loop === 'string';
  return false;
}

function isCommandPayloadBase(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.command === 'string' &&
    record.command.trim().length > 0 &&
    record.target === 'session' &&
    typeof record.origin_channel === 'string' &&
    record.origin_channel.trim().length > 0 &&
    typeof record.origin_id === 'string' &&
    record.origin_id.trim().length > 0
  );
}
