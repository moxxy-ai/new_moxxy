import { useEffect, useState } from 'react';
import {
  ConnectionBridge,
  isConnected,
  useActiveWorkspaceId,
  useConnection,
} from './lib/useConnection';
import { ChatStoreBridge } from './lib/useChat';
import { chatStore } from './lib/chatStore';
import { usePrefs } from './lib/usePrefs';
import { ConnectionScreen } from './connection/ConnectionScreen';
import { Onboarding } from './onboarding/Onboarding';
import { ChatSurface } from './chat/ChatSurface';
import { WorkspaceSidebar, type View } from './shell/WorkspaceSidebar';
import { ContextRail } from './shell/ContextRail';
import { WorkflowsPanel } from './workflows/WorkflowsPanel';
import { SettingsPanel } from './settings/SettingsPanel';
import { Splash } from './Splash';

/**
 * Top-level shell. Three layers of gating, in order:
 *
 *   1. CLI / provider onboarding takes the whole pane while either
 *      condition is unmet.
 *   2. While the runner is connecting (any phase that isn't
 *      `connected`), the ConnectionScreen owns the pane.
 *   3. Once connected, the workspace shell renders:
 *      WorkspaceSidebar | ContextRail | <active view>.
 */
export function App(): JSX.Element {
  const activeWorkspaceId = useActiveWorkspaceId();
  const { snapshot, hasEverConnected, retry } = useConnection(activeWorkspaceId);
  const { prefs, loading: prefsLoading } = usePrefs();
  const phase = snapshot?.phase;
  const [view, setView] = useState<View>('chat');
  // Context rail starts collapsed — the chat surface is what matters
  // on first launch; the user can open the rail when they want to
  // browse files / inspect the workspace.
  const [railOpen, setRailOpen] = useState(false);
  const [lastConnected, setLastConnected] = useState<typeof phase>(undefined);
  // Local flag that flips the moment the user clicks "Open my
  // workspaces" in the FirstRunWizard, so we don't re-render the
  // wizard while waiting for prefs.read to round-trip.
  const [justFinishedOnboarding, setJustFinishedOnboarding] = useState(false);
  if (phase?.phase === 'connected' && phase !== lastConnected) {
    setLastConnected(phase);
  }

  // Mirror the active workspace into the chat store so unread state
  // clears as soon as the user switches.
  useEffect(() => {
    chatStore.setActive(activeWorkspaceId);
  }, [activeWorkspaceId]);

  // First-run gate. Block on prefs loading so we never flash the
  // main UI before deciding whether onboarding is needed.
  if (prefsLoading) {
    return (
      <>
        <ConnectionBridge />
        <ChatStoreBridge />
        <Splash message="Loading preferences…" />
      </>
    );
  }

  if (prefs && !prefs.onboardingComplete && !justFinishedOnboarding) {
    return (
      <>
        <ConnectionBridge />
        <ChatStoreBridge />
        <Onboarding onComplete={() => setJustFinishedOnboarding(true)} />
      </>
    );
  }

  // Hold the splash until we have a connection snapshot for some
  // workspace AND we know who the active one is — but ONLY on the very
  // first boot. Once we've connected at least once (`lastConnected` set),
  // a workspace switch can briefly leave `snapshot` undefined; dropping to
  // the full-screen Splash there is exactly the flicker the user saw. Keep
  // the shell mounted instead and fall back to `lastConnected` for the
  // chrome phase (see `shellPhase` below).
  if (activeWorkspaceId === null || (!snapshot && !lastConnected)) {
    return (
      <>
        <ConnectionBridge />
        <ChatStoreBridge />
        <Splash />
      </>
    );
  }

  const cliMissing = phase?.phase === 'cli-missing';
  const connectedWithoutProvider =
    phase?.phase === 'connected' && phase.activeProvider === null;

  if (cliMissing || connectedWithoutProvider) {
    return (
      <>
        <ConnectionBridge />
        <ChatStoreBridge />
        <Onboarding
          phase={phase}
          // Nothing to do on completion: finishing the recovery gate (CLI
          // installed / provider added) flips the connection phase, which
          // re-renders this gate and drops it on its own.
          onComplete={() => undefined}
        />
      </>
    );
  }

  if (!isConnected(phase) && !hasEverConnected) {
    return (
      <>
        <ConnectionBridge />
        <ChatStoreBridge />
        <ConnectionScreen snapshot={snapshot} onRetry={() => void retry()} />
      </>
    );
  }

  const connected = isConnected(phase);
  const shellPhase = connected ? phase! : lastConnected!;
  // (mode + provider were previously surfaced as a chip in the chat
  // header; that's been dropped in favour of the workspace path.
  // Keep this comment so the variable's absence is intentional.)

  return (
    <div className="app-shell">
      <ConnectionBridge />
      <ChatStoreBridge />
      <WorkspaceSidebar view={view} onView={setView} />
      {view === 'chat' && (
        <>
          <ChatSurface
            phase={shellPhase}
            workspaceId={activeWorkspaceId}
            railOpen={railOpen}
            onShowRail={() => setRailOpen(true)}
          />
          <ContextRail
            open={railOpen}
            onClose={() => setRailOpen(false)}
            workspaceId={activeWorkspaceId}
          />
        </>
      )}
      {view === 'workflows' && (
        <main className="col-main col-main--flat">
          <WorkflowsPanel />
        </main>
      )}
      {view === 'settings' && (
        <main className="col-main col-main--flat">
          <SettingsPanel />
        </main>
      )}
      {!connected && <ReconnectBanner label={describePhase(phase)} />}
    </div>
  );
}

function describePhase(
  phase: import('@moxxy/desktop-ipc-contract').ConnectionPhase | undefined,
): string {
  if (!phase) return 'Reconnecting…';
  switch (phase.phase) {
    case 'idle':
      return 'Starting…';
    case 'resolving-cli':
      return 'Resolving moxxy CLI…';
    case 'spawning':
      return 'Starting agent runtime…';
    case 'adopting':
      return 'Attaching to running runner…';
    case 'attaching':
      return 'Attaching session…';
    case 'reconnecting':
      return phase.reason ? `Reconnecting — ${phase.reason}` : 'Reconnecting…';
    case 'failed':
      return phase.error ? `Disconnected — ${phase.error}` : 'Disconnected';
    default:
      return 'Reconnecting…';
  }
}

function ReconnectBanner({ label }: { readonly label: string }): JSX.Element {
  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 24,
        transform: 'translateX(-50%)',
        padding: '6px 14px 6px 6px',
        background: 'var(--color-card-bg)',
        border: '1px solid var(--color-card-border)',
        borderRadius: 999,
        boxShadow: '0 18px 36px -18px rgba(15, 23, 42, 0.25)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        fontSize: 13,
        color: 'var(--color-text-muted)',
        zIndex: 50,
      }}
    >
      <img
        src="/avatar.gif"
        alt=""
        aria-hidden="true"
        className="moxxy-avatar-loader moxxy-avatar-loader--sm"
        width={28}
        height={28}
        style={{ imageRendering: 'pixelated' }}
      />
      {label}
    </div>
  );
}
