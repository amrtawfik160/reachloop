import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { XError } from '../src/x/session';
import { harness } from './support/cli';
import { profile } from './support/fake-x';

const jane = profile('900', 'jane', { name: 'Jane Doe' });
const cold = profile('901', 'stranger');

async function withConversation() {
  const h = await harness();
  await h.run('init');
  await h.run('account', 'add', '--cookies-file', await h.cookieFile(h.x.signIn('101', 'acme')));
  h.x.receive('101', jane, 'Hi, what does it cost?', h.now() - 60_000);
  return h;
}

describe('inbox loop', () => {
  it('syncs, lists unread, shows the conversation and sends a reply to X', async () => {
    const h = await withConversation();
    const sync = await h.run('inbox', 'sync');
    expect(sync.json.data).toEqual([{ account: '@acme', conversations: 1, newMessages: 1, unread: 1 }]);

    const unread = await h.run('inbox', 'list', '--unread');
    expect(unread.json.data).toMatchObject([{ lead: '@jane', account: '@acme', last: 'Hi, what does it cost?', lastFrom: 'in', unread: true }]);

    const shown = await h.run('inbox', 'show', '@jane');
    expect(shown.json.data).toMatchObject({ lead: '@jane', canReply: true, messages: [{ from: 'them', text: 'Hi, what does it cost?' }] });

    const sent = await h.run('inbox', 'reply', '@jane', '--text', '$20 a month.', '--yes');
    expect(sent.code).toBe(0);
    expect(sent.json.data).toMatchObject({ status: 'sent', account: '@acme', lead: '@jane', sentToday: 1, capDm: 50 });
    expect(h.x.sent).toEqual([{ from: 'acme', recipientId: '900', text: '$20 a month.' }]);
    expect((await h.run('inbox', 'list', '--unread')).json.meta?.total).toBe(0);
  });

  it('counts a message request as the person writing first', async () => {
    const h = await harness();
    await h.run('init');
    await h.run('account', 'add', '--cookies-file', await h.cookieFile(h.x.signIn('101', 'acme')));
    h.x.receive('101', jane, 'hello from requests', h.now(), 'untrusted');
    await h.run('inbox', 'sync');
    expect((await h.run('inbox', 'reply', '@jane', '--text', 'hi!', '--yes')).json.data.status).toBe('sent');
  });
});

