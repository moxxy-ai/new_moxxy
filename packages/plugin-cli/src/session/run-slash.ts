import type React from 'react';
import type { Session } from '@moxxy/core';
import type { UserPromptAttachment } from '@moxxy/sdk';
import type { ListPickerOption } from '../components/ListPicker.js';
import type { Overlay, Picker } from './types.js';
import { formatTokensShort } from './helpers.js';

export interface SlashDeps {
  session: Session;
  providerName: string;
  activeModel: string;
  loopName: string;
  setSystemNotice: (msg: string | null) => void;
  setOverlay: React.Dispatch<React.SetStateAction<Overlay>>;
  setYolo: React.Dispatch<React.SetStateAction<boolean>>;
  setPicker: React.Dispatch<React.SetStateAction<Picker>>;
  queueRef: React.MutableRefObject<Array<{ text: string; attachments: UserPromptAttachment[] }>>;
  setQueueCount: React.Dispatch<React.SetStateAction<number>>;
  performSessionAction: (action: 'new' | 'clear' | 'exit', notice?: string) => void;
}

export function runSlash(cmd: string, deps: SlashDeps): void {
  const [head, ...rest] = cmd.split(/\s+/);
  const name = head!.slice(1); // drop leading "/"
  const args = rest.join(' ');

  // First: route through the channel-agnostic command registry.
  // Plugins (/info, /clear, /new, /exit, /help, ...) and any
  // user-defined commands live here.
  const registered = deps.session.commands.get(name);
  if (registered) {
    void (async () => {
      try {
        if (registered.pendingNotice) deps.setSystemNotice(registered.pendingNotice);
        const result = await registered.handler({
          channel: 'tui',
          sessionId: deps.session.id,
          args,
          session: deps.session,
        });
        if (result.kind === 'text') {
          deps.setSystemNotice(result.text);
        } else if (result.kind === 'session-action') {
          deps.performSessionAction(result.action, result.notice);
        } else if (result.kind === 'error') {
          deps.setSystemNotice(`error: ${result.message}`);
        }
      } catch (err) {
        deps.setSystemNotice(
          `command /${name} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
    return;
  }

  // Channel-local commands the registry can't host because their
  // handlers mutate React state or open Ink overlays.
  switch (head) {
    case '/queue':
      return handleQueue(deps);
    case '/clear-queue':
      return handleClearQueue(deps);
    case '/tools':
      deps.setSystemNotice(null);
      deps.setOverlay({ kind: 'tools' });
      return;
    case '/skills':
      deps.setSystemNotice(null);
      deps.setOverlay({ kind: 'skills' });
      return;
    case '/agents':
      deps.setSystemNotice(null);
      deps.setOverlay({ kind: 'agents' });
      return;
    case '/model':
      return openModelPicker(deps);
    case '/mcp':
      return openMcpPicker(deps);
    case '/loop':
      return openLoopPicker(deps);
    case '/yolo':
    case '/auto-approve':
      deps.setYolo((y) => {
        const next = !y;
        deps.setSystemNotice(
          next
            ? '⚠ yolo mode ON — tool calls auto-approved for the rest of this session'
            : 'yolo mode OFF — tool prompts will resume',
        );
        return next;
      });
      return;
    default:
      deps.setSystemNotice(`unknown command: ${cmd}   (try /help)`);
      return;
  }
}

function handleQueue(deps: SlashDeps): void {
  if (deps.queueRef.current.length === 0) {
    deps.setSystemNotice('no messages queued');
    return;
  }
  const previews = deps.queueRef.current
    .map((q, i) => `${i + 1}. ${q.text.length > 80 ? q.text.slice(0, 77) + '…' : q.text}`)
    .join('\n');
  deps.setSystemNotice(
    `${deps.queueRef.current.length} queued message${deps.queueRef.current.length === 1 ? '' : 's'}:\n${previews}`,
  );
}

function handleClearQueue(deps: SlashDeps): void {
  const n = deps.queueRef.current.length;
  deps.queueRef.current = [];
  deps.setQueueCount(0);
  deps.setSystemNotice(
    n === 0 ? 'queue was already empty' : `dropped ${n} queued message${n === 1 ? '' : 's'}`,
  );
}

function openModelPicker(deps: SlashDeps): void {
  // Build a flat list of all (provider, model) pairs across every
  // registered provider — the user can switch BOTH provider and
  // model in one pick. Grouping is by provider name. Providers
  // that didn't pass credential probing at boot are tagged
  // "not connected" so the user knows they need setup first.
  const providers = deps.session.providers.list();
  if (providers.length === 0) {
    deps.setSystemNotice('no providers registered');
    return;
  }
  const ready =
    (deps.session as unknown as { readyProviders?: Set<string> }).readyProviders ??
    new Set<string>();
  const options: ListPickerOption[] = [];
  for (const p of providers) {
    const isReady = ready.has(p.name);
    for (const m of p.models) {
      options.push({
        id: `${p.name}::${m.id}`,
        label: m.id,
        group: p.name,
        current: deps.providerName === p.name && deps.activeModel === m.id,
        description: m.contextWindow ? `${formatTokensShort(m.contextWindow)} ctx` : undefined,
        ...(isReady ? {} : { badge: 'not connected', badgeColor: 'red' as const }),
      });
    }
  }
  deps.setPicker({
    kind: 'model',
    title: 'Switch model',
    options,
  });
}

function openMcpPicker(deps: SlashDeps): void {
  // Open a server picker. Selecting one opens the action picker
  // (enable/disable/remove/cancel). MCP catalog state lives in
  // ~/.moxxy/mcp.json; we read it lazily here so changes from the
  // CLI (moxxy mcp ...) show up immediately on next invocation.
  void (async () => {
    try {
      const { readMcpConfig } = await import('@moxxy/plugin-mcp');
      const cfg = await readMcpConfig();
      if (cfg.servers.length === 0) {
        deps.setSystemNotice('no MCP servers registered — add one in chat via mcp_add_server');
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
      deps.setPicker({ kind: 'mcp-server', title: 'Pick an MCP server', options });
    } catch (err) {
      deps.setSystemNotice(
        `failed to read MCP catalog: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();
}

function openLoopPicker(deps: SlashDeps): void {
  const strategies = deps.session.loops.list();
  const options: ListPickerOption[] = strategies.map((s) => ({
    id: s.name,
    label: s.name,
    current: s.name === deps.loopName,
  }));
  if (options.length === 0) {
    deps.setSystemNotice('no loop strategies registered');
    return;
  }
  deps.setPicker({ kind: 'loop', title: 'Switch loop strategy', options });
}
