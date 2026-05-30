import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { Icon } from '@/lib/Icon';
import { api } from '@/lib/api';
import { useQueuedTurns } from '@/lib/useChat';
import { useVoiceRecorder } from '@/lib/useVoiceRecorder';
import { chatStore } from '@/lib/chatStore';
import { AgentPicker } from './AgentPicker';
import { ContextMeter } from './ContextMeter';
import { CommandPalette } from './CommandPalette';
import { FILE_INSERT_EVENT, type FileInsertDetail } from '@/shell/WorkspaceFiles';
import { ToolChip } from './composer/ToolChip';
import { QueuedChip } from './composer/QueuedChip';
import { AttachmentChip } from './composer/AttachmentChip';
import { sendBtn } from './composer/composer-styles';

interface ComposerAttachment {
  readonly path: string;
  readonly name: string;
}

interface ComposerProps {
  readonly ready: boolean;
  readonly sending: boolean;
  /** Runner is compacting the context — lock the composer entirely. */
  readonly compacting: boolean;
  readonly activeTurnId: string | null;
  readonly workspaceId: string;
  readonly onSend: (
    prompt: string,
    attachments?: ReadonlyArray<ComposerAttachment>,
  ) => void;
  readonly onAbort: () => void;
}

/**
 * Composer rendered as a rounded white card flush against the chat
 * pane bottom.
 *
 *   Enter         submit
 *   Shift+Enter   newline
 *   ⌘↵ / Ctrl+↵   submit (kept for terminal muscle memory)
 *   Esc           clear draft
 *
 * Tooling chips: Attach (file picker → appends a file: reference to
 * the draft) and Voice (push-to-record with MediaRecorder, transcribed
 * via the runner's active transcriber — disabled if none is set).
 */