describe('send safety', () => {
  it('refuses to DM someone who never wrote to the account, before anything reaches X', async () => {
    const h = await withConversation();
    h.x.search = [cold];
    await h.run('lead', 'search', '--keyword', 'x');
    await h.run('limits', 'set', '@acme', '--reply-only', 'on');
    const result = await h.run('inbox', 'reply', '@stranger', '--text', 'Buy now', '--yes');
    expect(result.code).toBe(6);
    expect(result.json.error?.code).toBe('REPLY_ONLY');
    expect(h.x.calls).not.toContain('send');
  });

  it('refuses a reply without --yes, and --dry-run sends nothing', async () => {
    const h = await withConversation();
    await h.run('inbox', 'sync');
    const unconfirmed = await h.run('inbox', 'reply', '@jane', '--text', 'hi');
    expect(unconfirmed.code).toBe(6);
    expect(unconfirmed.json.error?.code).toBe('CONFIRM_REQUIRED');
    expect((await h.run('inbox', 'reply', '@jane', '--text', 'hi', '--dry-run')).json.data.status).toBe('dry_run');
    expect(h.x.sent).toEqual([]);
  });

  it('stops at the daily cap and starts again the next day', async () => {
    const h = await withConversation();
    await h.run('inbox', 'sync');
    await h.run('limits', 'set', '@acme', '--dm', '1');
    expect((await h.run('inbox', 'reply', '@jane', '--text', 'one', '--yes')).code).toBe(0);
    const second = await h.run('inbox', 'reply', '@jane', '--text', 'two', '--yes');
    expect(second.code).toBe(6);
    expect(second.json.error?.code).toBe('DAILY_CAP_REACHED');
    h.advance(24 * 60 * 60 * 1000);
    expect((await h.run('inbox', 'reply', '@jane', '--text', 'two', '--yes')).code).toBe(0);
    expect(h.x.sent.map((s) => s.text)).toEqual(['one', 'two']);
  });

  it('does not send the same reply twice when the command is repeated', async () => {
    const h = await withConversation();
    await h.run('inbox', 'sync');
    await h.run('inbox', 'reply', '@jane', '--text', 'same', '--yes');
    const again = await h.run('inbox', 'reply', '@jane', '--text', 'same', '--yes');
    expect(again.json.data.status).toBe('already_sent');
    expect(h.x.sent.length).toBe(1);
  });

  it('holds a send with an unknown outcome until the inbox shows whether it went out', async () => {
    const h = await withConversation();
    await h.run('inbox', 'sync');
    h.x.failNextSend = new XError('socket hang up', 'NETWORK_ERROR');
    const first = await h.run('inbox', 'reply', '@jane', '--text', 'maybe', '--yes');
    expect(first.json.error?.code).toBe('NETWORK_ERROR');
    const retry = await h.run('inbox', 'reply', '@jane', '--text', 'maybe', '--yes');
    expect(retry.code).toBe(7);
    expect(retry.json.error?.code).toBe('CONFLICT');

    await h.run('inbox', 'show', '@jane');
    expect((await h.run('inbox', 'reply', '@jane', '--text', 'maybe', '--yes')).json.data.status).toBe('already_sent');
    expect(h.x.sent.length).toBe(1);
    expect((await h.run('limits', 'show', '@acme')).json.data.sentToday).toBe(1);
  });

  it('releases the daily count when X rejects a send', async () => {
    const h = await withConversation();
    await h.run('inbox', 'sync');
    h.x.failNextSend = new XError('closed', 'DMS_CLOSED');
    expect((await h.run('inbox', 'reply', '@jane', '--text', 'x', '--yes')).json.error?.code).toBe('DMS_CLOSED');
    expect((await h.run('limits', 'show', '@acme')).json.data.sentToday).toBe(0);
  });

  it('marks the account when X says the session expired, and then refuses sends without calling X', async () => {
    const h = await withConversation();
    await h.run('inbox', 'sync');
    h.x.failInbox = new XError('expired', 'SESSION_EXPIRED');
    const sync = await h.run('inbox', 'sync');
    expect(sync.code).toBe(4);
    expect((await h.run('account', 'show', '@acme')).json.data.status).toBe('session_expired');
    const reply = await h.run('inbox', 'reply', '@jane', '--text', 'hi', '--yes');
    expect(reply.code).toBe(4);
    expect(h.x.calls).not.toContain('send');
  });

  it('reports a rate limit with exit 5 and how long to wait', async () => {
    const h = await withConversation();
    h.x.failInbox = new XError('slow down', 'X_RATE_LIMITED', 90_000);
    const result = await h.run('inbox', 'sync');
    expect(result.code).toBe(5);
    expect(result.json.error).toMatchObject({ code: 'RATE_LIMITED', retryable: true, retryAfter: 90 });
  });

  it('refuses sends from a paused account', async () => {
    const h = await withConversation();
    await h.run('inbox', 'sync');
    await h.run('account', 'pause', '@acme');
    expect((await h.run('inbox', 'reply', '@jane', '--text', 'hi', '--yes', '--account', '@acme')).json.error?.code).toBe('ACCOUNT_PAUSED');
  });
});

describe('run once and status', () => {
  it('syncs every active account and reports unread conversations in status', async () => {
    const h = await withConversation();
    const run = await h.run('run', 'once');
    expect(run.json.data).toMatchObject([{ ok: true, account: '@acme', unread: 1 }]);
    const status = await h.run();
    expect(status.json.data).toMatchObject({ unreadConversations: 1, leads: { replied: 1 } });
    expect(status.json.hints).toEqual(['reachloop inbox list --unread --json']);
  });
});

