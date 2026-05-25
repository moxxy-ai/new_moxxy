import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VaultStore, createStaticKeySource, deriveKey, generateSalt } from '@moxxy/plugin-vault';
import type { ChannelDef } from '@moxxy/sdk';
import { buildTelegramPlugin } from './index.js';

let tmp: string;
let vault: VaultStore;
let telegramDef: ChannelDef;
let writeOut: string[];
let writeErr: string[];
let origStdoutWrite: typeof process.stdout.write;
let origStderrWrite: typeof process.stderr.write;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mox-tg-sub-'));
  vault = new VaultStore({
    filePath: path.join(tmp, 'vault.json'),
    keySource: createStaticKeySource(deriveKey('test', generateSalt())),
  });
  const plugin = buildTelegramPlugin({ vault });
  telegramDef = plugin.channels![0]!;
  writeOut = [];
  writeErr = [];
  origStdoutWrite = process.stdout.write.bind(process.stdout);
  origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writeOut.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writeErr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write;
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
});

function ctx(
  overrides: {
    startChannel?: () => Promise<number>;
    session?: { setPermissionResolver: (r: unknown) => void };
  } = {},
) {
  return {
    deps: { cwd: tmp, vault, logger: undefined, options: {} },
    args: { positional: [], flags: {} },
    startChannel: overrides.startChannel ?? (async () => 0),
    session: overrides.session ?? { setPermissionResolver: () => {} },
  } as never;
}

describe('telegram channel subcommands (registered on ChannelDef)', () => {
  it('exposes pair, unpair, status', () => {
    expect(telegramDef.subcommands).toBeDefined();
    expect(Object.keys(telegramDef.subcommands!)).toEqual(
      expect.arrayContaining(['pair', 'unpair', 'status']),
    );
  });

  it('`status` reports unconfigured vault state as JSON', async () => {
    const code = await telegramDef.subcommands!.status!.run(ctx());
    expect(code).toBe(0);
    const parsed = JSON.parse(writeOut.join(''));
    expect(parsed).toEqual({ tokenConfigured: false, authorizedChatId: null });
  });

  it('`status` surfaces stored token + authorized chat', async () => {
    await vault.set('telegram_bot_token', '1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi');
    await vault.set('telegram_authorized_chat_id', '987654321');
    const code = await telegramDef.subcommands!.status!.run(ctx());
    expect(code).toBe(0);
    const parsed = JSON.parse(writeOut.join(''));
    expect(parsed).toEqual({ tokenConfigured: true, authorizedChatId: 987654321 });
  });

  it('`unpair` clears the authorized chat and reports', async () => {
    await vault.set('telegram_authorized_chat_id', '111');
    const code = await telegramDef.subcommands!.unpair!.run(ctx());
    expect(code).toBe(0);
    expect(writeOut.join('')).toContain('unpaired');
    expect(await vault.get('telegram_authorized_chat_id')).toBeNull();
  });

  it('`unpair` is a no-op when nothing is paired', async () => {
    const code = await telegramDef.subcommands!.unpair!.run(ctx());
    expect(code).toBe(0);
    expect(writeOut.join('')).toContain('no pairing was active');
  });

  it('`pair` drives the pairing flow on the session in an interactive TTY', async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      const startChannel = vi.fn(async () => 0);
      const setPermissionResolver = vi.fn();
      // No token in the vault -> the channel throws before it can open
      // a real polling connection, so the flow fails fast (no network).
      // We only assert that `pair` now drives the in-process pairing
      // flow (wires the session's permission resolver) instead of
      // delegating to `startChannel`.
      await expect(
        telegramDef.subcommands!.pair!.run(ctx({ startChannel, session: { setPermissionResolver } })),
      ).rejects.toThrow(/token/i);
      expect(setPermissionResolver).toHaveBeenCalledTimes(1);
      expect(startChannel).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }
  });

  it('`pair` refuses to start without a TTY (interactive-only flow)', async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      const startChannel = vi.fn(async () => 0);
      const code = await telegramDef.subcommands!.pair!.run(ctx({ startChannel }));
      expect(code).toBe(1);
      expect(startChannel).not.toHaveBeenCalled();
      expect(writeErr.join('')).toMatch(/TTY/);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }
  });

  it('subcommands return 1 when vault is unavailable', async () => {
    const badCtx = {
      deps: { cwd: tmp, vault: undefined, logger: undefined, options: {} },
      args: { positional: [], flags: {} },
      startChannel: async () => 0,
    };
    const code = await telegramDef.subcommands!.status!.run(badCtx);
    expect(code).toBe(1);
    expect(writeErr.join('')).toContain('vault unavailable');
  });
});
