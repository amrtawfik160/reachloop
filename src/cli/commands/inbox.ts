import { findAccount, listAccounts, resolveAccount } from '../../core/accounts';
import { ReachloopError } from '../../core/errors';
import { listInbox, reply, showConversation, syncInbox } from '../../core/inbox';
import { bool, type Command, int, requiredStr, str } from '../command';

function iso(at: number | null): string | null {
  return at ? new Date(at).toISOString() : null;
}

export const inboxCommands: Command[] = [
  {
    path: 'inbox sync',
    usage: 'reachloop inbox sync [@account]',
    summary: 'Read new DMs and message requests from X for one account, or all active accounts.',
    db: 'required',
    options: {},
    positionals: { min: 0, max: 1 },
    run: async ({ app, positionals }) => {
      const [handle] = positionals;
      const accounts = handle ? [findAccount(app, handle)] : listAccounts(app).filter((a) => a.status === 'active');
      if (accounts.length === 0) {
        throw new ReachloopError('NO_ACCOUNT', 'No active X account.', { hint: 'reachloop account login --browser' });
      }
      const results = [];
      for (const account of accounts) results.push(await syncInbox(app, account));
      return {
        data: results.map(({ warnings: _, ...rest }) => rest),
        warnings: results.flatMap((r) => r.warnings.map((w) => `${r.account}: ${w}`)),
        hints: ['reachloop inbox list --unread --json'],
      };
    },
  },
  {
    path: 'inbox list',
    usage: 'reachloop inbox list [--unread] [--account @a] [--limit 20]',
    summary: 'List conversations, newest first, with the last message.',
    db: 'required',
    options: { unread: { type: 'boolean' }, account: { type: 'string' }, limit: { type: 'string' } },
    run: async ({ app, values }) => {
      const accountHandle = str(values, 'account');
      const { items, total } = listInbox(app, {
        unreadOnly: bool(values, 'unread'),
        account: accountHandle ? findAccount(app, accountHandle) : undefined,
        limit: int(values, 'limit', 20, { min: 1, max: 200 }),
      });
      const first = items[0];
      return {
        data: items.map((item) => ({ ...item, at: iso(item.at) })),
        meta: { total, returned: items.length },
        hints: first ? [`reachloop inbox show ${first.lead} --json`] : ['reachloop inbox sync --json'],
      };
    },
  },
  {
    path: 'inbox show',
    usage: 'reachloop inbox show <@lead> [--account @a] [--limit 10] [--cached]',
    summary: 'Show one conversation, fetched fresh from X unless --cached.',
    db: 'required',
    options: { account: { type: 'string' }, limit: { type: 'string' }, cached: { type: 'boolean' } },
    positionals: { min: 1, max: 1 },
    run: async ({ app, values, positionals }) => {
      const result = await showConversation(app, {
        handle: positionals[0] ?? '',
        account: str(values, 'account'),
        limit: int(values, 'limit', 10, { min: 1, max: 50 }),
        refresh: !bool(values, 'cached'),
      });
      return {
        data: {
          lead: `@${result.lead.handle}`,
          name: result.lead.name,
          account: result.account,
          canReply: result.canReply,
          messages: result.messages.map((m) => ({ ...m, at: iso(m.at) })),
        },
        hints: result.canReply
          ? [`reachloop inbox reply @${result.lead.handle} --account ${result.account} --text "<your reply>" --yes --json`]
          : [],
      };
    },
  },
  ...['reply', 'send'].map((verb): Command => ({
    path: `inbox ${verb}`,
    usage: `reachloop inbox ${verb} <@lead> --text "<message>" --yes [--account @a] [--idempotency-key k] [--dry-run]`,
    summary: 'Send a DM, subject to account limits and optional reply-only policy.',
    db: 'required',
    options: {
      text: { type: 'string' },
      yes: { type: 'boolean' },
      account: { type: 'string' },
      'idempotency-key': { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    positionals: { min: 1, max: 1 },
    run: async ({ app, values, positionals }) => {
      const handle = positionals[0] ?? '';
      const account = str(values, 'account');
      const result = await reply(app, {
        handle,
        account: account ? resolveAccount(app, account).handle : undefined,
        text: requiredStr(values, 'text'),
        confirmed: bool(values, 'yes'),
        idempotencyKey: str(values, 'idempotency-key'),
        dryRun: bool(values, 'dry-run'),
      });
      return { data: result, hints: [`reachloop inbox show ${result.lead} --json`] };
    },
  })),
];
