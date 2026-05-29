import OpenAI, { APIError, APIConnectionError, APIUserAbortError } from 'openai';
import {
  classifyHttpStatus,
  classifyNetworkError,
  MoxxyError,
  type Transcriber,
  type TranscribeOptions,
  type TranscriptionResult,
} from '@moxxy/sdk';

export type WhisperModel = 'whisper-1' | 'gpt-4o-transcribe' | 'gpt-4o-mini-transcribe';

/** Provider tag attached to classified errors for logs/debug context. */
const WHISPER_PROVIDER_ID = 'openai';

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
      const response = await this.run(() =>
        this.client.audio.transcriptions.create(
          {
            model: this.model,
            file,
            response_format: 'verbose_json',
            ...(language ? { language } : {}),
            ...(opts.prompt ? { prompt: opts.prompt } : {}),
          },
          { signal: opts.signal },
        ),
      );
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
    const response = await this.run(() =>
      this.client.audio.transcriptions.create(
        {
          model: this.model,
          file,
          ...(language ? { language } : {}),
          ...(opts.prompt ? { prompt: opts.prompt } : {}),
        },
        { signal: opts.signal },
      ),
    );
    return { text: (response as { text: string }).text };
  }

  /**
   * Run an SDK transcription call, translating failures into structured
   * `MoxxyError`s (network vs. HTTP status) to match the codex sibling.
   * User aborts re-throw unchanged so cancellation isn't masked as an error.
   */
  private async run<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      // Intentional cancellation: propagate as-is so callers see the abort.
      if (err instanceof APIUserAbortError) throw err;
      const ctx = { provider: WHISPER_PROVIDER_ID, url: this.client.baseURL };
      if (err instanceof APIConnectionError) {
        const network = classifyNetworkError(err.cause ?? err, ctx);
        if (network) throw network;
      }
      if (err instanceof APIError && typeof err.status === 'number') {
        const classified = classifyHttpStatus(err.status, { ...ctx, body: err.message });
        if (classified) throw classified;
        throw new MoxxyError({
          code: 'PROVIDER_BAD_REQUEST',
          message: `OpenAI transcription returned HTTP ${err.status}.`,
          context: { ...ctx, status: err.status },
          cause: err,
        });
      }
      const network = classifyNetworkError(err, ctx);
      if (network) throw network;
      throw err;
    }
  }
}

export function createWhisperTranscriber(opts: WhisperTranscriberOptions = {}): WhisperTranscriber {
  return new WhisperTranscriber(opts);
}
