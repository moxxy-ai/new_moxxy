import type { ProviderEvent, StopReason } from '@moxxy/sdk';

export interface PendingFunctionCall {
  id: string;
  callId: string;
  name: string;
  args: string;
  emittedStart: boolean;
}

export interface ResponsesSseEvent {
  type?: string;
  delta?: string;
  item?: {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  item_id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  response?: {
    status?: string;
    incomplete_details?: { reason?: string };
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  error?: { message?: string };
}

export interface SseStepResult {
  events?: ProviderEvent[];
  stopReason?: StopReason;
  usage?: { input?: number; output?: number };
  terminal?: boolean;
}
