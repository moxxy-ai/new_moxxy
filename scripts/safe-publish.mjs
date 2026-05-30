#!/usr/bin/env node
/**
 * Publish the public workspace packages, working around npm's tombstone
 * policy.
 *
 * Once a version is unpublished from npm the slot is permanently retired.
 * The version number can never be republished even though `npm view` returns
 * 404 for it. Hitting a tombstone makes `npm publish` fail with
 * "Cannot publish over previously published version", which is exactly the
 * error this project keeps tripping over because the package once shipped at
 * 2.x and was later torn down to 0.x.
 *
 * What this script does:
 *
 *   1. Iterate the non-private workspace packages under `packages/`.
 *   2. Skip a package whose current version is already on npm (visible).
 *      This matches the behaviour of `changesets publish` for unchanged
 *      packages, so it's safe to run on every CI invocation.
 *   3. Run `pnpm publish` for everything else (pnpm rewrites the
 *      `workspace:*` / `catalog:` protocols to real version ranges; plain
 *      `npm publish` ships them verbatim and the tarball becomes
 *      uninstallable). When the registry rejects
 *      the version as tombstoned the script bumps the patch number,
 *      writes the new version to package.json, and tries again. The bump
 *      loop is capped (MAX_BUMP_ATTEMPTS) so a misconfiguration cannot
 *      run away.
 *   4. After all publishes are done, commit any tombstone-driven bumps
 *      back to the repository so the next release does not have to walk
 *      the same dead slots again. Only runs inside GitHub Actions.
 *   5. Emit `🦋  New tag: <pkg>@<ver>` lines on success so
 *      `changesets/action` still picks them up and creates GitHub
 *      releases.
 *
 * Exit codes: 0 on full success, 1 if anything failed for a reason other
 * than tombstone-exhaustion (those are reported but do not block the
 * overall workflow from moving on).
 */

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const PACKAGES_DIR = join(ROOT, 'packages');
const MAX_BUMP_ATTEMPTS = 50;

// Patterns the registry uses when the version slot is permanently retired.
// Keep them broad: npm rephrases the message every few releases.
const TOMBSTONE_PATTERNS = [
  /Cannot publish over previously published version/i,
  /cannot publish over the previously published versions/i,
  /previously published versions: \d/i,
  /EPUBLISHCONFLICT/i,
];

// Visible-conflict patterns: the version exists on the registry right now.
// We treat this as a no-op rather than a failure to mirror the behaviour
// changesets has for unchanged packages.
const ALREADY_PUBLISHED_PATTERNS = [
  /You cannot publish over the previously published versions: \d/i,
  /403 Forbidden.*already published/i,
];

function readPkg(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
}

function writePkg(dir, pkg) {
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
}

function bumpPatch(version) {
  // Strip any pre-release / build suffix and bump the patch component.
  // Pre-release tagged versions (1.2.3-alpha.4) bump the numeric tail.
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) throw new Error(`unsupported semver for auto-bump: ${version}`);
  const [, maj, min, pat] = match;
  return `${maj}.${min}.${Number(pat) + 1}`;
}

function alreadyPublished(name, version) {
  const r = spawnSync('npm', ['view', `${name}@${version}`, 'version'], {
    encoding: 'utf8',
  });
  if (r.status !== 0) return false;
  return r.stdout.trim() === version;
}

