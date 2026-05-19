import { bootSessionWithConfig, stringFlag } from '../argv-helpers.js';
import { printError } from '../errors.js';
import type { ParsedArgv } from '../argv.js';

/**
 * Boot a session and run a registered channel by name, headlessly —
 * no interactive wizard, no TUI hand-off. This is the lowest-level
 * channel runner; both `runChannelByName` (the smart dispatcher in
 * `run-channel.ts`) and the Telegram wizard's "Start the bot" action
 * call into it, which is why it lives in its own module: keeping it
 * here lets `telegram-wizard.ts` skip a dependency on `run-channel.ts`,
 * breaking what would otherwise be a circular import.
 */
export async function startRegisteredChannel(name: string, argv: ParsedArgv): Promise<number> {
  // `skipKeyPrompt: true` — channels like telegram start a bot process
  // and may run for hours; if the model key resolves later from
  // env/vault when an actual turn fires, that's fine. The interactive
  // readline prompt would race the TUI / Telegram event loop.
  const { session, vault, config } = await bootSessionWithConfig(argv, { skipKeyPrompt: true });

  const def = session.channels.get(name);
  if (!def) {
    printError(
      `unknown channel: ${name}\n  Available:\n` +
        session.channels.list().map((d) => `    ${d.name} — ${d.description}\n`).join(''),
    );
    return 2;
  }

  // Merge sources, lowest → highest precedence: moxxy.config.ts → CLI flags.
  const configOpts = (config.channels?.[name] ?? {}) as Record<string, unknown>;
  const channel = def.create({
    cwd: process.cwd(),
    vault,
    logger: session.logger,
    options: { ...configOpts, ...argv.flags },
  });

  session.setPermissionResolver(channel.permissionResolver);

  // Build per-invocation start opts: well-known keys first, then any other
  // flags the caller forwarded (channel-specific, e.g., Telegram's `pair`).
  const reserved = new Set(['model', 'config', 'verbose']);
  const extraFlags: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(argv.flags)) {
    if (reserved.has(k)) continue;
    extraFlags[k] = v;
  }
  const startOpts = {
    session,
    model: stringFlag(argv, 'model'),
    ...extraFlags,
  };
  const handle = await channel.start(startOpts as never);

  const shutdown = async (): Promise<void> => {
    await handle.stop('SIGINT');
    // Fire onShutdown hooks so plugins can flush (memory journal, vault,
    // audit logs, etc.) before the process exits.
    await session.close('SIGINT').catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await handle.running;
  return 0;
}
