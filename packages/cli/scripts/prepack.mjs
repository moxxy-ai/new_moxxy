/**
 * prepack: strip workspace `@moxxy/*` devDependencies from the published
 * package.json.
 *
 * These devDeps exist only so pnpm links the workspace packages at build time
 * for tsup to bundle into the binary. They are NOT runtime deps — everything
 * first-party is inlined into dist/bin.js — so in the published tarball they
 * are dead references to unpublished (private) packages (`workspace:* -> 0.0.0`).
 *
 * We back up the original package.json and restore it in postpack.mjs, so the
 * working tree is left byte-identical after `pnpm pack`/`pnpm publish`.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.join(here, '..', 'package.json');
const backupPath = path.join(here, '..', 'package.json.prepack-backup');

const raw = await fs.readFile(pkgPath, 'utf8');
await fs.writeFile(backupPath, raw, 'utf8');

const pkg = JSON.parse(raw);
const removed = [];
if (pkg.devDependencies) {
  const kept = {};
  for (const [name, version] of Object.entries(pkg.devDependencies)) {
    if (name.startsWith('@moxxy/')) removed.push(name);
    else kept[name] = version;
  }
  pkg.devDependencies = kept;
}

await fs.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
console.log(`prepack: stripped ${removed.length} @moxxy/* devDependency(ies) from the published package.json`);
