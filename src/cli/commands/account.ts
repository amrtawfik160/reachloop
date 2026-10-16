import { readFile } from 'node:fs/promises';
import { type Account, addAccount, findAccount, listAccounts, removeAccount, setAccountStatus } from '../../core/accounts';
import type { App } from '../../core/app';
import { ReachloopError } from '../../core/errors';
import { usageToday } from '../../core/inbox';
import { parseCookieFile } from '../../x/cookies';
import { bool, type Command, int, requiredStr } from '../command';

export function accountView(app: App, account: Account) {
  const usage = usageToday(app, account);
  return {
    handle: `@${account.handle}`,
    status: account.status,
    replyOnly: account.replyOnly,
    dmToday: `${usage.sentToday}/${usage.capDm}`,
    signIn: account.signIn,
    lastInboxSyncAt: account.lastInboxSyncAt ? new Date(account.lastInboxSyncAt).toISOString() : null,
  };
}

function added(app: App, result: Awaited<ReturnType<typeof addAccount>>) {
  return {
    data: { ...accountView(app, result.account), created: result.created },
    warnings: result.warnings,
    hints: ['reachloop lead search --keyword "<words>" --json', 'reachloop inbox sync --json'],
  };
}

function oneHandle(positionals: string[]): string {
  const [handle] = positionals;
  if (!handle) throw new ReachloopError('USAGE', 'Name the account, for example @acme.');
  return handle;
}

export const accountCommands: Command[] = [
  {
    path: 'account add',
    usage: 'reachloop account add --cookies-file <file>',
    summary: 'Add an X account from a file with its auth_token, ct0 and twid cookies.',
    db: 'required',
    options: { 'cookies-file': { type: 'string' } },
    run: async ({ app, values }) => {
      const file = requiredStr(values, 'cookies-file');
      const text = await readFile(file, 'utf8').catch(() => {
        throw new ReachloopError('NOT_FOUND', `Cannot read ${file}.`);
      });
      const parsed = parseCookieFile(text);
      if (!parsed.ok) {
        throw new ReachloopError('USAGE', `The cookie file is missing: ${parsed.missing.join(', ')}.`, {
          hint: 'Export cookies from a signed-in x.com tab, or use: reachloop account login --browser',
        });
      }
      return added(app, await addAccount(app, { cookies: parsed.cookies, signIn: 'cookies' }));
    },
  },
  {
    path: 'account login',
    usage: 'reachloop account login --browser [--timeout <minutes>]',
    summary: 'Open Chrome so you can sign in to X yourself; Reachloop saves the session.',
    db: 'required',
    options: { browser: { type: 'boolean' }, timeout: { type: 'string' } },
    run: async ({ app, values, deps, io }) => {
      if (!bool(values, 'browser')) {
        throw new ReachloopError('USAGE', 'Use --browser, or add cookies with: reachloop account add --cookies-file <file>');
      }
      const minutes = int(values, 'timeout', 10, { min: 1, max: 60 });
      io.stderr('A Chrome window is opening. Sign in to X there. Reachloop waits and never types for you.\n');
      const cookies = await deps.signIn({ timeoutMs: minutes * 60_000 });
      return added(app, await addAccount(app, { cookies, signIn: 'browser' }));
    },
  },
  {
    path: 'account list',
    usage: 'reachloop account list',
    summary: 'List accounts with status and DMs sent today.',
    db: 'required',
    options: {},
    run: async ({ app }) => {
      const accounts = listAccounts(app).map((account) => accountView(app, account));
      return {
        data: accounts,
        meta: { total: accounts.length, returned: accounts.length },
        hints: accounts.length === 0 ? ['reachloop account login --browser'] : [],
      };
    },
  },
  {
    path: 'account show',
    usage: 'reachloop account show <@handle>',
    summary: 'Show one account.',
    db: 'required',
    options: {},
    positionals: { min: 1, max: 1 },
    run: async ({ app, positionals }) => ({ data: accountView(app, findAccount(app, oneHandle(positionals))) }),
  },
  {
    path: 'account pause',
    usage: 'reachloop account pause <@handle>',
    summary: 'Stop all sends from an account.',
    db: 'required',
    options: {},
    positionals: { min: 1, max: 1 },
    run: async ({ app, positionals }) => {
      const account = findAccount(app, oneHandle(positionals));
      setAccountStatus(app, account, 'paused');
      return { data: accountView(app, findAccount(app, account.handle)) };
    },
  },
  {
    path: 'account resume',
    usage: 'reachloop account resume <@handle>',
    summary: 'Allow sends from a paused account again.',
    db: 'required',
    options: {},
    positionals: { min: 1, max: 1 },
    run: async ({ app, positionals }) => {
      const account = findAccount(app, oneHandle(positionals));
      if (account.status !== 'paused') {
        throw new ReachloopError('USAGE', `@${account.handle} is ${account.status}, not paused.`, {
          hint: account.status === 'session_expired' ? 'reachloop account login --browser' : undefined,
        });
      }
      setAccountStatus(app, account, 'active');
      return { data: accountView(app, findAccount(app, account.handle)) };
    },
  },
  {
    path: 'account remove',
    usage: 'reachloop account remove <@handle> --yes',
    summary: 'Remove an account and delete its saved session.',
    db: 'required',
    options: { yes: { type: 'boolean' } },
    positionals: { min: 1, max: 1 },
    run: async ({ app, values, positionals }) => {
      const account = findAccount(app, oneHandle(positionals));
      if (!bool(values, 'yes')) {
        throw new ReachloopError('CONFIRM_REQUIRED', `Removing @${account.handle} needs --yes.`);
      }
      await removeAccount(app, account);
      return { data: { removed: `@${account.handle}` } };
    },
  },
];
