import OpenAI from 'openai';
import type { Transcriber, TranscribeOptions, TranscriptionResult } from '@moxxy/sdk';

export type WhisperModel = 'whisper-1' | 'gpt-4o-transcribe' | 'gpt-4o-mini-transcribe';

const DEFAULT_FILENAMES: Record<string, string> = {
  'audio/ogg': 'audio.ogg',
  'audio/opus': 'audio.opus',
  'audio/mpeg': 'audio.mp3',
  'audio/mp3': 'audio.mp3',
  'audio/wav': 'audio.wav',
  'audio/x-wav': 'audio.wav',
  'audio/webm': 'audio.webm',
  'audio/m4a': 'audio.m4a',
  'audio/mp4': 'audio.mp4',
  'audio/flac': 'audio.flac',
};

export interface WhisperTranscriberOptions {
  readonly apiKey?: string;
  readonly baseURL?: string;
  /** Defaults to `whisper-1`. */
  readonly model?: WhisperModel;
  /**
   * Default language hint (BCP-47). Overridden per-call by
   * `TranscribeOptions.language`. Omit to let Whisper auto-detect.
   */
  readonly language?: string;
  /** Inject a pre-built OpenAI client (tests pass a stub here). */
  readonly client?: OpenAI;
}

/**
 * `Transcriber` backed by OpenAI's audio.transcriptions endpoint
 * (Whisper-1 by default). Requests `verbose_json` so we can return
 * `language`, `durationSec`, and per-segment text without an extra call.
 *
 * Audio bytes come in as `Uint8Array | ArrayBuffer`; we wrap them in a
 * Node `File` for upload (Node 20.10+ provides File / Blob globals).
 */
export class WhisperTranscriber implements Transcriber {
  readonly name: string;
  private readonly client: OpenAI;
  private readonly model: WhisperModel;
  private readonly defaultLanguage: string | undefined;

  constructor(opts: WhisperTranscriberOptions = {}) {
    this.model = opts.model ?? 'whisper-1';
    this.name = `openai-${this.model}`;
    this.defaultLanguage = opts.language;
    this.client =
      opts.client ??
      new OpenAI({
        apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY,
        ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      });
  }

  async transcribe(
    audio: Uint8Array | ArrayBuffer,
    opts: TranscribeOptions = {},
  ): Promise<TranscriptionResult> {
    const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio);
    const mimeType = opts.mimeType ?? 'audio/ogg';
    const filename = DEFAULT_FILENAMES[mimeType] ?? 'audio.bin';
    // Node 20.10+ exposes File globally; the OpenAI SDK accepts it as
    // an `Uploadable`. Casting via `unknown` to satisfy the SDK's
    // `FileLike` overload without pulling in node:stream / openai/uploads.
    const file = new File([bytes], filename, { type: mimeType });
    const language = opts.language ?? this.defaultLanguage;
    // verbose_json is only supported by whisper-1; the gpt-4o family
    // returns plain JSON. Branch so callers get rich segments when
    // available, and a graceful text-only result when not.
    if (this.model === 'whisper-1') {
      const response = await this.client.audio.transcriptions.create({
        model: this.model,
        file,
        response_format: 'verbose_json',
        ...(language ? { language } : {}),
        ...(opts.prompt ? { prompt: opts.prompt } : {}),
      });
      // OpenAI verbose-json response: { text, language, duration, segments[] }
      const r = response as unknown as {
        text: string;
        language?: string;
        duration?: number;
        segments?: Array<{ start: number; end: number; text: string }>;
      };
      const result: {
        text: string;
        language?: string;
        durationSec?: number;
        segments?: Array<{ start: number; end: number; text: string }>;
      } = { text: r.text };
      if (r.language) result.language = r.language;
      if (typeof r.duration === 'number') result.durationSec = r.duration;
      if (r.segments) result.segments = r.segments.map((s) => ({ start: s.start, end: s.end, text: s.text }));
      return result;
    }
    const response = await this.client.audio.transcriptions.create({
      model: this.model,
      file,
      ...(language ? { language } : {}),
      ...(opts.prompt ? { prompt: opts.prompt } : {}),
    });
    return { text: (response as { text: string }).text };
  }
}

export function createWhisperTranscriber(opts: WhisperTranscriberOptions = {}): WhisperTranscriber {
  return new WhisperTranscriber(opts);
}
