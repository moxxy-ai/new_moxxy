import type React from 'react';
import { savePreferences, clearUsageStats } from '@moxxy/core';
import type { ClientSession as Session } from '@moxxy/sdk';
import type { UserPromptAttachment } from '@moxxy/sdk';
import type { ListPickerOption } from '../components/ListPicker.js';
import type { Overlay, Picker } from './types.js';
import { formatTokensShort } from './helpers.js';

export interface SlashDeps {
  session: Session;
  providerName: string;
  activeModel: string;
  modeName: string;
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
  // `/workflows` opens an interactive TUI modal (list + enable/disable + run),
  // intercepted BEFORE the command registry so the overlay wins here while
  // non-TUI channels (which don't run this code) still get the text command.
  if (name === 'workflows' || name === 'workflow' || name === 'flows') {
    deps.setSystemNotice(null);
    deps.setOverlay({ kind: 'workflows' });
    return;
  }

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
    case '/usage':
      deps.setSystemNotice(null);
      // `/usage clear` resets the saved cross-session aggregate; bare `/usage`
      // opens the panel. Clearing is a user-only action (no model tool).
      if (args.trim() === 'clear') {
        void clearUsageStats()
          .then(() => deps.setSystemNotice('✓ Cleared saved cross-session usage stats.'))
          .catch((err) =>
            deps.setSystemNotice(
              `failed to clear usage stats: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        return;
      }
      deps.setOverlay({ kind: 'usage' });
      return;
    case '/model':
      return openModelPicker(deps);
    case '/mcp':
      return openMcpPicker(deps);
    case '/mode':
    case '/loop':
      return openModePicker(deps, args);
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
  // model in one pick. Grouping is by provider name. Providers whose
  // credentials don't resolve are tagged "not connected".
  const providers = deps.session.providers.list();
  if (providers.length === 0) {
    deps.setSystemNotice('no providers registered');
    return;
  }
  // Re-probe credential readiness live rather than trusting the boot-time
  // snapshot: providers can be added (provider_add) and keys stored (/vault)
  // at runtime, which the boot snapshot never sees. We refresh
  // session.readyProviders so the selection guard (picker-handlers) agrees.
  void (async () => {
    const sess = deps.session;
    let ready = sess.readyProviders ?? new Set<string>();
    if (sess.credentialResolver) {
      const resolver = sess.credentialResolver;
      const fresh = new Set<string>();
      // The active provider is working by definition — always ready, even if
      // a non-interactive re-resolve of its (e.g. OAuth) creds would fail.
      if (deps.providerName) fresh.add(deps.providerName);
      await Promise.all(
        providers.map(async (p) => {
          if (fresh.has(p.name)) return;
          try {
            await resolver(p.name);
            fresh.add(p.name);
          } catch {
            // leave out — not connected
          }
        }),
      );
      ready = fresh;
      sess.readyProviders = fresh;
    }

    // One tab per provider — each tab carries its own searchable list,
    // so the user lands on (e.g.) anthropic and can type "haiku" without
    // wading past 200 unrelated entries from other providers. Tabs that
    // belong to a not-yet-connected provider keep their label but every
    // option inside gets the `not connected` red badge.
    const tabs = providers.map((p) => {
      const isReady = ready.has(p.name);
      const options: ListPickerOption[] = p.models.map((m) => ({
        id: `${p.name}::${m.id}`,
        label: m.id,
        current: deps.providerName === p.name && deps.activeModel === m.id,
        ...(m.contextWindow
          ? { description: `${formatTokensShort(m.contextWindow)} ctx` }
          : {}),
        ...(isReady ? {} : { badge: 'not connected', badgeColor: 'red' as const }),
      }));
      const label = isReady
        ? `${p.name} (${p.models.length})`
        : `${p.name} (offline)`;
      return { id: p.name, label, options };
    });
    deps.setPicker({
      kind: 'model',
      title: 'Switch model',
      tabs,
      initialTabId: deps.providerName,
      searchable: true,
      searchPlaceholder: 'filter models…',
    });
  })();
}

/**
 * Subset of deps `openMcpPicker` actually touches. Exported so the
 * picker-handlers Cancel path can re-open the server list (Cancel in
 * the action picker should walk back to the parent, not close the
 * whole modal) without dragging the rest of SlashDeps along.
 */
export interface OpenMcpPickerDeps {
  setPicker: (p: Picker) => void;
  setSystemNotice: (msg: string | null) => void;
}

export function openMcpPicker(deps: OpenMcpPickerDeps): void {
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

function openModePicker(deps: SlashDeps, arg = ''): void {
  const modes = deps.session.modes.list();
  if (modes.length === 0) {
    deps.setSystemNotice('no modes registered');
    return;
  }
  // `/mode <name>` switches directly when the argument names a mode;
  // otherwise (no arg, or no match) fall back to the interactive picker.
  const target = arg.trim().toLowerCase();
  if (target) {
    const match = modes.find((m) => m.name.toLowerCase() === target);
    if (match) {
      try {
        deps.session.modes.setActive(match.name);
        deps.setSystemNotice(`mode → ${match.name}`);
        void savePreferences({ mode: match.name });
      } catch (err) {
        deps.setSystemNotice(
          `failed to switch mode: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }
    deps.setSystemNotice(
      `no mode named "${arg.trim()}". Available: ${modes.map((m) => m.name).join(', ')}`,
    );
    return;
  }
  const options: ListPickerOption[] = modes.map((s) => ({
    id: s.name,
    label: s.name,
    current: s.name === deps.modeName,
    ...(s.description ? { description: truncate(s.description, 80) } : {}),
  }));
  deps.setPicker({ kind: 'mode', title: 'Switch mode', options });
}

/**
 * Trim a one-line summary so a long description doesn't overflow the
 * picker row. ListPicker already wraps with `truncate` for column
 * widths, but the picker description column is fluid so we cap at
 * ~80 chars here to keep things sane on narrower terminals too.
 */
function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
