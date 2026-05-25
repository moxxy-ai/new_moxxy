import React, { useEffect, useState } from 'react';
import { Box } from 'ink';
import type { ClientSession as Session } from '@moxxy/sdk';
import { BootScreen, type BootEvent, type BootEventId } from '../components/BootScreen.js';
import { InputBox } from '../components/InputBox.js';
import { FooterHints } from '../components/FooterHints.js';
import { SessionView } from './SessionView.js';
import { SystemNotice } from './OverlayOrNotice.js';
import { useVoiceInput } from './use-voice-input.js';
import type { InteractiveSessionProps } from './props.js';
import {
  hasConversationStarted,
  isConversationStartEvent,
  shouldShowBootScreen,
} from './boot-gate.js';

/**
 * Outer shell: mounts the BootScreen first, runs `bootstrap()` in an
 * effect, and swaps to the real `SessionView` once a `Session` is
 * available. Callers that already have a `Session` can pass `session`
 * directly and skip the boot phase.
 */
export const InteractiveSession: React.FC<InteractiveSessionProps> = ({
  session: eagerSession,
  bootstrap,
  registerInteractiveResolver,
  model,
  resumed,
}) => {
  const [session, setSession] = useState<Session | null>(eagerSession ?? null);
  const [bootEvents, setBootEvents] = useState<ReadonlyArray<BootEvent>>([]);
  const [bootError, setBootError] = useState<{ failedStep?: BootEventId; message: string } | null>(
    null,
  );
  // First-prompt gate: the boot screen stays visible (input enabled
  // once the session resolves) until the user submits something. Only
  // then do we swap to the chat view — prevents the splash from
  // flashing past on fast boots.
  const [initialPrompt, setInitialPrompt] = useState<string | null>(null);
  const [externalConversationStarted, setExternalConversationStarted] = useState(false);
  const startedAt = React.useMemo(() => Date.now(), []);

  useEffect(() => {
    if (eagerSession || !bootstrap) return;
    let cancelled = false;
    void (async () => {
      try {
        const s = await bootstrap((step) => {
          if (cancelled) return;
          if (step.kind === 'provider-failed') {
            setBootEvents((prev) => [
              ...prev,
              { id: 'provider-activated', at: Date.now(), failed: true },
            ]);
            return;
          }
          if (step.kind === 'ready') return;
          setBootEvents((prev) => [
            ...prev,
            {
              id: step.kind as BootEventId,
              at: Date.now(),
              ...(step.detail ? { detail: step.detail } : {}),
            },
          ]);
        });
        if (cancelled) return;
        setSession(s);
      } catch (err) {
        if (cancelled) return;
        setBootError({
          failedStep: 'provider-activated',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eagerSession, bootstrap]);

  useEffect(() => {
    if (!session || initialPrompt != null || resumed) return;
    if (hasConversationStarted(session.log)) {
      setExternalConversationStarted(true);
      return;
    }
    setExternalConversationStarted(false);
    return session.log.subscribe((event) => {
      if (isConversationStartEvent(event)) setExternalConversationStarted(true);
    });
  }, [session, initialPrompt, resumed]);

  // Splash phase: render the BootScreen until the user submits the
  // first prompt. The input unlocks the moment a session resolves; the
  // submission flips us into the chat view AND becomes the first turn.
  // Resumed sessions skip the splash entirely — the user wants to land
  // back in their conversation without re-typing anything.
  if (
    shouldShowBootScreen({
      hasSession: session != null,
      initialPrompt,
      resumed,
      externalConversationStarted,
    })
  ) {
    return (
      <Box flexDirection="column">
        <BootScreen
          events={bootEvents}
          startedAt={startedAt}
          {...(bootError ? { error: bootError } : {})}
        />
        {session ? (
          <BootInputArea
            session={session}
            ready={bootError == null}
            bootError={bootError}
            onSubmit={(text) => setInitialPrompt(text)}
          />
        ) : (
          <DisabledBootInput
            placeholder={
              bootError
                ? 'Bootstrap failed — quit and run `moxxy init`'
                : 'Initializing…'
            }
          />
        )}
      </Box>
    );
  }

  const activeSession = session;
  if (!activeSession) return null;

  return (
    <SessionView
      session={activeSession}
      registerInteractiveResolver={registerInteractiveResolver}
      {...(initialPrompt ? { initialPrompt } : {})}
      {...(model ? { model } : {})}
    />
  );
};

interface BootInputAreaProps {
  readonly session: Session;
  readonly ready: boolean;
  readonly bootError: { failedStep?: BootEventId; message: string } | null;
  readonly onSubmit: (text: string) => void;
}

/**
 * Splash-screen input area, mounted once a `Session` is available so
 * the voice hook (which needs live registries) can run. Ctrl+R toggles
 * recording exactly like in the chat view, and a transcribed utterance
 * fills the input via `externalInsert` so the user can review + Enter
 * to send as their first prompt.
 */
const BootInputArea: React.FC<BootInputAreaProps> = ({ session, ready, bootError, onSubmit }) => {
  const [systemNotice, setSystemNotice] = useState<string | null>(null);
  const voice = useVoiceInput({ session, setSystemNotice });
  const commandHotkeys: Record<string, () => void> = ready ? { r: voice.toggleVoiceInput } : {};

  return (
    <Box flexDirection="column">
      <Box marginTop={2}>
        <InputBox
          disabled={!ready}
          voicePhase={voice.phase}
          externalInsert={voice.externalInsert}
          commandHotkeys={commandHotkeys}
          placeholder={
            ready
              ? buildBootPlaceholder(voice.ready)
              : bootError
                ? 'Bootstrap failed — quit and run `moxxy init`'
                : 'Initializing…'
          }
          onSubmit={(text) => {
            if (!ready) return;
            const trimmed = text.trim();
            if (trimmed) onSubmit(trimmed);
          }}
        />
      </Box>
      {systemNotice ? <SystemNotice notice={systemNotice} /> : null}
      <Box>
        <FooterHints mode="boot" voiceReady={voice.ready} />
      </Box>
    </Box>
  );
};

const DisabledBootInput: React.FC<{ placeholder: string }> = ({ placeholder }) => (
  <>
    <Box marginTop={2}>
      <InputBox disabled placeholder={placeholder} onSubmit={() => undefined} />
    </Box>
    <Box>
      <FooterHints mode="boot" />
    </Box>
  </>
);

function buildBootPlaceholder(voiceReady: boolean): string {
  return voiceReady
    ? 'type a prompt to begin · / for commands · Ctrl+R voice'
    : 'type a prompt to begin · / for commands';
}
