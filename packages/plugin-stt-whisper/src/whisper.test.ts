import { describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { WhisperTranscriber } from './whisper.js';
import { buildWhisperPlugin } from './index.js';

const fakeOpenAI = (impl: (req: unknown) => unknown): OpenAI =>
  ({
    audio: {
      transcriptions: {
        create: vi.fn(async (req: unknown) => impl(req)),
      },
    },
  }) as unknown as OpenAI;

describe('WhisperTranscriber', () => {
  it('returns text, language, duration, and segments from verbose_json', async () => {
    const client = fakeOpenAI(() => ({
      text: 'hello world',
      language: 'en',
      duration: 1.5,
      segments: [
        { start: 0, end: 1.5, text: 'hello world' },
      ],
    }));
    const t = new WhisperTranscriber({ client });
    const result = await t.transcribe(new Uint8Array([1, 2, 3]), { mimeType: 'audio/ogg' });
    expect(result.text).toBe('hello world');
    expect(result.language).toBe('en');
    expect(result.durationSec).toBe(1.5);
    expect(result.segments).toEqual([{ start: 0, end: 1.5, text: 'hello world' }]);
  });

  it('passes language hint + prompt to the OpenAI client', async () => {
    const create = vi.fn(async () => ({ text: 'cześć', language: 'pl', segments: [] }));
    const client = { audio: { transcriptions: { create } } } as unknown as OpenAI;
    const t = new WhisperTranscriber({ client, language: 'pl' });
    await t.transcribe(new Uint8Array(), { mimeType: 'audio/ogg', prompt: 'jargon-list' });
    const req = create.mock.calls[0]![0] as { language: string; prompt: string; response_format: string };
    expect(req.language).toBe('pl');
    expect(req.prompt).toBe('jargon-list');
    expect(req.response_format).toBe('verbose_json');
  });

  it('uses the per-call language over the default', async () => {
    const create = vi.fn(async () => ({ text: '' }));
    const client = { audio: { transcriptions: { create } } } as unknown as OpenAI;
    const t = new WhisperTranscriber({ client, language: 'pl' });
    await t.transcribe(new Uint8Array(), { language: 'en' });
    const req = create.mock.calls[0]![0] as { language: string };
    expect(req.language).toBe('en');
  });

  it('falls back to plain text on gpt-4o-transcribe (no verbose_json branch)', async () => {
    const create = vi.fn(async () => ({ text: 'plain' }));
    const client = { audio: { transcriptions: { create } } } as unknown as OpenAI;
    const t = new WhisperTranscriber({ client, model: 'gpt-4o-transcribe' });
    const out = await t.transcribe(new Uint8Array(), { mimeType: 'audio/wav' });
    expect(out.text).toBe('plain');
    const req = create.mock.calls[0]![0] as { response_format?: string };
    expect(req.response_format).toBeUndefined();
  });

  it('plugin registers a transcriber whose createClient yields the right name', () => {
    const plugin = buildWhisperPlugin({});
    expect(plugin.transcribers).toHaveLength(1);
    const def = plugin.transcribers![0]!;
    expect(def.name).toBe('openai-whisper-1');
    expect(def.displayName).toBe('OpenAI whisper-1');
    const inst = def.createClient({ apiKey: 'sk-test' });
    expect(inst.name).toBe('openai-whisper-1');
  });

  it('plugin honors a non-default model name', () => {
    const plugin = buildWhisperPlugin({ model: 'gpt-4o-mini-transcribe' });
    expect(plugin.transcribers![0]!.name).toBe('openai-gpt-4o-mini-transcribe');
  });
});
