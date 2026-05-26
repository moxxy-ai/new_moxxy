import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { asSessionId, type CommandDef, type EmittedEvent } from '@moxxy/sdk';
import { buildVaultPlugin } from './index.js';
import { createStaticKeySource } from './keysource.js';
import { deriveKey, generateSalt } from './crypto.js';

const SECRET = 'sk-super-secret-9999';
const stableKey = deriveKey('test-passphrase', generateSalt());

let tmp: string;
let filePath: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mox-vault-cmd-'));
  filePath = path.join(tmp, 'vault.json');
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function setup() {
  const { plugin, vault } = buildVaultPlugin({
    filePath,
    keySource: createStaticKeySource(stableKey),
  });
  const cmd = plugin.commands?.find((c) => c.name === 'vault') as CommandDef;
  const appended: EmittedEvent[] = [];
  const session = {
    startTurn: () => ({ turnId: 'turn-1' }),
    log: {
      append: async (e: EmittedEvent) => {
        appended.push(e);
        return e as never;
      },
    },
  };
  const run = (args: string) =>
    cmd.handler({ channel: 'tui', sessionId: asSessionId('s1'), args, session });
  return { vault, cmd, appended, run };
}

describe('/vault command', () => {
  it('is registered with name "vault"', () => {
    const { cmd } = setup();
    expect(cmd).toBeDefined();
    expect(cmd.name).toBe('vault');
  });

  it('stores the secret and returns only a reference (never the plaintext)', async () => {
    const { vault, appended, run } = setup();
    const out = await run(`set API_KEY ${SECRET}`);

    // Secret actually stored
    expect(await vault.get('API_KEY')).toBe(SECRET);

    // User-facing confirmation has the reference, not the value
    expect(out.kind).toBe('text');
    if (out.kind !== 'text') throw new Error('expected text');
    expect(out.text).toContain('${vault:API_KEY}');
    expect(out.text).not.toContain(SECRET);

    // Model-facing note injected into the log has the reference, not the value
    expect(appended).toHaveLength(1);
    const note = appended[0]!;
    expect(note.type).toBe('user_prompt');
    if (note.type !== 'user_prompt') throw new Error('expected user_prompt');
    expect(note.text).toContain('${vault:API_KEY}');
    expect(note.text).not.toContain(SECRET);
  });

  it('list shows names + references but never values', async () => {
    const { vault, run } = setup();
    await vault.set('API_KEY', SECRET);
    const out = await run('list');
    expect(out.kind).toBe('text');
    if (out.kind !== 'text') throw new Error('expected text');
    expect(out.text).toContain('API_KEY');
    expect(out.text).toContain('${vault:API_KEY}');
    expect(out.text).not.toContain(SECRET);
  });

  it('rejects malformed set invocations without storing', async () => {
    const { run, appended } = setup();
    const noValue = await run('set API_KEY');
    expect(noValue.kind).toBe('error');
    const badName = await run('set "bad name" value');
    expect(badName.kind).toBe('error');
    expect(appended).toHaveLength(0);
  });

  it('shows usage for bare or help invocation', async () => {
    const { run } = setup();
    const out = await run('');
    expect(out.kind).toBe('text');
    if (out.kind !== 'text') throw new Error('expected text');
    expect(out.text).toContain('/vault set');
  });
});
