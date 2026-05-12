import {
  mcpConfigPath,
  readMcpConfig,
  removeServerFromConfig,
  setServerDisabled,
} from '@moxxy/plugin-mcp';
import type { ParsedArgv } from '../argv.js';
import { colors } from '../colors.js';

const HELP = `moxxy mcp — manage Model Context Protocol servers

  moxxy mcp list                    list every server in ~/.moxxy/mcp.json
  moxxy mcp enable <name>           re-enable a previously-disabled server
  moxxy mcp disable <name>          disable a server without removing it
  moxxy mcp remove <name>           drop a server from the catalog
  moxxy mcp path                    print the catalog file path

Add new servers from a moxxy chat session — the model uses
mcp_add_server to register them (tests connection first, caches tool
descriptors). This CLI is for enable/disable/remove on existing entries.
`;

export async function runMcpCommand(argv: ParsedArgv): Promise<number> {
  const sub = argv.positional[0] ?? 'list';

  switch (sub) {
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return 0;

    case 'path':
      process.stdout.write(mcpConfigPath() + '\n');
      return 0;

    case 'list': {
      const cfg = await readMcpConfig();
      if (cfg.servers.length === 0) {
        process.stdout.write('(no MCP servers registered)\n');
        return 0;
      }
      for (const s of cfg.servers) {
        const status = s.disabled ? colors.red('disabled') : colors.green('enabled ');
        const conn = s.kind === undefined || s.kind === 'stdio'
          ? `stdio: ${(s as { command: string }).command}`
          : `${s.kind}: ${(s as { url: string }).url}`;
        const toolCount = s.cachedTools?.length ?? 0;
        process.stdout.write(
          `${status}  ${colors.bold(s.name)}  ${colors.dim(`${toolCount} tools · ${conn}`)}\n`,
        );
      }
      return 0;
    }

    case 'enable':
    case 'disable': {
      const name = argv.positional[1];
      if (!name) {
        process.stderr.write(`${colors.red(`missing server name`)}\n  usage: moxxy mcp ${sub} <name>\n`);
        return 2;
      }
      const updated = await setServerDisabled(name, sub === 'disable');
      if (!updated) {
        process.stderr.write(`${colors.red(`no MCP server named "${name}"`)}\n`);
        return 1;
      }
      process.stdout.write(
        `${sub === 'disable' ? '✗' : '✓'} ${name} ${sub === 'disable' ? 'disabled' : 'enabled'} ` +
          colors.dim(`(restart moxxy or restart-affected session for the change to take effect in a running TUI)\n`),
      );
      return 0;
    }

    case 'remove': {
      const name = argv.positional[1];
      if (!name) {
        process.stderr.write(`${colors.red(`missing server name`)}\n  usage: moxxy mcp remove <name>\n`);
        return 2;
      }
      const removed = await removeServerFromConfig(name);
      if (!removed) {
        process.stderr.write(`${colors.red(`no MCP server named "${name}"`)}\n`);
        return 1;
      }
      process.stdout.write(`✓ ${name} removed from ${mcpConfigPath()}\n`);
      return 0;
    }

    default:
      process.stderr.write(`${colors.red(`unknown subcommand: ${sub}`)}\n${HELP}`);
      return 2;
  }
}
