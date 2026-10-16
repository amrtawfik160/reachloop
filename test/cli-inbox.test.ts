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
