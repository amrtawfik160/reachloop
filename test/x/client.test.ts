import { describe, expect, it, spyOn } from 'bun:test';
import {
  buildCommunityMembersVariables,
  buildFollowersVariables,
  buildUserByScreenNameVariables,
  buildDmConversationId,
  deriveDmInboxConversationState,
  isTransactionIdBootstrapError,
  mergeLeadProfile,
  parseDmConversationMessages,
  shouldRetryFollowersRequestError,
  TwitterGraphQLClient,
  TwitterGraphQLError,
  type TwitterUserLookupResult,
} from '../../src/x/client';
import type { TwitterFollowerLead } from '../../src/x/follower-parser';

describe('mergeLeadProfile', () => {
  it('backfills follower and following counts from a richer profile lookup', () => {
    const lead: TwitterFollowerLead = {
      xUserId: '1000001',
      username: 'founder_one',
      displayName: 'Founder One',
      followerCount: 0,
      followingCount: 0,
      isVerified: true,
    };

    const lookup: TwitterUserLookupResult = {
      userId: '1000001',
      screenName: 'founder_one',
      canDm: true,
      followerCount: 138765,
      followingCount: 1229,
      bio: 'Bootstrapped founder.',
    };

    expect(mergeLeadProfile(lead, lookup)).toMatchObject({
      followerCount: 138765,
      followingCount: 1229,
      bio: 'Bootstrapped founder.',
      canDm: true,
    });
  });
});

describe('buildUserByScreenNameVariables', () => {
  it('matches the Scweet UserByScreenName variable payload', () => {
    expect(buildUserByScreenNameVariables('@example_user')).toEqual({
      screen_name: 'example_user',
      withGrokTranslatedBio: false,
    });
  });
});

describe('buildFollowersVariables', () => {
  it('builds the Scweet-style follower payload', () => {
    expect(buildFollowersVariables({ userId: '123', count: 40, cursor: 'abc' })).toEqual({
      userId: '123',
      count: 40,
      includePromotedContent: false,
      withGrokTranslatedBio: false,
      cursor: 'abc',
    });
  });
});

describe('buildCommunityMembersVariables', () => {
  it('includes count and omits a null cursor', () => {
    expect(buildCommunityMembersVariables({ communityId: ' 777 ', count: 50 })).toEqual({
      communityId: '777',
      count: 50,
    });
  });
});

describe('shouldRetryFollowersRequestError', () => {
  it('retries upstream 5xx follower failures', () => {
    expect(
      shouldRetryFollowersRequestError(
        new TwitterGraphQLError('Twitter API request failed with HTTP 503', 'API_ERROR', 503)
      )
    ).toBe(true);
  });

  it('retries transport-level network failures without an HTTP status', () => {
    expect(
      shouldRetryFollowersRequestError(
        new TwitterGraphQLError('Network error fetching followers', 'NETWORK_ERROR')
      )
    ).toBe(true);
  });

  it('does not retry auth, rate-limit, or stale-query failures', () => {
    expect(
      shouldRetryFollowersRequestError(
        new TwitterGraphQLError('Session expired', 'SESSION_EXPIRED', 401)
      )
    ).toBe(false);
    expect(
      shouldRetryFollowersRequestError(
        new TwitterGraphQLError('Rate limited', 'X_RATE_LIMITED', 429)
      )
    ).toBe(false);
    expect(
      shouldRetryFollowersRequestError(
        new TwitterGraphQLError('Query ID stale', 'QUERY_ID_STALE', 404)
      )
    ).toBe(false);
  });
});

describe('isTransactionIdBootstrapError', () => {
  it('detects bootstrap failures from x-client-transaction-id initialization', () => {
    expect(
      isTransactionIdBootstrapError(
        new TwitterGraphQLError(
          'x-client-transaction-id generation failed after 3 attempts. Error: fetch failed',
          'NETWORK_ERROR'
        )
      )
    ).toBe(true);
    expect(
      isTransactionIdBootstrapError(
        new TwitterGraphQLError('Network error fetching followers', 'NETWORK_ERROR')
      )
    ).toBe(false);
  });
});

