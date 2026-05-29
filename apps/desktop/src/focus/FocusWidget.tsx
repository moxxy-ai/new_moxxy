/**
 * FocusWidget — the floating mini surface.
 *
 * Stages:
 *
 *   inactive    44×44   logo only.
 *                       Top 8 px = visible drag handle (only drag zone).
 *                       The rest = click target → ACTIVE.
 *
 *   active     220×56   logo + voice + text + restore-main + close.
 *                       Left 10 px = visible drag-grip column.
 *                       Buttons + logo are no-drag, clickable.
 *
 *   mini-text  360×220  compact composer (input + send).
 *                       Header bar = drag region.
 *
 *   mini-voice 360×220  push-to-talk + transcript.
 *                       Header bar = drag region.
 *
 * Resize is handled by the main process. Manual resize via window
 * edges is disabled in focus-window.ts; setBounds still works.
 *
 * Every stage is flat, sharp-cornered, shadowless — per user spec.
 * Drag is constrained to explicit handles; clicking buttons never
 * triggers window drag.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from '@/lib/api';
import { ChatStoreBridge, useChat } from '@/lib/useChat';
import { chatStore } from '@/lib/chatStore';
import { ConnectionBridge, useActiveWorkspaceId } from '@/lib/useConnection';

type Stage = 'inactive' | 'active' | 'mini-text' | 'mini-voice';

const SIZE: Record<Stage, { width: number; height: number }> = {
  inactive: { width: 44, height: 44 },
  active: { width: 232, height: 56 },
  'mini-text': { width: 360, height: 220 },
  'mini-voice': { width: 360, height: 220 },
};

const ASSET_LOGO = './logo.png';

// ---- Top-level wrapper ---------------------------------------------------

export function FocusWidget(): JSX.Element {
  const workspaceId = useActiveWorkspaceId();
  return (
    <>
      <ConnectionBridge />
      <ChatStoreBridge />
      <Surface workspaceId={workspaceId} />
    </>
  );
}

function Surface({
  workspaceId,
}: {
  readonly workspaceId: string | null;
}): JSX.Element {
  const [stage, setStage] = useState<Stage>('inactive');

  useEffect(() => {
    const { width, height } = SIZE[stage];
    void api().invoke('focus.resize', { width, height }).catch(() => undefined);
  }, [stage]);

  if (stage === 'inactive')
    return <Inactive onActivate={() => setStage('active')} />;
  if (stage === 'active')
    return (
      <Active
        onCollapse={() => setStage('inactive')}
        onText={() => setStage('mini-text')}
        onVoice={() => setStage('mini-voice')}
      />
    );
  if (stage === 'mini-text')
    return <MiniText workspaceId={workspaceId} onBack={() => setStage('active')} />;
  return (
    <MiniVoice
      workspaceId={workspaceId}
      onBack={() => setStage('active')}
      onSent={() => setStage('mini-text')}
    />
  );
}

// ---- Stage 1: inactive ---------------------------------------------------

function Inactive({ onActivate }: { readonly onActivate: () => void }): JSX.Element {
  // Layout: 10px | 1fr — drag handle on the LEFT, click target on
  // the right. iOS-style vertical pill as the grip glyph.
  return (
    <div style={style.inactiveRoot}>
      <div style={style.inactiveHandle} aria-hidden>
        <PillHandle />
      </div>
      <button
        type="button"
        onClick={onActivate}
        aria-label="moxxy · click to expand"
        style={style.inactiveButton}
      >
        <LogoMark />
      </button>
    </div>
  );
}

// ---- Stage 2: active -----------------------------------------------------

function Active({
  onCollapse,
  onText,
  onVoice,
}: {
  readonly onCollapse: () => void;
  readonly onText: () => void;
  readonly onVoice: () => void;
}): JSX.Element {
  // Layout: [grip-on-left] [brand] [divider] [actions]
  return (
    <div style={style.activeRoot}>
      <div style={style.activeGrip} aria-hidden>
        <PillHandle />
      </div>
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
        <ActionButton onClick={onVoice} aria-label="Voice">
          <MicIcon />
        </ActionButton>
        <ActionButton onClick={onText} aria-label="Text">
          <PencilIcon />
        </ActionButton>
        <ActionButton
          onClick={() => void api().invoke('focus.restoreMain').catch(() => undefined)}
          aria-label="Open main window"
        >
          <WindowIcon />
        </ActionButton>
        <ActionButton
          onClick={() => void api().invoke('focus.close').catch(() => undefined)}
          aria-label="Close focus mode"
          variant="danger"
        >
          <XIcon />
        </ActionButton>
      </div>
    </div>
  );
}

// ---- Stage 3a: mini-text -------------------------------------------------

function MiniText({
  workspaceId,
  onBack,
}: {
  readonly workspaceId: string | null;
  readonly onBack: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  const chat = useChat(workspaceId);
  const latest = useLatestBlock(workspaceId);

  const submit = (): void => {
    if (!workspaceId || !draft.trim()) return;
    void chat.send(draft.trim());
    setDraft('');
  };

  return (
    <div style={style.panel}>
      <MiniHeader title="Text" onBack={onBack} />
      <div style={style.panelBody}>
        {chat.sending ? (
          <ThinkingLine />
        ) : latest ? (
          <LatestLine block={latest} />
        ) : (
          <IdleLine
            label={workspaceId ? 'Type a quick prompt below.' : 'No active workspace.'}
          />
        )}
      </div>
      <form
        style={style.composer}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          autoFocus
          placeholder={workspaceId ? 'Ask Moxxy…' : 'No active workspace'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={!workspaceId}
          style={style.input}
        />
        <button
          type="submit"
          aria-label="Send"
          disabled={!workspaceId || !draft.trim()}
          style={style.send}
        >
          <SendIcon />
        </button>
      </form>
    </div>
  );
}

// ---- Stage 3b: mini-voice ------------------------------------------------

type VoicePhase = 'idle' | 'recording' | 'transcribing' | 'unavailable';

function MiniVoice({
  workspaceId,
  onBack,
  onSent,
}: {
  readonly workspaceId: string | null;
  readonly onBack: () => void;
  readonly onSent: () => void;
}): JSX.Element {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [transcript, setTranscript] = useState('');
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const startedRef = useRef(false);

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
        audioContextRef.current?.close().catch(() => undefined);
        audioContextRef.current = null;
        setAnalyser(null);
        void finalize(chunks, rec.mimeType);
      });
      rec.start();
      recorderRef.current = rec;
      setPhase('recording');

      // Wire up an AnalyserNode for the spectroscope. Same stream as
      // the MediaRecorder; just a parallel tap.
      const Ctor = (window as unknown as {
        AudioContext?: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
      });
      const Audio = Ctor.AudioContext ?? Ctor.webkitAudioContext;
      if (Audio) {
        const ctx = new Audio();
        audioContextRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const an = ctx.createAnalyser();
        an.fftSize = 256;
        an.smoothingTimeConstant = 0.7;
        source.connect(an);
        setAnalyser(an);
      }
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
      const text = await api().invoke('session.transcribe', {
        audioBase64: arrayBufferToBase64(buf),
        mimeType,
      });
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
    onSent();
  };

  // Auto-start recording on mount. The user clicked the mic icon in
  // the active row — they expect recording to begin immediately.
  // StrictMode is OFF in the focus window so this fires exactly once.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
    return () => {
      // Stop the mic when the user navigates away from the voice
      // mini panel.
      const rec = recorderRef.current;
      if (rec?.state === 'recording') {
        rec.stop();
        recorderRef.current = null;
      }
      audioContextRef.current?.close().catch(() => undefined);
      audioContextRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={style.panel}>
      <MiniHeader title="Voice" onBack={onBack} />
      <div
        style={{
          ...style.panelBody,
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        }}
      >
        {analyser && phase === 'recording' && <Spectroscope analyser={analyser} />}
        <button
          type="button"
          onClick={() => (phase === 'recording' ? stop() : void start())}
          disabled={phase === 'transcribing' || phase === 'unavailable'}
          style={{
            ...style.micButton,
            ...(phase === 'recording' ? style.micButtonRecording : null),
            ...(phase === 'transcribing' || phase === 'unavailable'
              ? style.micButtonDisabled
              : null),
          }}
          aria-label={phase === 'recording' ? 'Tap to stop' : 'Tap to record'}
        >
          <MicIcon big />
        </button>
        {transcript ? (
          <div style={style.transcript}>{transcript}</div>
        ) : (
          <div style={style.hint}>
            {phase === 'recording'
              ? 'Listening — tap mic to stop.'
              : phase === 'transcribing'
                ? 'Transcribing…'
                : phase === 'unavailable'
                  ? 'No mic / transcriber.'
                  : 'Tap to record.'}
          </div>
        )}
        {transcript && phase === 'idle' && (
          <button type="button" onClick={sendTranscript} style={style.transcriptSend}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}

// ---- Spectroscope --------------------------------------------------------
// Render the live audio spectrum as bars in moxxy pink. Reads
// frequency data from an AnalyserNode on each animation frame and
// paints to a canvas.

function Spectroscope({ analyser }: { readonly analyser: AnalyserNode }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bufferLength = analyser.frequencyBinCount;
    const data = new Uint8Array(bufferLength);
    let frame = 0;
    let raf = 0;

    const dpr = window.devicePixelRatio || 1;
    const cssWidth = 280;
    const cssHeight = 36;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    ctx.scale(dpr, dpr);

    const barCount = 24;
    const barWidth = (cssWidth - (barCount - 1) * 3) / barCount;

    const draw = (): void => {
      raf = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(data);
      ctx.clearRect(0, 0, cssWidth, cssHeight);
      const gradient = ctx.createLinearGradient(0, 0, cssWidth, 0);
      gradient.addColorStop(0, '#ec4899');
      gradient.addColorStop(1, '#d946ef');
      ctx.fillStyle = gradient;

      // Group analyser bins into `barCount` bars (linear binning is
      // fine for this small a visualisation).
      const binsPerBar = Math.floor(bufferLength / barCount) || 1;
      for (let i = 0; i < barCount; i++) {
        let sum = 0;
        for (let j = 0; j < binsPerBar; j++) {
          sum += data[i * binsPerBar + j] ?? 0;
        }
        const avg = sum / binsPerBar / 255;
        const h = Math.max(2, Math.round(avg * cssHeight));
        const x = i * (barWidth + 3);
        const y = cssHeight - h;
        ctx.fillRect(x, y, barWidth, h);
      }
      frame++;
    };
    draw();
    return () => {
      cancelAnimationFrame(raf);
      void frame;
    };
  }, [analyser]);

  return <canvas ref={canvasRef} aria-hidden style={{ display: 'block' }} />;
}

// ---- Helpers -------------------------------------------------------------

interface LatestBlock {
  readonly who: 'user' | 'assistant';
  readonly text: string;
}

const latestBlockCache = new Map<string, { key: string; block: LatestBlock }>();

function readLatestBlock(workspaceId: string | null): LatestBlock | null {
  if (!workspaceId) return null;
  const blocks = chatStore.getChat(workspaceId).blocks;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if ((b.kind === 'assistant' || b.kind === 'user') && b.text.trim()) {
      const key = `${b.kind}:${b.text.length}:${b.text.slice(0, 64)}`;
      const cached = latestBlockCache.get(workspaceId);
      if (cached?.key === key) return cached.block;
      const block: LatestBlock = { who: b.kind, text: b.text };
      latestBlockCache.set(workspaceId, { key, block });
      return block;
    }
  }
  if (latestBlockCache.has(workspaceId)) latestBlockCache.delete(workspaceId);
  return null;
}

function useLatestBlock(workspaceId: string | null): LatestBlock | null {
  return useSyncExternalStore(chatStore.subscribe, () =>
    readLatestBlock(workspaceId),
  );
}

function MiniHeader({
  title,
  onBack,
}: {
  readonly title: string;
  readonly onBack: () => void;
}): JSX.Element {
  return (
    <header style={style.miniHeader}>
      <button type="button" onClick={onBack} style={style.headerButton} aria-label="Back">
        <ChevronLeftIcon />
      </button>
      <div style={style.miniTitle}>
        <LogoMark size={16} />
        <span>{title}</span>
      </div>
      <button
        type="button"
        onClick={() => void api().invoke('focus.restoreMain').catch(() => undefined)}
        style={style.headerButton}
        aria-label="Open main window"
      >
        <WindowIcon />
      </button>
    </header>
  );
}

function ActionButton({
  onClick,
  children,
  variant,
  ...rest
}: {
  readonly onClick: () => void;
  readonly children: React.ReactNode;
  readonly variant?: 'danger';
  readonly 'aria-label': string;
}): JSX.Element {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...style.actionBtn,
        ...(hover
          ? variant === 'danger'
            ? { background: 'rgba(239, 68, 68, 0.12)', color: '#ef4444' }
            : { background: 'rgba(15, 23, 42, 0.06)', color: '#0f172a' }
          : null),
      }}
      aria-label={rest['aria-label']}
    >
      {children}
    </button>
  );
}

// Logo mark — uses the avatar.gif served from public/. Fallback to
// a typed glyph if the image fails to load (offline / dist mis-copy).
function LogoMark({ size = 24 }: { readonly size?: number }): JSX.Element {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        aria-hidden
        style={{
          width: size,
          height: size,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: Math.round(size * 0.7),
          fontWeight: 800,
          color: '#ec4899',
        }}
      >
        m
      </span>
    );
  }
  return (
    <img
      src={ASSET_LOGO}
      width={size}
      height={size}
      alt=""
      aria-hidden
      draggable={false}
      onError={() => setFailed(true)}
      style={{
        width: size,
        height: size,
        display: 'block',
        objectFit: 'cover',
      }}
    />
  );
}

function ThinkingLine(): JSX.Element {
  return (
    <div style={style.lineRow}>
      <Dot delay={0} />
      <Dot delay={160} />
      <Dot delay={320} />
      <span style={{ color: '#ec4899', fontWeight: 600, fontSize: 13 }}>working…</span>
    </div>
  );
}

function LatestLine({ block }: { readonly block: LatestBlock }): JSX.Element {
  const prefix = block.who === 'user' ? 'you · ' : '';
  return (
    <div
      style={{
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        display: 'block',
        fontSize: 13,
        color: '#0f172a',
        lineHeight: 1.4,
        width: '100%',
      }}
      title={block.text}
    >
      {prefix && (
        <span style={{ opacity: 0.55, fontWeight: 600, marginRight: 4 }}>{prefix}</span>
      )}
      {block.text.trim().split(/\n/)[0]}
    </div>
  );
}

function IdleLine({ label }: { readonly label: string }): JSX.Element {
  return (
    <div style={{ fontSize: 12.5, color: '#64748b', fontStyle: 'italic' }}>{label}</div>
  );
}

function Dot({ delay }: { readonly delay: number }): JSX.Element {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 5,
        height: 5,
        borderRadius: 5,
        background: '#ec4899',
        margin: '0 1px',
        animation: 'focus-thinking 1.2s ease-in-out infinite',
        animationDelay: `${delay}ms`,
      }}
    />
  );
}

// ---- Icons --------------------------------------------------------------
// Better SVG icons — fully inline, no font dependency. Stroke weights
// tuned for the 14–16 px size we use in the active row.

function PillHandle(): JSX.Element {
  // iOS-style grabber: thin vertical pill, ~3 px wide × 22 px tall,
  // medium opacity gray. Same shape iOS uses on its bottom-sheet
  // drag indicators (rotated 90° because we're a side handle, not
  // a top handle).
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: 3,
        height: 24,
        borderRadius: 2,
        background: 'rgba(15, 23, 42, 0.32)',
      }}
    />
  );
}
function MicIcon({ big = false }: { readonly big?: boolean }): JSX.Element {
  const size = big ? 28 : 16;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M5 11a7 7 0 0014 0M12 18v3M9 21h6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
function PencilIcon(): JSX.Element {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M16.4 3.6a2 2 0 012.8 2.8L7 18.6 3 19l.4-4z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M13.6 5.4l3 3" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}
function WindowIcon(): JSX.Element {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3 9h18" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="6.5" cy="6.5" r="0.6" fill="currentColor" />
      <circle cx="9" cy="6.5" r="0.6" fill="currentColor" />
      <circle cx="11.5" cy="6.5" r="0.6" fill="currentColor" />
    </svg>
  );
}
function XIcon(): JSX.Element {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
function ChevronLeftIcon(): JSX.Element {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M15 6l-6 6 6 6"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function SendIcon(): JSX.Element {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 12l18-8-7 19-3-9-8-2z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        fill="currentColor"
        fillOpacity="0.9"
      />
    </svg>
  );
}

// ---- Utilities -----------------------------------------------------------

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

// ---- Styles --------------------------------------------------------------
// Inline. Flat. Sharp-cornered. No transitions on the things that
// resize/relayout (those caused the bounce on collapse).

const drag = { WebkitAppRegion: 'drag' as const };
const noDrag = { WebkitAppRegion: 'no-drag' as const };

const PANEL_BG = '#ffffff';
const PANEL_BORDER = '1px solid rgba(15, 23, 42, 0.14)';

const style: Record<string, React.CSSProperties> = {
  // ---- inactive --------------------------------------------------------
  inactiveRoot: {
    width: '100%',
    height: '100%',
    background: PANEL_BG,
    border: PANEL_BORDER,
    boxSizing: 'border-box',
    display: 'grid',
    // Drag handle column on the left, click target fills the rest.
    gridTemplateColumns: '10px 1fr',
    ...noDrag,
  },
  inactiveHandle: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'grab',
    ...drag,
  },
  inactiveButton: {
    border: 'none',
    background: 'transparent',
    padding: 0,
    margin: 0,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    ...noDrag,
  },

  // ---- active ----------------------------------------------------------
  activeRoot: {
    width: '100%',
    height: '100%',
    background: PANEL_BG,
    border: PANEL_BORDER,
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    // Padding on the right for the trailing action buttons; the
    // grip column owns the left edge.
    padding: '0 8px 0 0',
    ...noDrag,
  },
  activeGrip: {
    width: 10,
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'grab',
    ...drag,
  },
  activeBrand: {
    width: 36,
    height: 36,
    padding: 0,
    margin: 0,
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    ...noDrag,
  },
  activeDivider: {
    width: 1,
    height: 26,
    background: 'rgba(15, 23, 42, 0.12)',
    margin: '0 6px',
    flexShrink: 0,
  },
  activeActions: {
    display: 'flex',
    gap: 2,
    marginLeft: 'auto',
    ...noDrag,
  },
  actionBtn: {
    width: 34,
    height: 34,
    padding: 0,
    margin: 0,
    border: 'none',
    background: 'transparent',
    color: '#64748b',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ---- mini -----------------------------------------------------------
  panel: {
    width: '100%',
    height: '100%',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    background: PANEL_BG,
    border: PANEL_BORDER,
    overflow: 'hidden',
    ...noDrag,
  },
  miniHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 8px',
    borderBottom: '1px solid rgba(15, 23, 42, 0.08)',
    cursor: 'grab',
    ...drag,
  },
  headerButton: {
    width: 24,
    height: 24,
    padding: 0,
    background: 'transparent',
    border: 'none',
    color: '#64748b',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    ...noDrag,
  },
  miniTitle: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11.5,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: '#64748b',
    ...noDrag,
  },
  panelBody: {
    flex: 1,
    padding: '10px 14px',
    display: 'flex',
    alignItems: 'center',
    minHeight: 0,
  },
  lineRow: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
  },
  composer: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 10px',
    borderTop: '1px solid rgba(15, 23, 42, 0.08)',
    background: '#fff',
    ...noDrag,
  },
  input: {
    flex: 1,
    height: 32,
    padding: '0 10px',
    fontSize: 13,
    color: '#0f172a',
    background: '#f8fafc',
    border: '1px solid rgba(15, 23, 42, 0.12)',
    outline: 'none',
    fontFamily: 'inherit',
  },
  send: {
    width: 32,
    height: 32,
    border: 'none',
    background: 'linear-gradient(135deg, #ec4899, #d946ef)',
    color: '#fff',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  micButton: {
    width: 72,
    height: 72,
    border: 'none',
    background: 'linear-gradient(135deg, #ec4899, #d946ef)',
    color: '#fff',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  micButtonRecording: {
    background: '#ef4444',
  },
  micButtonDisabled: {
    opacity: 0.6,
    cursor: 'default',
  },
  transcript: {
    fontSize: 12.5,
    color: '#0f172a',
    padding: '6px 10px',
    background: '#f8fafc',
    border: '1px solid rgba(15, 23, 42, 0.12)',
    maxWidth: '100%',
    textAlign: 'center',
  },
  hint: {
    fontSize: 12,
    color: '#64748b',
    letterSpacing: '0.02em',
  },
  transcriptSend: {
    padding: '6px 14px',
    fontSize: 12,
    fontWeight: 700,
    border: 'none',
    background: 'linear-gradient(135deg, #ec4899, #d946ef)',
    color: '#fff',
    cursor: 'pointer',
  },
};

// ---- Keyframes -----------------------------------------------------------

if (typeof document !== 'undefined' && !document.getElementById('focus-keyframes')) {
  const styleTag = document.createElement('style');
  styleTag.id = 'focus-keyframes';
  styleTag.textContent = `
    @keyframes focus-thinking {
      0%, 100% { transform: translateY(0); opacity: 0.4; }
      50%      { transform: translateY(-3px); opacity: 1; }
    }
  `;
  document.head.appendChild(styleTag);
}
