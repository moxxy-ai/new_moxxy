import { installPluginPackage } from '@moxxy/plugin-plugins-admin';
import type { ParsedArgv } from '../argv.js';
import { helpRequested, stringFlag } from '../argv-helpers.js';
import { colors } from '../colors.js';
import { printError } from '../errors.js';

const HELP = `moxxy plugins install — install a plugin into ~/.moxxy/plugins

  moxxy plugins install <package-or-path>
  moxxy plugins install <package> --version <range-or-tag>
`;

export async function runPluginInstallCommand(argv: ParsedArgv): Promise<number> {
  if (helpRequested(argv)) {
    process.stdout.write(HELP);
    return 0;
  }

  const packageName = argv.positional[1];
  if (!packageName) {
    process.stdout.write(HELP);
    return 2;
  }

  try {
    const result = await installPluginPackage({
      packageName,
      version: stringFlag(argv, 'version'),
    });
    process.stdout.write(
      `${colors.bold('installed')}  ${colors.dim(result.installed)}\n` +
        `${colors.dim('plugins dir: ' + result.dir)}\n` +
        `${colors.dim('Next: run `moxxy plugins reload` or `moxxy plugins start <package>`.')}\n`,
    );
    return 0;
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
