import { bootSessionWithConfig } from '../argv-helpers.js';
import { printError } from '../errors.js';
import type { ParsedArgv } from '../argv.js';
import { runChannelByName } from './run-channel.js';
import { colors } from '../colors.js';

/**
 * `moxxy channels` dispatcher.
 *
 *  - `moxxy channels`               list registered channels and their availability
 *  - `moxxy channels <name>`        boot and run a channel by name (same as `moxxy <name>`)
 *  - `moxxy channels <name> <sub>`  invoke a channel-defined subcommand (e.g.,
 *                                    `moxxy channels telegram pair|unpair|status`)
 *
 * The CLI knows nothing about specific channels: every channel-specific
 * command lives on its `ChannelDef.subcommands` map.
 */
export async function runChannelsCommand(argv: ParsedArgv): Promise<number> {
  const [name, sub, ...rest] = argv.positional;

  if (!name || name === 'list') {
    return runList();
  }

  const { session, vault, config } = await bootSessionWithConfig(argv, {
    skipKeyPrompt: true,
    tolerateNoProvider: true,
  });

  const def = session.channels.get(name);
  if (!def) {
    printError(
      `unknown channel: ${name}\n  Available:\n` +
        session.channels.list().map((d) => `    ${d.name} — ${d.description}\n`).join(''),
    );
    return 2;
  }

  // No subcommand → run the channel itself.
  if (!sub) {
    return await runChannelByName(name, argv);
  }

  const subcommand = def.subcommands?.[sub];
  if (!subcommand) {
    const available = def.subcommands
      ? Object.entries(def.subcommands)
          .map(([n, c]) => `    ${name} ${n}  — ${c.description}\n`)
          .join('')
      : '    (none)\n';
    printError(
      `unknown '${name}' subcommand: ${sub}\n  Available subcommands:\n${available}`,
    );
    return 2;
  }

  const configOpts = (config.channels?.[name] ?? {}) as Record<string, unknown>;
  const deps = {
    cwd: process.cwd(),
    vault,
    logger: session.logger,
    options: { ...configOpts, ...argv.flags },
  };

  return await subcommand.run({
    deps,
    args: {
      positional: rest,
      flags: argv.flags,
    },
    startChannel: (extra) => {
      // Coerce extra opts into the ParsedArgv.flags shape (string | boolean).
      // ChannelSubcommand.startChannel accepts arbitrary unknown values for
      // forward compatibility; we serialize them as the CLI would.
      const extraFlags: Record<string, string | boolean> = {};
      for (const [k, v] of Object.entries(extra ?? {})) {
        if (typeof v === 'string' || typeof v === 'boolean') extraFlags[k] = v;
        else if (v !== undefined && v !== null) extraFlags[k] = String(v);
      }
      const merged: ParsedArgv = {
        command: argv.command,
        flags: { ...argv.flags, ...extraFlags },
        positional: [],
      };
      return runChannelByName(name, merged);
    },
  });
}

async function runList(): Promise<number> {
  const { session, vault, config } = await bootSessionWithConfig(
    { flags: {} },
    { skipKeyPrompt: true, tolerateNoProvider: true },
  );
  const deps = {
    cwd: process.cwd(),
    vault,
    logger: session.logger,
    options: {},
  };
  const entries = await session.channels.listWithAvailability(deps);
  for (const { def, availability } of entries) {
    const status = availability.ok
      ? colors.green('available')
      : colors.yellow(`unavailable: ${availability.reason ?? ''}`);
    const configured = config.channels?.[def.name] ? colors.cyan(' [configured]') : '';
    process.stdout.write(
      `${colors.bold(def.name)}\t${status}${configured}\t${colors.dim(def.description)}\n`,
    );
    if (def.subcommands) {
      for (const [subName, sc] of Object.entries(def.subcommands)) {
        process.stdout.write(
          `  ${colors.gray(`${def.name} ${subName}`)}\t${colors.dim(sc.description)}\n`,
        );
      }
    }
  }
  return 0;
}
