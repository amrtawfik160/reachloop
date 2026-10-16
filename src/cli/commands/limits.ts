import { findAccount } from '../../core/accounts';
import { logEvent } from '../../core/app';
import { ReachloopError } from '../../core/errors';
import { usageToday } from '../../core/inbox';
import { MAX_DAILY_DM_CAP } from '../../core/send-gate';
import { type Command, oneOf, str } from '../command';

export const limitsCommands: Command[] = [
  {
    path: 'limits show',
    usage: 'reachloop limits show <@account>',
    summary: "Show an account's daily DM cap, reply-only setting and today's usage.",
    db: 'required',
    options: {},
    positionals: { min: 1, max: 1 },
    run: async ({ app, positionals }) => {
      const account = findAccount(app, positionals[0] ?? '');
      return { data: { account: `@${account.handle}`, ...usageToday(app, account), replyOnly: account.replyOnly, hardMax: MAX_DAILY_DM_CAP } };
    },
  },
  {
    path: 'limits set',
    usage: 'reachloop limits set <@account> [--dm <0-250>] [--reply-only <on|off>]',
    summary: `Set the daily DM cap or reply-only setting. The hard maximum is ${MAX_DAILY_DM_CAP}.`,
    db: 'required',
    options: { dm: { type: 'string' }, 'reply-only': { type: 'string' } },
    positionals: { min: 1, max: 1 },
    run: async ({ app, values, positionals }) => {
      const account = findAccount(app, positionals[0] ?? '');
      const raw = str(values, 'dm');
      const replyOnly = oneOf(values, 'reply-only', ['on', 'off'] as const);
      if (raw === undefined && replyOnly === undefined) {
        throw new ReachloopError('USAGE', 'Provide --dm and/or --reply-only.');
      }
      const cap = raw === undefined ? undefined : Number(raw);
      if (cap !== undefined) {
        if (!raw?.trim() || !Number.isInteger(cap) || cap < 0) {
          throw new ReachloopError('USAGE', '--dm must be a whole number from 0 to 250.');
        }
        if (cap > MAX_DAILY_DM_CAP) {
          throw new ReachloopError('CAP_ABOVE_MAX', `The daily DM cap cannot go above ${MAX_DAILY_DM_CAP}.`);
        }
      }
      // Validate both settings before writing, then save settings and audit events together.
      app.db.transaction(() => {
        if (cap !== undefined) {
          app.db.query('UPDATE accounts SET cap_dm = ? WHERE id = ?').run(cap, account.id);
          logEvent(app, { kind: 'cap_changed', accountId: account.id, data: { capDm: cap } });
        }
        if (replyOnly !== undefined) {
          const enabled = replyOnly === 'on';
          app.db.query('UPDATE accounts SET reply_only = ? WHERE id = ?').run(enabled ? 1 : 0, account.id);
          logEvent(app, { kind: 'reply_only_changed', accountId: account.id, data: { replyOnly: enabled } });
        }
      })();
      const updated = findAccount(app, account.handle);
      return { data: { account: `@${account.handle}`, ...usageToday(app, updated), replyOnly: updated.replyOnly, hardMax: MAX_DAILY_DM_CAP } };
    },
  },
];
