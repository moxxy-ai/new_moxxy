import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { collectTurn } from '@moxxy/core';
import { FakeProvider, createFakeSession, textReply } from '@moxxy/testing';

import {
  developerModePlugin,
  DEVELOPER_MODE_NAME,
  formatCommitMessage,
  parseVerify,
  renderDiffBody,
} from './index.js';
import { messageAwaitsUser } from './developer-loop.js';

describe('parseVerify', () => {
  it('extracts SUMMARY and COMMIT subject + body', () => {
    const text = [
      'SUMMARY: Added foo() and confirmed unit tests still pass',
      'COMMIT:',
      'add foo helper for downstream callers',
      '',
      'Body line one explaining the why.',
      'Body line two with extra detail.',
    ].join('\n');
    const out = parseVerify(text);
    expect(out.summary).toBe('Added foo() and confirmed unit tests still pass');
    expect(out.commitSubject).toBe('add foo helper for downstream callers');
    expect(out.commitBody).toBe('Body line one explaining the why.\nBody line two with extra detail.');
  });

  it('handles missing body', () => {
    const out = parseVerify('SUMMARY: did the thing\nCOMMIT:\nfix typo in readme');
    expect(out.commitSubject).toBe('fix typo in readme');
    expect(out.commitBody).toBeNull();
  });

  it('returns nulls when format is missing', () => {
    const out = parseVerify('I am thinking out loud and not following the format.');
    expect(out.summary).toBeNull();
    expect(out.commitSubject).toBeNull();
    expect(out.commitBody).toBeNull();
  });
});

describe('formatCommitMessage', () => {
  it('joins subject and body with one blank line', () => {
    expect(formatCommitMessage('subject', 'body line')).toBe('subject\n\nbody line');
  });
  it('returns subject alone when body is null', () => {
    expect(formatCommitMessage('only subject', null)).toBe('only subject');
  });
});

describe('renderDiffBody', () => {
  it('returns a friendly message when there are no changes', () => {
    const out = renderDiffBody({ files: [], totalFiles: 0, empty: true });
    expect(out).toMatch(/no changes/i);
  });

  it('surfaces git errors verbatim', () => {
    const out = renderDiffBody({ files: [], totalFiles: 0, empty: false, error: 'not a git repo' });
    expect(out).toContain('not a git repo');
  });

  it('emits fenced diff blocks per file', () => {
    const body = renderDiffBody({
      empty: false,
      totalFiles: 1,
      files: [
        {
          path: 'src/foo.ts',
          additions: 3,
          deletions: 1,
          truncated: false,
          diff: 'diff --git a/src/foo.ts b/src/foo.ts\n@@ -1,1 +1,3 @@\n-old\n+new\n+more\n',
        },
      ],
    });
    expect(body).toContain('Changed files (1)');
    expect(body).toContain('src/foo.ts  +3/-1');
    expect(body).toMatch(/```diff[\s\S]*\+new[\s\S]*```/);
  });
});

describe('messageAwaitsUser', () => {
  it('detects trailing questions and requests for the user', () => {
    expect(messageAwaitsUser('I need your API key. Please run `/vault set X <key>`.')).toBe(true);
    expect(messageAwaitsUser('Does this look right to you?')).toBe(true);
    expect(messageAwaitsUser('Could you provide the endpoint URL?')).toBe(true);
    expect(messageAwaitsUser('Let me know when the key is stored.')).toBe(true);
    expect(messageAwaitsUser('Please confirm before I continue')).toBe(true);
  });

  it('does not fire on completion statements', () => {
    expect(messageAwaitsUser('Done with the implementation.')).toBe(false);
    expect(messageAwaitsUser('Added foo() and the tests pass.')).toBe(false);
    expect(messageAwaitsUser('')).toBe(false);
  });
});

