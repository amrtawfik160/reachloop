import { existsSync } from 'node:fs';
import { type Db, openDb } from '../db/db';
import { type Paths, resolvePaths } from '../paths';
import { fileStore, keychainStore, keychainWorks, type SecretStore } from '../secrets/store';
import type { BrowserSignIn } from '../signin/chrome';
import type { XConnect } from '../x/session';
import { ReachloopError } from './errors';

export type Env = Record<string, string | undefined>;

export type App = {
  db: Db;
  paths: Paths;
  env: Env;
  secrets: { active: SecretStore; keychain: SecretStore; file: SecretStore };
  connect: XConnect;
  signIn: BrowserSignIn;
  now: () => number;
};

export type AppDeps = Pick<App, 'connect' | 'signIn' | 'now'> & { env: Env };

export function isInitialized(env: Env): boolean {
  return existsSync(resolvePaths(env).db);
}

export async function openApp(deps: AppDeps, options: { create: boolean }): Promise<App> {
  const paths = resolvePaths(deps.env);
  if (!options.create && !existsSync(paths.db)) {
    throw new ReachloopError('NOT_INITIALIZED', `No Reachloop database at ${paths.db}.`, { hint: 'reachloop init' });
  }
  const db = openDb(paths.db);
  const file = fileStore(paths.secretsFile);
  const keychain = keychainStore();
  return { ...deps, db, paths, secrets: { active: await chooseSecretStore(db, deps.env, { keychain, file }), keychain, file } };
}

// The OS keychain is preferred. Linux machines without a Secret Service daemon
// fall back to an owner-only file. The probe writes a test entry, so its
// answer is kept in settings instead of probing on every command.
async function chooseSecretStore(db: Db, env: Env, stores: { keychain: SecretStore; file: SecretStore }): Promise<SecretStore> {
  const override = env.REACHLOOP_SECRET_STORE;
  if (override === 'file' || override === 'keychain') return stores[override];
  const saved = db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'secret_backend'").get()?.value;
  if (saved === 'file' || saved === 'keychain') return stores[saved];
  const chosen = (await keychainWorks(stores.keychain)) ? stores.keychain : stores.file;
  db.query("INSERT INTO settings (key, value) VALUES ('secret_backend', ?)").run(chosen.backend);
  return chosen;
}

export function localDay(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function logEvent(app: App, event: { kind: string; accountId?: number; leadId?: number; data?: unknown }): void {
  app.db
    .query('INSERT INTO events (at, actor, kind, account_id, lead_id, data_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(
      app.now(),
      app.env.REACHLOOP_ACTOR ?? 'cli',
      event.kind,
      event.accountId ?? null,
      event.leadId ?? null,
      event.data === undefined ? null : JSON.stringify(event.data),
    );
}

export function getSetting(app: App, key: string): string | null {
  return app.db.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

export function setSetting(app: App, key: string, value: string): void {
  app.db.query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
}