describe('buildDmConversationId', () => {
  it('sorts numeric participant ids into the canonical conversation id', () => {
    expect(buildDmConversationId('2000000000000000002', '1000000000000000001')).toBe(
      '1000000000000000001:2000000000000000002'
    );
  });
});

describe('parseDmConversationMessages', () => {
  it('normalizes raw DM entries into route-ready message objects', () => {
    const messages = parseDmConversationMessages(
      [
        {
          message: {
            conversation_id: '123:456',
            message_data: {
              id: 'msg-1',
              time: '1000',
              sender_id: '123',
              recipient_id: '456',
              text: 'hello',
            },
          },
        },
        {
          message: {
            conversation_id: '123:456',
            message_data: {
              id: 'msg-2',
              time: '2000',
              sender_id: '456',
              recipient_id: '123',
              text: 'hi back',
            },
          },
        },
      ],
      '123'
    );

    expect(messages).toEqual([
      {
        id: 'msg-1',
        conversationId: '123:456',
        text: 'hello',
        senderId: '123',
        recipientId: '456',
        createdAt: 1000,
        direction: 'outbound',
      },
      {
        id: 'msg-2',
        conversationId: '123:456',
        text: 'hi back',
        senderId: '456',
        recipientId: '123',
        createdAt: 2000,
        direction: 'inbound',
      },
    ]);
  });
});

describe('TwitterGraphQLClient DM inbox params', () => {
  it('omits max_id from trusted first-page inbox requests', () => {
    const client = new TwitterGraphQLClient({
      authToken: 'auth',
      ct0: 'ct0',
      twid: 'u%3D123',
    });

    const params = (client as any).buildDmInboxParams(100);

    expect(params.get('count')).toBe('100');
    expect(params.has('max_id')).toBe(false);
  });

  it('sets max_id=0 for untrusted first-page inbox requests', () => {
    const client = new TwitterGraphQLClient({
      authToken: 'auth',
      ct0: 'ct0',
      twid: 'u%3D123',
    });

    const params = (client as any).buildDmInboxParams(100, undefined, {
      requireMaxId: true,
    });

    expect(params.get('count')).toBe('100');
    expect(params.get('max_id')).toBe('0');
  });

  it('keeps the provided untrusted cursor as max_id', () => {
    const client = new TwitterGraphQLClient({
      authToken: 'auth',
      ct0: 'ct0',
      twid: 'u%3D123',
    });

    const params = (client as any).buildDmInboxParams(100, 'cursor-1', {
      requireMaxId: true,
    });

    expect(params.get('max_id')).toBe('cursor-1');
  });
});

