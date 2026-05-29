/**
 * Floating focus widget — the renderer of the always-on-top mini
 * window. Single column with:
 *
 *   1. Header: workspace + status pill (idle / thinking / error) +
 *      a close button that restores the main window.
 *   2. Status line: latest assistant text, single-line truncated,
 *      OR the thinking dots while a turn is in flight.
 *   3. Composer: input + voice (push-to-talk) + send.
 *
 * Reuses the existing IPC surface, so messages dispatched here run
 * through the same per-workspace runner pool as the main UI.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from '@/lib/api';
import {
  ChatStoreBridge,
  useChat,
  useQueuedTurns,
} from '@/lib/useChat';
import { chatStore } from '@/lib/chatStore';
import { ConnectionBridge, useActiveWorkspaceId } from '@/lib/useConnection';
import { Icon } from '@/lib/Icon';

export function FocusWidget(): JSX.Element {
  const workspaceId = useActiveWorkspaceId();
  return (
    <>
      <ConnectionBridge />
      <ChatStoreBridge />
      <FocusContent workspaceId={workspaceId} />
    </>
  );
}

function FocusContent({ workspaceId }: { readonly workspaceId: string | null }): JSX.Element {
  const chat = useChat(workspaceId);
  const queued = useQueuedTurns(workspaceId);
  const latest = useSyncExternalStore(
    chatStore.subscribe,
    () => {
      if (!workspaceId) return null;
      const blocks = chatStore.getChat(workspaceId).blocks;
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i]!;
        if (b.kind === 'assistant' && b.text.trim().length > 0) return b.text;
      }
      return null;
    },
  );

  return (
    <div className="focus-widget" data-thinking={chat.sending ? 'true' : 'false'}>
      <Header />
      <StatusLine latest={latest} sending={chat.sending} queueDepth={queued.length} />
      <FocusComposer
        workspaceId={workspaceId}
        sending={chat.sending}
        onSend={(prompt) => void chat.send(prompt)}
      />
    </div>
  );
}

function Header(): JSX.Element {
  return (
    <header className="focus-widget__header" style={{ ['-webkit-app-region' as never]: 'drag' }}>
      <div className="focus-widget__brand">
        <img src="/logo.png" alt="" aria-hidden width={16} height={16} style={{ borderRadius: 4 }} />
        <span>moxxy · focus</span>
      </div>
      <div style={{ ['-webkit-app-region' as never]: 'no-drag' }}>
        <button
          type="button"
          className="btn-icon focus-widget__close"
          aria-label="Restore main window"
          onClick={() => {
            void api().invoke('focus.restoreMain').catch(() => undefined);
          }}
        >
          <Icon name="chevron-right" size={12} style={{ transform: 'rotate(180deg)' }} />
        </button>
      </div>
    </header>
  );
}

function StatusLine({
  latest,
  sending,
  queueDepth,
}: {
  readonly latest: string | null;
  readonly sending: boolean;
  readonly queueDepth: number;
}): JSX.Element {
  if (sending) {
    return (
      <div className="focus-widget__status focus-widget__status--thinking">
        <span className="thinking-dot" />
        <span className="thinking-dot" style={{ animationDelay: '160ms' }} />
        <span className="thinking-dot" style={{ animationDelay: '320ms' }} />
        <span>working…</span>
        {queueDepth > 0 && <em>· {queueDepth} queued</em>}
      </div>
    );
  }
  if (!latest) {
    return (
      <div className="focus-widget__status focus-widget__status--idle">
        Ready when you are.
      </div>
    );
  }
  return (
    <div className="focus-widget__status" title={latest}>
      {latest.trim().split(/\n/)[0]}
    </div>
  );
}

type VoiceState = 'idle' | 'recording' | 'transcribing' | 'unavailable';

function FocusComposer({
  workspaceId,
  sending,
  onSend,
}: {
  readonly workspaceId: string | null;
  readonly sending: boolean;
  readonly onSend: (prompt: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  const [voice, setVoice] = useState<VoiceState>('idle');
  const [recorder, setRecorder] = useState<MediaRecorder | null>(null);

  // Probe transcriber once at mount so the mic button shows the
  // right state.
  const [hasTranscriber, setHasTranscriber] = useState(false);
  useEffect(() => {
    void api()
      .invoke('session.hasTranscriber')
      .then(setHasTranscriber)
      .catch(() => setHasTranscriber(false));
  }, []);

  const submit = (): void => {
    if (!workspaceId || !draft.trim()) return;
    onSend(draft);
    setDraft('');
  };

  const startVoice = async (): Promise<void> => {
    if (!hasTranscriber) {
      setVoice('unavailable');
      window.setTimeout(() => setVoice('idle'), 1500);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
      const mimeType = candidates.find((m) => MediaRecorder.isTypeSupported(m));
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      rec.addEventListener('dataavailable', (ev) => {
        if (ev.data.size > 0) chunks.push(ev.data);
      });
      rec.addEventListener('stop', () => {
        stream.getTracks().forEach((t) => t.stop());
        void finalizeRecording(chunks, rec.mimeType, setVoice, (text) => {
          setDraft((d) => (d ? `${d.trimEnd()} ${text.trim()}` : text.trim()));
        });
      });
      rec.start();
      setRecorder(rec);
      setVoice('recording');
    } catch {
      setVoice('unavailable');
      window.setTimeout(() => setVoice('idle'), 1500);
    }
  };

  const stopVoice = (): void => {
    if (recorder?.state === 'recording') recorder.stop();
    setRecorder(null);
  };

  return (
    <form
      className="focus-widget__composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        className="focus-widget__input"
        autoFocus
        placeholder={workspaceId ? 'Ask Moxxy…' : 'No active workspace'}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={!workspaceId}
      />
      <button
        type="button"
        className={`btn-icon focus-widget__mic${voice === 'recording' ? ' focus-widget__mic--rec' : ''}`}
        aria-label={voice === 'recording' ? 'Stop recording' : 'Voice input'}
        onClick={() => (voice === 'recording' ? stopVoice() : void startVoice())}
        title={
          voice === 'recording'
            ? 'Release to transcribe'
            : voice === 'transcribing'
              ? 'Transcribing…'
              : voice === 'unavailable'
                ? 'No transcriber configured'
                : 'Push-to-talk'
        }
      >
        <Icon name="mic" size={14} />
      </button>
      <button
        type="submit"
        className="btn-cta focus-widget__send"
        aria-label="Send"
        disabled={!workspaceId || !draft.trim()}
      >
        <Icon name="send" size={13} />
      </button>
      {sending && <div className="focus-widget__busybar" />}
    </form>
  );
}

async function finalizeRecording(
  chunks: ReadonlyArray<Blob>,
  mimeType: string,
  setVoice: (v: VoiceState) => void,
  appendDraft: (text: string) => void,
): Promise<void> {
  setVoice('transcribing');
  try {
    const blob = new Blob([...chunks], { type: mimeType });
    const buf = await blob.arrayBuffer();
    const audioBase64 = arrayBufferToBase64(buf);
    const text = await api().invoke('session.transcribe', {
      audioBase64,
      mimeType,
    });
    if (text?.trim()) appendDraft(text);
    setVoice('idle');
  } catch {
    setVoice('unavailable');
    window.setTimeout(() => setVoice('idle'), 1500);
  }
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}
