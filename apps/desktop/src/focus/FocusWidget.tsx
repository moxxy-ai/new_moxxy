/**
 * Focus widget — multi-state floating panel.
 *
 *   1. dot       64×64    Just the brand logo. Click → menu.
 *   2. menu      240×64   Logo + voice + text + restore-main + close.
 *   3. text      380×200  Compact composer (input + voice + send).
 *   4. voice     380×200  Big push-to-talk button; releases →
 *                         transcribes into the text mode.
 *
 * Mode transitions call focus.resize IPC so the underlying
 * BrowserWindow shrinks / grows with the UI. focus.restoreMain
 * brings the main window back; close hides the widget entirely.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from '@/lib/api';
import { ChatStoreBridge, useChat } from '@/lib/useChat';
import { chatStore } from '@/lib/chatStore';
import { ConnectionBridge, useActiveWorkspaceId } from '@/lib/useConnection';
import { Icon } from '@/lib/Icon';

type Mode = 'dot' | 'menu' | 'text' | 'voice';

const MODE_DIMENSIONS: Record<Mode, { width: number; height: number }> = {
  dot: { width: 64, height: 64 },
  menu: { width: 244, height: 60 },
  text: { width: 380, height: 200 },
  voice: { width: 380, height: 220 },
};

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
  const [mode, setMode] = useState<Mode>('dot');
  const chat = useChat(workspaceId);

  // Resize the BrowserWindow whenever the mode changes so the chrome
  // matches the content. Pin the bottom-right corner to the screen
  // (main process handles that).
  useEffect(() => {
    const { width, height } = MODE_DIMENSIONS[mode];
    void api().invoke('focus.resize', { width, height }).catch(() => undefined);
  }, [mode]);

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

  if (mode === 'dot') return <DotMode onExpand={() => setMode('menu')} sending={chat.sending} />;
  if (mode === 'menu')
    return (
      <MenuMode
        onText={() => setMode('text')}
        onVoice={() => setMode('voice')}
        onDot={() => setMode('dot')}
      />
    );
  if (mode === 'voice')
    return (
      <VoiceMode
        workspaceId={workspaceId}
        onBack={() => setMode('menu')}
        onDone={() => setMode('text')}
      />
    );
  return (
    <TextMode
      workspaceId={workspaceId}
      onBack={() => setMode('menu')}
      sending={chat.sending}
      latest={latest}
      onSend={(p) => void chat.send(p)}
    />
  );
}

// --- dot ------------------------------------------------------------------

function DotMode({
  onExpand,
  sending,
}: {
  readonly onExpand: () => void;
  readonly sending: boolean;
}): JSX.Element {
  // Important: NO -webkit-app-region: drag on the button — that
  // makes the element a window-drag target on macOS and clicks are
  // absorbed by the OS instead of reaching React. The dot has no
  // "empty space" to drag from anyway; just make the whole circle a
  // click target.
  return (
    <button
      type="button"
      onClick={onExpand}
      title="moxxy · click to open"
      className="focus-dot"
      data-busy={sending ? 'true' : 'false'}
    >
      <img src="/logo.png" alt="moxxy" width={36} height={36} draggable={false} />
    </button>
  );
}

// --- menu (logo + voice + text + restore + close) -------------------------

function MenuMode({
  onText,
  onVoice,
  onDot,
}: {
  readonly onText: () => void;
  readonly onVoice: () => void;
  readonly onDot: () => void;
}): JSX.Element {
  // Note: React drops keys with leading hyphens silently in some
  // versions, so we use the WebkitAppRegion camelCase form which
  // both React and Electron understand.
  const drag = { WebkitAppRegion: 'drag' } as React.CSSProperties;
  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;
  return (
    <div className="focus-menu" style={drag}>
      <button
        type="button"
        className="focus-menu__handle"
        onClick={onDot}
        title="Collapse"
        style={noDrag}
      >
        <img src="/logo.png" alt="" aria-hidden width={26} height={26} draggable={false} />
      </button>
      <div className="focus-menu__split" />
      <div className="focus-menu__actions" style={noDrag}>
        <button
          type="button"
          className="focus-menu__btn"
          onClick={onVoice}
          title="Voice"
        >
          <Icon name="mic" size={16} />
        </button>
        <button
          type="button"
          className="focus-menu__btn"
          onClick={onText}
          title="Text input"
        >
          <Icon name="edit" size={15} />
        </button>
        <button
          type="button"
          className="focus-menu__btn"
          onClick={() => void api().invoke('focus.restoreMain').catch(() => undefined)}
          title="Open main window"
        >
          <Icon name="workspace" size={15} />
        </button>
        <button
          type="button"
          className="focus-menu__btn focus-menu__btn--close"
          onClick={() => void api().invoke('focus.close').catch(() => undefined)}
          title="Close focus mode"
        >
          <Icon name="x" size={13} />
        </button>
      </div>
    </div>
  );
}

// --- text mode (compact composer + status) --------------------------------

function TextMode({
  workspaceId,
  onBack,
  sending,
  latest,
  onSend,
}: {
  readonly workspaceId: string | null;
  readonly onBack: () => void;
  readonly sending: boolean;
  readonly latest: string | null;
  readonly onSend: (prompt: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState('');

  const submit = (): void => {
    if (!workspaceId || !draft.trim()) return;
    onSend(draft);
    setDraft('');
  };

  return (
    <div className="focus-widget" data-thinking={sending ? 'true' : 'false'}>
      <PanelHeader title="Text" onBack={onBack} />
      <StatusLine latest={latest} sending={sending} />
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
          type="submit"
          className="btn-cta focus-widget__send"
          aria-label="Send"
          disabled={!workspaceId || !draft.trim()}
        >
          <Icon name="send" size={13} />
        </button>
        {sending && <div className="focus-widget__busybar" />}
      </form>
    </div>
  );
}

// --- voice mode (big push-to-talk) ----------------------------------------

type VoicePhase = 'idle' | 'recording' | 'transcribing' | 'unavailable';

function VoiceMode({
  workspaceId,
  onBack,
  onDone,
}: {
  readonly workspaceId: string | null;
  readonly onBack: () => void;
  readonly onDone: () => void;
}): JSX.Element {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [transcript, setTranscript] = useState('');
  const recorderRef = useRef<MediaRecorder | null>(null);

  const start = async (): Promise<void> => {
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
        void finalize(chunks, rec.mimeType);
      });
      rec.start();
      recorderRef.current = rec;
      setPhase('recording');
    } catch {
      setPhase('unavailable');
      window.setTimeout(() => setPhase('idle'), 1500);
    }
  };

  const stop = (): void => {
    const rec = recorderRef.current;
    if (rec?.state === 'recording') rec.stop();
    recorderRef.current = null;
  };

  const finalize = async (chunks: ReadonlyArray<Blob>, mimeType: string): Promise<void> => {
    setPhase('transcribing');
    try {
      const blob = new Blob([...chunks], { type: mimeType });
      const buf = await blob.arrayBuffer();
      const audioBase64 = arrayBufferToBase64(buf);
      const text = await api().invoke('session.transcribe', { audioBase64, mimeType });
      if (text?.trim()) setTranscript(text.trim());
      setPhase('idle');
    } catch {
      setPhase('unavailable');
      window.setTimeout(() => setPhase('idle'), 1500);
    }
  };

  const sendTranscript = (): void => {
    if (!workspaceId || !transcript.trim()) return;
    void api()
      .invoke('session.runTurn', { workspaceId, prompt: transcript.trim() })
      .catch(() => undefined);
    setTranscript('');
    onDone();
  };

  return (
    <div className="focus-widget">
      <PanelHeader title="Voice" onBack={onBack} />
      <div className="focus-voice">
        <button
          type="button"
          className={`focus-voice__button focus-voice__button--${phase}`}
          onClick={() => (phase === 'recording' ? stop() : void start())}
          disabled={phase === 'transcribing' || phase === 'unavailable'}
          title={
            phase === 'recording'
              ? 'Tap to stop'
              : phase === 'transcribing'
                ? 'Transcribing…'
                : phase === 'unavailable'
                  ? 'Mic unavailable'
                  : 'Tap to record'
          }
        >
          <Icon name="mic" size={26} />
        </button>
        {transcript ? (
          <div className="focus-voice__transcript" title={transcript}>
            {transcript}
          </div>
        ) : (
          <div className="focus-voice__hint">
            {phase === 'recording'
              ? 'Listening…'
              : phase === 'transcribing'
                ? 'Transcribing…'
                : phase === 'unavailable'
                  ? 'No mic / transcriber'
                  : 'Tap the mic and speak.'}
          </div>
        )}
        {transcript && phase === 'idle' && (
          <button
            type="button"
            onClick={sendTranscript}
            className="btn-cta focus-voice__send"
          >
            Send <Icon name="send" size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

// --- shared bits ----------------------------------------------------------

function PanelHeader({
  title,
  onBack,
}: {
  readonly title: string;
  readonly onBack: () => void;
}): JSX.Element {
  return (
    <header
      className="focus-widget__header"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="focus-widget__brand">
        <img src="/logo.png" alt="" aria-hidden width={16} height={16} style={{ borderRadius: 4 }} draggable={false} />
        <span>moxxy · {title}</span>
      </div>
      <div style={{ display: 'flex', gap: 4, WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          type="button"
          className="btn-icon focus-widget__close"
          aria-label="Back to menu"
          title="Back"
          onClick={onBack}
        >
          <Icon name="chevron-right" size={12} style={{ transform: 'rotate(180deg)' }} />
        </button>
        <button
          type="button"
          className="btn-icon focus-widget__close"
          aria-label="Open main window"
          title="Open main window"
          onClick={() => void api().invoke('focus.restoreMain').catch(() => undefined)}
        >
          <Icon name="workspace" size={12} />
        </button>
      </div>
    </header>
  );
}

function StatusLine({
  latest,
  sending,
}: {
  readonly latest: string | null;
  readonly sending: boolean;
}): JSX.Element {
  if (sending) {
    return (
      <div className="focus-widget__status focus-widget__status--thinking">
        <span className="thinking-dot" />
        <span className="thinking-dot" style={{ animationDelay: '160ms' }} />
        <span className="thinking-dot" style={{ animationDelay: '320ms' }} />
        <span>working…</span>
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

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}
