import { describe, expect, it } from 'vitest';

describe('@moxxy/sdk package root', () => {
  it('exports defineTranscriber for workspace consumers', async () => {
    const sdk = await import('@moxxy/sdk');

    expect(typeof sdk.defineTranscriber).toBe('function');

    const def = sdk.defineTranscriber({
      name: 'package-root-transcriber',
      createClient: () => ({
        name: 'package-root-transcriber',
        transcribe: async () => ({ text: 'ok' }),
      }),
    });

    expect(def.name).toBe('package-root-transcriber');
    expect(Object.isFrozen(def)).toBe(true);
  });
});
