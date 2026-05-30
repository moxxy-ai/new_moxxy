import type { ClientSession as Session } from '@moxxy/sdk';
import { savePreferences } from '@moxxy/core';
import type { Picker } from './types.js';
import { openMcpPicker } from './run-slash.js';
import { appendCommandStateChanged } from './command-sync.js';

export interface PickerHandlerDeps {
  session: Session;
  providerName: string;
  setPicker: (p: Picker) => void;
  setSystemNotice: (msg: string | null) => void;
  setActiveModelOverride: (id: string) => void;
  refreshMcpStatus: () => Promise<void>;
  commandOriginId: string;
}

export function makePickerHandler(deps: PickerHandlerDeps): (picker: Picker, id: string) => void {
  return (picker, id) => {
    if (!picker) return;
    const kind = picker.kind;
    deps.setPicker(null);
    if (kind === 'mcp-server') {
      return handleMcpServerSelected(id, deps);
    }
    if (kind === 'mcp-action') {
      return handleMcpAction(picker.serverName, id, deps);
    }
    if (kind === 'model') {
      return handleModelSelected(id, deps);
    }
    if (kind === 'mode') {
      return handleModeSelected(id, deps);
    }
  };
}

function handleMcpServerSelected(id: string, deps: PickerHandlerDeps): void {
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
      deps.setPicker({
        kind: 'mcp-action',
        title: `${id} — pick an action`,
        serverName: id,
        options: [
          {
            id: 'toggle',
            label: toggleLabel,
            description: isDisabled
              ? 'register lazy stubs in this session'
              : 'detach live tools; keep config',
          },
          { id: 'remove', label: 'Remove', description: 'delete from ~/.moxxy/mcp.json' },
          { id: 'cancel', label: 'Cancel', description: 'close without changing anything' },
        ],
      });
    } catch (err) {
      deps.setSystemNotice(
        `failed to load action picker: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();
}

function handleMcpAction(serverName: string, id: string, deps: PickerHandlerDeps): void {
  if (id === 'cancel') {
    // Cancel pops back to the server list rather than closing the
    // whole modal — users hit Cancel when they picked the wrong
    // server, not because they want to abandon /mcp entirely.
    openMcpPicker(deps);
    return;
  }
  void (async () => {
    try {
      const { readMcpConfig, setServerDisabled, removeServerFromConfig } = await import(
        '@moxxy/plugin-mcp'
      );
      if (id === 'remove') {
        const ok = await removeServerFromConfig(serverName);
        const api = deps.session.mcpAdmin;
        if (api) await api.detach(serverName);
        deps.setSystemNotice(
          ok ? `✓ removed MCP server "${serverName}"` : `no MCP server named "${serverName}"`,
        );
        return;
      }
      if (id === 'toggle') {
        const cfg = await readMcpConfig();
        const current = cfg.servers.find((s) => s.name === serverName);
        if (!current) {
          deps.setSystemNotice(`no MCP server named "${serverName}"`);
          return;
        }
        const nextDisabled = !current.disabled;
        await setServerDisabled(serverName, nextDisabled);
        const api = deps.session.mcpAdmin;
        if (api) {
          if (nextDisabled) {
            await api.detach(serverName);
          } else {
            const r = await api.enableAndAttach(serverName);
            deps.setSystemNotice(
              r
                ? `✓ enabled "${serverName}" — ${r.toolNames.length} tool${r.toolNames.length === 1 ? '' : 's'} attached`
                : `enabled "${serverName}" in config but live attach failed`,
            );
            return;
          }
        }
        deps.setSystemNotice(`${nextDisabled ? '✗ disabled' : '✓ enabled'} "${serverName}"`);
      }
    } catch (err) {
      deps.setSystemNotice(
        `MCP action failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      void deps.refreshMcpStatus();
    }
  })();
}

function handleModelSelected(id: string, deps: PickerHandlerDeps): void {
  const [providerId, modelId] = id.split('::');
  if (!providerId || !modelId) return;
  // If the provider wasn't in the boot probe's ready set, switching
  // would surface a credential error on the next turn. Intercept
  // here and surface the right configuration command instead.
  const ready = deps.session.readyProviders ?? new Set<string>();
  if (!ready.has(providerId)) {
    const cmd =
      providerId === 'openai-codex'
        ? 'moxxy login openai-codex'
        : `moxxy init   # (will prompt for ${providerId.toUpperCase()}_API_KEY)`;
    deps.setSystemNotice(
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
      if (providerId !== deps.providerName) {
        const resolver = deps.session.credentialResolver;
        const cfg = resolver ? await resolver(providerId) : {};
        // Drop any previously-cached instance for this provider so the
        // freshly-resolved credentials actually take effect — setActive
        // alone keeps the first-cached instance.
        const def = deps.session.providers.list().find((p) => p.name === providerId);
        if (def) deps.session.providers.replace(def);
        deps.session.providers.setActive(providerId, cfg);
      }
      deps.setActiveModelOverride(modelId);
      const notice = `switched to ${providerId}:${modelId}`;
      deps.setSystemNotice(notice);
      void savePreferences({ providerName: providerId, model: modelId });
      void appendCommandStateChanged(deps.session, {
        command: `/model ${providerId}::${modelId}`,
        action: 'model_changed',
        target: 'session',
        origin_channel: 'tui',
        origin_id: deps.commandOriginId,
        notice,
        provider: providerId,
        model: modelId,
      });
    } catch (err) {
      deps.setSystemNotice(
        `failed to switch: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();
}

function handleModeSelected(id: string, deps: PickerHandlerDeps): void {
  try {
    deps.session.modes.setActive(id);
    const notice = `mode -> ${id}`;
    deps.setSystemNotice(notice);
    void savePreferences({ mode: id });
    void appendCommandStateChanged(deps.session, {
      command: `/loop ${id}`,
      action: 'loop_changed',
      target: 'session',
      origin_channel: 'tui',
      origin_id: deps.commandOriginId,
      notice,
      loop: id,
    });
  } catch (err) {
    deps.setSystemNotice(
      `failed to switch mode: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
