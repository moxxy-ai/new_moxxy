import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientSession as Session } from '@moxxy/sdk';
import { getInstallHint, type RequirementCheck } from '@moxxy/sdk';
import {
  CODEX_TRANSCRIBER_NAME,
  checkCodexTranscriptionReady,
  resolveCodexTranscriber,
} from '@moxxy/core';
import type { ExternalInsert } from '../components/prompt/external-insert.js';
import {
  startVoiceRecording,
  checkVoiceCaptureAvailable,
  unavailableVoiceCaptureCheck,
  VOICE_CAPTURE_RUNTIME,
  type ActiveVoiceRecording,
  type StartVoiceRecordingOptions,
} from '../voice-input.js';

const MOXXY_PCM16_24KHZ_MIME = 'audio/x-moxxy-pcm16-24khz';

export const checkCodexVoiceInputReady = checkCodexTranscriptionReady;
export { resolveCodexTranscriber };

export interface UseVoiceInputOptions {
  readonly session: Session;
  readonly setSystemNotice: (notice: string | null) => void;
  readonly startRecording?: (opts?: StartVoiceRecordingOptions) => Promise<ActiveVoiceRecording>;
  readonly checkCaptureAvailable?: () => Promise<RequirementCheck>;
}

export type VoicePhase = 'idle' | 'recording' | 'transcribing';

export interface VoiceInputState {
  readonly externalInsert?: ExternalInsert;
  readonly ready: boolean;
  /**
   * Current recording phase. Surfaced so the prompt area can render a
   * visible badge ('● REC' / 'TRANSCRIBING') without having to mirror
   * the internal `phaseRef`.
   */
  readonly phase: VoicePhase;
  readonly toggleVoiceInput: () => void;
}

export function useVoiceInput(opts: UseVoiceInputOptions): VoiceInputState {
  const { session, setSystemNotice } = opts;
  const startRecording = opts.startRecording ?? startVoiceRecording;
  const checkCaptureAvailable = opts.checkCaptureAvailable ?? checkVoiceCaptureAvailable;
  const phaseRef = useRef<VoicePhase>('idle');
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const setVoicePhase = useCallback((next: VoicePhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);
  const recordingRef = useRef<ActiveVoiceRecording | null>(null);
  const insertIdRef = useRef(0);
  const [externalInsert, setExternalInsert] = useState<ExternalInsert | undefined>();
  const [captureReadiness, setCaptureReadiness] = useState<RequirementCheck>(() =>
    unavailableVoiceCaptureCheck(),
  );
  const readiness = combineVoiceInputReadiness(checkCodexVoiceInputReady(session), captureReadiness);
  const ready = readiness.ready;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await checkCaptureAvailable();
        if (!cancelled) setCaptureReadiness(next);
      } catch {
        if (!cancelled) setCaptureReadiness(unavailableVoiceCaptureCheck());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [checkCaptureAvailable]);

  const toggleVoiceInput = useCallback(() => {
    void (async () => {
      if (phaseRef.current === 'transcribing') {
        setSystemNotice('voice: transcription is still running');
        return;
      }

      if (phaseRef.current === 'recording') {
        const recording = recordingRef.current;
        recordingRef.current = null;
        setVoicePhase('transcribing');
        setSystemNotice('voice: transcribing...');
        try {
          if (!recording) throw new Error('voice recorder is not running');
          const pcm = await recording.stop();
          const transcriber = resolveCodexTranscriber(session);
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
          setVoicePhase('idle');
        }
        return;
      }

      try {
        const readiness = combineVoiceInputReadiness(
          checkCodexVoiceInputReady(session),
          captureReadiness,
        );
        if (!readiness.ready) {
          setSystemNotice(formatVoiceReadinessNotice(readiness));
          return;
        }
        recordingRef.current = await startRecording();
        setVoicePhase('recording');
        setSystemNotice('voice: recording, press Ctrl+R to stop');
      } catch (err) {
        recordingRef.current = null;
        setVoicePhase('idle');
        setSystemNotice(formatVoiceError(err));
      }
    })();
  }, [captureReadiness, session, setSystemNotice, setVoicePhase, startRecording]);

  return { externalInsert, ready, phase, toggleVoiceInput };
}

export function combineVoiceInputReadiness(
  codexCheck: RequirementCheck,
  captureCheck: RequirementCheck,
): RequirementCheck {
  return {
    ready: codexCheck.ready && captureCheck.ready,
    issues: [...codexCheck.issues, ...captureCheck.issues],
  };
}

export function formatVoiceReadinessNotice(check: RequirementCheck): string {
  const issue = check.issues.find((i) => !i.requirement.optional) ?? check.issues[0];
  if (!issue) return 'voice: unavailable';
  if (issue.requirement.kind === 'provider' && issue.requirement.name === 'openai-codex') {
    return 'voice: Codex voice requires active provider openai-codex';
  }
  if (issue.requirement.kind === 'runtime' && issue.requirement.name === 'auth:provider:openai-codex') {
    return 'voice: run moxxy login openai-codex to enable Codex voice';
  }
  if (issue.requirement.kind === 'runtime' && issue.requirement.name === VOICE_CAPTURE_RUNTIME) {
    const install = getInstallHint('ffmpeg');
    return `voice: ffmpeg is required for voice input\nInstall via ${install.manager}:  ${install.command}`;
  }
  if (issue.requirement.kind === 'transcriber' && issue.code === 'inactive') {
    return `voice: Codex voice requires active transcriber ${CODEX_TRANSCRIBER_NAME}`;
  }
  return `voice: ${issue.hint ?? issue.message}`;
}

function formatVoiceError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/ffmpeg/i.test(message)) return `voice: ${message}`;
  if (/openai-codex|OAuth|credentials|login/i.test(message)) return `voice: ${message}`;
  return `voice: ${message || 'failed'}`;
}
