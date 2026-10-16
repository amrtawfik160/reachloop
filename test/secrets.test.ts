import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileStore, keychainStore, keychainWorks } from '../src/secrets/store';

describe('file secret store', () => {
  it('stores, reads and deletes a value in an owner-only file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rl-secrets-'));
    const file = path.join(dir, 'secrets.json');
    const store = fileStore(file);
    try {
      await store.set('account:1', 'cookie-value');
      expect(await store.get('account:1')).toBe('cookie-value');
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      await store.delete('account:1');
      expect(await store.get('account:1')).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('keychain secret store', () => {
  it('namespaces credentials and round-trips through the OS adapter', async () => {
    const values = new Map<string, string>();
    const store = keychainStore({
      get: async ({ service, name }) => values.get(`${service}:${name}`) ?? null,
      set: async ({ service, name, value }) => { values.set(`${service}:${name}`, value); },
      delete: async ({ service, name }) => values.delete(`${service}:${name}`),
    });
    await store.set('account:1', 'fake-session');
    expect(values.get('reachloop:account:1')).toBe('fake-session');
    expect(await store.get('account:1')).toBe('fake-session');
    await store.delete('account:1');
    expect(await store.get('account:1')).toBeNull();
    expect(await keychainWorks(store)).toBe(true);
    expect(values.size).toBe(0);
  });

  it('reports an unavailable OS store so callers can use the owner-only fallback', async () => {
    const store = keychainStore({
      get: async () => null,
      set: async () => { throw new Error('OS keychain unavailable'); },
      delete: async () => false,
    });
    expect(await keychainWorks(store)).toBe(false);
  });

  // Native credential access is an explicit integration check, not a unit-test prerequisite
  it.if(process.env.REACHLOOP_TEST_KEYCHAIN === '1')('round-trips a value through the native OS keychain', async () => {
    const store = keychainStore();
    const key = `test-${process.pid}-${Date.now()}`;
    try {
      await store.set(key, 'v1');
      expect(await store.get(key)).toBe('v1');
      await store.delete(key);
      expect(await store.get(key)).toBeNull();
    } finally {
      await store.delete(key);
    }
  });
});
