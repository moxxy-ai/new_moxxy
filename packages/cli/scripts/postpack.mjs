/**
 * postpack: restore the package.json that prepack.mjs backed up, so the
 * working tree is unchanged after `pnpm pack` / `pnpm publish`.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.join(here, '..', 'package.json');
const backupPath = path.join(here, '..', 'package.json.prepack-backup');

try {
  const backup = await fs.readFile(backupPath, 'utf8');
  await fs.writeFile(pkgPath, backup, 'utf8');
  await fs.rm(backupPath, { force: true });
  console.log('postpack: restored package.json');
} catch (err) {
  console.error(`postpack: nothing to restore (${err instanceof Error ? err.message : String(err)})`);
}
