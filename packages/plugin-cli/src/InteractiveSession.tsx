import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type {
  ApprovalDecision,
  ApprovalRequest,
  MoxxyEvent,
  PendingToolCall,
  PermissionContext,
  PermissionDecision,
  UserPromptAttachment,
} from '@moxxy/sdk';
import { runTurn, type Session } from '@moxxy/core';
import {
  detectPastedImagePath,
  extractImagePlaceholders,
  loadImageAttachment,
} from './image-attachments.js';
import { readClipboardImageSync } from './clipboard-image.js';
import { ChatView } from './components/ChatView.js';
import { PromptInput } from './components/PromptInput.js';
import { PermissionDialog } from './components/PermissionDialog.js';
import { ApprovalDialog } from './components/ApprovalDialog.js';
import { StatusBar } from './components/StatusBar.js';
import { Logo } from './components/Logo.js';
import { SessionInfo } from './components/SessionInfo.js';
import { SkillsPanel } from './components/SkillsPanel.js';
import { ToolsPanel } from './components/ToolsPanel.js';
import { BUILTIN_SLASH_COMMANDS } from './components/SlashCommands.js';
import { ListPicker, type ListPickerOption } from './components/ListPicker.js';
import { estimateContextTokens } from './context-estimate.js';
import { savePreferences } from '@moxxy/core';

export interface InteractiveSessionProps {
  readonly session: Session;
  readonly registerInteractiveResolver: (
    prompt: (call: PendingToolCall, ctx: PermissionContext) => Promise<PermissionDecision>,
  ) => void;
  readonly model?: string;
  /**
   * Optional version string surfaced in the logo + session-info panel.
   * Source of truth: `@moxxy/cli`'s package.json — the bin resolves it
   * at boot and passes it down (avoids putting fs reads in the TUI).
   */
  readonly version?: string;
}

