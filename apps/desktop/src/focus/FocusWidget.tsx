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
  // Small floating tile, just big enough for the brand mark. The
  // OS card chrome that wraps it draws the rounded-rect; we keep
  // the visible content centred and tiny.
  dot: { width: 44, height: 44 },
  // Toolbar — also tightened so it doesn't read as a status bar.
  menu: { width: 200, height: 52 },
  text: { width: 340, height: 180 },
  voice: { width: 340, height: 200 },
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

  // Show whichever block (user OR assistant) is most recent — that's
  // what the user actually wants reflected: their own message right
  // after they hit send, then the response when it streams back.
  const latest = useSyncExternalStore(
    chatStore.subscribe,
    () => {
      if (!workspaceId) return null;
      const blocks = chatStore.getChat(workspaceId).blocks;
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i]!;
        if (b.kind === 'assistant' && b.text.trim().length > 0) {
          return { who: 'assistant' as const, text: b.text };
        }
        if (b.kind === 'user' && b.text.trim().length > 0) {
          return { who: 'user' as const, text: b.text };
        }
      }
      return null;
    },
  );

  if (mode === 'dot') {
    return <DotMode onExpand={() => setMode('menu')} sending={chat.sending} />;
  }
  if (mode === 'menu')
    return (
      <MenuMode
        onText={() => setMode('text')}
        onVoice={() => setMode('voice')}
        onCollapse={() => setMode('dot')}
        sending={chat.sending}
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

interface LatestBlock {
  readonly who: 'user' | 'assistant';
  readonly text: string;
}

// --- dot (small floating logo) --------------------------------------------
//
// The dot is the default "I am here" surface — a small circular logo
// that expands to the menu on click. Corners around the circle are a
// drag region so the user can grab the widget by the (visually empty)
// corner area; the button itself is no-drag so the click reaches us.

function DotMode({
  onExpand,
  sending,
}: {
  readonly onExpand: () => void;
  readonly sending: boolean;
}): JSX.Element {
  const drag = { WebkitAppRegion: 'drag' } as React.CSSProperties;
  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;
  return (
    <div className="focus-dot__shell" style={drag}>
      <button
        type="button"
        onClick={onExpand}
        aria-label="moxxy · click to expand"
        className="focus-dot"
        data-busy={sending ? 'true' : 'false'}
        style={noDrag}
      >
        <img src="/logo.png" alt="moxxy" draggable={false} />
      </button>
    </div>
  );
}

// --- menu (voice + text + restore + close) -------------------------------
//
// Layout intent (per user feedback):
//   - Square-ish rounded-rect, not a pill — drag-feels like a small
//     widget, not a status bar.
//   - The entire card is a drag handle (WebkitAppRegion: drag), the
//     individual buttons opt OUT with WebkitAppRegion: no-drag so
//     they remain clickable. The grippy "rails" along the left and
//     right edges are visual hints for where the safe drag zones
//     are even when buttons cover the centre.

function MenuMode({
  onText,
  onVoice,
  onCollapse,
  sending,
}: {
  readonly onText: () => void;
  readonly onVoice: () => void;
  readonly onCollapse: () => void;
  readonly sending: boolean;
}): JSX.Element {
  // CamelCase WebkitAppRegion — React drops leading-hyphen keys in
  // some versions, this form is recognised by both React and Electron.
  const drag = { WebkitAppRegion: 'drag' } as React.CSSProperties;
  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;
  return (
    <div className="focus-menu" style={drag} data-busy={sending ? 'true' : 'false'}>
      <span aria-hidden className="focus-menu__grip focus-menu__grip--left" />
      <button
        type="button"
        className="focus-menu__brand focus-menu__brand--button"
        onClick={onCollapse}
        aria-label="Collapse to logo"
        style={noDrag}
      >
        <img src="/logo.png" alt="" aria-hidden draggable={false} />
      </button>
      <div className="focus-menu__actions" style={noDrag}>
        <button
          type="button"
          className="focus-menu__btn"
          onClick={onVoice}
          aria-label="Voice"
        >
          <Icon name="mic" size={16} />
        </button>
        <button
          type="button"
          className="focus-menu__btn"
          onClick={onText}
          aria-label="Text input"
        >
          <Icon name="edit" size={15} />
        </button>
        <button
          type="button"
          className="focus-menu__btn"
          onClick={() => void api().invoke('focus.restoreMain').catch(() => undefined)}
          aria-label="Open main window"
        >
          <Icon name="workspace" size={15} />
        </button>
        <button
          type="button"
          className="focus-menu__btn focus-menu__btn--close"
          onClick={() => void api().invoke('focus.close').catch(() => undefined)}
          aria-label="Close focus mode"
        >
          <Icon name="x" size={13} />
        </button>
      </div>
      <span aria-hidden className="focus-menu__grip focus-menu__grip--right" />
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
  readonly latest: LatestBlock | null;
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
          aria-label={
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
          <div className="focus-voice__transcript" aria-label={transcript}>
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
          onClick={onBack}
        >
          <Icon name="chevron-right" size={12} style={{ transform: 'rotate(180deg)' }} />
        </button>
        <button
          type="button"
          className="btn-icon focus-widget__close"
          aria-label="Open main window"
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
  readonly latest: LatestBlock | null;
  readonly sending: boolean;
}): JSX.Element {
  // If we have a most-recent block, surface it whether or not a turn
  // is in flight — the user wants to see their own message right
  // after they sent it. The "thinking…" dots become the prefix so the
  // running state is still visually distinct.
  if (latest) {
    const prefix =
      latest.who === 'user' ? 'you · ' : sending ? '· · ·  ' : '';
    return (
      <div
        className={`focus-widget__status${
          latest.who === 'user' ? ' focus-widget__status--user' : ''
        }${sending ? ' focus-widget__status--thinking' : ''}`}
      >
        {sending && (
          <>
            <span className="thinking-dot" />
            <span className="thinking-dot" style={{ animationDelay: '160ms' }} />
            <span className="thinking-dot" style={{ animationDelay: '320ms' }} />
          </>
        )}
        <span>
          {prefix && <span style={{ opacity: 0.7 }}>{prefix}</span>}
          {latest.text.trim().split(/\n/)[0]}
        </span>
      </div>
    );
  }
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
  return (
    <div className="focus-widget__status focus-widget__status--idle">
      Ready when you are.
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
