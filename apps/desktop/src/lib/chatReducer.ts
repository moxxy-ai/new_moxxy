/**
 * Pure reducer for chat state. Lives in its own module so the
 * renderer store (`chatStore`) and the `useChat` hook can both import
 * it without a cycle. Kept React-free so reducer tests can drive it
 * directly.
 */

import type { MoxxyEvent } from '@moxxy/sdk';

export type Block =
  | { kind: 'user'; id: string; text: string }
  | {
      kind: 'assistant';
      id: string;
      text: string;
      streaming: boolean;
      stopReason?: string;
    }
  | {
      kind: 'tool';
      id: string;
      callId: string;
      name: string;
      input: unknown;
      status: 'running' | 'ok' | 'error';
      output?: unknown;
      error?: string;
    }
  /** A skill activation. Carries enough structure for the Transcript
   *  to group the surrounding load_skill tool + subsequent tool calls
   *  under one SkillGroupView. Rendered as a fallback compact system
   *  note when the grouping logic can't pair it with anything. */
  | { kind: 'skill_marker'; id: string; name: string; reason: string }
  | { kind: 'system'; id: string; text: string; tone: 'info' | 'error' };

export interface ChatState {
  blocks: Block[];
  activeTurnId: string | null;
  sending: boolean;
  error: string | null;
  /** Auto-incrementing counter so block ids don't collide on rapid
   *  events with the same turn id. */
  seq: number;
}

export const initialChatState: ChatState = {
  blocks: [],
  activeTurnId: null,
  sending: false,
  error: null,
  seq: 0,
};

export type ChatAction =
  | { type: 'event'; event: MoxxyEvent }
  | { type: 'send_started'; turnId: string; prompt: string }
  | { type: 'send_failed'; message: string }
  | { type: 'turn_complete'; turnId: string; error: string | null }
  /** Surface the result of a slash command (text / error / notice)
   *  alongside the user's command line as system blocks. */
  | { type: 'command_invoked'; commandLine: string }
  | { type: 'command_result'; text: string; tone: 'info' | 'error' }
  | { type: 'clear' };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'clear':
      return { ...initialChatState };
    case 'send_started': {
      const block: Block = {
        kind: 'user',
        id: `u-${state.seq}`,
        text: action.prompt,
      };
      return {
        ...state,
        sending: true,
        error: null,
        activeTurnId: action.turnId,
        blocks: [...state.blocks, block],
        seq: state.seq + 1,
      };
    }
    case 'send_failed':
      return { ...state, sending: false, error: action.message };
    case 'command_invoked': {
      // Render the command line as a user-style block so the chat
      // shows what was run. Mono-ish styling happens in the view.
      const block: Block = {
        kind: 'user',
        id: `u-${state.seq}`,
        text: action.commandLine,
      };
      return { ...state, blocks: [...state.blocks, block], seq: state.seq + 1 };
    }
    case 'command_result': {
      if (!action.text.trim()) return state;
      const block: Block = {
        kind: 'system',
        id: `s-${state.seq}`,
        text: action.text,
        tone: action.tone,
      };
      return { ...state, blocks: [...state.blocks, block], seq: state.seq + 1 };
    }
    case 'turn_complete': {
      const next = closeStreamingAssistant(state.blocks);
      return {
        ...state,
        sending: false,
        activeTurnId: null,
        blocks: action.error
          ? [
              ...next,
              {
                kind: 'system',
                id: `s-${state.seq}`,
                text: action.error,
                tone: 'error',
              },
            ]
          : next,
        seq: state.seq + 1,
      };
    }
    case 'event':
      return apply(state, action.event);
    default:
      return state;
  }
}

function closeStreamingAssistant(blocks: Block[]): Block[] {
  return blocks.map((b) =>
    b.kind === 'assistant' && b.streaming ? { ...b, streaming: false } : b,
  );
}

function apply(state: ChatState, event: MoxxyEvent): ChatState {
  switch (event.type) {
    case 'user_prompt':
      return state;
    case 'assistant_chunk': {
      const last = state.blocks[state.blocks.length - 1];
      if (last && last.kind === 'assistant' && last.streaming) {
        const updated: Block = {
          ...last,
          text: last.text + event.delta,
        };
        return { ...state, blocks: [...state.blocks.slice(0, -1), updated] };
      }
      const block: Block = {
        kind: 'assistant',
        id: `a-${state.seq}`,
        text: event.delta,
        streaming: true,
      };
      return {
        ...state,
        blocks: [...state.blocks, block],
        seq: state.seq + 1,
      };
    }
    case 'assistant_message': {
      const last = state.blocks[state.blocks.length - 1];
      if (last && last.kind === 'assistant' && last.streaming) {
        const updated: Block = {
          ...last,
          text: event.content,
          streaming: false,
          stopReason: event.stopReason,
        };
        return { ...state, blocks: [...state.blocks.slice(0, -1), updated] };
      }
      const block: Block = {
        kind: 'assistant',
        id: `a-${state.seq}`,
        text: event.content,
        streaming: false,
        stopReason: event.stopReason,
      };
      return {
        ...state,
        blocks: [...state.blocks, block],
        seq: state.seq + 1,
      };
    }
    case 'tool_call_requested': {
      const block: Block = {
        kind: 'tool',
        id: `t-${state.seq}`,
        callId: event.callId,
        name: event.name,
        input: event.input,
        status: 'running',
      };
      return {
        ...state,
        blocks: [...state.blocks, block],
        seq: state.seq + 1,
      };
    }
    case 'tool_result': {
      const next = state.blocks.map((b) =>
        b.kind === 'tool' && b.callId === event.callId
          ? {
              ...b,
              status: event.ok ? ('ok' as const) : ('error' as const),
              ...(event.output !== undefined ? { output: event.output } : {}),
              ...(event.error?.message ? { error: event.error.message } : {}),
            }
          : b,
      );
      return { ...state, blocks: next };
    }
    case 'tool_call_denied': {
      const next = state.blocks.map((b) =>
        b.kind === 'tool' && b.callId === event.callId
          ? { ...b, status: 'error' as const, error: event.reason }
          : b,
      );
      return { ...state, blocks: next };
    }
    case 'skill_invoked': {
      const block: Block = {
        kind: 'skill_marker',
        id: `sk-${state.seq}`,
        name: event.name,
        reason: event.reason,
      };
      return {
        ...state,
        blocks: [...state.blocks, block],
        seq: state.seq + 1,
      };
    }
    case 'error': {
      const block: Block = {
        kind: 'system',
        id: `s-${state.seq}`,
        text: event.message,
        tone: 'error',
      };
      return {
        ...state,
        blocks: [...state.blocks, block],
        seq: state.seq + 1,
      };
    }
    case 'abort': {
      const next = closeStreamingAssistant(state.blocks);
      return {
        ...state,
        blocks: [
          ...next,
          {
            kind: 'system',
            id: `s-${state.seq}`,
            text: `aborted: ${event.reason}`,
            tone: 'info',
          },
        ],
        seq: state.seq + 1,
      };
    }
    default:
      return state;
  }
}
