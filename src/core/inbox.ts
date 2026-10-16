import { createHash } from 'node:crypto';
import type { XConversation, XMessage } from '../x/session';
import { type Account, findAccount, listAccounts, resolveAccount, withX } from './accounts';
import { type App, localDay, logEvent } from './app';
import { ReachloopError } from './errors';
import { findLead, type Lead, upsertLead } from './leads';
import { checkReply } from './send-gate';

const UNVERIFIED_SEND_EXPIRY_MS = 60 * 60 * 1000;

type ConversationRow = { id: number; account_id: number; lead_id: number; x_conversation_id: string; has_inbound: number };

function conversationFor(app: App, accountId: number, leadId: number): ConversationRow | null {
  return app.db
    .query<ConversationRow, [number, number]>(
      'SELECT id, account_id, lead_id, x_conversation_id, has_inbound FROM conversations WHERE account_id = ? AND lead_id = ?',
    )
    .get(accountId, leadId);
}

function storeMessages(app: App, conversationId: number, messages: XMessage[]): number {
  let stored = 0;
  for (const message of messages) {
    const result = app.db
      .query(
        "INSERT OR IGNORE INTO messages (conversation_id, direction, body, x_message_id, send_state, origin, at) VALUES (?, ?, ?, ?, ?, 'x', ?)",
      )
      .run(conversationId, message.direction, message.text, message.id, message.direction === 'out' ? 'sent' : null, message.at);
    stored += result.changes;
  }
  return stored;
}

function sentToday(app: App, accountId: number): number {
  return (
    app.db
      .query<{ count: number }, [number, string]>("SELECT count FROM daily_usage WHERE account_id = ? AND day = ? AND action = 'dm'")
      .get(accountId, localDay(app.now()))?.count ?? 0
  );
}

function addUsage(app: App, accountId: number, day: string, delta: number): void {
  app.db
    .query(
      `INSERT INTO daily_usage (account_id, day, action, count) VALUES (?, ?, 'dm', MAX(?, 0))
       ON CONFLICT (account_id, day, action) DO UPDATE SET count = MAX(count + ?, 0)`,
    )
    .run(accountId, day, delta, delta);
}

// A send whose result never came back stays "reserved". When the inbox shows an
// outbound message with the same text, the send happened; after an hour with no
// such message it is treated as failed and its usage is released.
function reconcileReserved(app: App, conversationId: number, accountId: number, xMessages: XMessage[]): void {
  const reserved = app.db
    .query<{ id: number; body: string; at: number }, [number]>(
      "SELECT id, body, at FROM messages WHERE conversation_id = ? AND send_state = 'reserved'",
    )
    .all(conversationId);
  for (const row of reserved) {
    const match = xMessages.find((m) => m.direction === 'out' && m.text === row.body && m.at >= row.at - 60_000);
    if (match) {
      app.db.query('DELETE FROM messages WHERE x_message_id = ? AND id != ?').run(match.id, row.id);
      app.db.query("UPDATE messages SET send_state = 'sent', x_message_id = ?, at = ? WHERE id = ?").run(match.id, match.at, row.id);
    } else if (app.now() - row.at > UNVERIFIED_SEND_EXPIRY_MS) {
      app.db.query("UPDATE messages SET send_state = 'failed' WHERE id = ?").run(row.id);
      addUsage(app, accountId, localDay(row.at), -1);
    }
  }
}

function recordConversation(app: App, account: Account, conversation: XConversation): { leadId: number; stored: number } {
  const { id: leadId } = upsertLead(app, { ...conversation.peer, canDm: undefined }, 'inbox');
  const hasInbound = conversation.messages.some((m) => m.direction === 'in') ? 1 : 0;
  const lastAt = conversation.messages.reduce((latest, m) => Math.max(latest, m.at), 0) || null;
  app.db
    .query(
      `INSERT INTO conversations (account_id, lead_id, x_conversation_id, has_inbound, unread, last_message_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, lead_id) DO UPDATE SET
         x_conversation_id = excluded.x_conversation_id,
         has_inbound = MAX(has_inbound, excluded.has_inbound),
         unread = excluded.unread,
         last_message_at = MAX(COALESCE(last_message_at, 0), COALESCE(excluded.last_message_at, 0))`,
    )
    .run(account.id, leadId, conversation.conversationId, hasInbound, conversation.unread ? 1 : 0, lastAt);
  const row = conversationFor(app, account.id, leadId);
  if (!row) throw new ReachloopError('INTERNAL', 'conversation row missing after upsert');
  reconcileReserved(app, row.id, account.id, conversation.messages);
  const stored = storeMessages(app, row.id, conversation.messages);
  if (hasInbound) app.db.query("UPDATE leads SET status = 'replied' WHERE id = ? AND status IN ('new','contacted')").run(leadId);
  return { leadId, stored };
}

export type SyncResult = { account: string; conversations: number; newMessages: number; unread: number; warnings: string[] };

