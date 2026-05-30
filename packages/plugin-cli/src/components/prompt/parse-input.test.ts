import { describe, expect, it, vi } from 'vitest';
import type { Action } from './reducer.js';
import { parseInputChunk, type ParseCtx } from './parse-input.js';

function makeCtx(overrides: Partial<ParseCtx> = {}): { ctx: ParseCtx; actions: Action[] } {
  const actions: Action[] = [];
  const ctx: ParseCtx = {
    inPaste: false,
    pasteAccum: { text: '' },
    dispatch: (action) => actions.push(action),
    onSubmit: () => undefined,
    onCancel: () => undefined,
    onSlashUp: () => undefined,
    onSlashDown: () => undefined,
    onSlashAccept: () => undefined,
    onExit: () => undefined,
    slashOpen: false,
    bufferRef: { current: { buffer: '', cursor: 0 } },
    ...overrides,
  };
  return { ctx, actions };
}

describe('parseInputChunk command hotkeys', () => {
  it('routes Ctrl+R to commandHotkeys.r without inserting text', () => {
    let called = 0;
    const { ctx, actions } = makeCtx({
      commandHotkeys: {
        r: () => {
          called += 1;
        },
      },
    });

    const remainder = parseInputChunk('\x12', ctx);

    expect(remainder).toBe('');
    expect(called).toBe(1);
    expect(actions).toEqual([]);
  });

  it('routes kitty-encoded Ctrl+R to commandHotkeys.r', () => {
    let called = 0;
    let cancelled = false;
    const { ctx, actions } = makeCtx({
      onCancel: () => {
        cancelled = true;
      },
      commandHotkeys: {
        r: () => {
          called += 1;
        },
      },
    });

    const remainder = parseInputChunk('\x1b[114;5u', ctx);

    expect(remainder).toBe('');
    expect(called).toBe(1);
    expect(cancelled).toBe(false);
    expect(actions).toEqual([]);
  });
});

describe('parseInputChunk exit handling', () => {
  it('routes Ctrl+C to onExit without terminating the process', () => {
    let exited = false;
    const processExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit should not be called');
    });
    const { ctx, actions } = makeCtx({
      onExit: () => {
        exited = true;
      },
    });

    try {
      const remainder = parseInputChunk('\x03', ctx);

      expect(remainder).toBe('');
      expect(exited).toBe(true);
      expect(actions).toEqual([]);
      expect(processExit).not.toHaveBeenCalled();
    } finally {
      processExit.mockRestore();
    }
  });
});
