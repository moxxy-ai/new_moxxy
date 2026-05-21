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

  it('exports requirement types through package root declarations', async () => {
    const requirement: import('@moxxy/sdk').MoxxyRequirement = {
      kind: 'runtime',
      name: 'auth:provider:openai-codex',
      state: 'ready',
    };
    const check: import('@moxxy/sdk').RequirementCheck = {
      ready: false,
      issues: [
        {
          requirement,
          code: 'not_ready',
          message: 'OAuth is not ready',
        },
      ],
    };

    expect(check.issues[0]?.requirement.name).toBe('auth:provider:openai-codex');
  });
});
