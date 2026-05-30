/**
 * Stage 2: active — the 232×56 (or 196×56 without a mic) pill with the
 * brand button plus the voice / text / restore-main / close actions.
 *
 * The mic button starts an in-place recording overlay: while recording
 * the SpectroBackground visualiser fills the panel background instead of
 * opening a separate window.
 */

import { useState } from 'react';
import { api } from '@/lib/api';
import { useChat } from '@/lib/useChat';
import { useVoiceRecorder } from '@/lib/useVoiceRecorder';
import { ActionButton, Dot, LogoMark } from './focus-primitives';
import { MicIcon, PencilIcon, WindowIcon, XIcon } from './focus-icons';
import { SpectroBackground } from './SpectroBackground';
import { style } from './focus-styles';

export function Active({
  workspaceId,
  hasTranscriber,
  onCollapse,
  onText,
}: {
  readonly workspaceId: string | null;
  readonly hasTranscriber: boolean;
  readonly onCollapse: () => void;
  readonly onText: () => void;
}): JSX.Element {
  const chat = useChat(workspaceId);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const voice = useVoiceRecorder({
    onTranscript: (text) => {
      // Send straight as a turn — the visualiser snaps back to idle and
      // the focus widget's StatusLine + main window pick up the
      // user_prompt event.
      if (workspaceId) void chat.send(text);
    },
    onAnalyser: setAnalyser,
  });
  const phase = voice.phase;
  const toggleMic = voice.toggle;

  const recording = phase === 'recording';
  return (
    <div style={style.activeRoot}>
      {analyser && recording && <SpectroBackground analyser={analyser} />}
      <button
        type="button"
        onClick={onCollapse}
        aria-label="Collapse"
        style={style.activeBrand}
      >
        <LogoMark size={26} />
      </button>
      <div style={style.activeDivider} aria-hidden />
      <div style={style.activeActions}>
        {hasTranscriber && (
          <ActionButton
            onClick={toggleMic}
            aria-label={recording ? 'Stop recording' : 'Record voice'}
          >
            {phase === 'transcribing' ? <Dot delay={0} /> : <MicIcon />}
          </ActionButton>
        )}
        <ActionButton onClick={onText} aria-label="Text">
          <PencilIcon />
        </ActionButton>
        {/* Dismiss the floating bar (leaves the app where it was — does NOT
            open the main window). Kept before the restore button so the LAST
            icon is the "open main window" action. */}
        <ActionButton
          onClick={() => void api().invoke('focus.close').catch(() => undefined)}
          aria-label="Close focus mode"
          variant="danger"
        >
          <XIcon />
        </ActionButton>
        {/* Last icon: reopen the full app (restores + focuses the main window
            and closes this bar). */}
        <ActionButton
          onClick={() => void api().invoke('focus.restoreMain').catch(() => undefined)}
          aria-label="Open main window"
        >
          <WindowIcon />
        </ActionButton>
      </div>
    </div>
  );
}
