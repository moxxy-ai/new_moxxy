import type { EventLogReader, MoxxyEvent } from '@moxxy/sdk';

interface BootScreenState {
  readonly hasSession: boolean;
  readonly initialPrompt: string | null;
  readonly resumed: boolean | undefined;
  readonly externalConversationStarted: boolean;
}

export function isConversationStartEvent(event: MoxxyEvent): boolean {
  return event.type === 'user_prompt';
}

export function hasConversationStarted(log: Pick<EventLogReader, 'ofType'>): boolean {
  return log.ofType('user_prompt').length > 0;
}

export function shouldShowBootScreen(state: BootScreenState): boolean {
  if (!state.hasSession) return true;
  return (
    state.initialPrompt == null &&
    !state.resumed &&
    !state.externalConversationStarted
  );
}