export async function syncInbox(app: App, account: Account): Promise<SyncResult> {
  return withX(app, account, async (x) => {
    const warnings: string[] = [];
    const trusted = await x.inbox('trusted');
    let requests: XConversation[] = [];
    try {
      requests = await x.inbox('untrusted');
    } catch (err) {
      if (err instanceof ReachloopError && (err.code === 'SESSION_EXPIRED' || err.code === 'ACCOUNT_SUSPENDED')) throw err;
      warnings.push(`Message requests could not be read: ${(err as Error).message}`);
    }
    let newMessages = 0;
    const all = [...trusted, ...requests];
    app.db.transaction(() => {
      for (const conversation of all) newMessages += recordConversation(app, account, conversation).stored;
      app.db.query('UPDATE accounts SET last_inbox_sync_at = ? WHERE id = ?').run(app.now(), account.id);
    })();
    return {
      account: `@${account.handle}`,
      conversations: all.length,
      newMessages,
      unread: all.filter((c) => c.unread).length,
      warnings,
    };
  });
}

export type InboxItem = { lead: string; account: string; last: string | null; lastFrom: 'in' | 'out' | null; at: number | null; unread: boolean };

export function listInbox(app: App, args: { unreadOnly: boolean; account?: Account; limit: number }): { items: InboxItem[]; total: number } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (args.unreadOnly) where.push('c.unread = 1');
  if (args.account) {
    where.push('c.account_id = ?');
    params.push(args.account.id);
  }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total =
    app.db.query<{ n: number }, (string | number)[]>(`SELECT count(*) AS n FROM conversations c${clause}`).get(...params)?.n ?? 0;
  const items = app.db
    .query<{ lead: string; account: string; last: string | null; last_from: 'in' | 'out' | null; at: number | null; unread: number }, (string | number)[]>(
      `SELECT l.handle AS lead, a.handle AS account, m.body AS last, m.direction AS last_from, c.last_message_at AS at, c.unread
       FROM conversations c
       JOIN leads l ON l.id = c.lead_id
       JOIN accounts a ON a.id = c.account_id
       LEFT JOIN messages m ON m.id = (SELECT id FROM messages WHERE conversation_id = c.id ORDER BY at DESC, id DESC LIMIT 1)
       ${clause}
       ORDER BY c.last_message_at DESC LIMIT ?`,
    )
    .all(...params, args.limit)
    .map((row) => ({
      lead: `@${row.lead}`,
      account: `@${row.account}`,
      last: row.last,
      lastFrom: row.last_from,
      at: row.at,
      unread: row.unread === 1,
    }));
  return { items, total };
}

function conversationAccount(
  app: App,
  lead: Lead,
  accountHandle: string | undefined,
  whenNone: 'not_found' | 'default_account' = 'not_found',
): Account {
  if (accountHandle) return findAccount(app, accountHandle);
  const ids = app.db.query<{ account_id: number }, [number]>('SELECT account_id FROM conversations WHERE lead_id = ?').all(lead.id);
  const accounts = listAccounts(app).filter((a) => ids.some((row) => row.account_id === a.id));
  if (accounts.length === 1 && accounts[0]) return accounts[0];
  if (accounts.length === 0) {
    if (whenNone === 'default_account') return resolveAccount(app, undefined);
    throw new ReachloopError('NOT_FOUND', `No conversation with @${lead.handle}.`, { hint: 'reachloop inbox sync' });
  }
  throw new ReachloopError('USAGE', `@${lead.handle} talks to ${accounts.length} of your accounts. Pick one with --account.`);
}

export type ShownMessage = { from: 'them' | 'you'; text: string; at: number; state: string | null };

export async function showConversation(
  app: App,
  args: { handle: string; account?: string; limit: number; refresh: boolean },
): Promise<{ lead: Lead; account: string; messages: ShownMessage[]; canReply: boolean }> {
  const lead = findLead(app, args.handle);
  const account = conversationAccount(app, lead, args.account);
  const conversation = conversationFor(app, account.id, lead.id);
  if (!conversation) {
    throw new ReachloopError('NOT_FOUND', `No conversation between @${account.handle} and @${lead.handle}.`, {
      hint: 'reachloop inbox sync',
    });
  }
  if (args.refresh) {
    const messages = await withX(app, account, (x) => x.conversation(conversation.x_conversation_id));
    if (messages) {
      app.db.transaction(() => {
        reconcileReserved(app, conversation.id, account.id, messages);
        storeMessages(app, conversation.id, messages);
        if (messages.some((m) => m.direction === 'in')) {
          app.db.query('UPDATE conversations SET has_inbound = 1 WHERE id = ?').run(conversation.id);
        }
      })();
    }
  }
  const rows = app.db
    .query<{ direction: 'in' | 'out'; body: string; at: number; send_state: string | null }, [number, number]>(
      'SELECT direction, body, at, send_state FROM messages WHERE conversation_id = ? ORDER BY at DESC, id DESC LIMIT ?',
    )
    .all(conversation.id, args.limit)
    .reverse();
  const hasInbound = conversationFor(app, account.id, lead.id)?.has_inbound === 1;
  return {
    lead,
    account: `@${account.handle}`,
    messages: rows.map((row) => ({ from: row.direction === 'in' ? 'them' : 'you', text: row.body, at: row.at, state: row.send_state })),
    canReply: hasInbound,
  };
}