function inspect(h: Awaited<ReturnType<typeof harness>>) {
  const db = new Database(h.home + '/reachloop.db');
  return { db, counts: () => ['leads', 'conversations', 'messages', 'daily_usage'].map(t => db.query('SELECT count(*) AS n FROM ' + t).get()) };
}

async function coldAccount() {
  const h = await harness();
  await h.run('init');
  await h.run('account', 'add', '--cookies-file', await h.cookieFile(h.x.signIn('101', 'acme')));
  h.x.search = [cold];
  h.x.calls.length = 0;
  return h;
}

describe('outbound defaults', () => {
  it('starts a saved-lead thread by default and shares duplicate protection across aliases', async () => {
    const h = await coldAccount();
    await h.run('lead', 'search', '--keyword', 'x');
    const sent = await h.run('inbox', 'send', '@stranger', '--text', 'hello', '--yes');
    expect(sent.json.data).toMatchObject({ status: 'sent', sentToday: 1, capDm: 50 });
    expect((await h.run('inbox', 'reply', '@stranger', '--text', 'hello', '--yes')).json.data.status).toBe('already_sent');
    expect(h.x.sent).toHaveLength(1);
    expect((await h.run('inbox', 'show', '@stranger')).json.data).toMatchObject({ canReply: true, messages: [{ from: 'you', text: 'hello', state: 'sent' }] });
    const { db } = inspect(h);
    expect(db.query('SELECT x_conversation_id, has_inbound FROM conversations').get()).toEqual({ x_conversation_id: '101:901', has_inbound: 0 });
    db.close();
  });

  it('looks up a new handle only after confirmation and never persists dry runs', async () => {
    const h = await coldAccount();
    const { db, counts } = inspect(h);
    const before = counts();
    expect((await h.run('inbox', 'send', '@stranger', '--text', 'hello')).json.error?.code).toBe('CONFIRM_REQUIRED');
    expect(h.x.calls).toEqual([]);
    expect(counts()).toEqual(before);
    expect((await h.run('inbox', 'send', '@stranger', '--text', 'hello', '--dry-run')).json.data.status).toBe('dry_run');
    expect(h.x.calls).toEqual(['lookup:stranger']);
    expect(counts()).toEqual(before);
    expect(h.x.sent).toEqual([]);
    expect((await h.run('inbox', 'reply', '@stranger', '--text', 'hello', '--yes')).json.data.status).toBe('sent');
    expect((await h.run('inbox', 'send', '@stranger', '--text', 'hello', '--yes')).json.data.status).toBe('already_sent');
    db.close();
  });

  it('resolves a CSV lead without an X id only on actual send, not dry-run', async () => {
    const h = await coldAccount();
    const csv = h.home + '/leads.csv';
    await Bun.write(csv, 'handle,name\nstranger,Stranger\n');
    expect((await h.run('lead', 'import', '--csv', csv)).code).toBe(0);
    const { db, counts } = inspect(h);
    const before = counts();
    expect((await h.run('inbox', 'send', '@stranger', '--text', 'hello', '--dry-run')).code).toBe(0);
    expect(counts()).toEqual(before);
    expect(db.query('SELECT x_user_id FROM leads').get()).toEqual({ x_user_id: null });
    expect((await h.run('inbox', 'send', '@stranger', '--text', 'hello', '--yes')).json.data.status).toBe('sent');
    expect(db.query('SELECT x_user_id FROM leads').get()).toEqual({ x_user_id: '901' });
    db.close();
  });

  it('blocks new handles before lookup for reply-only, paused and exhausted accounts', async () => {
    const h = await coldAccount();
    const { db, counts } = inspect(h);
    const before = counts();
    await h.run('limits', 'set', '@acme', '--reply-only', 'on');
    expect((await h.run('inbox', 'send', '@stranger', '--text', 'hi', '--yes')).json.error?.code).toBe('REPLY_ONLY');
    expect((await h.run('inbox', 'send', '@stranger', '--text', 'hi', '--dry-run')).json.error?.code).toBe('REPLY_ONLY');
    await h.run('limits', 'set', '@acme', '--reply-only', 'off', '--dm', '0');
    expect((await h.run('inbox', 'send', '@stranger', '--text', 'hi', '--yes')).json.error?.code).toBe('DAILY_CAP_REACHED');
    await h.run('account', 'pause', '@acme');
    expect((await h.run('inbox', 'send', '@stranger', '--account', '@acme', '--text', 'hi', '--yes')).json.error?.code).toBe('ACCOUNT_PAUSED');
    expect(h.x.calls).toEqual([]);
    expect(counts()).toEqual(before);
    db.close();
  });

  it('requires inbound evidence for this account only, and switching policy off allows the same lead', async () => {
    const h = await withConversation();
    await h.run('inbox', 'sync');
    await h.run('account', 'add', '--cookies-file', await h.cookieFile(h.x.signIn('102', 'other')));
    await h.run('limits', 'set', '@other', '--reply-only', 'on');
    const args = ['inbox', 'send', '@jane', '--account', '@other', '--text', 'hello', '--yes'];
    h.x.calls.length = 0;
    expect((await h.run(...args)).json.error?.code).toBe('REPLY_ONLY');
    expect(h.x.calls).toEqual([]);
    await h.run('limits', 'set', '@other', '--reply-only', 'off');
    expect((await h.run(...args)).json.data.status).toBe('sent');
    await h.run('limits', 'set', '@other', '--reply-only', 'on');
    expect((await h.run('inbox', 'show', '@jane', '--account', '@other', '--cached')).json.data.canReply).toBe(false);
    await h.run('limits', 'set', '@acme', '--reply-only', 'on');
    expect((await h.run('inbox', 'reply', '@jane', '--account', '@acme', '--text', 'hi', '--yes')).code).toBe(0);
  });

  it('holds an uncertain first send and reconciles the canonical new thread through show', async () => {
    const h = await coldAccount();
    h.x.failNextSend = new XError('socket closed', 'NETWORK_ERROR');
    const args = ['inbox', 'send', '@stranger', '--text', 'maybe', '--yes'];
    expect((await h.run(...args)).json.error?.code).toBe('NETWORK_ERROR');
    expect((await h.run(...args)).json.error?.code).toBe('CONFLICT');
    expect((await h.run('inbox', 'show', '@stranger')).json.data.messages[0].state).toBe('sent');
    expect((await h.run(...args)).json.data.status).toBe('already_sent');
    expect(h.x.sent).toHaveLength(1);
    expect((await h.run('limits', 'show', '@acme')).json.data.sentToday).toBe(1);
  });

  it('lets X enforce recipient privacy and releases rejected new-thread quota', async () => {
    const h = await coldAccount();
    h.x.search = [profile('901', 'stranger', { canDm: false })];
    await h.run('limits', 'set', '@acme', '--dm', '250');
    h.x.failNextSend = new XError('closed', 'DMS_CLOSED');
    const args = ['inbox', 'send', '@stranger', '--text', 'hello', '--yes'];
    expect((await h.run(...args)).json.error?.code).toBe('DMS_CLOSED');
    expect((await h.run('limits', 'show', '@acme')).json.data.sentToday).toBe(0);
    expect((await h.run(...args)).json.data).toMatchObject({ status: 'sent', capDm: 250, sentToday: 1 });
  });
});


