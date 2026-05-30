import { useEffect, useState } from 'react';
import { speak, cancelSpeech, isSpeechSupported } from '@/lib/speech';
import { Icon } from '@/lib/Icon';

export function ActionRow({ text }: { readonly text: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null);

  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* swallow; rare on Electron */
    }
  };

  const onSpeak = (): void => {
    if (speaking) {
      cancelSpeech();
      setSpeaking(false);
      return;
    }
    setSpeaking(true);
    speak(text, {
      onend: () => setSpeaking(false),
      onerror: () => setSpeaking(false),
    });
  };

  // Stop any in-flight speech if this block unmounts (workspace switch,
  // clear, or scroll out of the virtualised window).
  useEffect(() => () => cancelSpeech(), []);

  return (
    <div
      style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 2, color: 'var(--color-text-dim)' }}
    >
      <ActBtn label={copied ? 'Copied!' : 'Copy'} active={copied} activeColor="var(--color-green)" onClick={() => void onCopy()}>
        <Icon name={copied ? 'check' : 'copy'} size={15} />
      </ActBtn>
      {isSpeechSupported() && (
        <ActBtn
          label={speaking ? 'Stop' : 'Read aloud'}
          active={speaking}
          activeColor="var(--color-primary)"
          onClick={onSpeak}
        >
          <Icon name={speaking ? 'stop' : 'speaker'} size={15} />
        </ActBtn>
      )}
      <span aria-hidden style={{ width: 1, height: 14, background: 'var(--color-card-border)', margin: '0 5px' }} />
      <ActBtn
        label="Good response"
        active={feedback === 'up'}
        activeColor="var(--color-green)"
        onClick={() => setFeedback((f) => (f === 'up' ? null : 'up'))}
      >
        <Icon name="thumbs-up" size={15} />
      </ActBtn>
      <ActBtn
        label="Bad response"
        active={feedback === 'down'}
        activeColor="var(--color-red)"
        onClick={() => setFeedback((f) => (f === 'down' ? null : 'down'))}
      >
        <Icon name="thumbs-down" size={15} />
      </ActBtn>
    </div>
  );
}

function ActBtn({
  label,
  active,
  activeColor,
  onClick,
  children,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly activeColor: string;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      className="btn-icon"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={onClick}
      style={{
        width: 28,
        height: 28,
        borderRadius: 8,
        color: active ? activeColor : 'var(--color-text-dim)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {children}
    </button>
  );
}
