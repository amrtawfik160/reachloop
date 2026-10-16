import type { TwitterAuthCookies } from '../x/client';
import { XError, type XProfile, type XSession } from '../x/session';
import { type App, logEvent } from './app';
import { fromXError, ReachloopError } from './errors';
import { type AccountStatus, DEFAULT_DAILY_DM_CAP } from './send-gate';

export const ACCOUNT_WARNING_THRESHOLD = 3;

export type SignInMethod = 'cookies' | 'browser';

export type Account = {
  id: number;
  xUserId: string;
  handle: string;
  status: AccountStatus;
  signIn: SignInMethod;
  secretRef: string;
  capDm: number;
  lastInboxSyncAt: number | null;
  createdAt: number;
};

type AccountRow = {
  id: number;
  x_user_id: string;
  handle: string;
  status: AccountStatus;
  sign_in: SignInMethod;
  secret_ref: string;
  cap_dm: number;
  last_inbox_sync_at: number | null;
  created_at: number;
};

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    xUserId: row.x_user_id,
    handle: row.handle,
    status: row.status,
    signIn: row.sign_in,
    secretRef: row.secret_ref,
    capDm: row.cap_dm,
    lastInboxSyncAt: row.last_inbox_sync_at,
    createdAt: row.created_at,
  };
}

export function bareHandle(handle: string): string {
  return handle.trim().replace(/^@/, '');
}

export function listAccounts(app: App): Account[] {
  return app.db.query<AccountRow, []>('SELECT * FROM accounts ORDER BY id').all().map(toAccount);
}

export function findAccount(app: App, handle: string): Account {
  const row = app.db.query<AccountRow, [string]>('SELECT * FROM accounts WHERE handle = ?').get(bareHandle(handle));
  if (!row) {
    throw new ReachloopError('NO_ACCOUNT', `No account @${bareHandle(handle)} in Reachloop.`, { hint: 'reachloop account list' });
  }
  return toAccount(row);
}

export function resolveAccount(app: App, handle: string | undefined): Account {
  if (handle) return findAccount(app, handle);
  const active = listAccounts(app).filter((account) => account.status === 'active');
  if (active.length === 1 && active[0]) return active[0];
  if (active.length === 0) {
    throw new ReachloopError('NO_ACCOUNT', 'No active X account.', { hint: 'reachloop account login --browser' });
  }
  throw new ReachloopError('USAGE', `There are ${active.length} active accounts. Pick one with --account @handle.`, {
    hint: 'reachloop account list',
  });
}

function secretKey(xUserId: string): string {
  return `account:${xUserId}`;
}

function storeOf(app: App, ref: string): { store: App['secrets']['active']; key: string } {
  const separator = ref.indexOf(':');
  const backend = ref.slice(0, separator);
  return { store: backend === 'keychain' ? app.secrets.keychain : app.secrets.file, key: ref.slice(separator + 1) };
}

async function loadCookies(app: App, account: Account): Promise<TwitterAuthCookies> {
  const { store, key } = storeOf(app, account.secretRef);
  const raw = await store.get(key);
  if (!raw) {
    throw new ReachloopError('SESSION_EXPIRED', `The saved session for @${account.handle} is missing.`, {
      hint: 'reachloop account login --browser',
    });
  }
  return JSON.parse(raw) as TwitterAuthCookies;
}

export function setAccountStatus(app: App, account: Account, status: AccountStatus): void {
  app.db.query('UPDATE accounts SET status = ? WHERE id = ?').run(status, account.id);
  logEvent(app, { kind: 'account_status', accountId: account.id, data: { status } });
}

// An expired or suspended session marks the account, so the send gate refuses
// later sends without calling X.
export async function withX<T>(app: App, account: Account, work: (x: XSession) => Promise<T>): Promise<T> {
  const cookies = await loadCookies(app, account);
  const { store, key } = storeOf(app, account.secretRef);
  const x = app.connect({ cookies, onCookiesRotated: (next) => store.set(key, JSON.stringify(next)) });
  try {
    return await work(x);
  } catch (err) {
    if (!(err instanceof XError)) throw err;
    if (err.code === 'SESSION_EXPIRED') setAccountStatus(app, account, 'session_expired');
    if (err.code === 'ACCOUNT_SUSPENDED') setAccountStatus(app, account, 'suspended');
    throw fromXError(err, `@${account.handle}`);
  }
}

export type AddedAccount = { account: Account; created: boolean; warnings: string[] };

export async function addAccount(
  app: App,
  args: { cookies: TwitterAuthCookies; signIn: SignInMethod },
): Promise<AddedAccount> {
  let profile: XProfile;
  try {
    profile = await app.connect({ cookies: args.cookies, onCookiesRotated: async () => {} }).me();
  } catch (err) {
    if (err instanceof XError) throw fromXError(err, 'these cookies');
    throw err;
  }
  const key = secretKey(profile.xUserId);
  await app.secrets.active.set(key, JSON.stringify(args.cookies));
  const secretRef = `${app.secrets.active.backend}:${key}`;
  const existing = app.db.query<AccountRow, [string]>('SELECT * FROM accounts WHERE x_user_id = ?').get(profile.xUserId);
  if (existing) {
    app.db
      .query("UPDATE accounts SET handle = ?, status = 'active', sign_in = ?, secret_ref = ? WHERE id = ?")
      .run(profile.handle, args.signIn, secretRef, existing.id);
  } else {
    app.db
      .query(
        "INSERT INTO accounts (x_user_id, handle, status, sign_in, secret_ref, cap_dm, created_at) VALUES (?, ?, 'active', ?, ?, ?, ?)",
      )
      .run(profile.xUserId, profile.handle, args.signIn, secretRef, DEFAULT_DAILY_DM_CAP, app.now());
  }
  const account = findAccount(app, profile.handle);
  logEvent(app, { kind: existing ? 'account_signed_in' : 'account_added', accountId: account.id, data: { signIn: args.signIn } });
  const count = listAccounts(app).length;
  const warnings =
    count > ACCOUNT_WARNING_THRESHOLD
      ? [
          `You now have ${count} accounts. They all send from this computer's IP address, so X can link them. Reachloop suggests ${ACCOUNT_WARNING_THRESHOLD} or fewer.`,
        ]
      : [];
  return { account, created: !existing, warnings };
}

export async function removeAccount(app: App, account: Account): Promise<void> {
  const { store, key } = storeOf(app, account.secretRef);
  await store.delete(key).catch(() => {});
  app.db.query('DELETE FROM accounts WHERE id = ?').run(account.id);
  logEvent(app, { kind: 'account_removed', data: { handle: account.handle } });
}
