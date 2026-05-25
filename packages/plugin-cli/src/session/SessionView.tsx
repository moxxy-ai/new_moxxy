import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box } from 'ink';
import { useApp } from 'ink';
import type { UserPromptAttachment } from '@moxxy/sdk';
import type { ClientSession as Session } from '@moxxy/sdk';
import { savePreferences } from '@moxxy/core';
import { ChatView } from '../components/ChatView.js';
import { StatusLine } from '../components/StatusLine.js';
import { estimateContextTokens } from '../context-estimate.js';
import {
  buildSlashSuggestions,
  clearTerminalScreen,
  getModeName,
  resolveActiveDescriptor,
  resolveActiveModel,
  resolveContextWindow,
} from './helpers.js';
import { useMcpStatus } from './use-mcp-status.js';
import { useEventStream } from './use-event-stream.js';
import { useImageAttachments } from './use-image-attachments.js';
import { useTurnRunner } from './use-turn-runner.js';
import { usePermissionQueue } from './use-permission-queue.js';
import { useGlobalHotkeys } from './use-global-hotkeys.js';
import { useVoiceInput } from './use-voice-input.js';
import { makePickerHandler } from './picker-handlers.js';
import { runSlash } from './run-slash.js';
import { OverlayOrNotice } from './OverlayOrNotice.js';
import { InteractiveZone } from './InteractiveZone.js';
import type { InteractiveSessionProps } from './props.js';
import type { Overlay, Picker } from './types.js';

interface SessionViewProps {
  readonly session: Session;
  readonly registerInteractiveResolver: InteractiveSessionProps['registerInteractiveResolver'];
  readonly model?: string;
  readonly version?: string;
  /**
   * Prompt typed on the splash screen. Submitted automatically on mount
   * so the user's first message kicks off the first turn — they don't
   * have to retype it after the view transitions.
   */
  readonly initialPrompt?: string;
}

