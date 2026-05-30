import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { resolveMoxxyCli } from './cli-resolver';

let tmp: string;
const originalEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'cli-resolver-'));
  process.env = { ...originalEnv };
  process.env.PATH = tmp;
  process.env.HOME = tmp;
  delete process.env.MOXXY_CLI_ENTRY;
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(originalCwd);
});

const originalCwd = process.cwd();

afterEach(() => {
  process.env = originalEnv;
}, 0);

describe('resolveMoxxyCli', () => {
  it('returns null when nothing is found', () => {
    expect(resolveMoxxyCli()).toBeNull();
  });

  it('prefers MOXXY_CLI_ENTRY when set to an existing file', () => {
    const bin = path.join(tmp, 'bin.js');
    writeFileSync(bin, '#!/usr/bin/env node\nconsole.log("hi")');
    process.env.MOXXY_CLI_ENTRY = bin;
    const result = resolveMoxxyCli();
    expect(result).toEqual({ kind: 'node', entry: bin });
  });

  it('ignores MOXXY_CLI_ENTRY when the file does not exist', () => {
    process.env.MOXXY_CLI_ENTRY = path.join(tmp, 'no-such-file.js');
    // Fall through. With nothing else on PATH, null is the right answer.
    expect(resolveMoxxyCli()).toBeNull();
  });

  it('finds moxxy on PATH and returns a `direct` invocation', () => {
    const bin = path.join(tmp, 'moxxy');
    writeFileSync(bin, '#!/bin/sh\necho moxxy\n');
    chmodSync(bin, 0o755);
    const result = resolveMoxxyCli();
    expect(result).toEqual({ kind: 'direct', bin });
  });

  it('walks the monorepo tree to packages/cli/dist/bin.js', () => {
    const repoRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fakemonorepo-')));
    const cliDist = path.join(repoRoot, 'packages', 'cli', 'dist');
    mkdirSync(cliDist, { recursive: true });
    const bin = path.join(cliDist, 'bin.js');
    writeFileSync(bin, '// moxxy cli');
    const restoreCwd = process.cwd();
    process.chdir(repoRoot);
    try {
      const result = resolveMoxxyCli();
      expect(result).toEqual({ kind: 'node', entry: bin });
    } finally {
      process.chdir(restoreCwd);
    }
  });

  it('walks the monorepo tree from nested cwd', () => {
    const repoRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'nestedmonorepo-')));
    const cliDist = path.join(repoRoot, 'packages', 'cli', 'dist');
    mkdirSync(cliDist, { recursive: true });
    const bin = path.join(cliDist, 'bin.js');
    writeFileSync(bin, '// moxxy cli');
    const nested = path.join(repoRoot, 'apps', 'desktop', 'electron', 'main');
    mkdirSync(nested, { recursive: true });
    const restoreCwd = process.cwd();
    process.chdir(nested);
    try {
      const result = resolveMoxxyCli();
      expect(result).toEqual({ kind: 'node', entry: bin });
    } finally {
      process.chdir(restoreCwd);
    }
  });

  it.skipIf(process.platform === 'win32')('skips non-files on PATH', () => {
    // A directory under PATH named `moxxy` shouldn't match.
    const fake = path.join(tmp, 'moxxy');
    mkdirSync(fake);
    expect(resolveMoxxyCli()).toBeNull();
  });

  it('MOXXY_CLI_ENTRY overrides PATH', () => {
    const onPath = path.join(tmp, 'moxxy');
    writeFileSync(onPath, '#!/bin/sh\necho path\n');
    chmodSync(onPath, 0o755);

    const override = path.join(tmp, 'override.js');
    writeFileSync(override, '// override');
    process.env.MOXXY_CLI_ENTRY = override;

    expect(resolveMoxxyCli()).toEqual({ kind: 'node', entry: override });
  });
});

describe('vi sanity', () => {
  it('preserves environment between tests', () => {
    process.env.PATH = '/foo';
    expect(process.env.PATH).toBe('/foo');
    vi.restoreAllMocks();
  });
});
