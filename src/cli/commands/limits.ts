import { findAccount } from '../../core/accounts';
import { logEvent } from '../../core/app';
import { ReachloopError } from '../../core/errors';
import { usageToday } from '../../core/inbox';
import { MAX_DAILY_DM_CAP } from '../../core/send-gate';
import { type Command, requiredStr } from '../command';

export const limitsCommands: Command[] = [
  {
    path: 'limits show',
    usage: 'reachloop limits show <@account>',
    summary: "Show an account's daily DM cap and today's usage.",
    db: 'required',
    options: {},
    positionals: { min: 1, max: 1 },
    run: async ({ app, positionals }) => {
      const account = findAccount(app, positionals[0] ?? '');
      return { data: { account: `@${account.handle}`, ...usageToday(app, account), hardMax: MAX_DAILY_DM_CAP } };
    },
  },
  {
    path: 'limits set',
    usage: 'reachloop limits set <@account> --dm <0-200>',
    summary: `Set the daily DM cap. The hard maximum is ${MAX_DAILY_DM_CAP}.`,
    db: 'required',
    options: { dm: { type: 'string' } },
    positionals: { min: 1, max: 1 },
    run: async ({ app, values, positionals }) => {
      const account = findAccount(app, positionals[0] ?? '');
      const raw = requiredStr(values, 'dm');
      const cap = Number(raw);
      if (!Number.isInteger(cap) || cap < 0) throw new ReachloopError('USAGE', '--dm must be a whole number.');
      if (cap > MAX_DAILY_DM_CAP) {
        throw new ReachloopError('CAP_ABOVE_MAX', `The daily DM cap cannot go above ${MAX_DAILY_DM_CAP}.`);
      }
      app.db.query('UPDATE accounts SET cap_dm = ? WHERE id = ?').run(cap, account.id);
      logEvent(app, { kind: 'cap_changed', accountId: account.id, data: { capDm: cap } });
      return { data: { account: `@${account.handle}`, ...usageToday(app, findAccount(app, account.handle)), hardMax: MAX_DAILY_DM_CAP } };
    },
  },
];
