import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from './tauri';

/**
 * Push-to-talk voice capture, transcription via the runner.
 *
 * Browsers (and Tauri webviews) expose `MediaRecorder` with `audio/webm`
 * on Chromium-family WebViews and `audio/mp4` on WebKit. We probe at
 * record start so the mime hint sent to the runner matches what the
 * blob actually contains.
 *
 * Lifecycle:
 *  - call `start()` → asks for the mic, opens a recorder, sets
 *    `state = "recording"`.
 *  - call `stop()` → flushes the recorder, base64-encodes the blob,
 *    sends to `transcribe` Tauri command, returns the resulting text.
 *    `state` transitions recording → transcribing → idle.
 *  - any failure (mic denied, runner offline, encoder hiccup) lands in
 *    `error` and `state` falls back to `idle`.
 *
 * MediaRecorder + getUserMedia are stubbed in test-setup.ts; tests can
 * replace MediaRecorder with a fixture that immediately emits a blob.
 */
export type VoiceState = 'idle' | 'recording' | 'transcribing';

export interface VoiceApi {
  readonly state: VoiceState;
  readonly error: string | null;
  readonly start: () => Promise<void>;
  /** Stop recording. Returns the transcribed text (or null on failure). */
  readonly stop: () => Promise<string | null>;
  readonly cancel: () => void;
}

interface TranscribeResult {
  text?: string;
}

const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
] as const;

function pickMimeType(): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const MR = (globalThis as any).MediaRecorder;
  if (typeof MR?.isTypeSupported !== 'function') return undefined;
  for (const t of PREFERRED_MIME_TYPES) {
    try {
      if (MR.isTypeSupported(t)) return t;
    } catch {
      /* fall through */
    }
  }
  return undefined;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  // Build the binary string in chunks so we don't blow the call-stack
  // budget on a long recording (charCodeAt apply has a per-call limit).
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function useVoiceRecorder(): VoiceApi {
  const [state, setState] = useState<VoiceState>('idle');
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string | undefined>(undefined);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  }, []);

  useEffect(() => {
    return () => {
      releaseStream();
    };
  }, [releaseStream]);

  const start = useCallback(async () => {
    if (state !== 'idle') return;
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'microphone unavailable');
      return;
    }
    const mime = pickMimeType();
    const recorder = mime
      ? new MediaRecorder(stream, { mimeType: mime })
      : new MediaRecorder(stream);
    chunksRef.current = [];
    mimeRef.current = mime;
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    streamRef.current = stream;
    recorderRef.current = recorder;
    recorder.start();
    setState('recording');
  }, [state]);

  const stop = useCallback(async (): Promise<string | null> => {
    const recorder = recorderRef.current;
    if (!recorder || state !== 'recording') return null;

    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => {
        const type = mimeRef.current ?? recorder.mimeType ?? 'audio/webm';
        resolve(new Blob(chunksRef.current, { type }));
      };
      recorder.stop();
    });
    releaseStream();
    setState('transcribing');

    try {
      const audio = await blobToBase64(blob);
      const result = await invoke<TranscribeResult>('transcribe', {
        audioB64: audio,
        mimeType: blob.type || mimeRef.current || null,
      });
      setState('idle');
      return typeof result?.text === 'string' ? result.text : null;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState('idle');
      return null;
    }
  }, [releaseStream, state]);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        /* ignore */
      }
    }
    releaseStream();
    setState('idle');
  }, [releaseStream]);

  return { state, error, start, stop, cancel };
}
