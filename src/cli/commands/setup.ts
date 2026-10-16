import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listAccounts, withX } from '../../core/accounts';
import { type App, type Env, getSetting, setSetting } from '../../core/app';
import { ReachloopError } from '../../core/errors';
import { syncInbox } from '../../core/inbox';
import { resolvePaths } from '../../paths';
import { findChrome } from '../../signin/chrome';
import { SKILL_FILES } from '../../skill-files';
import { disposeHttpClient, fetchImpersonated } from '../../x/http-client';
import { bool, type Command, oneOf } from '../command';
import { accountView } from './account';

export const X_RULES_NOTICE = [
  'Reachloop sends DMs from your own X account, from your own computer.',
  'You can initiate DMs by default, subject to X recipient permissions. The optional reply-only mode is disabled by default.',
  'Each account defaults to 50 DMs per day, with a hard maximum of 250. These limits do not guarantee compliance with X rules.',
  'X may suspend accounts that it sees as automated. You are responsible for how you use your accounts.',
  'Reachloop has no built-in AI, no proxies and no telemetry. Your data stays in one file on this computer.',
].join('\n');

function schemaVersion(app: App): number {
  return app.db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
}

function skillTargets(env: Env, agent: 'claude' | 'codex' | 'all'): string[] {
  const home = env.HOME || os.homedir();
  const claude = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'skills', 'reachloop');
  const codex = path.join(env.CODEX_HOME || path.join(home, '.codex'), 'skills', 'reachloop');
  if (agent === 'claude') return [claude];
  if (agent === 'codex') return [codex];
  return [claude, codex];
}

export const setupCommands: Command[] = [
  {
    path: 'init',
    usage: 'reachloop init',
    summary: 'Create the Reachloop database and show the X rules notice.',
    options: {},
    db: 'create',
    run: async ({ app }) => {
      const firstRun = getSetting(app, 'rules_notice_shown_at') === null;
      if (firstRun) setSetting(app, 'rules_notice_shown_at', new Date(app.now()).toISOString());
      return {
        data: { db: app.paths.db, schemaVersion: schemaVersion(app), secretStore: app.secrets.active.backend, notice: X_RULES_NOTICE },
        human: `${X_RULES_NOTICE}\n\nDatabase: ${app.paths.db}`,
        hints: ['reachloop account login --browser', 'reachloop skill install --agent all'],
      };
    },
  },
  {
    path: 'doctor',
    usage: 'reachloop doctor [--offline]',
    summary: 'Check the database, saved sessions, Chrome and the connection to X.',
    db: 'required',
    options: { offline: { type: 'boolean' } },
    run: async ({ app, values }) => {
      const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
      checks.push({ check: 'database', ok: true, detail: `${app.paths.db} (schema ${schemaVersion(app)})` });
      checks.push({
        check: 'secret store',
        ok: true,
        detail:
          app.secrets.active.backend === 'keychain'
            ? 'OS keychain'
            : `file ${app.paths.secretsFile} (owner-only); no OS keychain was available`,
      });
      const chrome = await findChrome(app.env);
      checks.push({ check: 'chrome', ok: chrome !== null, detail: chrome ?? 'not found; browser sign-in needs Google Chrome or Chromium' });
      if (!bool(values, 'offline')) {
        try {
          const response = await fetchImpersonated('https://x.com/', { timeoutMs: 15_000 });
          checks.push({ check: 'x.com', ok: response.status < 500, detail: `HTTP ${response.status} with Chrome TLS` });
        } catch (err) {
          checks.push({ check: 'x.com', ok: false, detail: (err as Error).message });
        }
        for (const account of listAccounts(app).filter((a) => a.status === 'active')) {
          try {
            const me = await withX(app, account, (x) => x.me());
            checks.push({ check: `session @${account.handle}`, ok: true, detail: `signed in as @${me.handle}` });
          } catch (err) {
            checks.push({ check: `session @${account.handle}`, ok: false, detail: (err as Error).message });
          }
        }
        await disposeHttpClient();
      }
      const healthy = checks.every((c) => c.ok);
      return {
        data: { healthy, checks },
        human: checks.map((c) => `${c.ok ? 'ok  ' : 'FAIL'}  ${c.check}: ${c.detail}`).join('\n'),
      };
    },
  },
  {
    path: 'status',
    usage: 'reachloop',
    summary: 'Show accounts, DMs sent today, leads and unread conversations.',
    db: 'required',
    options: {},
    run: async ({ app }) => {
      const accounts = listAccounts(app).map((account) => accountView(app, account));
      const leads = Object.fromEntries(
        app.db
          .query<{ status: string; n: number }, []>('SELECT status, count(*) AS n FROM leads GROUP BY status')
          .all()
          .map((row) => [row.status, row.n]),
      );
      const unread = app.db.query<{ n: number }, []>('SELECT count(*) AS n FROM conversations WHERE unread = 1').get()?.n ?? 0;
      const hints =
        accounts.length === 0
          ? ['reachloop account login --browser']
          : unread > 0
            ? ['reachloop inbox list --unread --json']
            : ['reachloop inbox sync --json'];
      return { data: { accounts, leads, unreadConversations: unread }, hints };
    },
  },
  {
    path: 'run once',
    usage: 'reachloop run once',
    summary: 'Do one round of background work now: sync the inbox of every active account.',
    db: 'required',
    options: {},
    run: async ({ app }) => {
      const results = [];
      for (const account of listAccounts(app).filter((a) => a.status === 'active')) {
        try {
          results.push({ ok: true, ...(await syncInbox(app, account)) });
        } catch (err) {
          const code = err instanceof ReachloopError ? err.code : 'INTERNAL';
          results.push({ ok: false, account: `@${account.handle}`, code, message: (err as Error).message });
        }
      }
      return { data: results, hints: ['reachloop inbox list --unread --json'] };
    },
  },
  {
    path: 'db path',
    usage: 'reachloop db path',
    summary: 'Print where the database file is.',
    db: 'none',
    options: {},
    run: async ({ deps }) => {
      const paths = resolvePaths(deps.env);
      return { data: { db: paths.db, home: paths.home }, human: paths.db };
    },
  },
  {
    path: 'skill install',
    usage: 'reachloop skill install --agent claude|codex|all',
    summary: 'Install the Reachloop skill for Claude Code and/or Codex.',
    db: 'none',
    options: { agent: { type: 'string' } },
    run: async ({ deps, values }) => {
      const agent = oneOf(values, 'agent', ['claude', 'codex', 'all'] as const) ?? 'all';
      const installed: string[] = [];
      for (const dir of skillTargets(deps.env, agent)) {
        for (const [relative, content] of Object.entries(SKILL_FILES)) {
          const file = path.join(dir, relative);
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, content);
        }
        installed.push(dir);
      }
      return { data: { installed }, hints: ['Restart your agent so it loads the skill.'] };
    },
  },
];
