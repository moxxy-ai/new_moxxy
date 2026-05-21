import { describe, expect, it } from 'vitest';
import { nextExternalInsertAction } from './external-insert.js';

describe('nextExternalInsertAction', () => {
  it('turns a new external insert into a reducer insert action', () => {
    expect(nextExternalInsertAction(null, { id: 1, text: 'transcript' })).toEqual({
      lastId: 1,
      action: { type: 'insert', text: 'transcript' },
    });
  });

  it('ignores the same insert id so React re-renders do not duplicate text', () => {
    expect(nextExternalInsertAction(1, { id: 1, text: 'again' })).toEqual({
      lastId: 1,
    });
  });
});
