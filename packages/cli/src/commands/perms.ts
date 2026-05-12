import * as path from 'node:path';
import * as os from 'node:os';
import { PermissionEngine } from '@moxxy/core';
import type { ParsedArgv } from '../argv.js';
import { confirmedYes } from '../argv-helpers.js';
import { printError } from '../errors.js';

const HELP = `moxxy perms — view and edit ~/.moxxy/permissions.json

  moxxy perms list                       show the current policy
  moxxy perms allow <tool>[ <reason>]    add an allow rule (tool name; supports * glob)
  moxxy perms deny  <tool>[ <reason>]    add a deny rule
  moxxy perms remove <tool>              remove every rule (allow + deny) for <tool>
  moxxy perms clear                      wipe the entire policy (with confirmation)
  moxxy perms path                       print the path to the policy file
`;

function policyPath(): string {
  return path.join(os.homedir(), '.moxxy', 'permissions.json');
}

export async function runPermsCommand(argv: ParsedArgv): Promise<number> {
  // No subcommand + TTY → mount the Ink editor.
  const sub = argv.positional[0];
  if (!sub && process.stdin.isTTY) {
    const [{ render }, React, { PermissionEditor }] = await Promise.all([
      import('ink'),
      import('react'),
      import('@moxxy/plugin-cli'),
    ]);
    const { waitUntilExit } = render(
      React.createElement(PermissionEditor, { policyPath: policyPath() }),
    );
    await waitUntilExit();
    return 0;
  }

  const cmd = sub ?? 'list';
  const engine = await PermissionEngine.load(policyPath());

  switch (cmd) {
    case 'list': {
      const policy = engine.policySnapshot;
      if (policy.allow.length === 0 && policy.deny.length === 0) {
        process.stdout.write('(no rules configured)\n');
        return 0;
      }
      if (policy.deny.length > 0) {
        process.stdout.write('deny:\n');
        for (const r of policy.deny) {
          process.stdout.write(`  ${r.name}${r.reason ? `  — ${r.reason}` : ''}\n`);
        }
      }
      if (policy.allow.length > 0) {
        process.stdout.write('allow:\n');
        for (const r of policy.allow) {
          process.stdout.write(`  ${r.name}${r.reason ? `  — ${r.reason}` : ''}\n`);
        }
      }
      return 0;
    }
    case 'allow':
    case 'deny': {
      const tool = argv.positional[1];
      if (!tool) {
        printError(`tool name required\n${HELP}`);
        return 2;
      }
      const reason = argv.positional.slice(2).join(' ') || undefined;
      if (sub === 'allow') await engine.addAllow({ name: tool, ...(reason ? { reason } : {}) });
      else await engine.addDeny({ name: tool, ...(reason ? { reason } : {}) });
      process.stdout.write(`added ${sub} rule: ${tool}${reason ? ` (${reason})` : ''}\n`);
      return 0;
    }
    case 'remove': {
      const tool = argv.positional[1];
      if (!tool) {
        printError(`tool name required\n${HELP}`);
        return 2;
      }
      const removed = await engine.removeByName(tool);
      process.stdout.write(removed === 0 ? `no rules matched ${tool}\n` : `removed ${removed} rule${removed === 1 ? '' : 's'}\n`);
      return 0;
    }
    case 'clear': {
      if (!confirmedYes(argv)) {
        printError('refusing to clear without --yes. Re-run as: moxxy perms clear --yes');
        return 2;
      }
      await engine.clear();
      process.stdout.write('policy cleared\n');
      return 0;
    }
    case 'path': {
      process.stdout.write(policyPath() + '\n');
      return 0;
    }
    default:
      printError(`unknown 'perms' subcommand: ${cmd}\n${HELP}`);
      return 2;
  }
}
