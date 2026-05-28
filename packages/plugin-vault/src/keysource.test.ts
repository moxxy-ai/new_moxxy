import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCombinedKeySource, createStaticKeySource } from './keysource.js';
import { generateSalt } from './crypto.js';

// ---------------------------------------------------------------------------
// Fake keytar.
//
// keysource.ts reaches the OS keychain via a *dynamic* `import('keytar')`.
// We replace that module with an in-memory store so the tests never touch the
// real macOS/Linux/Windows keychain. The mock factory must not close over
// outer mutable bindings directly (vi.mock is hoisted above them), so we keep
// the backing store on a stable object created inside the factory and expose
// it through the mocked module's own helpers.
// ---------------------------------------------------------------------------
const keytarState: { store: Map<string, string>; failGet: boolean; failSet: boolean } = {
  store: new Map(),
  failGet: false,
  failSet: false,
};

vi.mock('keytar', () => ({
  getPassword: vi.fn(async (svc: string, acct: string) => {
    if (keytarState.failGet) throw new Error('keychain locked');
    return keytarState.store.get(`${svc}:${acct}`) ?? null;
  }),
  setPassword: vi.fn(async (svc: string, acct: string, password: string) => {
    if (keytarState.failSet) throw new Error('keychain refused');
    keytarState.store.set(`${svc}:${acct}`, password);
  }),
}));

const KEYTAR_KEY = 'moxxy:vault-master-key';

let tmp: string;
let diskKeyPath: string;
const ENV_VAR = 'TEST_VAULT_PASSPHRASE_XYZ';

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mox-keysrc-'));
  diskKeyPath = path.join(tmp, 'vault.key');
  keytarState.store = new Map();
  keytarState.failGet = false;
  keytarState.failSet = false;
  delete process.env[ENV_VAR];
  delete process.env.MOXXY_VAULT_PASSPHRASE;
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  delete process.env[ENV_VAR];
  delete process.env.MOXXY_VAULT_PASSPHRASE;
  vi.clearAllMocks();
});

/**
 * Poll the filesystem until the backfill writes `expected`. We compare against
 * the expected value (not "any value") because the disk file may already hold
 * a stale value that the fire-and-forget backfill is about to overwrite.
 */
