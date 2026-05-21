import { useCallback, useRef, useState } from 'react';
import type { Session } from '@moxxy/core';
import type { Transcriber } from '@moxxy/sdk';
import type { ExternalInsert } from '../components/prompt/external-insert.js';
import {
  startVoiceRecording,
  type ActiveVoiceRecording,
  type StartVoiceRecordingOptions,
} from '../voice-input.js';

const CODEX_TRANSCRIBER_NAME = 'openai-codex-transcribe';
const MOXXY_PCM16_24KHZ_MIME = 'audio/x-moxxy-pcm16-24khz';

export interface UseVoiceInputOptions {
  readonly session: Session;
  readonly setSystemNotice: (notice: string | null) => void;
  readonly startRecording?: (opts?: StartVoiceRecordingOptions) => Promise<ActiveVoiceRecording>;
}

export interface VoiceInputState {
  readonly externalInsert?: ExternalInsert;
  readonly toggleVoiceInput: () => void;
}

type VoicePhase = 'idle' | 'recording' | 'transcribing';

export function useVoiceInput(opts: UseVoiceInputOptions): VoiceInputState {
  const { session, setSystemNotice } = opts;
  const startRecording = opts.startRecording ?? startVoiceRecording;
  const phaseRef = useRef<VoicePhase>('idle');
  const recordingRef = useRef<ActiveVoiceRecording | null>(null);
  const insertIdRef = useRef(0);
  const [externalInsert, setExternalInsert] = useState<ExternalInsert | undefined>();

  const toggleVoiceInput = useCallback(() => {
    void (async () => {
      if (phaseRef.current === 'transcribing') {
        setSystemNotice('voice: transcription is still running');
        return;
      }

      if (phaseRef.current === 'recording') {
        const recording = recordingRef.current;
        recordingRef.current = null;
        phaseRef.current = 'transcribing';
        setSystemNotice('voice: transcribing...');
        try {
          if (!recording) throw new Error('voice recorder is not running');
          const pcm = await recording.stop();
          const transcriber = resolveTranscriber(session);
          const result = await transcriber.transcribe(pcm, {
            mimeType: MOXXY_PCM16_24KHZ_MIME,
          });
          const text = result.text.trim();
          if (!text) {
            setSystemNotice('voice: empty transcript');
            return;
          }
          const id = insertIdRef.current + 1;
          insertIdRef.current = id;
          setExternalInsert({ id, text });
          setSystemNotice('voice: transcript inserted');
        } catch (err) {
          setSystemNotice(formatVoiceError(err));
        } finally {
          phaseRef.current = 'idle';
        }
        return;
      }

      try {
        recordingRef.current = await startRecording();
        phaseRef.current = 'recording';
        setSystemNotice('voice: recording, press Ctrl+R to stop');
      } catch (err) {
        recordingRef.current = null;
        phaseRef.current = 'idle';
        setSystemNotice(formatVoiceError(err));
      }
    })();
  }, [session, setSystemNotice, startRecording]);

  return { externalInsert, toggleVoiceInput };
}

function resolveTranscriber(session: Session): Transcriber {
  const active = session.transcribers.tryGetActive();
  if (active) return active;
  if (session.transcribers.has(CODEX_TRANSCRIBER_NAME)) {
    return session.transcribers.setActive(CODEX_TRANSCRIBER_NAME);
  }
  throw new Error(
    `No speech-to-text backend is registered. Run \`moxxy login openai-codex\` and restart with the Codex STT plugin enabled.`,
  );
}

function formatVoiceError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/ffmpeg/i.test(message)) return `voice: ${message}`;
  if (/openai-codex|OAuth|credentials|login/i.test(message)) return `voice: ${message}`;
  return `voice: ${message || 'failed'}`;
}
