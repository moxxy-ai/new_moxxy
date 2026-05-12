import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ParsedArgv } from '../argv.js';
import { hasBoolFlag } from '../argv-helpers.js';
import { printError } from '../errors.js';

const HELP = `moxxy plugins new — scaffold a new user-scope plugin

  moxxy plugins new <name>            create ~/.moxxy/plugins/<name>
  moxxy plugins new <name> --here     create ./<name> in the current dir
  moxxy plugins new <name> --force    overwrite if the dir already exists
`;

export async function runPluginNewCommand(argv: ParsedArgv): Promise<number> {
  // The first positional is "new" (subcommand) when called via
  // `moxxy plugins new <name>`; the actual name is the second.
  const name = argv.positional[1];
  if (!name) {
    process.stdout.write(HELP);
    return 2;
  }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    printError(
      `invalid plugin name '${name}'. Use lowercase letters, digits, and hyphens; must start with a letter.`,
    );
    return 2;
  }

  const here = hasBoolFlag(argv, 'here');
  const force = hasBoolFlag(argv, 'force');
  const root = here
    ? path.join(process.cwd(), name)
    : path.join(os.homedir(), '.moxxy', 'plugins', name);

  // Refuse to clobber existing dirs unless --force.
  try {
    const stat = await fs.stat(root);
    if (stat.isDirectory() && !force) {
      printError(`refusing to overwrite ${root} (pass --force to allow)`);
      return 1;
    }
  } catch {
    // doesn't exist → that's what we want
  }

  await fs.mkdir(root, { recursive: true });

  const pkgName = here ? name : `moxxy-plugin-${name}`;
  const pkgJson = {
    name: pkgName,
    version: '0.1.0',
    private: true,
    type: 'module',
    description: `moxxy plugin: ${name}`,
    moxxy: {
      plugin: {
        entry: './index.mjs',
      },
    },
  };
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify(pkgJson, null, 2) + '\n',
  );

  const indexBody = renderIndexMjs(name);
  await fs.writeFile(path.join(root, 'index.mjs'), indexBody);

  const readme = renderReadme(name, root);
  await fs.writeFile(path.join(root, 'README.md'), readme);

  process.stdout.write(
    `created ${root}\n` +
      `  package.json   moxxy.plugin.entry → ./index.mjs\n` +
      `  index.mjs      ${pkgName} skeleton (no tools yet)\n` +
      `  README.md      notes\n\n` +
      `Next: edit ${path.join(root, 'index.mjs')} to add tools/providers/etc., ` +
      `then run \`moxxy plugins reload\` (or restart moxxy) to pick it up.\n`,
  );
  return 0;
}

function renderIndexMjs(name: string): string {
  return `// Scaffolded by \`moxxy plugins new ${name}\`.
//
// A plugin is a plain object with __moxxy === 'plugin' and a 'name'. To add
// tools/providers/channels/etc., import the SDK helpers — those require
// installing @moxxy/sdk into this plugin (npm i @moxxy/sdk or pnpm add).
//
// Minimal example without the SDK (zero-dep):

const plugin = Object.freeze({
  __moxxy: 'plugin',
  name: '${name}',
  version: '0.1.0',
  // Lifecycle hooks (all optional). Each is async and receives a context.
  hooks: {
    onInit: async (_ctx) => {
      // Called once when this plugin is loaded.
    },
  },
});

export default plugin;
`;
}

function renderReadme(name: string, root: string): string {
  return `# moxxy plugin: ${name}

Location: \`${root}\`

This plugin is auto-discovered by moxxy from \`~/.moxxy/plugins/*/package.json\`
(when its \`moxxy.plugin\` manifest is valid). Edit \`index.mjs\` and run
\`moxxy plugins reload\` to hot-reload without restarting your session.

## Extending

Once you want to add tools, providers, channels, etc.:

\`\`\`bash
cd ${root}
npm init -y          # if you haven't yet
npm install @moxxy/sdk
\`\`\`

Then in \`index.mjs\`:

\`\`\`js
import { definePlugin, defineTool, z } from '@moxxy/sdk';

export default definePlugin({
  name: '${name}',
  version: '0.1.0',
  tools: [
    defineTool({
      name: '${name}_echo',
      description: 'Echo a message',
      inputSchema: z.object({ msg: z.string() }),
      handler: async ({ msg }) => msg,
    }),
  ],
});
\`\`\`
`;
}