async function waitForFile(filePath: string, expected: string, timeoutMs = 1000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '<unwritten>';
  for (;;) {
    try {
      last = (await fs.readFile(filePath, 'utf8')).trim();
      if (last === expected) return last;
    } catch {
      // not written yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${filePath}; last=${last}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Poll the fake keychain until the backfill writes `expected`. */
async function waitForKeytar(key: string, expected: string, timeoutMs = 1000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = keytarState.store.get(key);
    if (v === expected) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for keytar ${key}; last=${v ?? '<unset>'}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Let any not-yet-awaited backfill promises settle, then assert absence. */
async function flushMicrotasks(): Promise<void> {
  // A couple of macrotask hops covers the dynamic import + fs round-trip the
  // fire-and-forget backfills perform.
  await new Promise((r) => setTimeout(r, 50));
}

describe('createCombinedKeySource', () => {
  it('env var wins and is NOT persisted to keytar or disk', async () => {
    process.env[ENV_VAR] = 'from-env';
    // Seed both lower-priority sources to prove the env branch short-circuits
    // before they're consulted AND before any persistence happens.
    const src = createCombinedKeySource({
      passphrasePrompt: async () => {
        throw new Error('prompt should not be called when env var is set');
      },
      envVar: ENV_VAR,
      diskKeyPath,
    });
    const salt = generateSalt();
    const key = await src.obtain(salt);

    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
    expect(src.name).toBe(`env:${ENV_VAR}`);

    // Give any (incorrect) async persistence a chance to fire, then prove
    // neither backend was written.
    await flushMicrotasks();
    expect(keytarState.store.size).toBe(0);
    await expect(fs.readFile(diskKeyPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keytar value wins over disk, and backfills disk', async () => {
    const keytarVal = Buffer.from('k'.repeat(32)).toString('base64');
    const diskVal = Buffer.from('d'.repeat(32)).toString('base64');
    keytarState.store.set(KEYTAR_KEY, keytarVal);
    await fs.writeFile(diskKeyPath, diskVal + '\n', { mode: 0o600 });

    const src = createCombinedKeySource({
      passphrasePrompt: async () => {
        throw new Error('prompt should not be called');
      },
      diskKeyPath,
    });
    const key = await src.obtain(generateSalt());

    expect(key.toString('base64')).toBe(keytarVal);
    expect(src.name).toBe('keytar');

    // Disk is backfilled with the keytar value (overwriting the stale disk val).
    const onDisk = await waitForFile(diskKeyPath, keytarVal);
    expect(onDisk).toBe(keytarVal);
  });

  it('disk value used when keytar absent, and backfills keytar', async () => {
    const diskVal = Buffer.from('d'.repeat(32)).toString('base64');
    await fs.writeFile(diskKeyPath, diskVal + '\n', { mode: 0o600 });
    // keytar empty.

    const src = createCombinedKeySource({
      passphrasePrompt: async () => {
        throw new Error('prompt should not be called');
      },
      diskKeyPath,
    });
    const key = await src.obtain(generateSalt());

    expect(key.toString('base64')).toBe(diskVal);
    expect(src.name).toBe(`file:${diskKeyPath}`);

    // keytar is backfilled with the disk value.
    const inKeytar = await waitForKeytar(KEYTAR_KEY, diskVal);
    expect(inKeytar).toBe(diskVal);
  });

  it('interactive prompt is the last resort and persists to BOTH keytar and disk', async () => {
    let prompts = 0;
    const src = createCombinedKeySource({
      passphrasePrompt: async () => {
        prompts += 1;
        return 'my-passphrase';
      },
      diskKeyPath,
    });
    const salt = generateSalt();
    const key = await src.obtain(salt);

    expect(prompts).toBe(1);
    expect(src.name).toBe('passphrase');
    expect(key.length).toBe(32);

    // The prompt branch awaits persistKey(), so both backends are written
    // synchronously before obtain() resolves.
    const expected = key.toString('base64');
    expect(keytarState.store.get(KEYTAR_KEY)).toBe(expected);
    const onDisk = (await fs.readFile(diskKeyPath, 'utf8')).trim();
    expect(onDisk).toBe(expected);
  });

  it('disableKeytar skips the keychain entirely (disk-only)', async () => {
    const src = createCombinedKeySource({
      passphrasePrompt: async () => 'pw',
      disableKeytar: true,
      diskKeyPath,
    });
    const key = await src.obtain(generateSalt());
    expect(src.name).toBe('passphrase');

    // Disk written, keytar untouched.
    const onDisk = (await fs.readFile(diskKeyPath, 'utf8')).trim();
    expect(onDisk).toBe(key.toString('base64'));
    await flushMicrotasks();
    expect(keytarState.store.size).toBe(0);
  });

  it('diskKeyPath:false disables the disk cache (keytar-only persistence)', async () => {
    const src = createCombinedKeySource({
      passphrasePrompt: async () => 'pw',
      diskKeyPath: false,
    });
    const key = await src.obtain(generateSalt());
    expect(src.name).toBe('passphrase');
    // Persisted to keytar only; no file anywhere under tmp.
    expect(keytarState.store.get(KEYTAR_KEY)).toBe(key.toString('base64'));
    const entries = await fs.readdir(tmp);
    expect(entries).toEqual([]);
  });

  it('writes the disk key file with mode 0o600', async () => {
    const src = createCombinedKeySource({
      passphrasePrompt: async () => 'pw',
      diskKeyPath,
    });
    await src.obtain(generateSalt());
    const stat = await fs.stat(diskKeyPath);
    // Mask to the permission bits; expect owner read/write only.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('name starts as "unknown" before obtain() is called', () => {
    const src = createCombinedKeySource({
      passphrasePrompt: async () => 'pw',
      diskKeyPath,
    });
    expect(src.name).toBe('unknown');
  });

  it('persist() writes the supplied key to both backends', async () => {
    const src = createCombinedKeySource({
      passphrasePrompt: async () => 'pw',
      diskKeyPath,
    });
    const key = Buffer.from('p'.repeat(32));
    await src.persist?.(key, generateSalt());
    expect(keytarState.store.get(KEYTAR_KEY)).toBe(key.toString('base64'));
    const onDisk = (await fs.readFile(diskKeyPath, 'utf8')).trim();
    expect(onDisk).toBe(key.toString('base64'));
  });

  it('falls through to the prompt when keytar throws and disk is empty', async () => {
    keytarState.failGet = true; // keychain unavailable
    let prompted = false;
    const src = createCombinedKeySource({
      passphrasePrompt: async () => {
        prompted = true;
        return 'pw';
      },
      diskKeyPath,
    });
    await src.obtain(generateSalt());
    expect(prompted).toBe(true);
    expect(src.name).toBe('passphrase');
  });
});

describe('createStaticKeySource', () => {
  it('always returns the provided key and reports name "static"', async () => {
    const key = Buffer.from('s'.repeat(32));
    const src = createStaticKeySource(key);
    expect(src.name).toBe('static');
    // Ignores the salt and returns the exact same buffer regardless.
    expect(await src.obtain(generateSalt())).toBe(key);
    expect(await src.obtain(generateSalt())).toBe(key);
    // No persist hook on the static source.
    expect(src.persist).toBeUndefined();
  });
});
