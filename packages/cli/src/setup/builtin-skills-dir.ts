import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BUILTIN_SKILLS_DIR } from '@moxxy/skills-builtin';

/**
 * Directory of builtin skill markdown, resolved for BOTH run modes:
 *
 *  - Bundled cli: the tsup build copies the markdown next to the bin at
 *    `./skills` (see tsup.config.ts onSuccess). Every bundled module shares
 *    the bin's `import.meta.url`, so this resolves to `dist/skills`.
 *  - From-source dev: that sibling dir doesn't exist, so fall back to the
 *    `@moxxy/skills-builtin` package's own `skills/` directory.
 *
 * All builtin-skill consumers (boot loader in setup.ts, the synthesize-skill
 * reload path, and the `moxxy skills` command) MUST use this so they agree.
 */
const LOCAL_SKILLS_DIR = fileURLToPath(new URL('./skills', import.meta.url));

export const BUILTIN_SKILLS_DIR_RESOLVED: string = existsSync(LOCAL_SKILLS_DIR)
  ? LOCAL_SKILLS_DIR
  : BUILTIN_SKILLS_DIR;