describe('fresh reservation checks', () => {
  for (const change of [
    { sql: "UPDATE accounts SET status = 'paused'", code: 'ACCOUNT_PAUSED' },
    { sql: 'UPDATE accounts SET cap_dm = 0', code: 'DAILY_CAP_REACHED' },
    { sql: 'UPDATE accounts SET reply_only = 1', code: 'REPLY_ONLY' },
  ]) {
    it('rechecks persisted policy after lookup: ' + change.code, async () => {
      const h = await coldAccount();
      const { db, counts } = inspect(h);
      const before = counts();
      h.x.onLookup = () => { db.exec(change.sql); };
      expect((await h.run('inbox', 'send', '@stranger', '--text', 'hello', '--yes')).json.error?.code).toBe(change.code);
      expect(h.x.calls).toEqual(['lookup:stranger']);
      expect(h.x.sent).toEqual([]);
      expect(counts()).toEqual(before);
      db.close();
    });
  }

  it('charges and deduplicates the actual reservation day after a lookup crosses midnight', async () => {
    const h = await coldAccount();
    h.x.onLookup = () => { h.advance(24 * 60 * 60 * 1000); };
    const args = ['inbox', 'send', '@stranger', '--text', 'hello', '--yes'];
    expect((await h.run(...args)).json.data.sentToday).toBe(1);
    expect((await h.run(...args)).json.data.status).toBe('already_sent');
    expect(h.x.sent).toHaveLength(1);
    const { db } = inspect(h);
    expect(db.query('SELECT day, count FROM daily_usage').all()).toEqual([{ day: '2026-10-17', count: 1 }]);
    db.close();
  });

  it('accepts the 250th DM but refuses 251 before lookup and preserves quota on rejection', async () => {
    const h = await coldAccount();
    await h.run('limits', 'set', '@acme', '--dm', '250');
    const { db } = inspect(h);
    db.exec("INSERT INTO daily_usage (account_id, day, action, count) VALUES (1, '2026-10-16', 'dm', 249)");
    expect((await h.run('inbox', 'send', '@stranger', '--text', 'last', '--yes')).json.data.sentToday).toBe(250);
    h.x.calls.length = 0;
    expect((await h.run('inbox', 'send', '@unknown', '--text', 'too many', '--yes')).json.error?.code).toBe('DAILY_CAP_REACHED');
    expect(h.x.calls).toEqual([]);
    db.close();
  });

  it('expires an undelivered unknown first-send reservation and releases its quota', async () => {
    const h = await coldAccount();
    h.x.failNextSend = new Error('no response');
    const args = ['inbox', 'send', '@stranger', '--text', 'uncertain', '--yes'];
    expect((await h.run(...args)).json.error?.code).toBe('NETWORK_ERROR');
    expect((await h.run(...args)).json.error?.code).toBe('CONFLICT');
    h.advance(61 * 60 * 1000);
    // X confirms the canonical conversation exists but contains no sent message
    h.x.inboxes.set('101', [{ conversationId: '101:901', peer: cold, unread: false, messages: [] }]);
    expect((await h.run('inbox', 'show', '@stranger')).json.data.messages[0].state).toBe('failed');
    expect((await h.run('limits', 'show', '@acme')).json.data.sentToday).toBe(0);
    expect((await h.run(...args)).json.data.status).toBe('sent');
  });
});


