import { describe, expect, it } from 'vitest';
import {
  applescriptTool,
  clickTool,
  clipboardTool,
  keyTool,
  openTool,
  screenshotTool,
  typeTool,
} from './index.js';

describe('@moxxy/plugin-computer-control schemas', () => {
  it('screenshot accepts an optional region', () => {
    expect(screenshotTool.inputSchema.safeParse({}).success).toBe(true);
    expect(
      screenshotTool.inputSchema.safeParse({ region: { x: 0, y: 0, width: 100, height: 100 } })
        .success,
    ).toBe(true);
  });

  it('click requires x and y, count 1-3 only', () => {
    expect(clickTool.inputSchema.safeParse({ x: 100, y: 200 }).success).toBe(true);
    expect(clickTool.inputSchema.safeParse({ x: 100, y: 200, count: 2 }).success).toBe(true);
    expect(clickTool.inputSchema.safeParse({ x: 100, y: 200, count: 5 }).success).toBe(false);
    expect(clickTool.inputSchema.safeParse({ x: -1, y: 0 }).success).toBe(false);
  });

  it('type rejects oversize payloads', () => {
    expect(typeTool.inputSchema.safeParse({ text: 'hello' }).success).toBe(true);
    expect(typeTool.inputSchema.safeParse({ text: 'a'.repeat(5000) }).success).toBe(false);
  });

  it('key allows known modifier names and rejects unknown ones', () => {
    expect(keyTool.inputSchema.safeParse({ key: 'tab' }).success).toBe(true);
    expect(
      keyTool.inputSchema.safeParse({ key: 'a', modifiers: ['cmd', 'shift'] }).success,
    ).toBe(true);
    expect(
      keyTool.inputSchema.safeParse({ key: 'a', modifiers: ['windows'] }).success,
    ).toBe(false);
  });

  it('open requires target or app at runtime (not enforced by zod)', () => {
    // Both optional at schema level — runtime guard does the validation.
    expect(openTool.inputSchema.safeParse({ app: 'Safari' }).success).toBe(true);
    expect(openTool.inputSchema.safeParse({ target: '/tmp' }).success).toBe(true);
    expect(openTool.inputSchema.safeParse({}).success).toBe(true);
  });

  it('clipboard requires action enum', () => {
    expect(clipboardTool.inputSchema.safeParse({ action: 'read' }).success).toBe(true);
    expect(clipboardTool.inputSchema.safeParse({ action: 'write', text: 'x' }).success).toBe(true);
    expect(clipboardTool.inputSchema.safeParse({ action: 'paste' }).success).toBe(false);
  });

  it('applescript needs a non-empty script', () => {
    expect(applescriptTool.inputSchema.safeParse({ script: 'return 1' }).success).toBe(true);
    expect(applescriptTool.inputSchema.safeParse({ script: '' }).success).toBe(false);
  });

  it('every tool is permission:prompt — never auto-allowed', () => {
    const all = [
      screenshotTool,
      clickTool,
      typeTool,
      keyTool,
      openTool,
      clipboardTool,
      applescriptTool,
    ];
    for (const tool of all) {
      expect(tool.permission?.action).toBe('prompt');
    }
  });
});