describe('deriveDmInboxConversationState', () => {
  it('marks a conversation read when inbound messages are at or before the last read event', () => {
    const result = deriveDmInboxConversationState({
      conversation: {
        conversation_id: '123:456',
        participants: [
          { user_id: '123', last_read_event_id: 'msg-2' },
          { user_id: '456' },
        ],
      },
      entries: [
        {
          message: {
            conversation_id: '123:456',
            message_data: {
              id: 'msg-1',
              time: '1000',
              sender_id: '123',
              recipient_id: '456',
              text: 'hello',
            },
          },
        },
        {
          message: {
            conversation_id: '123:456',
            message_data: {
              id: 'msg-2',
              time: '2000',
              sender_id: '456',
              recipient_id: '123',
              text: 'hi back',
            },
          },
        },
      ],
      senderUserId: '123',
    });

    expect(result).toMatchObject({
      unreadCount: 0,
      isUnread: false,
      lastReadEventId: 'msg-2',
      unreadCountTruncated: false,
      requiresConversationFetch: false,
    });
    expect(result.messagesSinceReadEvent).toEqual([]);
  });

  it('counts only inbound messages newer than the last read event', () => {
    const result = deriveDmInboxConversationState({
      conversation: {
        conversation_id: '123:456',
        participants: [
          { user_id: '123', last_read_event_id: 'msg-1' },
          { user_id: '456' },
        ],
      },
      entries: [
        {
          message: {
            conversation_id: '123:456',
            message_data: {
              id: 'msg-1',
              time: '1000',
              sender_id: '123',
              recipient_id: '456',
              text: 'hello',
            },
          },
        },
        {
          message: {
            conversation_id: '123:456',
            message_data: {
              id: 'msg-2',
              time: '2000',
              sender_id: '456',
              recipient_id: '123',
              text: 'reply one',
            },
          },
        },
        {
          message: {
            conversation_id: '123:456',
            message_data: {
              id: 'msg-3',
              time: '3000',
              sender_id: '123',
              recipient_id: '456',
              text: 'follow up',
            },
          },
        },
        {
          message: {
            conversation_id: '123:456',
            message_data: {
              id: 'msg-4',
              time: '4000',
              sender_id: '456',
              recipient_id: '123',
              text: 'reply two',
            },
          },
        },
      ],
      senderUserId: '123',
    });

    expect(result).toMatchObject({
      unreadCount: 2,
      isUnread: true,
      lastReadEventId: 'msg-1',
      unreadCountTruncated: false,
      requiresConversationFetch: false,
    });
    expect(result.messagesSinceReadEvent.map((message) => message.id)).toEqual([
      'msg-2',
      'msg-3',
      'msg-4',
    ]);
  });

  it('treats missing last_read_event_id conservatively', () => {
    const result = deriveDmInboxConversationState({
      conversation: {
        conversation_id: '123:456',
        participants: [{ user_id: '123' }, { user_id: '456' }],
      },
      entries: [
        {
          message: {
            conversation_id: '123:456',
            message_data: {
              id: 'msg-1',
              time: '1000',
              sender_id: '456',
              recipient_id: '123',
              text: 'hello',
            },
          },
        },
        {
          message: {
            conversation_id: '123:456',
            message_data: {
              id: 'msg-2',
              time: '2000',
              sender_id: '123',
              recipient_id: '456',
              text: 'reply',
            },
          },
        },
      ],
      senderUserId: '123',
    });

    expect(result).toMatchObject({
      unreadCount: 0,
      isUnread: false,
      lastReadEventId: undefined,
      unreadCountTruncated: false,
      requiresConversationFetch: false,
    });

    const unreadResult = deriveDmInboxConversationState({
      conversation: {
        conversation_id: '123:456',
        participants: [{ user_id: '123' }, { user_id: '456' }],
      },
      entries: [
        {
          message: {
            conversation_id: '123:456',
            message_data: {
              id: 'msg-3',
              time: '3000',
              sender_id: '456',
              recipient_id: '123',
              text: 'fresh reply',
            },
          },
        },
      ],
      senderUserId: '123',
    });

    expect(unreadResult).toMatchObject({
      unreadCount: 1,
      isUnread: true,
      unreadCountTruncated: true,
      requiresConversationFetch: true,
    });
  });

  it('flags truncated unread counts when the read pointer is outside the inbox window', () => {
    const result = deriveDmInboxConversationState({
      conversation: {
        conversation_id: '123:456',
        participants: [
          { user_id: '123', last_read_event_id: 'older-read-event' },
          { user_id: '456' },
        ],
      },
      entries: [
        {
          message: {
            conversation_id: '123:456',
            message_data: {
              id: 'msg-2',
              time: '2000',
              sender_id: '456',
              recipient_id: '123',
              text: 'reply one',
            },
          },
        },
        {
          message: {
            conversation_id: '123:456',
            message_data: {
              id: 'msg-3',
              time: '3000',
              sender_id: '123',
              recipient_id: '456',
              text: 'follow up',
            },
          },
        },
      ],
      senderUserId: '123',
    });

    expect(result).toMatchObject({
      unreadCount: 1,
      isUnread: true,
      unreadCountTruncated: true,
      requiresConversationFetch: true,
    });
  });
});

