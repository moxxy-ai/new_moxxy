import { describe, expect, it } from 'vitest';
import { asEventId, asSessionId, asTurnId, type MoxxyEvent } from '@moxxy/sdk';
import { collapseBlankLines, formatCompactionEvent } from './EventLine.js';

describe('formatCompactionEvent', () => {
  it('renders a compact, readable compaction summary', () => {
    const event = {
      id: asEventId('e1'),
      seq: 10,
      ts: 1,
      type: 'compaction',
      sessionId: asSessionId('s1'),
      turnId: asTurnId('t1'),
      source: 'compactor',
      compactor: 'summarize-old-turns',
      replacedRange: [0, 10_526],
      summary: 'old summary',
      tokensSaved: 315_810,
    } satisfies MoxxyEvent;

    expect(formatCompactionEvent(event)).toBe(
      'context compacted · 10,527 events · ~315.8k tokens saved',
    );
  });
});

describe('collapseBlankLines', () => {
  it('keeps single line breaks intact', () => {
    expect(collapseBlankLines('one\ntwo\nthree')).toBe('one\ntwo\nthree');
  });

  it('collapses consecutive newlines (paragraph breaks) to one', () => {
    expect(collapseBlankLines('one\n\ntwo')).toBe('one\ntwo');
    expect(collapseBlankLines('one\n\n\n\ntwo')).toBe('one\ntwo');
  });

  it('treats whitespace-only blank lines as blank', () => {
    expect(collapseBlankLines('one\n  \ntwo')).toBe('one\ntwo');
    expect(collapseBlankLines('one\n\t\ntwo')).toBe('one\ntwo');
  });

  it('trims leading and trailing whitespace', () => {
    expect(collapseBlankLines('\n\nhello\n\n')).toBe('hello');
    expect(collapseBlankLines('  hello  ')).toBe('hello');
  });

  it('leaves plain text unchanged', () => {
    expect(collapseBlankLines('hello world')).toBe('hello world');
  });
});
