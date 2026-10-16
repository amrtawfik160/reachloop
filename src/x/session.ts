import {
  lookupUserByRestId,
  parseUserIdFromTwid,
  TwitterGraphQLClient,
  TwitterGraphQLError,
  type TwitterAuthCookies,
  type TwitterDMConversationMessage,
  type TwitterGraphQLErrorCode,
  type TwitterUserLookupResult,
} from './client';
import type { TwitterFollowerLead } from './follower-parser';

export type XProfile = {
  xUserId: string;
  handle: string;
  name?: string;
  bio?: string;
  followers?: number;
  following?: number;
  verified: boolean;
  canDm?: boolean;
};

export type XPage = { profiles: XProfile[]; nextCursor?: string };

export type XMessage = {
  id: string;
  text: string;
  direction: 'in' | 'out';
  at: number;
};

export type XConversation = {
  conversationId: string;
  peer: XProfile;
  unread: boolean;
  messages: XMessage[];
};

export interface XSession {
  me(): Promise<XProfile>;
  lookup(handle: string): Promise<XProfile>;
  searchUsers(args: { query: string; cursor?: string }): Promise<XPage>;
  followersOf(args: { handle: string; cursor?: string }): Promise<XPage>;
  inbox(kind: 'trusted' | 'untrusted'): Promise<XConversation[]>;
  conversation(conversationId: string): Promise<XMessage[] | null>;
  sendDm(args: { recipientId: string; text: string }): Promise<{ messageId: string; conversationId: string }>;
}

export type XConnect = (args: {
  cookies: TwitterAuthCookies;
  onCookiesRotated: (cookies: TwitterAuthCookies) => Promise<void>;
}) => XSession;

export class XError extends Error {
  constructor(
    message: string,
    readonly code: TwitterGraphQLErrorCode,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'XError';
  }
}

function fromLookup(user: TwitterUserLookupResult): XProfile {
  return {
    xUserId: user.userId,
    handle: user.screenName,
    name: user.displayName,
    bio: user.bio,
    followers: user.followerCount,
    following: user.followingCount,
    verified: user.isVerified === true,
    canDm: user.canDm,
  };
}

function fromLead(lead: TwitterFollowerLead): XProfile {
  return {
    xUserId: lead.xUserId,
    handle: lead.username,
    name: lead.displayName,
    bio: lead.bio,
    followers: lead.followerCount,
    following: lead.followingCount,
    verified: lead.isVerified,
    canDm: lead.canDm,
  };
}

function fromMessage(message: TwitterDMConversationMessage): XMessage {
  return {
    id: message.id,
    text: message.text,
    direction: message.direction === 'inbound' ? 'in' : 'out',
    at: message.createdAt,
  };
}

async function translated<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof TwitterGraphQLError) {
      const retryAfterMs = err.rateLimitResetAt ? Math.max(0, err.rateLimitResetAt - Date.now()) : undefined;
      throw new XError(err.message, err.code, retryAfterMs);
    }
    throw err;
  }
}

export const connectX: XConnect = ({ cookies, onCookiesRotated }) => {
  const client = new TwitterGraphQLClient(cookies, undefined, onCookiesRotated);
  const senderId = parseUserIdFromTwid(cookies.twid);
  if (senderId) client.accountId = senderId;
  return {
    me: () =>
      translated(async () => {
        if (!senderId) throw new XError('The cookies have no twid cookie, so the account is unknown.', 'SESSION_EXPIRED');
        return fromLookup(await lookupUserByRestId({ auth: cookies, userId: senderId }));
      }),
    lookup: (handle) => translated(async () => fromLookup(await client.lookupUserByScreenName(handle))),
    searchUsers: ({ query, cursor }) =>
      translated(async () => {
        const page = await client.searchUsers({ query, cursor, count: 20 });
        return { profiles: page.users.map(fromLead), nextCursor: page.hasNextPage ? page.nextCursor : undefined };
      }),
    followersOf: ({ handle, cursor }) =>
      translated(async () => {
        const page = await client.getFollowers({ username: handle, cursor, count: 100 });
        return { profiles: page.users.map(fromLead), nextCursor: page.hasNextPage ? page.nextCursor : undefined };
      }),
    inbox: (kind) =>
      translated(async () => {
        const inbox = await client.getInboxConversations({ count: 50, kind });
        return inbox.conversations.flatMap((conversation) => {
          const peer = conversation.participants[0];
          if (conversation.isGroupConversation || !peer || conversation.participants.length !== 1) return [];
          return [
            {
              conversationId: conversation.conversationId,
              peer: { xUserId: peer.userId, handle: peer.screenName ?? peer.userId, name: peer.name, verified: false },
              unread: conversation.isUnread,
              messages: conversation.inboxMessages.map(fromMessage),
            },
          ];
        });
      }),
    conversation: (conversationId) =>
      translated(async () => {
        const result = await client.getConversationMessages({ conversationId, limit: 50 });
        return result ? result.messages.map(fromMessage) : null;
      }),
    sendDm: ({ recipientId, text }) => translated(() => client.sendDM({ recipientId, text })),
  };
};
