import { describe, expect, it } from 'vitest';
import { buildPromptPlaceholder } from './InteractiveZone.js';

describe('buildPromptPlaceholder', () => {
  it('mentions Ctrl+R voice input in the idle prompt hint', () => {
    expect(buildPromptPlaceholder(false, true)).toContain('Ctrl+R voice');
  });

  it('hides Ctrl+R voice input when voice requirements are not ready', () => {
    expect(buildPromptPlaceholder(false, false)).not.toContain('Ctrl+R voice');
  });

  it('keeps the queue hint focused while a turn is busy', () => {
    expect(buildPromptPlaceholder(true, true)).toContain('type to queue a message');
  });
});