describe('conversation evidence', () => {
  it('rechecks same-account inbound evidence inside the transaction', async () => {
    const h = await withConversation();
    await h.run('inbox', 'sync');
    await h.run('limits', 'set', '@acme', '--reply-only', 'on');
    const { db, counts } = inspect(h);
    db.exec('UPDATE leads SET x_user_id = NULL');
    h.x.search = [jane];
    h.x.onLookup = () => { db.exec('UPDATE conversations SET has_inbound = 0'); };
    const before = counts();
    h.x.calls.length = 0;
    expect((await h.run('inbox', 'send', '@jane', '--text', 'hello', '--yes')).json.error?.code).toBe('REPLY_ONLY');
    expect(h.x.calls).toEqual(['lookup:jane']);
    expect(counts()).toEqual(before);
    expect(db.query('SELECT x_user_id FROM leads').get()).toEqual({ x_user_id: null });
    db.close();
  });

  it('stores the real conversation id returned by X on success', async () => {
    const h = await coldAccount();
    const connect = h.x.connect;
    h.x.connect = args => {
      const session = connect(args);
      return { ...session, sendDm: async args => ({ ...await session.sendDm(args), conversationId: 'x-returned-thread' }) };
    };
    expect((await h.run('inbox', 'send', '@stranger', '--text', 'hello', '--yes')).code).toBe(0);
    const { db } = inspect(h);
    expect(db.query('SELECT x_conversation_id FROM conversations').get()).toEqual({ x_conversation_id: 'x-returned-thread' });
    db.close();
  });
});
