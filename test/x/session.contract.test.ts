import { beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fx from '../fixtures/x-responses';

type Request = { url: string; method: string; headers: Record<string, string>; body?: string };
type Reply = { status: number; body: unknown; headers?: Record<string, string | string[]> };

const requests: Request[] = [];
let route: (request: Request) => Reply = () => ({ status: 404, body: '' });

mock.module('../../src/x/http-client', () => ({
  CHROME_120_USER_AGENT: 'Mozilla/5.0 Chrome/120.0.0.0',
  disposeHttpClient: async () => {},
  fetchImpersonated: async (url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const request = { url, method: options.method ?? 'GET', headers: options.headers ?? {}, body: options.body };
    requests.push(request);
    const reply = route(request);
    const headers = new Headers();
    for (const [key, value] of Object.entries(reply.headers ?? {})) {
      for (const v of Array.isArray(value) ? value : [value]) headers.append(key, v);
    }
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return {
      status: reply.status,
      ok: reply.status >= 200 && reply.status < 300,
      headers,
      finalUrl: url,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  },
}));

mock.module('x-client-transaction-id', () => ({
  handleXMigration: async () => ({}),
  ClientTransaction: { create: async () => ({ generateTransactionId: async () => 'tx-id' }) },
}));

const { connectX, XError } = await import('../../src/x/session');

const cookies = () => ({ authToken: 'auth-1', ct0: 'csrf-1', twid: `u%3D${fx.SENDER_ID}` });

function standardX(request: Request): Reply {
  const path = new URL(request.url).pathname;
  if (path.endsWith('/UserByRestId')) return { status: 200, body: fx.userByRestId };
  if (path.endsWith('/SearchTimeline')) return { status: 200, body: fx.searchTimeline };
  if (path.endsWith('/dm/inbox_initial_state.json')) return { status: 200, body: fx.inboxInitialState };
  if (path.endsWith('/dm/inbox_timeline/untrusted.json')) return { status: 200, body: fx.untrustedTimeline };
  if (path.endsWith('/dm/new2.json')) return { status: 200, body: fx.dmNew2 };
  return { status: 404, body: '' };
}

beforeEach(() => {
  requests.length = 0;
  route = standardX;
});

describe('X adapter against recorded-shape responses', () => {
  it('identifies the signed-in account from the twid cookie, sending the session cookies and CSRF token', async () => {
    const me = await connectX({ cookies: cookies(), onCookiesRotated: async () => {} }).me();
    expect(me).toMatchObject({ xUserId: fx.SENDER_ID, handle: 'acme', followers: 1200 });
    const call = requests.find((r) => r.url.includes('/UserByRestId'));
    expect(call?.headers.cookie).toContain('auth_token=auth-1');
    expect(call?.headers['x-csrf-token']).toBe('csrf-1');
    expect(call?.headers.authorization).toStartWith('Bearer ');
  });

  it('runs a People search and returns profiles with DM status and the next cursor', async () => {
    const page = await connectX({ cookies: cookies(), onCookiesRotated: async () => {} }).searchUsers({ query: 'saas founder' });
    expect(page.profiles.map((p) => [p.handle, p.canDm])).toEqual([
      ['founder_a', true],
      ['founder_b', false],
    ]);
    expect(page.nextCursor).toBe('CURSOR-2');
    const call = requests.find((r) => r.url.includes('/SearchTimeline'));
    const variables = JSON.parse(new URL(call?.url ?? '').searchParams.get('variables') ?? '{}');
    expect(variables).toMatchObject({ rawQuery: 'saas founder', product: 'People' });
  });

  it('reads one-to-one conversations from the inbox and labels who wrote each message', async () => {
    const inbox = await connectX({ cookies: cookies(), onCookiesRotated: async () => {} }).inbox('trusted');
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ peer: { xUserId: fx.PEER_ID, handle: 'jane' }, unread: true });
    expect(inbox[0]?.messages.map((m) => [m.direction, m.text])).toEqual([
      ['in', 'What does it cost?'],
      ['out', 'Thanks for following!'],
    ]);
  });

  it('sends a DM to the conversation X expects and returns the message id', async () => {
    const sent = await connectX({ cookies: cookies(), onCookiesRotated: async () => {} }).sendDm({ recipientId: fx.PEER_ID, text: 'reply' });
    expect(sent).toEqual({ messageId: '7003', conversationId: `${fx.PEER_ID}-${fx.SENDER_ID}` });
    const call = requests.find((r) => r.url.includes('/dm/new2.json'));
    expect(call?.method).toBe('POST');
    expect(JSON.parse(call?.body ?? '{}')).toMatchObject({ conversation_id: `${fx.PEER_ID}-${fx.SENDER_ID}`, text: 'reply' });
  });

  it('turns an X "could not authenticate" reply into a session-expired error', async () => {
    route = () => ({ status: 401, body: fx.sessionExpired, headers: { 'content-type': 'application/json' } });
    const error = await connectX({ cookies: cookies(), onCookiesRotated: async () => {} })
      .inbox('trusted')
      .catch((err) => err);
    expect(error).toBeInstanceOf(XError);
    expect(error.code).toBe('SESSION_EXPIRED');
  });

  it('turns HTTP 429 into a rate limit with the reset time', async () => {
    const reset = Math.floor(Date.now() / 1000) + 120;
    route = () => ({ status: 429, body: '', headers: { 'x-rate-limit-reset': String(reset) } });
    const error = await connectX({ cookies: cookies(), onCookiesRotated: async () => {} })
      .inbox('trusted')
      .catch((err) => err);
    expect(error.code).toBe('X_RATE_LIMITED');
    expect(error.retryAfterMs).toBeGreaterThan(100_000);
  });

  it('saves a rotated ct0 cookie that X sets', async () => {
    route = (request) => ({ ...standardX(request), headers: { 'set-cookie': 'ct0=csrf-2; Path=/; Domain=.x.com' } });
    const rotated: string[] = [];
    await connectX({ cookies: cookies(), onCookiesRotated: async (next) => void rotated.push(next.ct0) }).inbox('trusted');
    expect(rotated).toEqual(['csrf-2']);
  });
});