function tryPublish(dir) {
  // Publish with `pnpm publish`, NOT `npm publish`. pnpm rewrites the
  // pnpm-only `workspace:*` and `catalog:` protocols in `dependencies` /
  // `peerDependencies` to concrete version ranges in the published
  // package.json. `npm publish` ships those protocols verbatim, producing a
  // tarball that npm itself cannot install (EUNSUPPORTEDPROTOCOL
  // 'Unsupported URL Type "workspace:"').
  //
  // --no-git-checks: this script rewrites package.json in place when walking
  //   past tombstoned versions, which dirties the working tree. pnpm's
  //   default pre-publish git checks would otherwise abort the publish.
  const args = ['publish', '--access', 'public', '--no-git-checks'];
  if (process.env.GITHUB_ACTIONS === 'true') args.push('--provenance');
  const r = spawnSync('pnpm', args, {
    cwd: dir,
    encoding: 'utf8',
    env: process.env,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function matchesAny(text, patterns) {
  return patterns.some((re) => re.test(text));
}

function listPublishablePackages() {
  if (!existsSync(PACKAGES_DIR)) return [];
  return readdirSync(PACKAGES_DIR)
    .map((name) => join(PACKAGES_DIR, name))
    .filter((dir) => statSync(dir).isDirectory())
    .filter((dir) => existsSync(join(dir, 'package.json')))
    .map((dir) => ({ dir, pkg: readPkg(dir) }))
    .filter(({ pkg }) => !pkg.private && typeof pkg.name === 'string');
}

function announceTag(name, version) {
  // The pattern changesets/action greps for to create GitHub releases.
  console.log(`🦋  New tag:  ${name}@${version}`);
}

function inGitHubActions() {
  return process.env.GITHUB_ACTIONS === 'true';
}

function commitBumps(bumps) {
  if (bumps.length === 0) return;
  if (!inGitHubActions()) {
    console.log('\nSkipping git commit of tombstone bumps (not in GitHub Actions).');
    return;
  }
  console.log('\nCommitting tombstone bumps so the next release does not walk them again...');
  try {
    execSync('git config user.name "github-actions[bot]"', { stdio: 'inherit' });
    execSync('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"', {
      stdio: 'inherit',
    });
    for (const b of bumps) {
      execSync(`git add ${JSON.stringify(join(b.dir, 'package.json'))}`, { stdio: 'inherit' });
    }
    const summary = bumps.map((b) => `- ${b.name}: ${b.from} → ${b.to}`).join('\n');
    const body = `chore(release): bump past tombstoned npm versions\n\n${summary}`;
    execSync(`git commit -m ${JSON.stringify(body)}`, { stdio: 'inherit' });
    execSync('git push', { stdio: 'inherit' });
  } catch (err) {
    console.warn('Failed to push the tombstone bump commit. The bumped versions are in the working tree; commit manually.');
    console.warn(err instanceof Error ? err.message : String(err));
  }
}

const packages = listPublishablePackages();
if (packages.length === 0) {
  console.log('No publishable workspace packages found under packages/.');
  process.exit(0);
}

const results = [];
const bumps = [];

for (const { dir, pkg } of packages) {
  console.log(`\n=== ${pkg.name}@${pkg.version} ===`);

  if (alreadyPublished(pkg.name, pkg.version)) {
    console.log('  → already on npm, skipping');
    results.push({ name: pkg.name, version: pkg.version, status: 'skipped' });
    continue;
  }

  let current = pkg;
  let attempts = 0;
  let outcome = null;

  while (attempts <= MAX_BUMP_ATTEMPTS) {
    const r = tryPublish(dir);
    if (r.code === 0) {
      console.log(`  ✓ published ${current.name}@${current.version}`);
      announceTag(current.name, current.version);
      outcome = { status: 'published', version: current.version };
      break;
    }

    const tombstone = matchesAny(r.stderr, TOMBSTONE_PATTERNS);
    const alreadyVisible = !tombstone && matchesAny(r.stderr, ALREADY_PUBLISHED_PATTERNS);

    if (alreadyVisible) {
      console.log(`  → ${current.name}@${current.version} is already on the registry, skipping`);
      outcome = { status: 'skipped', version: current.version };
      break;
    }

    if (!tombstone) {
      console.error(`::error::publish failed for ${current.name}@${current.version}`);
      console.error(r.stderr.trim());
      outcome = { status: 'failed', version: current.version, error: r.stderr.slice(0, 800) };
      break;
    }

    attempts += 1;
    if (attempts > MAX_BUMP_ATTEMPTS) {
      console.error(
        `::error::${current.name}@${current.version} is tombstoned and ${MAX_BUMP_ATTEMPTS} consecutive bumps were also tombstoned. Bump manually.`,
      );
      outcome = { status: 'failed', version: current.version, error: 'tombstone-exhausted' };
      break;
    }

    const next = bumpPatch(current.version);
    console.warn(
      `::warning::${current.name}@${current.version} is tombstoned, bumping to ${next} (attempt ${attempts}/${MAX_BUMP_ATTEMPTS})`,
    );
    bumps.push({ dir, name: current.name, from: current.version, to: next });
    current = { ...current, version: next };
    writePkg(dir, current);
  }

  results.push({ name: current.name, ...outcome });
}

console.log('\n----- Publish summary -----');
const longest = Math.max(...results.map((r) => r.name.length), 1);
for (const r of results) {
  console.log(`  ${r.status.padEnd(10)} ${r.name.padEnd(longest)} ${r.version}`);
}

// Consolidate per-package bumps to one entry per package (final version),
// in case a package walked through several tombstones.
const finalBumps = [];
for (const b of bumps) {
  const existing = finalBumps.find((x) => x.name === b.name);
  if (existing) {
    existing.to = b.to;
  } else {
    finalBumps.push({ ...b });
  }
}
commitBumps(finalBumps);

const failed = results.filter((r) => r.status === 'failed');
if (failed.length > 0) {
  console.error(`\n${failed.length} package(s) failed to publish.`);
  process.exit(1);
}
process.exit(0);