export function Composer({
  ready,
  sending,
  compacting,
  activeTurnId,
  workspaceId,
  onSend,
  onAbort,
}: ComposerProps): JSX.Element {
  const [draft, setDraft] = useState('');
  const [hasTranscriber, setHasTranscriber] = useState(false);
  const [noTranscriberMsg, setNoTranscriberMsg] = useState<string | null>(null);
  const voice = useVoiceRecorder({
    onTranscript: (t) => setDraft((d) => (d ? `${d.trimEnd()} ${t}` : t)),
  });
  const [actionsOpen, setActionsOpen] = useState(false);
  /** Files the user picked from the rail or the native picker. Each
   *  one ships as a UserPromptAttachment with kind: 'file' + content:
   *  absolute path so the agent's read_file / cat tools find it. */
  const [attachments, setAttachments] = useState<ReadonlyArray<ComposerAttachment>>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const addAttachment = (att: ComposerAttachment): void => {
    setAttachments((cur) => (cur.some((a) => a.path === att.path) ? cur : [...cur, att]));
  };
  const removeAttachment = (path: string): void => {
    setAttachments((cur) => cur.filter((a) => a.path !== path));
  };
  const inFlight = activeTurnId !== null || sending;
  // The user can type / submit even while a turn is running — the
  // send() call queues it; the drainer ships it the moment the
  // current turn completes. A compaction is the one exception: the
  // composer locks fully until the runner finishes summarizing.
  const canSubmit =
    ready && !compacting && (draft.trim().length > 0 || attachments.length > 0);
  const queued = useQueuedTurns(workspaceId);

  // The context rail's file tree fires a CustomEvent when the user
  // clicks a file. We treat it as an attachment, not text — the
  // absolute path is what the agent needs, the chip in the input
  // is what the user wants to see.
  useEffect(() => {
    const handler = (ev: Event): void => {
      const detail = (ev as CustomEvent<FileInsertDetail>).detail;
      if (!detail?.absPath) return;
      addAttachment({ path: detail.absPath, name: detail.name });
      window.setTimeout(() => taRef.current?.focus(), 0);
    };
    window.addEventListener(FILE_INSERT_EVENT, handler);
    return () => window.removeEventListener(FILE_INSERT_EVENT, handler);
  }, []);

  // Probe transcriber availability when the connection comes up.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void api()
      .invoke('session.hasTranscriber')
      .then((has) => {
        if (!cancelled) setHasTranscriber(has);
      })
      .catch(() => {
        if (!cancelled) setHasTranscriber(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ready]);

  const submit = useCallback(() => {
    if (!canSubmit) return;
    onSend(draft, attachments.length > 0 ? attachments : undefined);
    setDraft('');
    setAttachments([]);
  }, [canSubmit, draft, attachments, onSend]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter alone submits; Shift+Enter inserts a newline (the browser
    // default). ⌘↵ / Ctrl+↵ also submit so terminal-muscle-memory
    // users aren't surprised.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setDraft('');
    }
  };

  const onAttach = useCallback(async () => {
    try {
      const path = await api().invoke('session.pickAttachment');
      if (!path) return;
      const name = path.split('/').pop() ?? path;
      addAttachment({ path, name });
      taRef.current?.focus();
    } catch {
      /* noop — file picker errors are non-fatal */
    }
  }, []);

  const onVoiceClick = useCallback(() => {
    if (voice.phase === 'recording') {
      voice.toggle();
      return;
    }
    if (!hasTranscriber) {
      setNoTranscriberMsg('No transcriber configured on the runner.');
      window.setTimeout(() => setNoTranscriberMsg(null), 2500);
      return;
    }
    voice.toggle();
  }, [hasTranscriber, voice]);

  return (
    <form
      data-testid="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      style={{
        margin: '12px 18px 4px',
        padding: '12px 14px',
        background: 'var(--color-card-bg)',
        border: '1px solid var(--color-card-border)',
        borderRadius: 16,
        boxShadow: 'var(--color-card-shadow)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {(attachments.length > 0 || queued.length > 0) && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
            paddingBottom: 4,
          }}
        >
          {attachments.map((a) => (
            <AttachmentChip
              key={a.path}
              name={a.name}
              path={a.path}
              onRemove={() => removeAttachment(a.path)}
            />
          ))}
          {queued.map((q) => (
            <QueuedChip
              key={q.id}
              text={q.prompt}
              onRemove={() => chatStore.dropFromQueue(workspaceId, q.id)}
            />
          ))}
        </div>
      )}
      {compacting && (
        <div
          role="status"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '7px 10px',
            marginBottom: 6,
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--color-primary-strong)',
            background: 'var(--color-primary-soft)',
            borderRadius: 9,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 13,
              height: 13,
              borderRadius: '50%',
              border: '2px solid var(--color-primary-soft)',
              borderTopColor: 'var(--color-primary)',
              animation: 'moxxy-spin 0.8s linear infinite',
            }}
          />
          Compacting context — summarizing older turns to free up the window…
        </div>
      )}
      <textarea
        ref={taRef}
        data-testid="composer-input"
        aria-label="prompt"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={
          compacting
            ? 'Compacting context…'
            : attachments.length > 0
              ? 'Ask about the attached file…'
              : ready
                ? 'Send a message to the agent…'
                : 'Waiting for runner…'
        }
        disabled={!ready || compacting}
        rows={Math.min(8, Math.max(1, draft.split('\n').length))}
        style={{
          width: '100%',
          resize: 'none',
          padding: '4px 6px 6px',
          fontSize: 14.5,
          lineHeight: 1.55,
          color: 'var(--color-text)',
          background: 'transparent',
          border: 'none',
          fontFamily: 'inherit',
          outline: 'none',
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <AgentPicker workspaceId={workspaceId} disabled={!ready || inFlight} />
        <ToolChip label="Actions" onClick={() => setActionsOpen(true)}>
          <Icon name="spark" size={14} />
          <span>Actions</span>
        </ToolChip>
        <ToolChip label="Attach file" onClick={() => void onAttach()}>
          <Icon name="attach" size={16} />
          <span>Attach</span>
        </ToolChip>
        <ToolChip
          label={voice.phase === 'recording' ? 'Stop recording' : 'Voice input'}
          onClick={onVoiceClick}
          tone={
            voice.phase === 'recording'
              ? 'recording'
              : voice.phase === 'transcribing'
                ? 'busy'
                : 'idle'
          }
        >
          <Icon name="mic" size={16} />
          <span>
            {voice.phase === 'recording'
              ? 'Listening…'
              : voice.phase === 'transcribing'
                ? 'Transcribing…'
                : 'Voice'}
          </span>
        </ToolChip>
        <span style={{ flex: 1 }} />
        <ContextMeter workspaceId={workspaceId} />
        {inFlight ? (
          <button
            type="button"
            className="btn-cta"
            data-testid="composer-abort"
            onClick={onAbort}
            style={sendBtn('var(--color-red)', true)}
            aria-label="Abort"
          >
            <Icon name="stop" size={16} />
          </button>
        ) : (
          <button
            type="submit"
            className="btn-cta"
            data-testid="composer-send"
            disabled={!canSubmit}
            style={sendBtn('var(--color-send)', canSubmit)}
            aria-label="Send"
          >
            <Icon name="send" size={16} />
          </button>
        )}
      </div>
      {(voice.errorReason ?? noTranscriberMsg) && (
        <p
          role="status"
          style={{
            margin: 0,
            textAlign: 'center',
            fontSize: 11,
            color: 'var(--color-red)',
          }}
        >
          {voice.errorReason ?? noTranscriberMsg}
        </p>
      )}
      {actionsOpen && (
        <CommandPalette
          workspaceId={workspaceId}
          onClose={() => setActionsOpen(false)}
        />
      )}
    </form>
  );
}
