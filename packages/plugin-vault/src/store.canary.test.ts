import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VaultStore, VaultPassphraseError } from './store.js';
import { createStaticKeySource } from './keysource.js';
import { deriveKey, encrypt, generateSalt } from './crypto.js';

let tmp: string;
let filePath: string;

const keyA = deriveKey('passphrase-A', generateSalt());
const keyB = deriveKey('passphrase-B', generateSalt());

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mox-vault-canary-'));
  filePath = path.join(tmp, 'vault.json');
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const storeWith = (key: Buffer) =>
  new VaultStore({ filePath, keySource: createStaticKeySource(key) });

describe('VaultStore canary verification', () => {
  it('writes a canary into a freshly created vault', async () => {
    const a = storeWith(keyA);
    await a.set('first', 'value'); // triggers new-vault creation + canary write

    const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(raw.canary).toMatchObject({
      iv: expect.any(String),
      tag: expect.any(String),
      data: expect.any(String),
    });
    // The canary plaintext is fixed and must not appear in ciphertext.
    expect(JSON.stringify(raw.canary)).not.toContain('moxxy:vault:v1');
  });

  it('rejects open()/get() with VaultPassphraseError + recovery hint on wrong key', async () => {
    const a = storeWith(keyA);
    await a.set('secret', 'hunter2');

    // Reopen the same on-disk vault with a DIFFERENT key.
    const b = storeWith(keyB);
    const err = await b.open().then(
      () => null,
      (e) => e as Error,
    );
    expect(err).toBeInstanceOf(VaultPassphraseError);
    expect((err as VaultPassphraseError).message).toContain('Wrong vault passphrase');
    // Recovery hint surfaces the exact file + the wipe instructions.
    expect((err as VaultPassphraseError).message).toContain(filePath);
    expect((err as VaultPassphraseError).message).toContain('moxxy init');
    expect((err as VaultPassphraseError).message).toContain('~/.moxxy/vault.key');
    expect((err as VaultPassphraseError).message).toContain('MOXXY_VAULT_PASSPHRASE');

    // A fresh store opened lazily through get() must reject the same way —
    // the canary check runs on the implicit open(), not just explicit open().
    const c = storeWith(keyB);
    await expect(c.get('secret')).rejects.toBeInstanceOf(VaultPassphraseError);
  });

  it('backfills a canary on first open of a legacy (canary-less) vault and still verifies', async () => {
    // Build a legacy VaultFile by hand: version 1, one real entry, NO canary.
    const salt = generateSalt();
    const legacyKey = deriveKey('legacy-pass', salt);
    const now = new Date().toISOString();
    const entryBlob = encrypt('legacy-secret', legacyKey);
    const legacyFile = {
      version: 1,
      kdf: 'scrypt',
      salt: salt.toString('base64'),
      entries: {
        token: { ...entryBlob, createdAt: now, updatedAt: now },
      },
      // no `canary` field
    };
    await fs.writeFile(filePath, JSON.stringify(legacyFile, null, 2), { mode: 0o600 });
    expect(JSON.parse(await fs.readFile(filePath, 'utf8')).canary).toBeUndefined();

    // Open with the correct legacy key: verifyPassphrase probes the first
    // entry (no canary present) and must succeed, then backfill a canary.
    const store = new VaultStore({ filePath, keySource: createStaticKeySource(legacyKey) });
    await store.open();
    expect(await store.get('token')).toBe('legacy-secret');

    // The canary was backfilled and persisted to disk.
    const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(raw.canary).toMatchObject({ iv: expect.any(String), tag: expect.any(String) });
    // Existing entry preserved untouched.
    expect(raw.entries.token).toBeDefined();

    // Reopen a fresh instance: now the backfilled canary is what gets verified.
    const reopened = new VaultStore({
      filePath,
      keySource: createStaticKeySource(legacyKey),
    });
    expect(await reopened.get('token')).toBe('legacy-secret');
  });

  it('rejects a legacy vault opened with the wrong key (entry-probe path)', async () => {
    // Legacy file (no canary) with one entry, encrypted under keyA.
    const salt = generateSalt();
    const realKey = deriveKey('right', salt);
    const now = new Date().toISOString();
    const legacyFile = {
      version: 1,
      kdf: 'scrypt',
      salt: salt.toString('base64'),
      entries: { e: { ...encrypt('v', realKey), createdAt: now, updatedAt: now } },
    };
    await fs.writeFile(filePath, JSON.stringify(legacyFile, null, 2), { mode: 0o600 });

    const wrongKey = deriveKey('wrong', salt);
    const store = new VaultStore({ filePath, keySource: createStaticKeySource(wrongKey) });
    // decrypt of the probe entry fails the AES-GCM auth tag -> friendly error.
    await expect(store.open()).rejects.toBeInstanceOf(VaultPassphraseError);
  });

  it('verifyPassphrase is a no-op for an empty legacy vault (no canary, no entries)', async () => {
    const salt = generateSalt();
    const legacyFile = {
      version: 1,
      kdf: 'scrypt',
      salt: salt.toString('base64'),
      entries: {},
      // no canary, no entries -> nothing to verify
    };
    await fs.writeFile(filePath, JSON.stringify(legacyFile, null, 2), { mode: 0o600 });

    // ANY key opens an empty legacy vault without error (nothing to probe).
    const anyKey = deriveKey('whatever', generateSalt());
    const store = new VaultStore({ filePath, keySource: createStaticKeySource(anyKey) });
    await expect(store.open()).resolves.toBeUndefined();
    // And it backfills a canary so subsequent opens are verifiable.
    const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(raw.canary).toMatchObject({ iv: expect.any(String) });
  });

  it('rejects an unsupported vault file version/kdf', async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({ version: 2, kdf: 'scrypt', salt: 'x', entries: {} }),
      { mode: 0o600 },
    );
    const store = storeWith(keyA);
    await expect(store.open()).rejects.toThrow(/Unsupported vault file/);
  });
});
