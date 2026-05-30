import { describe, it, expect } from 'vitest';
import { toSpeakableText } from './speech';

describe('toSpeakableText', () => {
  it('strips heading markers but keeps the heading text', () => {
    expect(toSpeakableText('## Hello world')).toBe('Hello world.');
  });

  it('keeps link text and drops the URL', () => {
    expect(toSpeakableText('See [the docs](https://example.com) now')).toBe(
      'See the docs now.',
    );
  });

  it('unwraps inline code and emphasis', () => {
    expect(toSpeakableText('Run `npm test` to **verify** the *change*')).toBe(
      'Run npm test to verify the change.',
    );
  });

  it('collapses a fenced code block to a short aside', () => {
    const out = toSpeakableText('Before\n\n```ts\nconst x = 1;\n```\n\nAfter');
    expect(out).toBe('Before. (code block). After.');
  });

  it('strips list bullets and numbers', () => {
    expect(toSpeakableText('- one\n- two\n1. three')).toBe('one two three.');
  });

  it('keeps existing sentence punctuation across paragraphs', () => {
    expect(toSpeakableText('First para.\n\nSecond para.')).toBe(
      'First para. Second para.',
    );
  });

  it('leaves snake_case identifiers intact', () => {
    expect(toSpeakableText('call run_turn now')).toBe('call run_turn now.');
  });

  it('strips bare URLs so they are not read aloud', () => {
    expect(toSpeakableText('See https://example.com/x?y=1 for more')).toBe('See for more.');
    expect(toSpeakableText('visit www.example.com today')).toBe('visit today.');
  });
});
