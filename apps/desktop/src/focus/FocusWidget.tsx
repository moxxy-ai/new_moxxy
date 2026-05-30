/**
 * FocusWidget — the floating mini surface.
 *
 * Stages:
 *
 *   inactive    44×44   logo only. Click → ACTIVE.
 *
 *   active     232×56   logo + voice + text + restore-main + close.
 *                       Mic button starts an in-place recording
 *                       overlay (spectrum visualiser fills the panel
 *                       background) instead of opening a separate
 *                       window. Press Space anywhere on the widget
 *                       to start / stop recording.
 *
 *   mini-text  360×220  compact composer (input + send).
 *
 * Resize is handled by the main process. Manual resize via window
 * edges is disabled in focus-window.ts; setBounds still works.
 *
 * Every stage is flat, sharp-cornered, shadowless.
 *
 * This module is the thin orchestrator: it owns the stage state machine
 * and the resize IPC, delegating each stage's chrome to its own module
 * (Inactive / Active / MiniText). Styles, icons, primitives, the
 * visualiser, and the latest-line hook live alongside in `./focus/*`.
 */

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ChatStoreBridge } from '@/lib/useChat';
import { ConnectionBridge, useActiveWorkspaceId } from '@/lib/useConnection';
import { Inactive } from './Inactive';
import { Active } from './Active';
import { MiniText } from './MiniText';

type Stage = 'inactive' | 'active' | 'mini-text';

// Active width depends on whether the mic button is present. With
// the mic visible there are 4 actions (mic, text, restore, close);
// without it just 3, so we tighten the panel accordingly so it
// doesn't look hollow on the right.
const ACTIVE_WIDTH_WITH_MIC = 232;
const ACTIVE_WIDTH_WITHOUT_MIC = 196;

const SIZE: Record<Stage, { width: number; height: number }> = {
  inactive: { width: 44, height: 44 },
  active: { width: ACTIVE_WIDTH_WITH_MIC, height: 56 },
  'mini-text': { width: 360, height: 220 },
};

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
  // Lifted from Active so the resize IPC knows whether to tighten
  // the panel before painting (no flicker on first activation).
  const [hasTranscriber, setHasTranscriber] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api()
      .invoke('session.hasTranscriber')
      .then((has) => {
        if (!cancelled) setHasTranscriber(Boolean(has));
      })
      .catch(() => {
        if (!cancelled) setHasTranscriber(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const { height } = SIZE[stage];
    let width = SIZE[stage].width;
    if (stage === 'active' && hasTranscriber === false) {
      width = ACTIVE_WIDTH_WITHOUT_MIC;
    }
    void api().invoke('focus.resize', { width, height }).catch(() => undefined);
  }, [stage, hasTranscriber]);

  if (stage === 'inactive')
    return <Inactive onActivate={() => setStage('active')} />;
  if (stage === 'active')
    return (
      <Active
        workspaceId={workspaceId}
        hasTranscriber={hasTranscriber === true}
        onCollapse={() => setStage('inactive')}
        onText={() => setStage('mini-text')}
      />
    );
  return <MiniText workspaceId={workspaceId} onBack={() => setStage('active')} />;
}
