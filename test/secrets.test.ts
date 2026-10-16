import { describe, expect, it } from 'bun:test';
import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileStore, keychainStore } from '../src/secrets/store';

describe('file secret store', () => {
  it('stores, reads and deletes a value in an owner-only file', async () => {
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'rl-secrets-')), 'secrets.json');
    const store = fileStore(file);
    await store.set('account:1', 'cookie-value');
    expect(await store.get('account:1')).toBe('cookie-value');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await store.delete('account:1');
    expect(await store.get('account:1')).toBeNull();
  });
});

describe('keychain secret store', () => {
  it.if(process.platform === 'darwin')('round-trips a value through the macOS Keychain', async () => {
    const store = keychainStore();
    const key = `test-${process.pid}`;
    await store.set(key, 'v1');
    expect(await store.get(key)).toBe('v1');
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
  });
});
