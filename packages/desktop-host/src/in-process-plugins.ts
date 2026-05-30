/**
 * In-process moxxy plugin host for the desktop.
 *
 * Before this module the desktop was a *pure* thin client — every
 * capability (chat, transcribe, slash commands, …) round-tripped
 * through the runner socket. That works for streamed chat turns but
 * breaks for anything where `RemoteSession` doesn't expose a setter:
 * notably `transcribers.setActive`, which throws on the remote view,
 * so the desktop couldn't activate the Codex OAuth transcriber the
 * same way the TUI does in self-host mode.
 *
 * This module flips the model for the slice of capabilities the
 * desktop actually needs to host locally: the main process loads
 * the relevant plugins *directly*, mirroring the TUI's self-host
 * setup. The runner is still the source of truth for chat (turns
 * stream back through the existing SessionDriver IPC pipeline), but
 * voice + future plugin-backed flows talk to instances built here
 * against the same shared vault on disk.
 *
 * Today this hosts the Codex OAuth transcriber. The same pattern
 * generalises: any other plugin we want the desktop to drive in-
 * process is constructed here, given its host dependencies (vault,
 * logger, …), and exposed through `InProcessPlugins` for the IPC
 * handlers to consume.
 */

import { CodexOAuthTranscriber } from '@moxxy/plugin-stt-whisper-codex';
import { buildVaultPlugin, type VaultStore } from '@moxxy/plugin-vault';
import type { Transcriber } from '@moxxy/sdk';

/**
 * One-shot bag of plugin instances the desktop's IPC handlers can
 * call without going through the runner socket.
 */
export interface InProcessPlugins {
  /** Vault shared with the runner — same file path
   *  (`~/.moxxy/vault.json`), same key source (combined keychain +
   *  env/passphrase). Populated by the user's existing `moxxy
   *  login` / `moxxy vault set` flows. */
  readonly vault: VaultStore;
  /** Codex OAuth transcriber instance wired against the shared
   *  vault. The TUI's voice flow uses the same backing class. */
  readonly transcriber: Transcriber;
}

/**
 * Build the in-process plugin bag. Calls `buildVaultPlugin()` for
 * its default vault wiring (keychain + env/passphrase key source,
 * `~/.moxxy/vault.json`) so the desktop reads / writes the exact
 * same vault file the TUI does — `moxxy login openai-codex`
 * results are immediately visible here.
 *
 * Pure function of its inputs (no global state) so tests can swap
 * the vault for an in-memory fake by passing a pre-built one in
 * `opts.vault`.
 */
export function buildInProcessPlugins(
  opts: { readonly vault?: VaultStore } = {},
): InProcessPlugins {
  const vault = opts.vault ?? buildVaultPlugin().vault;
  const transcriber = new CodexOAuthTranscriber({ vault });
  return { vault, transcriber };
}