export const InteractiveSession: React.FC<InteractiveSessionProps> = ({
  session,
  registerInteractiveResolver,
  model,
  version,
}) => {
  const { exit } = useApp();
  const [events, setEvents] = useState<ReadonlyArray<MoxxyEvent>>([]);
  const [streamingDelta, setStreamingDelta] = useState('');
  const [busy, setBusy] = useState(false);
  // Wall-clock start of the active turn (epoch ms). Powers the spinner +
  // elapsed-time readout in the status bar. `null` between turns.
  const [busyStartedAt, setBusyStartedAt] = useState<number | null>(null);
  // Queued user messages typed while a turn is in flight. The queue is
  // drained when the current turn finishes: every queued entry is
  // concatenated into a single follow-up turn so the model sees the
  // user's accumulated input as one coherent prompt rather than N
  // micro-turns. `queueRef` is the source of truth (so async drain
  // closures see the latest list); `queueCount` is purely for re-render.
  const queueRef = useRef<Array<{ text: string; attachments: UserPromptAttachment[] }>>([]);
  const [queueCount, setQueueCount] = useState(0);
  // Mirror of `busy` for closures that need the latest value without
  // waiting for the next render (the submit handler is recreated each
  // render, but the user could submit between two state batches).
  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  const [systemNotice, setSystemNotice] = useState<string | null>(null);
  // Structured ephemeral overlay (mutually exclusive with systemNotice).
  // /skills and /tools render through here so they get full-color
  // typography instead of being squeezed into the yellow notice strip.
  const [overlay, setOverlay] = useState<
    | { kind: 'skills' }
    | { kind: 'tools' }
    | null
  >(null);
  // When true, closed skill scopes render expanded (children visible).
  // Default false = collapsed summary. Toggled by /expand and /collapse.
  // In-flight scopes ignore this flag and always render expanded so the
  // user can watch tools execute live.
  const [expandSkills, setExpandSkills] = useState(false);
  const [yolo, setYolo] = useState(false);
  const yoloRef = useRef(false);
  // MCP attach summary — refreshed on mount, after every /mcp action, and
  // every 5s while the session is open so lazy stubs that connect mid-turn
  // surface in the status bar without needing a user-driven refresh.
  const [mcpStatus, setMcpStatus] = useState<{ connected: number; enabled: number }>({
    connected: 0,
    enabled: 0,
  });
  const refreshMcpStatus = React.useCallback(async () => {
    const api = (session as unknown as {
      mcpAdmin?: { listServers: () => Promise<ReadonlyArray<{ enabled: boolean; connected: boolean }>> };
    }).mcpAdmin;
    if (!api?.listServers) return;
    try {
      const list = await api.listServers();
      const enabled = list.filter((s) => s.enabled);
      setMcpStatus({
        enabled: enabled.length,
        connected: enabled.filter((s) => s.connected).length,
      });
    } catch {
      // best-effort — leave the previous count visible
    }
  }, [session]);
  useEffect(() => {
    void refreshMcpStatus();
    const t = setInterval(() => void refreshMcpStatus(), 5000);
    return () => clearInterval(t);
  }, [refreshMcpStatus]);
  // Mid-session model override. When the user picks a model via /model,
  // this takes precedence over the prop passed in at mount time.
  const [activeModelOverride, setActiveModelOverride] = useState<string | null>(null);
  const [picker, setPicker] = useState<
    | null
    | { kind: 'model' | 'loop'; title: string; options: ReadonlyArray<ListPickerOption> }
    | { kind: 'mcp-server'; title: string; options: ReadonlyArray<ListPickerOption> }
    | { kind: 'mcp-action'; title: string; serverName: string; options: ReadonlyArray<ListPickerOption> }
  >(null);
  const [pendingPermission, setPendingPermission] = useState<{
    call: PendingToolCall;
    ctx: PermissionContext;
    resolve: (d: PermissionDecision) => void;
  } | null>(null);
  // Generic approval queue. Loop strategies push checkpoint questions
  // here via the resolver we install on the Session; the dialog drains
  // it one at a time. Same shape as pendingPermission — single
  // outstanding question with an inline resolve closure.
  const [pendingApproval, setPendingApproval] = useState<{
    request: ApprovalRequest;
    resolve: (d: ApprovalDecision) => void;
  } | null>(null);
  const streamingBufferRef = useRef('');
  // Per-turn abort controller. Esc while busy aborts THIS turn without
  // poisoning the session's own controller, so the next prompt still
  // runs normally.
  const turnControllerRef = useRef<AbortController | null>(null);

  // Pending images keyed by the integer in `[Image #N]` placeholders.
  // Promise<UserPromptAttachment | null>: null means the read failed,
  // which we surface as a notice but keep the placeholder text visible
  // so the user can see what went wrong. Cleared after a successful
  // submit so subsequent turns get fresh numbering.
  const imageAttachmentsRef = useRef<Map<number, Promise<UserPromptAttachment | null>>>(new Map());
  const nextImageIdRef = useRef(1);

  // Keep the yolo flag in a ref so the promptHandler closure (registered
  // once on mount) reads the latest value without a re-register.
  useEffect(() => {
    yoloRef.current = yolo;
  }, [yolo]);

  useEffect(() => {
    const unsub = session.log.subscribe((event) => {
      setEvents((prev) => [...prev, event]);
      if (event.type === 'assistant_chunk') {
        streamingBufferRef.current += event.delta;
        setStreamingDelta(streamingBufferRef.current);
      }
      if (event.type === 'assistant_message') {
        streamingBufferRef.current = '';
        setStreamingDelta('');
      }
    });

    registerInteractiveResolver(async (call, ctx) => {
      // YOLO mode: auto-allow every tool call without asking. Toggled via
      // `/yolo`. Useful for trusted workflows; the status bar shows it on.
      if (yoloRef.current) {
        return { mode: 'allow', reason: 'yolo mode' };
      }
      return new Promise<PermissionDecision>((resolve) => {
        setPendingPermission({ call, ctx, resolve });
      });
    });

    // Install a generic approval resolver so loop strategies that opt
    // into ctx.approval (plan-execute, future strategies) get a TUI
    // checkpoint dialog. Tears down on unmount so headless tests don't
    // accidentally inherit a dialog-bound resolver.
    session.setApprovalResolver({
      name: 'tui-approval',
      confirm: (request) =>
        new Promise<ApprovalDecision>((resolve) => {
          setPendingApproval({ request, resolve });
        }),
    });

    return () => {
      unsub();
      session.setApprovalResolver(null);
    };
  }, [session, registerInteractiveResolver]);

  // While the model is running, Esc / Ctrl+C cancels the turn. The
  // per-turn AbortController fires; loop strategies + provider streams
  // observe ctx.signal.aborted and bail out. PromptInput is disabled
  // during busy, so its own useInput doesn't fight us for these keys.
  useInput(
    (input, key) => {
      if (!busy) return;
      const isCancel =
        key.escape || (key.ctrl && input === 'c');
      if (isCancel) {
        const ctrl = turnControllerRef.current;
        if (ctrl && !ctrl.signal.aborted) {
          ctrl.abort('user cancel');
          setSystemNotice('turn cancelled');
        }
      }
    },
    { isActive: busy },
  );

  // Always-on Ctrl+B handler: toggle global skill-scope expand/collapse.
  // Lives outside the busy gate so the hotkey works both while typing
  // and while a turn is in flight. PromptInput's useInput doesn't
  // intercept Ctrl+B (it gates printable input on !key.ctrl), so the
  // keystroke passes through cleanly.
  useInput((input, key) => {
    if (key.ctrl && input === 'b') {
      setExpandSkills((e) => {
        const next = !e;
        setSystemNotice(
          next
            ? 'skill scopes expanded — Ctrl+B again to collapse'
            : 'skill scopes collapsed — Ctrl+B again to expand',
        );
        return next;
      });
    }
  });

  // Snapshot the session's stable session metadata for the header table.
  const providerName = session.providers.getActiveName() ?? '(none)';
  const activeModel =
    activeModelOverride ??
    model ?? (() => {
      try {
        return session.providers.getActive().models[0]?.id ?? 'default';
      } catch {
        return 'default';
      }
    })();
  // Look up the active model's context window from its ModelDescriptor —
  // need this for the percentage meter on the status bar. The active
  // ModelDescriptor isn't tracked centrally, so we match by id on the
  // active provider's `models` list.
  const contextWindow = (() => {
    try {
      const provider = session.providers.getActive();
      const match = provider.models.find((m) => m.id === activeModel);
      return match?.contextWindow ?? provider.models[0]?.contextWindow ?? null;
    } catch {
      return null;
    }
  })();
  // Re-estimate every render. estimateContextTokens is char-cheap so
  // this stays well under a millisecond even on busy logs.
  const contextUsed = estimateContextTokens(session.log);

  const loopName = (() => {
    try {
      return session.loops.getActive().name;
    } catch {
      return '(none)';
    }
  })();
  const toolCount = session.tools.list().length;
  const skillCount = session.skills.list().length;
  const pluginCount = session.pluginHost.list().length;

  const handlePickerSelect = (id: string): void => {
    if (!picker) return;
    const currentPicker = picker;
    const kind = currentPicker.kind;
    setPicker(null);
    if (kind === 'mcp-server') {
      // Step 2 of the /mcp flow: opened the action picker for the
      // selected server. We need to re-derive the disabled flag for the
      // action label so the picker accurately reads "disable" vs "enable".
      void (async () => {
        try {
          const { readMcpConfig } = await import('@moxxy/plugin-mcp');
          const cfg = await readMcpConfig();
          const server = cfg.servers.find((s) => s.name === id);
          const isDisabled = server?.disabled ?? false;
          const toggleLabel = isDisabled ? 'Enable' : 'Disable';
          setPicker({
            kind: 'mcp-action',
            title: `${id} — pick an action`,
            serverName: id,
            options: [
              { id: 'toggle', label: toggleLabel, description: isDisabled ? 'register lazy stubs in this session' : 'detach live tools; keep config' },
              { id: 'remove', label: 'Remove', description: 'delete from ~/.moxxy/mcp.json' },
              { id: 'cancel', label: 'Cancel', description: 'close without changing anything' },
            ],
          });
        } catch (err) {
          setSystemNotice(`failed to load action picker: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
      return;
    }
    if (kind === 'mcp-action') {
      const serverName = currentPicker.serverName;
      if (id === 'cancel') return;
      void (async () => {
        try {
          const { readMcpConfig, setServerDisabled, removeServerFromConfig } = await import('@moxxy/plugin-mcp');
          if (id === 'remove') {
            const ok = await removeServerFromConfig(serverName);
            const api = (session as unknown as { mcpAdmin?: { detach: (n: string) => Promise<boolean> } }).mcpAdmin;
            if (api) await api.detach(serverName);
            setSystemNotice(ok ? `✓ removed MCP server "${serverName}"` : `no MCP server named "${serverName}"`);
            return;
          }
          if (id === 'toggle') {
            const cfg = await readMcpConfig();
            const current = cfg.servers.find((s) => s.name === serverName);
            if (!current) {
              setSystemNotice(`no MCP server named "${serverName}"`);
              return;
            }
            const nextDisabled = !current.disabled;
            await setServerDisabled(serverName, nextDisabled);
            const api = (session as unknown as {
              mcpAdmin?: {
                enableAndAttach: (n: string) => Promise<{ toolNames: ReadonlyArray<string> } | null>;
                detach: (n: string) => Promise<boolean>;
              };
            }).mcpAdmin;
            if (api) {
              if (nextDisabled) {
                await api.detach(serverName);
              } else {
                const r = await api.enableAndAttach(serverName);
                setSystemNotice(
                  r
                    ? `✓ enabled "${serverName}" — ${r.toolNames.length} tool${r.toolNames.length === 1 ? '' : 's'} attached`
                    : `enabled "${serverName}" in config but live attach failed`,
                );
                return;
              }
            }
            setSystemNotice(`${nextDisabled ? '✗ disabled' : '✓ enabled'} "${serverName}"`);
          }
        } catch (err) {
          setSystemNotice(`MCP action failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          void refreshMcpStatus();
        }
      })();
      return;
    }
    if (kind === 'model') {
      const [providerId, modelId] = id.split('::');
      if (!providerId || !modelId) return;
      // If the provider wasn't in the boot probe's ready set, switching
      // would surface a credential error on the next turn. Intercept
      // here and surface the right configuration command instead.
      const ready =
        (session as unknown as { readyProviders?: Set<string> }).readyProviders ?? new Set<string>();
      if (!ready.has(providerId)) {
        const cmd =
          providerId === 'openai-codex'
            ? 'moxxy login openai-codex'
            : `moxxy init   # (will prompt for ${providerId.toUpperCase()}_API_KEY)`;
        setSystemNotice(
          `${providerId} isn't connected. Run \`${cmd}\` then restart moxxy.\n` +
            `Alternatively set the ${providerId.toUpperCase()}_API_KEY env var before launching.`,
        );
        return;
      }
      // Provider switches must resolve credentials (vault tokens for
      // OAuth providers, API keys for the rest) before setActive — the
      // registry caches the instance on first activation, so passing
      // empty config strands the new provider without auth. The CLI
      // stashes a credentialResolver on the session at boot.
      void (async () => {
        try {
          if (providerId !== providerName) {
            const resolver = (
              session as unknown as {
                credentialResolver?: (name: string) => Promise<Record<string, unknown>>;
              }
            ).credentialResolver;
            const cfg = resolver ? await resolver(providerId) : {};
            // Drop any previously-cached instance for this provider so the
            // freshly-resolved credentials actually take effect — setActive
            // alone keeps the first-cached instance.
            const def = session.providers.list().find((p) => p.name === providerId);
            if (def) session.providers.replace(def);
            session.providers.setActive(providerId, cfg);
          }
          setActiveModelOverride(modelId);
          setSystemNotice(`switched to ${providerId}:${modelId}`);
          void savePreferences({ providerName: providerId, model: modelId });
        } catch (err) {
          setSystemNotice(
            `failed to switch: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
      return;
    }
    if (kind === 'loop') {
      try {
        session.loops.setActive(id);
        setSystemNotice(`loop strategy → ${id}`);
        void savePreferences({ loopStrategy: id });
      } catch (err) {
        setSystemNotice(
          `failed to switch loop: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };

  const runSlash = (cmd: string): void => {
    const [head] = cmd.split(/\s+/);
    switch (head) {
      case '/exit':
      case '/quit':
      case '/q':
        exit();
        return;
      case '/clear':
        setEvents([]);
        setStreamingDelta('');
        streamingBufferRef.current = '';
        setSystemNotice('chat scrollback cleared (events still in the log)');
        return;
      case '/new': {
        // Hard reset: abort any in-flight turn, wipe the underlying
        // event log so the next prompt starts with empty conversation
        // context, and drop every UI overlay. Active provider/model/
        // loop are preserved — those are user choices, not session
        // state. YOLO is reset to its safe default (off) because it's
        // a per-session safety toggle; conversation memory ending
        // shouldn't carry an auto-approve flag forward implicitly.
        const ctrl = turnControllerRef.current;
        if (ctrl && !ctrl.signal.aborted) ctrl.abort('user reset');
        session.log.clear();
        setEvents([]);
        setStreamingDelta('');
        streamingBufferRef.current = '';
        setOverlay(null);
        setPendingPermission(null);
        setPendingApproval(null);
        setBusy(false);
        setYolo(false);
        queueRef.current = [];
        setQueueCount(0);
        setSystemNotice('new session — conversation history cleared');
        return;
      }
      case '/queue': {
        if (queueRef.current.length === 0) {
          setSystemNotice('no messages queued');
          return;
        }
        const previews = queueRef.current
          .map((q, i) => `${i + 1}. ${q.text.length > 80 ? q.text.slice(0, 77) + '…' : q.text}`)
          .join('\n');
        setSystemNotice(
          `${queueRef.current.length} queued message${queueRef.current.length === 1 ? '' : 's'}:\n${previews}`,
        );
        return;
      }
      case '/clear-queue': {
        const n = queueRef.current.length;
        queueRef.current = [];
        setQueueCount(0);
        setSystemNotice(n === 0 ? 'queue was already empty' : `dropped ${n} queued message${n === 1 ? '' : 's'}`);
        return;
      }
      case '/tools':
        setSystemNotice(null);
        setOverlay({ kind: 'tools' });
        return;
      case '/skills':
        setSystemNotice(null);
        setOverlay({ kind: 'skills' });
        return;
      case '/expand':
        setExpandSkills(true);
        setSystemNotice('skill scopes expanded (use /collapse to re-collapse)');
        return;
      case '/collapse':
        setExpandSkills(false);
        setSystemNotice('skill scopes collapsed');
        return;
      case '/model': {
        // Build a flat list of all (provider, model) pairs across every
        // registered provider — the user can switch BOTH provider and
        // model in one pick. Grouping is by provider name. Providers
        // that didn't pass credential probing at boot are tagged
        // "not connected" so the user knows they need setup first.
        const providers = session.providers.list();
        if (providers.length === 0) {
          setSystemNotice('no providers registered');
          return;
        }
        const ready =
          (session as unknown as { readyProviders?: Set<string> }).readyProviders ?? new Set<string>();
        const options: ListPickerOption[] = [];
        for (const p of providers) {
          const isReady = ready.has(p.name);
          for (const m of p.models) {
            options.push({
              id: `${p.name}::${m.id}`,
              label: m.id,
              group: p.name,
              current: providerName === p.name && activeModel === m.id,
              description: m.contextWindow ? `${formatTokensShort(m.contextWindow)} ctx` : undefined,
              ...(isReady ? {} : { badge: 'not connected', badgeColor: 'red' as const }),
            });
          }
        }
        setPicker({
          kind: 'model',
          title: 'Switch model',
          options,
        });
        return;
      }
      case '/mcp': {
        // Open a server picker. Selecting one opens the action picker
        // (enable/disable/remove/cancel). MCP catalog state lives in
        // ~/.moxxy/mcp.json; we read it lazily here so changes from the
        // CLI (moxxy mcp ...) show up immediately on next invocation.
        void (async () => {
          try {
            const { readMcpConfig } = await import('@moxxy/plugin-mcp');
            const cfg = await readMcpConfig();
            if (cfg.servers.length === 0) {
              setSystemNotice('no MCP servers registered — add one in chat via mcp_add_server');
              return;
            }
            const options: ListPickerOption[] = cfg.servers.map((s) => {
              const status = s.disabled ? 'disabled' : 'enabled';
              const toolCount = s.cachedTools?.length ?? 0;
              return {
                id: s.name,
                label: s.name,
                description: `${status} · ${toolCount} tool${toolCount === 1 ? '' : 's'}`,
                current: false,
              };
            });
            setPicker({ kind: 'mcp-server', title: 'Pick an MCP server', options });
          } catch (err) {
            setSystemNotice(`failed to read MCP catalog: ${err instanceof Error ? err.message : String(err)}`);
          }
        })();
        return;
      }
      case '/loop': {
        const strategies = session.loops.list();
        const options: ListPickerOption[] = strategies.map((s) => ({
          id: s.name,
          label: s.name,
          current: s.name === loopName,
        }));
        if (options.length === 0) {
          setSystemNotice('no loop strategies registered');
          return;
        }
        setPicker({ kind: 'loop', title: 'Switch loop strategy', options });
        return;
      }
      case '/yolo':
      case '/auto-approve':
        setYolo((y) => {
          const next = !y;
          setSystemNotice(
            next
              ? '⚠ yolo mode ON — tool calls auto-approved for the rest of this session'
              : 'yolo mode OFF — tool prompts will resume',
          );
          return next;
        });
        return;
      case '/help':
        setSystemNotice(
          BUILTIN_SLASH_COMMANDS.map((c) => `/${c.name}  — ${c.description}`).join('\n'),
        );
        return;
      default:
        setSystemNotice(`unknown command: ${cmd}   (try /help)`);
        return;
    }
  };

  const registerImage = (detected: ReturnType<typeof detectPastedImagePath>): string => {
    if (!detected) return '';
    const id = nextImageIdRef.current;
    nextImageIdRef.current += 1;
    imageAttachmentsRef.current.set(
      id,
      loadImageAttachment(detected).catch((err) => {
        setSystemNotice(
          `failed to read image ${detected.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }),
    );
    return `[Image #${id}]`;
  };

  const handlePasteText = (pasted: string): string => {
    // Path 1: pasted text itself is a file path to an image (drag-drop
    // from Finder, "Copy as Path", or `pbcopy <path>`).
    const pathDetected = detectPastedImagePath(pasted);
    if (pathDetected) return registerImage(pathDetected);

    // Path 2: terminals fire bracketed paste with empty / whitespace
    // content when the clipboard holds an image (e.g. a screenshot
    // copied via Cmd+Shift+Ctrl+4). Probe the system clipboard for an
    // image and route it through the same pipeline. Falls back to the
    // raw paste if the clipboard has no image (or the platform isn't
    // supported), so plain text pastes are unaffected.
    if (pasted.trim() === '') {
      const fromClipboard = readClipboardImageSync();
      if (fromClipboard) return registerImage(fromClipboard);
    }
    return pasted;
  };

  /**
   * Resolve `[Image #N]` placeholders in `text` to attachment payloads
   * and clear the per-prompt image map (so future submissions get fresh
   * placeholder numbering). Returns `null` if the active model can't
   * accept images — caller surfaces the user-facing notice.
   */
  const resolveAttachments = async (
    text: string,
  ): Promise<UserPromptAttachment[] | { error: string }> => {
    const referencedIds = extractImagePlaceholders(text);
    if (referencedIds.length === 0) return [];
    const activeDescriptor = (() => {
      try {
        const provider = session.providers.getActive();
        return provider.models.find((m) => m.id === activeModel) ?? null;
      } catch {
        return null;
      }
    })();
    if (activeDescriptor && activeDescriptor.supportsImages !== true) {
      return {
        error: `${providerName}:${activeModel} doesn't accept images — switch to a vision-capable model via /model`,
      };
    }
    const attachments: UserPromptAttachment[] = [];
    for (const id of referencedIds) {
      const pending = imageAttachmentsRef.current.get(id);
      if (!pending) continue;
      const att = await pending;
      if (att) attachments.push(att);
    }
    imageAttachmentsRef.current.clear();
    nextImageIdRef.current = 1;
    return attachments;
  };

  const runTurnWith = async (
    text: string,
    attachments: UserPromptAttachment[],
  ): Promise<void> => {
    setBusy(true);
    busyRef.current = true;
    setBusyStartedAt(Date.now());
    streamingBufferRef.current = '';
    setStreamingDelta('');
    const effectiveModel = activeModelOverride ?? model;
    // Fresh controller per turn so Esc cancels just this turn, not the
    // session.
    const controller = new AbortController();
    turnControllerRef.current = controller;
    try {
      for await (const _event of runTurn(session, text, {
        ...(effectiveModel ? { model: effectiveModel } : {}),
        signal: controller.signal,
        ...(attachments.length > 0 ? { attachments } : {}),
      })) {
        void _event;
      }
    } catch (err) {
      // surfaced via error events; nothing extra to do
      void err;
    } finally {
      turnControllerRef.current = null;
      setBusy(false);
      busyRef.current = false;
      setBusyStartedAt(null);
      // Drain any messages the user queued while this turn was running.
      // `drainQueue` calls back into `runTurnWith`, so messages queued
      // *during* the drain itself get picked up by the next finally too.
      await drainQueue();
    }
  };

  /**
   * Concatenate every queued message into one follow-up turn and run
   * it. We join with a blank line so the model can still see the
   * boundaries between the user's separate thoughts, but the whole
   * batch counts as a single conversational turn rather than N
   * micro-turns. Idempotent when the queue is empty.
   */
  const drainQueue = async (): Promise<void> => {
    if (queueRef.current.length === 0) return;
    const batch = queueRef.current.splice(0);
    setQueueCount(0);
    const joinedText = batch.map((b) => b.text).join('\n\n');
    const joinedAtts = batch.flatMap((b) => b.attachments);
    await runTurnWith(joinedText, joinedAtts);
  };

  const handleSubmit = async (text: string): Promise<void> => {
    setSystemNotice(null);
    setOverlay(null);
    if (text.startsWith('/')) {
      runSlash(text);
      return;
    }

    // Resolve image attachments at submit time so each queued message
    // carries its own snapshot of bytes; the placeholder counter resets
    // here so the next message starts numbering from #1 again.
    const resolved = await resolveAttachments(text);
    if (!Array.isArray(resolved)) {
      setSystemNotice(resolved.error);
      return;
    }

    if (busyRef.current) {
      queueRef.current.push({ text, attachments: resolved });
      setQueueCount(queueRef.current.length);
      return;
    }

    await runTurnWith(text, resolved);
  };

  return (
    <Box flexDirection="column">
      <Logo {...(version ? { version } : {})} />
      <SessionInfo
        loop={loopName}
        provider={providerName}
        model={activeModel}
        toolCount={toolCount}
        skillCount={skillCount}
        pluginCount={pluginCount}
        {...(version ? { version: `v${version}` } : {})}
      />
      <Box>
        <Text dimColor>type / for commands · /exit to quit</Text>
      </Box>
      <ChatView events={events} streamingDelta={streamingDelta} expandClosedSkills={expandSkills} />
      {overlay?.kind === 'skills' ? (
        <SkillsPanel skills={session.skills.list()} mcpServers={deriveMcpServers(session.tools.list())} />
      ) : overlay?.kind === 'tools' ? (
        <ToolsPanel tools={session.tools.list()} />
      ) : systemNotice ? (
        <Box marginTop={1} marginBottom={1} flexDirection="column">
          {systemNotice.split('\n').map((line, i) => (
            <Text key={i} color="yellow">{line}</Text>
          ))}
        </Box>
      ) : null}
      {pendingPermission ? (
        <PermissionDialog
          call={pendingPermission.call}
          toolDescription={session.tools.get(pendingPermission.call.name)?.description}
          onDecide={(decision) => {
            const { call, resolve } = pendingPermission;
            setPendingPermission(null);
            if (decision.mode === 'allow_always') {
              void session.permissions
                .addAllow({ name: call.name, reason: 'allow_always via TUI dialog' })
                .catch(() => undefined);
            }
            resolve(decision);
          }}
        />
      ) : pendingApproval ? (
        <ApprovalDialog
          request={pendingApproval.request}
          onDecide={(decision) => {
            const { resolve } = pendingApproval;
            setPendingApproval(null);
            resolve(decision);
          }}
        />
      ) : picker ? (
        <ListPicker
          title={picker.title}
          options={picker.options}
          onSelect={handlePickerSelect}
          onCancel={() => setPicker(null)}
        />
      ) : (
        <PromptInput
          onSubmit={handleSubmit}
          disabled={false}
          placeholder={
            busy
              ? 'type to queue a message — sent after the current turn'
              : 'type a prompt or / for commands'
          }
          onPasteText={handlePasteText}
        />
      )}
      <StatusBar
        provider={providerName}
        model={activeModel}
        contextUsed={contextUsed}
        contextWindow={contextWindow ?? undefined}
        yolo={yolo}
        mcp={mcpStatus}
        busyStartedAt={busy && !pendingPermission && !pendingApproval ? busyStartedAt : null}
        queueCount={queueCount}
      />
    </Box>
  );
};

function formatTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

/**
 * Group MCP tools (those prefixed `mcp__<server>__*`) by server name
 * for the SkillsPanel summary. Reads the live tool registry — only
 * servers whose tools are currently registered appear, so the section
 * reflects the actual catalog the model can call right now.
 */
function deriveMcpServers(
  tools: ReadonlyArray<{ readonly name: string }>,
): ReadonlyArray<{ name: string; toolCount: number; toolNames: ReadonlyArray<string> }> {
  const grouped = new Map<string, string[]>();
  for (const t of tools) {
    const m = /^mcp__([a-z0-9-]+)__/.exec(t.name);
    if (!m) continue;
    const server = m[1]!;
    const list = grouped.get(server) ?? [];
    list.push(t.name);
    grouped.set(server, list);
  }
  return [...grouped.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, toolNames]) => ({ name, toolCount: toolNames.length, toolNames }));
}
