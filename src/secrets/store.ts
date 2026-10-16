import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type SecretBackend = 'keychain' | 'file';

export interface SecretStore {
  readonly backend: SecretBackend;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const SERVICE = 'reachloop';

export function keychainStore(): SecretStore {
  return {
    backend: 'keychain',
    get: (name) => Bun.secrets.get({ service: SERVICE, name }),
    set: (name, value) => Bun.secrets.set({ service: SERVICE, name, value }),
    delete: async (name) => {
      await Bun.secrets.delete({ service: SERVICE, name });
    },
  };
}

export function fileStore(file: string): SecretStore {
  async function load(): Promise<Record<string, string>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }
  async function save(values: Record<string, string>): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const partial = `${file}.${process.pid}.partial`;
    await writeFile(partial, JSON.stringify(values), { mode: 0o600 });
    await chmod(partial, 0o600);
    await rename(partial, file);
  }
  return {
    backend: 'file',
    get: async (key) => (await load())[key] ?? null,
    set: async (key, value) => save({ ...(await load()), [key]: value }),
    delete: async (key) => {
      const values = await load();
      delete values[key];
      await save(values);
    },
  };
}

export async function keychainWorks(store: SecretStore): Promise<boolean> {
  const probe = 'reachloop-probe';
  try {
    await store.set(probe, 'ok');
    const ok = (await store.get(probe)) === 'ok';
    await store.delete(probe);
    return ok;
  } catch {
    return false;
  }
}