describe('TwitterGraphQLClient DM conversation lookup', () => {
  it('falls back to the untrusted/message-request inbox when trusted inbox has no conversation', async () => {
    const client = new TwitterGraphQLClient({
      authToken: 'auth',
      ct0: 'ct0',
      twid: 'u%3D123',
    });

    spyOn(client, 'lookupUserByScreenName').mockResolvedValue({
      userId: '456',
      screenName: 'lead',
      canDm: true,
    });

    const getConversationMessages = spyOn(client, 'getConversationMessages')
      .mockImplementation(async ({ conversationId }: { conversationId: string }) => {
        if (conversationId !== 'untrusted-conv') return null;
        return {
          conversationId: 'untrusted-conv',
          messages: [
            {
              id: 'msg-1',
              conversationId: 'untrusted-conv',
              text: 'reply from request inbox',
              senderId: '456',
              recipientId: '123',
              createdAt: 2_000,
              direction: 'inbound',
            },
          ],
          nextCursor: null,
          hasMore: false,
        };
      });

    const getInboxConversations = spyOn(client, 'getInboxConversations')
      .mockResolvedValueOnce({
        conversations: [],
        nextCursor: undefined,
        hasNextPage: false,
      })
      .mockResolvedValueOnce({
        conversations: [
          {
            conversationId: 'untrusted-conv',
            participantIds: ['123', '456'],
            participants: [{ userId: '456', screenName: 'lead', name: 'Lead' }],
            unreadCount: 0,
            isUnread: false,
            unreadCountTruncated: false,
            inboxMessages: [],
            messagesSinceReadEvent: [],
            requiresConversationFetch: false,
          } as any,
        ],
        nextCursor: undefined,
        hasNextPage: false,
      });

    const result = await client.getConversationMessagesByScreenName({
      screenName: 'lead',
      limit: 20,
    });

    expect(getInboxConversations).toHaveBeenLastCalledWith({
      count: 200,
      kind: 'untrusted',
    });
    expect(getConversationMessages).toHaveBeenLastCalledWith({
      conversationId: 'untrusted-conv',
      limit: 20,
      beforeSentAt: undefined,
      minEntryId: undefined,
    });
    expect(result.conversationId).toBe('untrusted-conv');
    expect(result.messages[0]?.text).toBe('reply from request inbox');
  });

  it('does not resolve a screen-name lookup through a group DM containing that user', async () => {
    const client = new TwitterGraphQLClient({
      authToken: 'auth',
      ct0: 'ct0',
      twid: 'u%3D123',
    });

    spyOn(client, 'lookupUserByScreenName').mockResolvedValue({
      userId: '456',
      screenName: 'lead',
      canDm: true,
    });

    const getConversationMessages = spyOn(client, 'getConversationMessages')
      .mockResolvedValue(null);

    spyOn(client, 'getInboxConversations')
      .mockResolvedValueOnce({
        conversations: [
          {
            conversationId: 'group-conv',
            participantIds: ['123', '456', '789'],
            participants: [
              { userId: '456', screenName: 'lead', name: 'Lead' },
              { userId: '789', screenName: 'someone_else', name: 'Someone Else' },
            ],
            isGroupConversation: true,
            unreadCount: 0,
            isUnread: false,
            unreadCountTruncated: false,
            inboxMessages: [],
            messagesSinceReadEvent: [],
            requiresConversationFetch: false,
          },
        ],
        nextCursor: undefined,
        hasNextPage: false,
      })
      .mockResolvedValueOnce({
        conversations: [],
        nextCursor: undefined,
        hasNextPage: false,
      });

    const result = await client.getConversationMessagesByScreenName({
      screenName: 'lead',
      limit: 20,
    });

    expect(result.conversationId).toBeNull();
    expect(result.messages).toEqual([]);
    expect(getConversationMessages).not.toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'group-conv' })
    );
  });
});
