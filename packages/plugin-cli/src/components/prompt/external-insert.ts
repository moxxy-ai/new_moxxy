import type { Action } from './reducer.js';

export interface ExternalInsert {
  readonly id: number;
  readonly text: string;
}

export interface ExternalInsertDecision {
  readonly lastId: number | null;
  readonly action?: Action;
}

export function nextExternalInsertAction(
  lastId: number | null,
  insert: ExternalInsert | undefined,
): ExternalInsertDecision {
  if (!insert) return { lastId };
  if (insert.id === lastId) return { lastId };
  return {
    lastId: insert.id,
    action: { type: 'insert', text: insert.text },
  };
}
