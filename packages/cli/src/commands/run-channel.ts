import { bootSessionWithConfig } from '../argv-helpers.js';
import { printError } from '../errors.js';
import { stringFlag } from '../argv-helpers.js';
import type { ParsedArgv } from '../argv.js';

/**
 * Generic channel dispatcher. Looks up a ChannelDef by name in the session's
 * ChannelRegistry, instantiates it with the standard factory deps, swaps in
 * its PermissionResolver, and runs it.
 *
 * Channel-specific subcommands (e.g., `moxxy channels telegram pair`) live on
 * each `ChannelDef.subcommands` map and are dispatched by
 * `runChannelsCommand`. This is the code path for `moxxy <channel-name>` and
 * `moxxy channels <name>` when no subcommand is given.
 */
export async function runChannelByName(name: string, argv: ParsedArgv): Promise<number> {
  const { session, vault, config } = await bootSessionWithConfig(argv);

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
  // The `as never` widens against `Channel<TStartOpts>` — every channel's
  // own start type carries its own shape, and CLI is generic across all
  // of them.
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