describe('developerMode: pause when awaiting user input', () => {
  it('skips verify+commit and yields when the model ends by asking for a key', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'moxxy-dev-await-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    const originalCwd = process.cwd();
    try {
      git('init', '-q');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      git('config', 'commit.gpgsign', 'false');
      const scratch = join(repo, 'scratch.ts');
      writeFileSync(scratch, 'export const before = 1;\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'initial');
      // Non-empty pending diff: proves the skip is due to the await-user check,
      // NOT the empty-diff short-circuit.
      writeFileSync(scratch, 'export const before = 1;\nexport const after = 2;\n');
      process.chdir(repo);

      const provider = new FakeProvider({
        script: [
          // Implementation phase ends by asking the user to store a key.
          textReply(
            'I scaffolded the config but need your API key. Please run ' +
              '`/vault set PLATFORM_API_KEY <your-key>` and let me know once done.',
          ),
          // If verify wrongly ran, it would consume this and produce a commit —
          // the assertions below catch that regression.
          textReply('SUMMARY: x\nCOMMIT:\nshould not happen'),
        ],
      });

      const session = createFakeSession({ provider });
      session.pluginHost.registerStatic(developerModePlugin);
      session.modes.setActive(DEVELOPER_MODE_NAME);

      const events = await collectTurn(session, 'integrate platform X');

      // Yielded back to the user awaiting input…
      expect(
        events.some((e) => e.type === 'plugin_event' && e.subtype === 'developer_awaiting_user'),
      ).toBe(true);
      // …without entering the verify phase or opening a commit.
      expect(
        events.some((e) => e.type === 'plugin_event' && e.subtype === 'developer_verify_started'),
      ).toBe(false);
      expect(
        events.some((e) => e.type === 'plugin_event' && e.subtype === 'developer_commit_created'),
      ).toBe(false);
    } finally {
      process.chdir(originalCwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('developerMode end-to-end (headless)', () => {
  it('runs implementation, verify, then emits suggested commit when headless', async () => {
    // runDeveloperMode collects the working-tree diff from process.cwd() and
    // short-circuits (skipping verify + commit) when there are no changes. Run
    // inside a throwaway git repo with a real pending change so the full flow
    // exercises rather than depending on whatever state the repo happens to be
    // in. Restored in finally.
    const repo = mkdtempSync(join(tmpdir(), 'moxxy-dev-mode-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    const originalCwd = process.cwd();
    try {
      git('init', '-q');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      git('config', 'commit.gpgsign', 'false');
      const scratch = join(repo, 'scratch.ts');
      writeFileSync(scratch, 'export const before = 1;\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'initial');
      // Pending change against HEAD so the diff is non-empty.
      writeFileSync(scratch, 'export const before = 1;\nexport const after = 2;\n');
      process.chdir(repo);

      const provider = new FakeProvider({
        script: [
          // Implementation phase: model says it's done without calling tools.
          textReply('Done with the implementation.'),
          // Verify phase: returns the structured SUMMARY/COMMIT block.
          textReply(
            [
              'SUMMARY: Verified — tests pass',
              'COMMIT:',
              'add scratch helper',
              '',
              'Tiny helper used by the smoke test.',
            ].join('\n'),
          ),
        ],
      });

      const session = createFakeSession({ provider });
      session.pluginHost.registerStatic(developerModePlugin);
      session.modes.setActive(DEVELOPER_MODE_NAME);

      const events = await collectTurn(session, 'add a scratch helper');

      const modeIter = events.find(
        (e) => e.type === 'mode_iteration' && e.strategy === DEVELOPER_MODE_NAME,
      );
      expect(modeIter).toBeDefined();

      const verifyCompleted = events.find(
        (e) => e.type === 'plugin_event' && e.subtype === 'developer_verify_completed',
      );
      expect(verifyCompleted).toBeDefined();
      if (verifyCompleted?.type !== 'plugin_event') throw new Error();
      expect((verifyCompleted.payload as { hasCommitSubject: boolean }).hasCommitSubject).toBe(true);

      // Headless: the final assistant_message announces the suggested commit
      // message (since FakeSession has no approval resolver).
      const finalSystem = events
        .filter((e) => e.type === 'assistant_message' && e.source === 'system')
        .pop();
      if (finalSystem?.type !== 'assistant_message') throw new Error('expected system message');
      expect(finalSystem.content).toContain('add scratch helper');
    } finally {
      process.chdir(originalCwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
