import { buildDmConversationId, type TwitterAuthCookies } from '../../src/x/client';
import { XError, type XConnect, type XConversation, type XMessage, type XProfile, type XSession } from '../../src/x/session';

export type Sent = { from: string; recipientId: string; text: string };

export function profile(xUserId: string, handle: string, extra: Partial<XProfile> = {}): XProfile {
  return { xUserId, handle, name: handle, verified: false, canDm: true, followers: 10, ...extra };
}

export class FakeX {
  accounts = new Map<string, XProfile>();
  search: XProfile[] = [];
  followers = new Map<string, XProfile[]>();
  inboxes = new Map<string, XConversation[]>();
  sent: Sent[] = [];
  failNextSend: XError | Error | null = null;
  failInbox: XError | null = null;
  pageSize = 20;
  onLookup: (() => void) | null = null;
  calls: string[] = [];
  now: () => number = Date.now;

  signIn(xUserId: string, handle: string): TwitterAuthCookies {
    const cookies = { authToken: `token-${xUserId}`, ct0: `csrf-${xUserId}`, twid: `u%3D${xUserId}` };
    this.accounts.set(cookies.authToken, profile(xUserId, handle));
    return cookies;
  }

  receive(accountXUserId: string, from: XProfile, text: string, at: number, kind: 'trusted' | 'untrusted' = 'trusted'): void {
    const inbox = this.inboxes.get(accountXUserId) ?? [];
    const conversationId = buildDmConversationId(from.xUserId, accountXUserId);
    let conversation = inbox.find((c) => c.conversationId === conversationId);
    if (!conversation) {
      conversation = { conversationId, peer: from, unread: true, messages: [] };
      Object.assign(conversation, { kind });
      inbox.push(conversation);
    }
    conversation.unread = true;
    conversation.messages.push({ id: `m-${at}`, text, direction: 'in', at });
    this.inboxes.set(accountXUserId, inbox);
  }

  private page(list: XProfile[], cursor: string | undefined) {
    const start = cursor ? Number(cursor) : 0;
    const profiles = list.slice(start, start + this.pageSize);
    const next = start + this.pageSize < list.length ? String(start + this.pageSize) : undefined;
    return { profiles, nextCursor: next };
  }

  connect: XConnect = ({ cookies }) => {
    const me = () => {
      const found = this.accounts.get(cookies.authToken);
      if (!found) throw new XError('Twitter session expired or unauthorized', 'SESSION_EXPIRED');
      return found;
    };
    const session: XSession = {
      me: async () => {
        this.calls.push('me');
        return me();
      },
      lookup: async (handle) => {
        this.calls.push(`lookup:${handle}`);
        this.onLookup?.();
        me();
        const found = this.search.find((p) => p.handle.toLowerCase() === handle.toLowerCase());
        if (!found) throw new XError('not found', 'USER_NOT_FOUND');
        return found;
      },
      searchUsers: async ({ query, cursor }) => {
        this.calls.push(`search:${query}`);
        me();
        return this.page(this.search, cursor);
      },
      followersOf: async ({ handle, cursor }) => {
        me();
        return this.page(this.followers.get(handle) ?? [], cursor);
      },
      inbox: async (kind) => {
        this.calls.push(`inbox:${kind}`);
        const account = me();
        if (this.failInbox) throw this.failInbox;
        return (this.inboxes.get(account.xUserId) ?? []).filter((c) => ((c as { kind?: string }).kind ?? 'trusted') === kind);
      },
      conversation: async (conversationId) => {
        const account = me();
        this.calls.push(`conversation:${conversationId}`);
        return (this.inboxes.get(account.xUserId) ?? []).find((c) => c.conversationId === conversationId)?.messages ?? null;
      },
      sendDm: async ({ recipientId, text }) => {
        const account = me();
        this.calls.push('send');
        if (this.failNextSend) {
          const failure = this.failNextSend;
          this.failNextSend = null;
          if (failure instanceof XError && failure.code === 'NETWORK_ERROR') this.deliver(account, recipientId, text);
          throw failure;
        }
        return this.deliver(account, recipientId, text);
      },
    };
    return session;
  };

  private deliver(account: XProfile, recipientId: string, text: string) {
    this.sent.push({ from: account.handle, recipientId, text });
    const inbox = this.inboxes.get(account.xUserId) ?? [];
    let conversation = inbox.find((c) => c.peer.xUserId === recipientId);
    if (!conversation) {
      conversation = { conversationId: buildDmConversationId(account.xUserId, recipientId), peer: this.search.find((p) => p.xUserId === recipientId) ?? profile(recipientId, recipientId), unread: false, messages: [] };
      inbox.push(conversation);
      this.inboxes.set(account.xUserId, inbox);
    }
    const message: XMessage = { id: `sent-${this.sent.length}`, text, direction: 'out', at: this.now() };
    conversation?.messages.push(message);
    return { messageId: message.id, conversationId: conversation?.conversationId ?? buildDmConversationId(recipientId, account.xUserId) };
  }
}