export const SessionView: React.FC<SessionViewProps> = ({
  session,
  registerInteractiveResolver,
  model,
  initialPrompt,
}) => {
  const { exit } = useApp();
  const stream = useEventStream(session);
  const [systemNotice, setSystemNotice] = useState<string | null>(null);
  // Structured ephemeral overlay (mutually exclusive with systemNotice).
  // /skills and /tools render through here so they get full-color
  // typography instead of being squeezed into the yellow notice strip.
  const [overlay, setOverlay] = useState<Overlay>(null);
  // Global Ctrl+O toggle. When true, every live-tools block renders
  // expanded (every constituent call visible). Default false: each
  // block shows its verb-summary line + the latest call preview.
  const [expandToolOutputs, setExpandToolOutputs] = useState(false);
  const [yolo, setYolo] = useState(false);
  const { mcpStatus, refreshMcpStatus } = useMcpStatus(session);
  // Mid-session model override. When the user picks a model via /model,
  // this takes precedence over the prop passed in at mount time.
  const [activeModelOverride, setActiveModelOverride] = useState<string | null>(null);
  const [picker, setPicker] = useState<Picker>(null);
  const permissions = usePermissionQueue(session, registerInteractiveResolver);
  const images = useImageAttachments((msg) => setSystemNotice(msg));
  const voice = useVoiceInput({ session, setSystemNotice });

  // Keep the yolo flag in a ref so the permission handler closure
  // reads the latest value without re-registering.
  useEffect(() => {
    permissions.yoloRef.current = yolo;
  }, [yolo, permissions.yoloRef]);

  const turn = useTurnRunner({
    session,
    resolveModel: () => resolveActiveModel(session, activeModelOverride, model),
    stream,
  });

  const pendingPermission = permissions.pendingPermission;
  const pendingApproval = permissions.pendingApproval;
  const overlayOpen =
    overlay != null || picker != null || pendingPermission != null || pendingApproval != null;

  useGlobalHotkeys({
    busy: turn.busy,
    overlayOpen,
    turnControllerRef: turn.turnControllerRef,
    setSystemNotice,
  });

  // Hotkeys that need to reach inside PromptInput. Routed through
  // parse-input.ts since Ink's useInput stops firing once the editor
  // owns the stdin stream (data-mode flowing vs. readable-mode read()).
  const commandHotkeys: Record<string, () => void> = {
    t: () => {
      const moved = turn.forceSendFirst();
      setSystemNotice(
        moved
          ? 'queue: first message will run next, by itself'
          : 'queue: nothing queued to force-send',
      );
    },
    b: () => {
      const dropped = turn.dropFirst();
      setSystemNotice(
        dropped ? 'queue: dropped the first queued message' : 'queue: nothing to drop',
      );
    },
    o: () => {
      setExpandToolOutputs((e) => {
        const next = !e;
        setSystemNotice(
          next
            ? 'tool blocks expanded — Ctrl+O again to collapse'
            : 'tool blocks collapsed — Ctrl+O again to expand',
        );
        return next;
      });
    },
    r: voice.toggleVoiceInput,
  };

  // Snapshot per-tool compact-presentation metadata from the live tool
  // registry. Built once per session (plugins register at boot); MCP
  // hot-attach won't surface here until the next session, which is
  // acceptable since MCP tools rarely declare `compact` anyway. The
  // stable map identity drives a memo in pairToolEvents.
  const compactTools = useMemo(() => {
    const m = new Map<string, NonNullable<ReturnType<typeof session.tools.list>[number]['compact']>>();
    for (const tool of session.tools.list()) {
      if (tool.compact) m.set(tool.name, tool.compact);
    }
    return m;
  }, [session]);

  const providerName = session.providers.getActiveName() ?? '(none)';
  const activeModel = resolveActiveModel(session, activeModelOverride, model);
  const contextWindow = resolveContextWindow(session, activeModel);
  // Re-estimate every render. estimateContextTokens is char-cheap so
  // this stays well under a millisecond even on busy logs.
  const contextUsed = estimateContextTokens(session.log);
  const modeName = getModeName(session);

  // Shift+Tab (and /mode) advance to the next registered mode, wrapping
  // around. Mirrors the model/loop picker's persistence so the choice
  // survives across sessions. setSystemNotice forces the re-render that
  // refreshes the footer's mode label.
  const cycleMode = React.useCallback(() => {
    const modes = session.modes.list();
    if (modes.length === 0) return;
    let current: string;
    try {
      current = session.modes.getActive().name;
    } catch {
      current = '';
    }
    const idx = modes.findIndex((m) => m.name === current);
    const next = modes[(idx + 1) % modes.length]!;
    try {
      session.modes.setActive(next.name);
      void savePreferences({ mode: next.name });
      setSystemNotice(`mode → ${next.name}`);
    } catch {
      /* registry empty or name vanished — leave the active mode as-is */
    }
  }, [session]);

  const slashSuggestions = React.useMemo(() => buildSlashSuggestions(session), [session]);

  const handlePickerSelect = React.useMemo(
    () =>
      makePickerHandler({
        session,
        providerName,
        setPicker,
        setSystemNotice,
        setActiveModelOverride,
        refreshMcpStatus,
      }),
    [session, providerName, refreshMcpStatus],
  );

  // Channel-side handler for `session-action` outputs returned by
  // commands registered in `session.commands`. The actual TUI state
  // mutations (clearing scrollback, aborting turns, exiting Ink) live
  // here because the registry handlers are channel-agnostic.
  const performSessionAction = (action: 'new' | 'clear' | 'exit', notice?: string): void => {
    if (action === 'exit') {
      exit();
      return;
    }
    clearTerminalScreen();
    stream.setEvents([]);
    stream.cancelStreamFlush();
    stream.setStreamingDelta('');
    stream.streamingBufferRef.current = '';
    if (action === 'clear') {
      if (notice) setSystemNotice(notice);
      return;
    }
    // 'new': full session reset.
    const ctrl = turn.turnControllerRef.current;
    if (ctrl && !ctrl.signal.aborted) ctrl.abort('user reset');
    session.log.clear();
    setOverlay(null);
    for (const p of permissions.pendingPermissions) {
      p.resolve({ mode: 'deny', reason: '/new — session reset' });
    }
    permissions.setPendingPermissions([]);
    permissions.setPendingApproval(null);
    turn.setBusy(false);
    setYolo(false);
    turn.queueRef.current = [];
    turn.setQueueCount(0);
    if (notice) setSystemNotice(notice);
  };

  const handleSubmit = async (text: string): Promise<void> => {
    setSystemNotice(null);
    setOverlay(null);
    if (text.startsWith('/')) {
      runSlash(text, {
        session,
        providerName,
        activeModel,
        modeName,
        setSystemNotice,
        setOverlay,
        setYolo,
        setPicker,
        queueRef: turn.queueRef,
        setQueueCount: turn.setQueueCount,
        performSessionAction,
      });
      return;
    }

    // Resolve image attachments at submit time so each queued message
    // carries its own snapshot of bytes; the placeholder counter resets
    // here so the next message starts numbering from #1 again.
    const resolved = await images.resolveAttachments(
      text,
      resolveActiveDescriptor(session, activeModel),
      providerName,
      activeModel,
    );
    if (!Array.isArray(resolved)) {
      setSystemNotice(resolved.error);
      return;
    }
    const attachments = resolved as UserPromptAttachment[];

    if (turn.busyRef.current) {
      turn.queueRef.current.push({ text, attachments });
      turn.setQueueCount(turn.queueRef.current.length);
      return;
    }

    await turn.runTurnWith(text, attachments);
  };

  // Hand off the prompt the user typed on the splash screen. Fires
  // once after mount — `firedInitial` guards against re-fires if the
  // wrapper ever re-renders us with the same prop.
  const firedInitial = useRef(false);
  useEffect(() => {
    if (firedInitial.current) return;
    if (!initialPrompt) return;
    firedInitial.current = true;
    void handleSubmit(initialPrompt);
    // handleSubmit closes over the latest state via refs; intentionally fired
    // once per initialPrompt. (react-hooks/exhaustive-deps is not wired in the
    // root lint config; re-add a disable directive here if it is.)
  }, [initialPrompt]);

  return (
    <Box flexDirection="column">
      <ChatView
        events={stream.events}
        streamingDelta={stream.streamingDelta}
        expandToolOutputs={expandToolOutputs}
        compactTools={compactTools}
        hideLive={
          overlay != null ||
          picker != null ||
          pendingPermission != null ||
          pendingApproval != null
        }
      />
      <OverlayOrNotice
        overlay={overlay}
        systemNotice={systemNotice}
        session={session}
        events={stream.events}
        contextWindow={contextWindow}
        contextTokens={contextUsed}
        onClose={() => setOverlay(null)}
      />
      <InteractiveZone
        session={session}
        pendingPermission={pendingPermission}
        pendingPermissionDepth={Math.max(0, permissions.pendingPermissions.length - 1)}
        pendingApproval={pendingApproval}
        picker={picker}
        busy={turn.busy}
        voiceReady={voice.ready}
        voicePhase={voice.phase}
        yolo={yolo}
        slashCommands={slashSuggestions}
        queueMessages={turn.queueRef.current}
        priorityMessage={turn.priorityMessage}
        commandHotkeys={commandHotkeys}
        onCycleMode={cycleMode}
        externalInsert={voice.externalInsert}
        onPermissionDecide={(perm, decision) => {
          permissions.setPendingPermissions((prev) => prev.slice(1));
          if (decision.mode === 'allow_always') {
            void session.permissions
              .addAllow({ name: perm.call.name, reason: 'allow_always via TUI dialog' })
              .catch(() => undefined);
          }
          perm.resolve(decision);
        }}
        onApprovalDecide={(decision) => {
          if (!pendingApproval) return;
          const { resolve } = pendingApproval;
          permissions.setPendingApproval(null);
          resolve(decision);
        }}
        onPickerSelect={handlePickerSelect}
        onPickerCancel={() => setPicker(null)}
        onSubmit={handleSubmit}
        onPasteText={images.handlePasteText}
      />
      <StatusLine
        busyStartedAt={
          turn.busy && !pendingPermission && !pendingApproval ? turn.busyStartedAt : null
        }
        queueCount={turn.queueCount}
        modeName={modeName}
        provider={providerName}
        model={activeModel}
        mcp={mcpStatus}
        contextUsed={contextUsed}
        {...(contextWindow ? { contextWindow } : {})}
      />
    </Box>
  );
};
