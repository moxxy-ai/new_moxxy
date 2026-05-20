/**
 * Transcribers convert audio bytes into text. They are a separate capability
 * from `LLMProvider` because (a) most providers (Anthropic today) do not yet
 * accept native audio, (b) users frequently want to pair a text provider with
 * a dedicated STT backend (Whisper, Deepgram, AssemblyAI, local whisper.cpp),
 * and (c) the same transcript may be used in many places — channels feeding
 * voice notes into a turn, skills processing recorded meetings, etc.
 *
 * Plugins register a `TranscriberDef` via `PluginSpec.transcribers`. The
 * core `TranscriberRegistry` holds them; channels call
 * `session.transcribers.getActive()` (or `.get(name)`) to use one.
 *
 * Audio input is represented in two places once a `Transcriber` is wired:
 *   - `UserPromptAttachment` with `kind: 'audio'` — channel-level handoff,
 *     consumed by the channel and either transcribed or sent through as a
 *     native audio block (provider-permitting).
 *   - `ContentBlock` with `type: 'audio'` — provider-level wire format, only
 *     used by models that advertise `supportsAudio: true`.
 */

export interface TranscriptionSegment {
  /** Segment start, in seconds from the start of the clip. */
  readonly start: number;
  /** Segment end, in seconds. */
  readonly end: number;
  readonly text: string;
  /** Optional speaker label when the backend supports diarization. */
  readonly speaker?: string;
}

export interface TranscriptionResult {
  /** Full concatenated transcript. */
  readonly text: string;
  /** BCP-47 language tag when the backend reports one (e.g. `en`, `pl`). */
  readonly language?: string;
  /** Clip length in seconds when known. */
  readonly durationSec?: number;
  /** Optional per-segment breakdown for richer downstream use. */
  readonly segments?: ReadonlyArray<TranscriptionSegment>;
}

export interface TranscribeOptions {
  /** MIME type of the audio bytes (e.g. `audio/ogg`, `audio/webm`). */
  readonly mimeType?: string;
  /** Hint the recognizer with a BCP-47 language tag. */
  readonly language?: string;
  /** Vocabulary / context hint passed to backends that support it (Whisper). */
  readonly prompt?: string;
  /** Cancellation signal — channels propagate the turn's abort here. */
  readonly signal?: AbortSignal;
}

export interface Transcriber {
  /** Short stable name, e.g. `openai-whisper-1`. */
  readonly name: string;
  transcribe(
    audio: Uint8Array | ArrayBuffer,
    opts?: TranscribeOptions,
  ): Promise<TranscriptionResult>;
}

/**
 * Plugin-side definition. Mirrors `ProviderDef`: a `createClient(config)`
 * factory the registry calls when the user activates this transcriber.
 */
export interface TranscriberDef {
  readonly name: string;
  /** Optional human-readable label for UI surfaces. */
  readonly displayName?: string;
  createClient(config: Record<string, unknown>): Transcriber;
}