export type ReplyResult = {
  status: 'sent' | 'already_sent' | 'dry_run';
  account: string;
  lead: string;
  text: string;
  messageId: string | null;
  sentToday: number;
  capDm: number;
};

function autoKey(account: Account, lead: Lead, text: string, day: string): string {
  return `auto:${account.id}:${lead.id}:${day}:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
}

export async function reply(
  app: App,
  args: { handle: string; account?: string; text: string; confirmed: boolean; idempotencyKey?: string; dryRun: boolean },
): Promise<ReplyResult> {
  const text = args.text.trim();
  if (!text) throw new ReachloopError('USAGE', 'A reply needs --text.');
  const lead = findLead(app, args.handle);
  const account = conversationAccount(app, lead, args.account, 'default_account');
  const conversation = conversationFor(app, account.id, lead.id);
  const day = localDay(app.now());
  const key = args.idempotencyKey ?? autoKey(account, lead, text, day);
  const base = { account: `@${account.handle}`, lead: `@${lead.handle}`, text, capDm: account.capDm };

  const prior = app.db
    .query<{ id: number; send_state: string | null; x_message_id: string | null }, [string]>(
      'SELECT id, send_state, x_message_id FROM messages WHERE dedupe_key = ?',
    )
    .get(key);
  if (prior?.send_state === 'sent') {
    return { ...base, status: 'already_sent', messageId: prior.x_message_id, sentToday: sentToday(app, account.id) };
  }
  if (prior?.send_state === 'reserved') {
    throw new ReachloopError('CONFLICT', 'An earlier send with this key has no confirmed result yet.', {
      hint: `reachloop inbox show @${lead.handle} --json`,
    });
  }

  const check = (confirmed: boolean) =>
    checkReply({
      confirmed,
      accountStatus: findAccount(app, account.handle).status,
      hasInbound: conversation?.has_inbound === 1,
      sentToday: sentToday(app, account.id),
      capDm: account.capDm,
    });

  if (args.dryRun) {
    const gate = check(true);
    if (!gate.ok) throw gate.error;
    return { ...base, status: 'dry_run', messageId: null, sentToday: sentToday(app, account.id) };
  }

  const reserveId = app.db
    .transaction(() => {
      const gate = check(args.confirmed);
      if (!gate.ok) throw gate.error;
      if (!conversation || !lead.xUserId) throw new ReachloopError('INTERNAL', 'reply passed the gate without a conversation');
      if (prior) app.db.query('DELETE FROM messages WHERE id = ?').run(prior.id);
      const inserted = app.db
        .query(
          "INSERT INTO messages (conversation_id, direction, body, dedupe_key, send_state, origin, at) VALUES (?, 'out', ?, ?, 'reserved', 'reply', ?)",
        )
        .run(conversation.id, text, key, app.now());
      addUsage(app, account.id, day, 1);
      return Number(inserted.lastInsertRowid);
    })
    .immediate();

  try {
    const sent = await withX(app, account, (x) => x.sendDm({ recipientId: lead.xUserId ?? '', text }));
    app.db.transaction(() => {
      app.db.query("UPDATE messages SET send_state = 'sent', x_message_id = ?, at = ? WHERE id = ?").run(sent.messageId || null, app.now(), reserveId);
      app.db.query('UPDATE conversations SET unread = 0, last_message_at = ? WHERE account_id = ? AND lead_id = ?').run(app.now(), account.id, lead.id);
      app.db.query("UPDATE leads SET status = 'contacted' WHERE id = ? AND status = 'new'").run(lead.id);
    })();
    logEvent(app, { kind: 'dm_sent', accountId: account.id, leadId: lead.id, data: { messageId: sent.messageId } });
    return { ...base, status: 'sent', messageId: sent.messageId || null, sentToday: sentToday(app, account.id) };
  } catch (err) {
    const unknownOutcome = !(err instanceof ReachloopError) || err.code === 'NETWORK_ERROR';
    if (unknownOutcome) {
      logEvent(app, { kind: 'dm_unverified', accountId: account.id, leadId: lead.id });
      throw new ReachloopError('NETWORK_ERROR', 'The DM may or may not have been sent; X did not answer.', {
        hint: `Check with: reachloop inbox show @${lead.handle} --json. Do not resend before that.`,
      });
    }
    app.db.transaction(() => {
      app.db.query("UPDATE messages SET send_state = 'failed' WHERE id = ?").run(reserveId);
      addUsage(app, account.id, day, -1);
    })();
    logEvent(app, { kind: 'dm_failed', accountId: account.id, leadId: lead.id, data: { code: err.code } });
    throw err;
  }
}

export function usageToday(app: App, account: Account): { sentToday: number; capDm: number; remaining: number } {
  const sent = sentToday(app, account.id);
  return { sentToday: sent, capDm: account.capDm, remaining: Math.max(0, account.capDm - sent) };
}
