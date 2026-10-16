import { ClientTransaction, handleXMigration } from 'x-client-transaction-id';
import { xConfig } from './config';
import { log } from './log';
import {
  parseFollowersTimelineResponse,
  type TwitterFollowerLead,
} from './follower-parser';
import { parseCommunityMembersTimelineResponse } from './community-parser';
import { parseSearchUsersResponse, parseSearchRepliersResponse } from './search-parser';
import {
  discoverSearchTimelineQueryId,
  invalidateQueryIdCache,
  invalidateManifestCache,
  discoverFollowerQueryIds,
  invalidateFollowerQueryIdCache,
  getQueryId,
} from './query-id-discovery';
import { fetchImpersonated, CHROME_120_USER_AGENT } from './http-client';
import { acquireLimiter, reportRateLimited, type LimiterOperation } from './token-bucket';

const SCWEET_WEB_FEATURES = {
  rweb_video_screen_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_jetfuel_frame: true,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_grok_annotations_enabled: false,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_analysis_button_from_backend: true,
  post_ctas_fetch_enabled: true,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
  responsive_web_enhance_cards_enabled: false,
};

const USER_BY_SCREEN_NAME_FEATURES = JSON.stringify({
  ...SCWEET_WEB_FEATURES,
  hidden_profile_subscriptions_enabled: true,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: true,
});

// Matches twikit's USER_FEATURES verbatim (d60/twikit:twikit/constants.py).
// Used for UserByRestId — kept distinct from USER_BY_SCREEN_NAME_FEATURES
// (timeline-related ops) so drift on one set doesn't silently break the other.
const USER_FEATURES = JSON.stringify({
  hidden_profile_likes_enabled: true,
  hidden_profile_subscriptions_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
});

const USER_BY_SCREEN_NAME_FIELD_TOGGLES = JSON.stringify({
  withPayments: false,
  withAuxiliaryUserLabels: true,
});

/**
 * fieldToggles required by the Followers, BlueVerifiedFollowers, community
 * members, and SearchTimeline endpoints per the X.com bundle metadata.
 * Without this parameter these endpoints return HTTP 404.
 */
const TIMELINE_FIELD_TOGGLES = JSON.stringify({
  withPayments: false,
  withAuxiliaryUserLabels: true,
  withArticleRichContentState: false,
  withArticlePlainText: false,
  withArticleSummaryText: false,
  withArticleVoiceOver: false,
  withGrokAnalyze: false,
  withDisallowedReplyControls: false,
});

const FOLLOWERS_FEATURES = JSON.stringify({
  ...SCWEET_WEB_FEATURES,
  responsive_web_grok_annotations_enabled: true,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_twitter_blue_verified_badge_is_enabled: true,
  vibe_api_enabled: false,
  responsive_web_graphql_exclude_directive_enabled: true,
  longform_notetweets_richtext_consumption_enabled: true,
});

const SEARCH_TIMELINE_FEATURES = JSON.stringify({
  ...SCWEET_WEB_FEATURES,
});

// ============== Public Types ==============

export interface TwitterAuthCookies {
  authToken: string;
  ct0: string;
  /** Twitter user-ID cookie. Format: "u%3D<numericUserId>" (URL-encoded "u=<id>"). */
  twid?: string;
}

export interface TwitterUserLookupResult {
  userId: string;
  screenName: string;
  canDm?: boolean;
  displayName?: string;
  profileImageUrl?: string;
  bio?: string;
  location?: string;
  followerCount?: number;
  followingCount?: number;
  isVerified?: boolean;
  createdAt?: string;
}

export interface TwitterDMSendResult {
  conversationId: string;
  messageId: string;
}

export interface TwitterFollowUserResult {
  userId: string;
  screenName?: string;
  following?: boolean;
  followRequestSent?: boolean;
  followedBy?: boolean;
}

export interface TwitterFollowersResult {
  users: TwitterFollowerLead[];
  nextCursor?: string;
  hasNextPage: boolean;
}

export interface TwitterDMConversationMessage {
  id: string;
  conversationId: string;
  text: string;
  senderId: string;
  recipientId: string;
  createdAt: number;
  direction: 'inbound' | 'outbound';
}

export interface TwitterDMConversationMessagesResult {
  conversationId: string | null;
  messages: TwitterDMConversationMessage[];
  nextCursor: number | null;
  hasMore: boolean;
}

export interface TwitterDMParticipant {
  userId: string;
  screenName?: string;
  name?: string;
}

export interface TwitterDMInboxConversation {
  conversationId: string;
  participantIds: string[];
  participants: TwitterDMParticipant[];
  isGroupConversation?: boolean;
  unreadCount: number;
  isUnread: boolean;
  lastReadEventId?: string;
  unreadCountTruncated?: boolean;
  latestInboundMessageAt?: number;
  inboxMessages: TwitterDMConversationMessage[];
  messagesSinceReadEvent: TwitterDMConversationMessage[];
  requiresConversationFetch: boolean;
  lastMessage?: {
    id: string;
    text: string;
    createdAt: number;
    senderId: string;
    recipientId: string;
  };
}

export interface TwitterDMInboxResult {
  conversations: TwitterDMInboxConversation[];
  nextCursor?: string;
  hasNextPage: boolean;
}

export interface TwitterUnreadDMInboxResult extends TwitterDMInboxResult {
  unreadConversations: TwitterDMInboxConversation[];
}

export interface TwitterCommunityMembersResult {
  users: TwitterFollowerLead[];
  nextCursor?: string;
  hasNextPage: boolean;
}

export type TwitterGraphQLErrorCode =
  | 'SESSION_EXPIRED'
  | 'ACCOUNT_SUSPENDED'
  | 'X_RATE_LIMITED'
  | 'DMS_CLOSED'
  | 'USER_NOT_FOUND'
  | 'NETWORK_ERROR'
  | 'API_ERROR'
  | 'QUERY_ID_STALE';

export class TwitterGraphQLError extends Error {
  constructor(
    message: string,
    public readonly code: TwitterGraphQLErrorCode,
    public readonly httpStatus?: number,
    public readonly apiErrors?: Array<{ code: number; message: string }>,
    /** Unix timestamp (ms) when this rate-limit resets. Only set for X_RATE_LIMITED errors. */
    public readonly rateLimitResetAt?: number
  ) {
    super(message);
    this.name = 'TwitterGraphQLError';
  }
}

// ============== Internal Response Shapes ==============

interface TwitterApiErrorEntry {
  code?: number;
  message?: string;
}

interface TwitterApiResponseBase {
  errors?: TwitterApiErrorEntry[];
}

interface TwitterUserLegacy {
  screen_name?: string;
  /** Present in some legacy API responses — prefer dm_permissions.can_dm. */
  can_dm?: boolean;
  created_at?: string;
  description?: string;
  followers_count?: number;
  friends_count?: number;
}

interface TwitterUserResult {
  __typename?: string;
  /** Numeric Twitter user ID string (preferred). */
  rest_id?: string;
  /** Numeric ID string in some older response shapes. */
  id_str?: string;
  /** Base64-encoded GraphQL global ID ("User:{numericId}") — fallback if rest_id absent. */
  id?: string;
  relationship_counts?: { followers?: number; following?: number };
  legacy?: TwitterUserLegacy;
  /** Current location of the canDm flag in Twitter GraphQL responses. */
  dm_permissions?: { can_dm?: boolean };
  core?: {
    name?: string;
    screen_name?: string;
    created_at?: string;
  };
  avatar?: {
    image_url?: string;
  };
  profile_bio?: {
    description?: string;
  };
  location?: {
    location?: string;
  };
  verification?: {
    verified?: boolean;
  };
  is_blue_verified?: boolean;
}

interface TwitterUserData {
  result?: TwitterUserResult;
}

interface UserByScreenNameResponse extends TwitterApiResponseBase {
  data?: {
    user?: TwitterUserData;
  };
}

interface TwitterLegacyDmUser {
  id_str?: string;
  screen_name?: string;
  name?: string;
}

interface DmParticipantRaw {
  user_id?: string;
  last_read_event_id?: string;
}

interface DmConversationRaw {
  conversation_id?: string;
  participants?: DmParticipantRaw[];
}

interface DmMessageDataRaw {
  id?: string;
  time?: string;
  recipient_id?: string;
  sender_id?: string;
  text?: string;
}

interface DmMessageRaw {
  id?: string;
  time?: string;
  conversation_id?: string;
  request_id?: string;
  message_data?: DmMessageDataRaw;
}

interface DmMessageEntryRaw {
  message?: DmMessageRaw;
  welcome_message_create?: DmMessageRaw;
}

interface DmInboxStateRaw {
  cursor?: string;
  entries?: DmMessageEntryRaw[];
  users?: Record<string, TwitterLegacyDmUser>;
  conversations?: Record<string, DmConversationRaw>;
}

interface DmInboxResponse extends TwitterApiResponseBase {
  inbox_initial_state?: DmInboxStateRaw;
}

interface DmConversationTimelineRaw {
  status?: 'AT_END' | 'HAS_MORE';
  min_entry_id?: string;
  max_entry_id?: string;
  entries?: DmMessageEntryRaw[];
}

interface DmConversationResponse extends TwitterApiResponseBase {
  conversation_timeline?: DmConversationTimelineRaw;
}

// ============== Type Guards ==============

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUserByScreenNameResponse(value: unknown): value is UserByScreenNameResponse {
  return isRecord(value);
}

function toTimestamp(value?: string): number {
  const parsed = Number(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractDmMessage(entry: DmMessageEntryRaw): DmMessageRaw | null {
  return entry.message ?? entry.welcome_message_create ?? null;
}

export function buildDmConversationId(leftUserId: string, rightUserId: string): string {
  const values = [leftUserId.trim(), rightUserId.trim()].filter(Boolean);
  if (values.length !== 2) {
    return values.join(':');
  }

  const [left, right] = values;
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    return BigInt(left) <= BigInt(right) ? `${left}:${right}` : `${right}:${left}`;
  }

  return left.localeCompare(right) <= 0 ? `${left}:${right}` : `${right}:${left}`;
}

export function parseDmConversationMessages(
  entries: DmMessageEntryRaw[],
  senderUserId: string
): TwitterDMConversationMessage[] {
  return entries
    .map((entry) => extractDmMessage(entry))
    .filter((message): message is DmMessageRaw => Boolean(message))
    .map((message) => {
      const data = message.message_data ?? {};
      const senderId = data.sender_id ?? '';
      const recipientId = data.recipient_id ?? '';
      return {
        id:
          data.id ??
          message.id ??
          message.request_id ??
          `${message.conversation_id ?? 'unknown'}:${data.time ?? '0'}`,
        conversationId: message.conversation_id ?? '',
        text: data.text ?? '',
        senderId,
        recipientId,
        createdAt: toTimestamp(data.time ?? message.time),
        direction: (senderId === senderUserId ? 'outbound' : 'inbound') as 'outbound' | 'inbound',
      };
    })
    .filter((message) => message.text.length > 0 || message.id.length > 0);
}

export function deriveDmInboxConversationState(args: {
  conversation: DmConversationRaw;
  entries: DmMessageEntryRaw[];
  senderUserId: string;
}): Pick<
  TwitterDMInboxConversation,
  | 'unreadCount'
  | 'isUnread'
  | 'lastReadEventId'
  | 'unreadCountTruncated'
  | 'latestInboundMessageAt'
  | 'inboxMessages'
  | 'messagesSinceReadEvent'
  | 'requiresConversationFetch'
  | 'lastMessage'
> {
  const lastReadEventId =
    args.conversation.participants
      ?.find((participant) => participant.user_id === args.senderUserId)
      ?.last_read_event_id
      ?.trim() || undefined;
  const inboxMessages = parseDmConversationMessages(args.entries, args.senderUserId).sort(
    (left, right) => right.createdAt - left.createdAt
  );
  const latestInboundMessageAt = inboxMessages.find((message) => message.direction === 'inbound')?.createdAt;
  const lastMessage = inboxMessages[0]
    ? {
        id: inboxMessages[0].id,
        text: inboxMessages[0].text,
        createdAt: inboxMessages[0].createdAt,
        senderId: inboxMessages[0].senderId,
        recipientId: inboxMessages[0].recipientId,
      }
    : undefined;

  if (inboxMessages.length === 0) {
    return {
      unreadCount: 0,
      isUnread: false,
      lastReadEventId,
      unreadCountTruncated: false,
      latestInboundMessageAt,
      inboxMessages: [],
      messagesSinceReadEvent: [],
      requiresConversationFetch: false,
      lastMessage,
    };
  }

  if (!lastReadEventId) {
    const latestMessage = inboxMessages[0];
    const isUnread = latestMessage?.direction === 'inbound';

    return {
      unreadCount: isUnread ? 1 : 0,
      isUnread,
      lastReadEventId,
      unreadCountTruncated: isUnread,
      latestInboundMessageAt,
      inboxMessages,
      messagesSinceReadEvent: isUnread ? [latestMessage] : [],
      requiresConversationFetch: isUnread,
      lastMessage,
    };
  }

  const messagesSinceReadEvent: TwitterDMConversationMessage[] = [];
  let unreadCount = 0;
  let sawReadPointer = false;

  for (const message of inboxMessages) {
    if (message.id === lastReadEventId) {
      sawReadPointer = true;
      break;
    }

    messagesSinceReadEvent.push(message);
    if (message.direction === 'inbound') {
      unreadCount += 1;
    }
  }

  const isUnread = unreadCount > 0;
  const unreadCountTruncated = isUnread && !sawReadPointer;

  return {
    unreadCount,
    isUnread,
    lastReadEventId,
    unreadCountTruncated,
    latestInboundMessageAt,
    inboxMessages,
    messagesSinceReadEvent: messagesSinceReadEvent.slice().reverse(),
    requiresConversationFetch: unreadCountTruncated,
    lastMessage,
  };
}

function isOneToOneInboxConversation(
  conversation: TwitterDMInboxConversation,
  senderUserId: string,
  expectedParticipantUserId?: string
): boolean {
  if (conversation.isGroupConversation) {
    return false;
  }

  const nonSelfParticipantIds = conversation.participantIds.filter(
    (participantId) => participantId && participantId !== senderUserId
  );
  if (nonSelfParticipantIds.length !== 1) {
    return false;
  }

  if (conversation.participants.length > 1) {
    return false;
  }

  return expectedParticipantUserId
    ? nonSelfParticipantIds[0] === expectedParticipantUserId
    : true;
}

export function mergeLeadProfile(
  lead: TwitterFollowerLead,
  lookup: TwitterUserLookupResult
): TwitterFollowerLead {
  return {
    ...lead,
    displayName: lookup.displayName || lead.displayName,
    profileImageUrl: lookup.profileImageUrl || lead.profileImageUrl,
    bio: lookup.bio || lead.bio,
    location: lookup.location || lead.location,
    followerCount: lookup.followerCount ?? lead.followerCount,
    followingCount: lookup.followingCount ?? lead.followingCount,
    isVerified: lookup.isVerified ?? lead.isVerified,
    canDm: lookup.canDm ?? lead.canDm,
    createdAt: lookup.createdAt || lead.createdAt,
  };
}

export function buildUserByScreenNameVariables(screenName: string): {
  screen_name: string;
  withGrokTranslatedBio: false;
} {
  return {
    screen_name: screenName.replace(/^@/, ''),
    withGrokTranslatedBio: false,
  };
}

export function buildUserByRestIdVariables(userId: string): {
  userId: string;
  withSafetyModeUserFields: true;
} {
  return {
    userId: userId.trim(),
    withSafetyModeUserFields: true,
  };
}

/**
 * Decode the numeric Twitter user ID encoded in the `twid` cookie.
 * twid format: "u%3D<numericUserId>" (URL-encoded "u=<id>"). Returns null
 * when the cookie is missing or malformed.
 */
export function parseUserIdFromTwid(twid: string | undefined): string | null {
  if (!twid) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(twid);
  } catch {
    return null;
  }
  const match = decoded.match(/^u=(\d+)$/);
  return match ? match[1] : null;
}

/**
 * Looks up a user by numeric ID using the X.com GraphQL `UserByRestId`
 * endpoint. This is the cookie-only replacement for the legacy v1.1
 * `account/verify_credentials.json` endpoint X removed — it accepts the same
 * cookie-based auth and returns the public profile.
 *
 * Used by the `/account/identify-from-cookies` route so the dashboard can
 * verify which X user a freshly-pasted cookie jar belongs to without ever
 * needing a username up front.
 */
async function lookupUserByRestIdWithQueryId(
  queryId: string,
  args: {
    auth: TwitterAuthCookies;
    userId: string;
    userAgent?: string;
  }
): Promise<TwitterUserLookupResult> {
  const variables = JSON.stringify(buildUserByRestIdVariables(args.userId));
  const url = new URL(`https://x.com/i/api/graphql/${queryId}/UserByRestId`);
  url.searchParams.set('variables', variables);
  // Match twikit: UserByRestId uses USER_FEATURES only, no fieldToggles.
  url.searchParams.set('features', USER_FEATURES);

  const userAgent = args.userAgent ?? CHROME_120_USER_AGENT;
  const headers = await buildGraphqlHeaders(args.auth, userAgent, url.toString(), {
    referer: 'https://x.com/home',
    // If the x-client-transaction-id bootstrap fails, fall through without
    // the header so an account check still works.
    requireTransactionId: false,
  });

  let responseText = '';
  let responseStatus = 0;
  let responseHeaders: Headers | undefined;
  let parsed: unknown = null;

  try {
    const response = await fetchImpersonated(url.toString(), {
      method: 'GET',
      headers,
    });

    responseStatus = response.status;
    responseHeaders = response.headers;
    applySetCookieRotation(args.auth, response.headers);
    responseText = await response.text();
    parsed = tryParseJson(responseText);

    if (!response.ok) {
      throw classifyNonOkResponse(responseStatus, responseText, parsed, url.toString(), response.headers);
    }
  } catch (err) {
    if (err instanceof TwitterGraphQLError) throw err;
    throw new TwitterGraphQLError(
      `Network error looking up user by ID ${args.userId}: ${(err as Error).message}`,
      'NETWORK_ERROR'
    );
  }

  if (!isUserByScreenNameResponse(parsed)) {
    throw new TwitterGraphQLError(
      `Failed to parse UserByRestId response for user ${args.userId}`,
      'API_ERROR',
      responseStatus
    );
  }

  const apiErrors = parseApiErrors(parsed);
  const userResult = parsed.data?.user?.result;

  if (!userResult) {
    const bodyError = classifyApiErrorsFromBody(apiErrors, responseStatus, responseHeaders);
    if (bodyError) throw bodyError;

    if (apiErrors.length > 0) {
      throw new TwitterGraphQLError(
        `User ${args.userId} not found or unavailable: ${apiErrors[0].message}`,
        'USER_NOT_FOUND',
        responseStatus,
        apiErrors
      );
    }
    throw new TwitterGraphQLError(
      `User ${args.userId} not found or unavailable`,
      'USER_NOT_FOUND',
      responseStatus
    );
  }

  if (userResult.__typename === 'UserUnavailable') {
    throw new TwitterGraphQLError(
      `User ${args.userId} is unavailable`,
      'USER_NOT_FOUND',
      responseStatus
    );
  }

  let resolvedUserId =
    userResult.rest_id ??
    userResult.id_str ??
    '';

  if (!resolvedUserId && userResult.id) {
    const decoded = Buffer.from(userResult.id, 'base64').toString('utf8');
    const match = decoded.match(/^User:(\d+)$/);
    if (match) resolvedUserId = match[1];
  }

  if (!resolvedUserId) resolvedUserId = args.userId;

  const screenName = userResult.core?.screen_name ?? userResult.legacy?.screen_name ?? '';
  if (!screenName) {
    throw new TwitterGraphQLError(
      `UserByRestId returned no screen_name for user ${args.userId}`,
      'API_ERROR',
      responseStatus
    );
  }

  const dmPermsFlag = userResult.dm_permissions?.can_dm;
  const legacyFlag = userResult.legacy?.can_dm;
  const canDm =
    dmPermsFlag !== undefined ? dmPermsFlag : legacyFlag;

  return {
    userId: resolvedUserId,
    screenName,
    canDm,
    displayName: userResult.core?.name?.trim() || screenName,
    profileImageUrl: userResult.avatar?.image_url,
    bio: userResult.profile_bio?.description ?? userResult.legacy?.description,
    location: userResult.location?.location || undefined,
    followerCount: userResult.relationship_counts?.followers ?? userResult.legacy?.followers_count,
    followingCount: userResult.relationship_counts?.following ?? userResult.legacy?.friends_count,
    isVerified:
      userResult.is_blue_verified === true ||
      userResult.verification?.verified === true,
    createdAt: userResult.core?.created_at ?? userResult.legacy?.created_at,
  };
}

export async function lookupUserByRestId(args: {
  auth: TwitterAuthCookies;
  userId: string;
  userAgent?: string;
}): Promise<TwitterUserLookupResult> {
  // Try the bundled-default queryId first (same pattern the other GraphQL
  // ops use). Only fall back to scraping x.com's bundle if X has rotated
  // the ID, since the bundle-fetch path is the unreliable one — Cloudflare
  // serves data-center IPs (e.g. Fly.io egress) different markup, and the
  // discovery scan sometimes can't see the operation we need from those IPs.
  const defaultQueryId = xConfig.twitterUserByRestIdQueryId;
  try {
    return await lookupUserByRestIdWithQueryId(defaultQueryId, args);
  } catch (err) {
    if (err instanceof TwitterGraphQLError && err.code === 'QUERY_ID_STALE') {
      invalidateManifestCache();
      const discoveredId = await getQueryId('UserByRestId');
      if (discoveredId && discoveredId !== defaultQueryId) {
        log.info(
          `[TwitterGraphQLClient] UserByRestId query ID updated: ${defaultQueryId} → ${discoveredId}`
        );
        return await lookupUserByRestIdWithQueryId(discoveredId, args);
      }
    }
    throw err;
  }
}

export function buildFollowersVariables(args: {
  userId: string;
  count?: number;
  cursor?: string;
}): {
  userId: string;
  count: number;
  includePromotedContent: false;
  withGrokTranslatedBio: false;
  cursor?: string;
} {
  return {
    userId: args.userId,
    count: args.count ?? 100,
    includePromotedContent: false,
    withGrokTranslatedBio: false,
    ...(args.cursor ? { cursor: args.cursor } : {}),
  };
}

export function buildCommunityMembersVariables(args: {
  communityId: string;
  count?: number;
  cursor?: string;
}): {
  communityId: string;
  count: number;
  cursor?: string;
} {
  return {
    communityId: args.communityId.trim(),
    count: args.count ?? 100,
    ...(args.cursor ? { cursor: args.cursor } : {}),
  };
}

// ============== User-Agent Pool ==============
// Rotating set of realistic Chrome user agents across major platforms.
// Using a single static UA across all accounts is a strong bot signal.
//
// All entries are Chrome 120 because the TLS/HTTP2 fingerprint emitted by
// cycletls in http-client.ts is locked to Chrome 120. UA-major and JA3-major
// disagreeing is itself a fingerprint — the OS varies, the version does not.

const USER_AGENT_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

/**
 * Returns a stable but varied user agent derived from the account's auth token.
 * Same account always gets the same UA (consistency), but different accounts differ.
 *
 * The override is honored verbatim when provided. The previous implementation
 * silently discarded any override that happened to equal USER_AGENT_POOL[0],
 * which made `getSecChUa()` derive a mismatched hint for callers passing that
 * exact UA — a textbook fingerprinting tell.
 */
function pickUserAgent(authToken: string, override?: string): string {
  if (override) return override;
  const hash = authToken
    .split('')
    .reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) >>> 0, 0);
  return USER_AGENT_POOL[hash % USER_AGENT_POOL.length];
}

/**
 * Extracts the major version from a Chrome/Edge user-agent string. Defaults
 * to "134" if the UA can't be parsed, so unknown UAs still produce a
 * self-consistent header set.
 */
function extractChromiumMajorVersion(userAgent: string): string {
  const edgeMatch = userAgent.match(/Edg\/(\d+)/);
  if (edgeMatch) return edgeMatch[1];
  const chromeMatch = userAgent.match(/Chrome\/(\d+)/);
  if (chromeMatch) return chromeMatch[1];
  return '120';
}

/**
 * Returns the matching sec-ch-ua hint string for a given user agent. The
 * version is parsed from the UA so the hint always tracks the UA, even when
 * the UA is overridden or rotated.
 */
function getSecChUa(userAgent: string): string {
  const version = extractChromiumMajorVersion(userAgent);
  if (userAgent.includes('Edg/')) {
    return `"Microsoft Edge";v="${version}", "Chromium";v="${version}", "Not-A.Brand";v="99"`;
  }
  return `"Chromium";v="${version}", "Google Chrome";v="${version}", "Not-A.Brand";v="99"`;
}

/**
 * Returns "?1" for mobile UAs, "?0" for desktop.
 */
function getSecChUaMobile(userAgent: string): string {
  return userAgent.includes('Mobile') ? '?1' : '?0';
}

/**
 * Returns the platform hint string for a given user agent.
 */
function getSecChUaPlatform(userAgent: string): string {
  if (userAgent.includes('Windows NT')) return '"Windows"';
  if (userAgent.includes('Macintosh')) return '"macOS"';
  if (userAgent.includes('Linux')) return '"Linux"';
  return '"Windows"';
}

// ============== Helpers ==============

/**
 * Walks a parsed JSON body and returns the first value whose key matches `key`.
 * Mirrors twikit's `find_dict(..., find_one=True)` used to pull `message_data`
 * out of the deeply-nested `dm/new2.json` response.
 */
function findFirstByKey(node: unknown, key: string): unknown {
  if (node === null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findFirstByKey(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const obj = node as Record<string, unknown>;
  if (key in obj) return obj[key];
  for (const value of Object.values(obj)) {
    const found = findFirstByKey(value, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function buildCommonHeaders(
  auth: TwitterAuthCookies,
  userAgent: string,
  options: { referer?: string } = {}
): Record<string, string> {
  const resolvedUa = pickUserAgent(auth.authToken, userAgent);
  let cookieStr = `auth_token=${auth.authToken}; ct0=${auth.ct0}`;
  if (auth.twid) cookieStr += `; twid=${auth.twid}`;
  // Deliberately send ONLY auth_token + ct0 + twid. Cloudflare cookies such as
  // __cf_bm and cf_clearance are bound to the browser that set them.
  return {
    authorization: `Bearer ${xConfig.twitterBearerToken}`,
    'x-csrf-token': auth.ct0,
    cookie: cookieStr,
    'content-type': 'application/json',
    'user-agent': resolvedUa,
    'x-twitter-client-language': 'en',
    'x-twitter-active-user': 'yes',
    'x-twitter-auth-type': 'OAuth2Session',
    accept: '*/*',
    'accept-encoding': 'gzip, deflate, br, zstd',
    'accept-language': 'en-US,en;q=0.9',
    origin: 'https://x.com',
    referer: options.referer ?? 'https://x.com/messages',
    'sec-ch-ua': getSecChUa(resolvedUa),
    'sec-ch-ua-mobile': getSecChUaMobile(resolvedUa),
    'sec-ch-ua-platform': getSecChUaPlatform(resolvedUa),
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    // Chrome's XHR/fetch priority hint — sent on every same-origin XHR. Its
    // absence is one of the cheaper bot signals to detect.
    priority: 'u=1, i',
  };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * X rotates `ct0` (and occasionally `auth_token`/`twid`) on certain auth
 * events via Set-Cookie. undici doesn't manage a cookie jar by default, so
 * without this hook every subsequent request would carry the stale `ct0`
 * and get 403'd — which the classifier could then misread as a session
 * expiry, burning an otherwise healthy account. We mutate the auth object
 * in place so the next request picks up the fresh values automatically.
 */
function applySetCookieRotation(auth: TwitterAuthCookies, headers: Headers): boolean {
  const getter = (headers as { getSetCookie?: () => string[] }).getSetCookie;
  let setCookies: string[];
  if (typeof getter === 'function') {
    setCookies = getter.call(headers);
  } else {
    const single = headers.get('set-cookie');
    setCookies = single ? [single] : [];
  }
  if (setCookies.length === 0) return false;

  let changed = false;

  for (const raw of setCookies) {
    const firstSegment = raw.split(';', 1)[0] ?? '';
    const eq = firstSegment.indexOf('=');
    if (eq === -1) continue;
    const name = firstSegment.slice(0, eq).trim();
    const value = firstSegment.slice(eq + 1).trim();
    if (!value || value === '""') continue;
    if (name === 'ct0' && value !== auth.ct0) {
      auth.ct0 = value;
      changed = true;
    } else if (name === 'auth_token' && value !== auth.authToken) {
      auth.authToken = value;
      changed = true;
    } else if (name === 'twid' && value !== auth.twid) {
      auth.twid = value;
      changed = true;
    }
  }

  return changed;
}

type TxCacheEntry = {
  promise: Promise<ClientTransaction>;
  createdAt: number;
};

let clientTransactionCache: TxCacheEntry | null = null;
const CLIENT_TRANSACTION_MAX_AGE_MS = 30 * 60 * 1000;

export function invalidateClientTransaction(): void {
  if (!clientTransactionCache) return;
  clientTransactionCache = null;
  log.info('x-client-transaction-id cache invalidated — will re-initialize on next request');
}

async function initTransaction(): Promise<ClientTransaction> {
  // x-client-transaction-id internally calls fetch() to pull x.com's homepage
  // and the ondemand.js bundle. We must use the impersonating client here too —
  // Cloudflare blocks the default runtime fingerprint, which would silently fail
  // every TX-ID bootstrap and cascade into the Followers/SearchTimeline
  // endpoints (they require x-client-transaction-id).
  const originalFetch = globalThis.fetch;
  const impersonatedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase() as
      | 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD' | 'PATCH';
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of new Headers(init.headers as HeadersInit)) headers[k] = v;
    }
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const res = await fetchImpersonated(url, { method, headers, body });
    const text = await res.text();
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      headers: res.headers,
      text: async () => text,
      json: async () => {
        try { return JSON.parse(text); } catch { return null; }
      },
      url: res.finalUrl,
    } as unknown as Response;
  };
  globalThis.fetch = Object.assign(impersonatedFetch, { preconnect: originalFetch.preconnect });
  try {
    const document = await handleXMigration();
    return await ClientTransaction.create(document);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function getClientTransaction(): Promise<ClientTransaction> {
  const existing = clientTransactionCache;
  if (existing && Date.now() - existing.createdAt > CLIENT_TRANSACTION_MAX_AGE_MS) {
    log.info('x-client-transaction-id cache expired after 30 minutes — re-initializing');
    clientTransactionCache = null;
  } else if (existing) {
    return existing.promise;
  }

  const entry: TxCacheEntry = { createdAt: Date.now(), promise: initTransaction() };
  clientTransactionCache = entry;
  // On init failure, drop this entry so the next caller retries instead of
  // re-using a rejected promise.
  entry.promise.catch(() => {
    if (clientTransactionCache === entry) clientTransactionCache = null;
  });
  return entry.promise;
}

/**
 * Adds `x-client-transaction-id` to a header bag, mirroring twikit's per-request
 * TID generation in `Client.request` ([client.py:145-146](github.com/d60/twikit)).
 * The TID is `sha256(method!path!time!keyword!animation_key)` — both method
 * and path are part of the hash, so a TID computed for GET is *not* valid for
 * POST. Twikit applies this to every authenticated request (GraphQL and v1.1
 * REST alike); we follow the same rule.
 */
async function addClientTransactionId(
  headers: Record<string, string>,
  method: string,
  requestUrl: string,
): Promise<void> {
  const MAX_TX_RETRIES = 2;
  let lastTxErr: unknown = null;

  for (let attempt = 0; attempt <= MAX_TX_RETRIES; attempt++) {
    try {
      const transaction = await getClientTransaction();
      const path = new URL(requestUrl).pathname;
      headers['x-client-transaction-id'] = await transaction.generateTransactionId(method, path);
      lastTxErr = null;
      break;
    } catch (txErr) {
      lastTxErr = txErr;
      log.warn(
        { err: (txErr as Error)?.message ?? txErr, attempt },
        `x-client-transaction-id generation failed (attempt ${attempt + 1}/${MAX_TX_RETRIES + 1})`
      );
      invalidateClientTransaction();
      if (attempt < MAX_TX_RETRIES) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }

  if (lastTxErr && !headers['x-client-transaction-id']) {
    throw new TwitterGraphQLError(
      `x-client-transaction-id generation failed after ${MAX_TX_RETRIES + 1} attempts. ` +
      `The X.com homepage could not be fetched (network down or IP blocked). ` +
      `Error: ${(lastTxErr as Error)?.message ?? lastTxErr}`,
      'NETWORK_ERROR'
    );
  }
}

async function buildGraphqlHeaders(
  auth: TwitterAuthCookies,
  userAgent: string,
  requestUrl: string,
  options: { referer?: string; method?: string; requireTransactionId?: boolean; skipTransactionId?: boolean } = {}
): Promise<Record<string, string>> {
  const headers = buildCommonHeaders(auth, userAgent, options);
  if (options.skipTransactionId) return headers;
  try {
    await addClientTransactionId(headers, options.method ?? 'GET', requestUrl);
  } catch (err) {
    if (options.requireTransactionId === false) {
      log.warn(
        { err: (err as Error)?.message ?? err },
        'Continuing GraphQL request without x-client-transaction-id after optional bootstrap failure'
      );
      return headers;
    }
    throw err;
  }
  return headers;
}

function parseApiErrors(
  response: TwitterApiResponseBase
): Array<{ code: number; message: string }> {
  if (!Array.isArray(response.errors)) return [];
  return response.errors
    .filter((e): e is TwitterApiErrorEntry & { code: number } =>
      isRecord(e) && typeof e.code === 'number'
    )
    .map((e) => ({ code: e.code, message: typeof e.message === 'string' ? e.message : '' }));
}

/**
 * Maps Twitter API error codes from a structured response body.
 * Returns a TwitterGraphQLError if a known code is found, otherwise null.
 * Called BEFORE falling back to HTTP-status classification so that body errors
 * take precedence (e.g. a 400/403 body may contain DMS_CLOSED or USER_NOT_FOUND
 * rather than SESSION_EXPIRED).
 */
function classifyApiErrorsFromBody(
  apiErrors: Array<{ code: number; message: string }>,
  httpStatus: number,
  responseHeaders?: Headers
): TwitterGraphQLError | null {
  if (apiErrors.length === 0) return null;
  const first = apiErrors[0];

  if (first.code === 88 || first.code === 130) {
    const resetHeader = responseHeaders?.get('x-rate-limit-reset');
    const rateLimitResetAt = resetHeader ? parseInt(resetHeader, 10) * 1000 : undefined;
    return new TwitterGraphQLError(
      `Twitter API rate limit exceeded`,
      'X_RATE_LIMITED',
      httpStatus,
      apiErrors,
      rateLimitResetAt
    );
  }
  // Codes 37/64/326 are account-level suspension or lock states. Treat these
  // separately from expired cookies so the UI does not ask users to re-import
  // a working session.
  if (first.code === 37 || first.code === 64 || first.code === 326) {
    return new TwitterGraphQLError(
      `X account is suspended, locked, or restricted`,
      'ACCOUNT_SUSPENDED',
      httpStatus,
      apiErrors
    );
  }
  if (first.code === 32 || first.code === 135) {
    return new TwitterGraphQLError(
      `Twitter session expired or unauthorized`,
      'SESSION_EXPIRED',
      httpStatus,
      apiErrors
    );
  }
  if (
    first.code === 349 ||
    first.code === 226 ||
    first.code === 150 ||
    first.code === 93
  ) {
    return new TwitterGraphQLError(
      `User cannot receive DMs (DMs closed or restricted)`,
      'DMS_CLOSED',
      httpStatus,
      apiErrors
    );
  }
  if (first.code === 34 || first.code === 50 || first.code === 63 || first.code === 108) {
    return new TwitterGraphQLError(
      `User not found or suspended`,
      'USER_NOT_FOUND',
      httpStatus,
      apiErrors
    );
  }
  if (
    first.message.toLowerCase().includes('query') &&
    first.message.toLowerCase().includes('id')
  ) {
    return new TwitterGraphQLError(
      `GraphQL query ID is stale`,
      'QUERY_ID_STALE',
      httpStatus,
      apiErrors
    );
  }
  return null;
}

/**
 * Fallback classification based purely on HTTP status when the body has no
 * recognised Twitter error codes. Also used to detect QUERY_ID_STALE from
 * body text when the response is not valid JSON.
 *
 * @param requestUrl - The full URL that was fetched. When provided, a 404 on
 *   a Twitter GraphQL endpoint path (/i/api/graphql/) is always classified as
 *   QUERY_ID_STALE rather than NETWORK_ERROR, because a network-level 404 would
 *   manifest as a network/connection error — not a 404 with a body.
 */
function classifyHttpStatusError(status: number, rawBody: string, requestUrl?: string, responseHeaders?: Headers): TwitterGraphQLError {
  if (status === 429) {
    const resetHeader = responseHeaders?.get('x-rate-limit-reset');
    const rateLimitResetAt = resetHeader ? parseInt(resetHeader, 10) * 1000 : undefined;
    return new TwitterGraphQLError(
      `Twitter API rate limit exceeded (HTTP 429)`,
      'X_RATE_LIMITED',
      status,
      undefined,
      rateLimitResetAt
    );
  }
  if (status === 401 || status === 403) {
    // Distinguish proxy/intermediary 401/403 from real X.com session expiry.
    // Real X.com auth-failure responses always include a JSON body with
    // errors[].code 32/64/135/326 — those are handled earlier in
    // classifyApiErrorsFromBody and never reach this fallback. If we get here
    // with 401/403, the body had no recognised X API errors, which strongly
    // suggests the response originated from a proxy/CDN, not X.com. Treating
    // those as SESSION_EXPIRED was prematurely burning accounts when proxies
    // hiccup (IP blocked, upstream rate-limited, proxy auth failing).
    const trimmedBody = rawBody.trim();
    const lowerBody = trimmedBody.toLowerCase();
    const contentType = (responseHeaders?.get('content-type') || '').toLowerCase();
    const looksLikeHtml =
      trimmedBody.startsWith('<') || lowerBody.includes('<html') || contentType.includes('html');
    const looksLikeJson =
      contentType.includes('json') || trimmedBody.startsWith('{') || trimmedBody.startsWith('[');
    const isEmptyBody = trimmedBody.length === 0;
    const looksLikeProxyResponse =
      looksLikeHtml ||
      isEmptyBody ||
      !looksLikeJson ||
      lowerBody.includes('proxy') ||
      lowerBody.includes('cloudflare') ||
      lowerBody.includes('access denied');

    if (looksLikeProxyResponse) {
      const bodySummary = trimmedBody ? ` — ${trimmedBody.slice(0, 200)}` : ' (empty body)';
      log.warn(
        { status, requestUrl, bodyLength: rawBody.length, contentType },
        'HTTP 401/403 without X API error body — classifying as NETWORK_ERROR (account session likely still valid)'
      );
      return new TwitterGraphQLError(
        `Upstream returned HTTP ${status}${bodySummary} (account session likely still valid)`,
        'NETWORK_ERROR',
        status
      );
    }

    return new TwitterGraphQLError(
      `Twitter session expired or unauthorized (HTTP ${status})`,
      'SESSION_EXPIRED',
      status
    );
  }
  if (status === 400 && (rawBody.includes('query-id') || rawBody.includes('queryId'))) {
    return new TwitterGraphQLError(
      `Twitter GraphQL query ID is stale or invalid (HTTP 400)`,
      'QUERY_ID_STALE',
      status
    );
  }
  if (status === 404) {
    // A real X.com stale-query-ID 404 has a JSON body with errors[].code=215 and
    // message="Unknown query id." — that is caught earlier in classifyApiErrorsFromBody.
    // BUT a deleted-account lookup also returns 404, with errors[].code=50
    // ("User not found"). If JSON parsing failed upstream (truncated body,
    // invalid encoding, etc.) the body classifier never ran — sniff for code 50
    // here so we don't waste a query-id-discovery cycle on a deleted user.
    if (rawBody.includes('"code":50') || rawBody.includes('"User not found"')) {
      return new TwitterGraphQLError(
        `User not found (HTTP 404)`,
        'USER_NOT_FOUND',
        status
      );
    }
    // Otherwise — an unrecognised 404 body (proxy/CDN HTML page) on a
    // Twitter GraphQL endpoint most likely means a stale query ID.
    const bodyLower = rawBody.toLowerCase();
    const isGraphqlEndpoint =
      requestUrl !== undefined && requestUrl.includes('/i/api/graphql/');

    if (
      isGraphqlEndpoint ||
      bodyLower.includes('unknown query') ||
      bodyLower.includes('query-id') ||
      bodyLower.includes('queryid')
    ) {
      log.warn(
        { status, requestUrl, bodySummary: rawBody.slice(0, 1000), bodyLength: rawBody.length },
        'HTTP 404 on Twitter GraphQL endpoint — classifying as QUERY_ID_STALE (may also indicate stale x-client-transaction-id)'
      );
      return new TwitterGraphQLError(
        `Twitter GraphQL endpoint returned HTTP 404 — the query ID for this operation is likely outdated.`,
        'QUERY_ID_STALE',
        status
      );
    }
    const bodySummary = rawBody ? ` — ${rawBody.slice(0, 200)}` : '';
    return new TwitterGraphQLError(
      `Upstream returned HTTP 404 (not a stale query ID)${bodySummary}`,
      'NETWORK_ERROR',
      status
    );
  }
  const bodySummary = rawBody ? ` — ${rawBody.slice(0, 300)}` : '';
  return new TwitterGraphQLError(
    `Twitter API request failed with HTTP ${status}${bodySummary}`,
    'API_ERROR',
    status
  );
}

/**
 * Classify an error from a non-OK HTTP response. Attempts body-based error
 * parsing first; falls back to HTTP status classification.
 *
 * @param requestUrl - Passed through to classifyHttpStatusError for smarter 404 handling.
 */
function classifyNonOkResponse(
  status: number,
  rawBody: string,
  parsed: unknown,
  requestUrl?: string,
  responseHeaders?: Headers
): TwitterGraphQLError {
  if (isRecord(parsed)) {
    const base = parsed as TwitterApiResponseBase;
    const apiErrors = parseApiErrors(base);
    const bodyError = classifyApiErrorsFromBody(apiErrors, status, responseHeaders);
    if (bodyError) return bodyError;

    if (apiErrors.length > 0) {
      return new TwitterGraphQLError(
        `Twitter API error: ${apiErrors[0].message || JSON.stringify(apiErrors[0])}`,
        'API_ERROR',
        status,
        apiErrors
      );
    }
  }
  return classifyHttpStatusError(status, rawBody, requestUrl, responseHeaders);
}

export function shouldRetryFollowersRequestError(error: unknown): boolean {
  if (!(error instanceof TwitterGraphQLError)) {
    return false;
  }

  if (error.code === 'SESSION_EXPIRED' || error.code === 'X_RATE_LIMITED' || error.code === 'QUERY_ID_STALE') {
    return false;
  }

  if (error.code === 'NETWORK_ERROR') {
    return true;
  }

  return typeof error.httpStatus === 'number' && error.httpStatus >= 500 && error.httpStatus < 600;
}

export function isTransactionIdBootstrapError(error: unknown): error is TwitterGraphQLError {
  return (
    error instanceof TwitterGraphQLError &&
    error.code === 'NETWORK_ERROR' &&
    error.message.includes('x-client-transaction-id generation failed')
  );
}

// ============== Client ==============

export class TwitterGraphQLClient {
  private cachedSenderUserId: string | null = null;
  /** Optional account identifier used as the limiter bucket key. When omitted, the proactive rate limiter is a no-op (used by bootstrap / discovery paths). */
  public accountId?: string;

  constructor(
    private readonly auth: TwitterAuthCookies,
    private readonly userAgent: string = CHROME_120_USER_AGENT,
    private readonly onAuthCookiesChanged?: (auth: TwitterAuthCookies) => Promise<void> | void,
    private queryIds: {
      userByScreenName: string;
      sendDmMutation: string;
      followers: string;
      following: string;
      blueVerifiedFollowers: string;
      communityMembers: string;
      searchTimeline: string;
    } = {
      userByScreenName: xConfig.twitterUserByScreenNameQueryId,
      sendDmMutation: xConfig.twitterSendDmQueryId,
      followers: xConfig.twitterFollowersQueryId,
      following: xConfig.twitterFollowingQueryId,
      blueVerifiedFollowers: xConfig.twitterBlueVerifiedFollowersQueryId,
      communityMembers: xConfig.twitterCommunityMembersQueryId,
      searchTimeline: xConfig.twitterSearchTimelineQueryId,
    }
  ) {}

  /**
   * Wraps an operation in:
   *   1. A pre-flight `acquireLimiter` call so we pace requests instead of bursting into 429s.
   *   2. A 429 reporter that halves this bucket's capacity for 1h if X still rate-limits us.
   * Mirrors Scweet's `TokenBucketLimiter` + reactive throttle behaviour.
   */
  private async withLimiter<T>(operation: LimiterOperation, fn: () => Promise<T>): Promise<T> {
    await acquireLimiter(this.accountId, operation);
    try {
      return await fn();
    } catch (err) {
      if (err instanceof TwitterGraphQLError && err.code === 'X_RATE_LIMITED') {
        reportRateLimited(this.accountId, operation);
      }
      throw err;
    }
  }

  private async handleSetCookieRotation(headers: Headers): Promise<void> {
    const changed = applySetCookieRotation(this.auth, headers);
    if (!changed || !this.onAuthCookiesChanged) {
      return;
    }

    await this.onAuthCookiesChanged({
      authToken: this.auth.authToken,
      ct0: this.auth.ct0,
      ...(this.auth.twid ? { twid: this.auth.twid } : {}),
    });
  }

  /**
   * Runs `operation(queryId)` where queryId is the current searchTimeline query ID.
   * If the operation throws QUERY_ID_STALE, auto-discovers the new ID from X.com's
   * JS bundles, updates the in-memory queryIds, and retries the operation once.
   */
  private async withAutoRefreshRetry<T>(
    operation: (queryId: string) => Promise<T>
  ): Promise<T> {
    const initialQueryId = await this.preferDiscoveredQueryId('searchTimeline', 'SearchTimeline');
    try {
      return await operation(initialQueryId);
    } catch (err) {
      if (err instanceof TwitterGraphQLError && err.code === 'QUERY_ID_STALE') {
        log.info('[TwitterGraphQLClient] searchTimeline query ID is stale — attempting auto-discovery...');
        invalidateQueryIdCache();
        invalidateClientTransaction();
        const newId = await discoverSearchTimelineQueryId();
        if (newId && newId !== this.queryIds.searchTimeline) {
          log.info(`[TwitterGraphQLClient] searchTimeline query ID updated: ${this.queryIds.searchTimeline} → ${newId}`);
          this.queryIds = { ...this.queryIds, searchTimeline: newId };
          return await operation(newId);
        }
        log.info('[TwitterGraphQLClient] Auto-discovery returned same searchTimeline query ID — retrying once in case of transient failure');
        try {
          return await operation(this.queryIds.searchTimeline);
        } catch (retryErr) {
          log.warn('[TwitterGraphQLClient] Retry with same searchTimeline query ID also failed — rethrowing');
          throw retryErr;
        }
      }
      throw err;
    }
  }

  /**
   * Runs `operation(followersQueryId, blueVerifiedQueryId)` with the current
   * follower query IDs. If the operation throws QUERY_ID_STALE, auto-discovers
   * fresh IDs from X.com JS bundles, updates the in-memory queryIds, and
   * retries the operation once.
   *
   * @param verifiedOnly - When true, the BlueVerifiedFollowers ID is the active one.
   */
  private async withFollowersAutoRefreshRetry<T>(
    verifiedOnly: boolean,
    operation: (followersId: string, blueVerifiedId: string) => Promise<T>
  ): Promise<T> {
    const activeOp = verifiedOnly ? 'BlueVerifiedFollowers' : 'Followers';
    await this.preferDiscoveredFollowerQueryIds();
    try {
      return await operation(this.queryIds.followers, this.queryIds.blueVerifiedFollowers);
    } catch (err) {
      if (err instanceof TwitterGraphQLError && err.code === 'QUERY_ID_STALE') {
        log.info(`[TwitterGraphQLClient] ${activeOp} query ID is stale — attempting auto-discovery...`);
        invalidateFollowerQueryIdCache();
        invalidateClientTransaction();
        const discovered = await discoverFollowerQueryIds();

        const newFollowers = discovered.followers ?? this.queryIds.followers;
        const newFollowing = discovered.following ?? this.queryIds.following;
        const newBlueVerified = discovered.blueVerifiedFollowers ?? this.queryIds.blueVerifiedFollowers;

        const currentActive = verifiedOnly ? this.queryIds.blueVerifiedFollowers : this.queryIds.followers;
        const newActive = verifiedOnly ? newBlueVerified : newFollowers;

        if (newActive && newActive !== currentActive) {
          log.info(`[TwitterGraphQLClient] ${activeOp} query ID updated: ${currentActive} → ${newActive}`);
          this.queryIds = {
            ...this.queryIds,
            followers: newFollowers,
            following: newFollowing,
            blueVerifiedFollowers: newBlueVerified,
          };
          return await operation(newFollowers, newBlueVerified);
        }
        log.info(`[TwitterGraphQLClient] Auto-discovery returned same ${activeOp} query ID — retrying once in case of transient failure`);
        try {
          return await operation(this.queryIds.followers, this.queryIds.blueVerifiedFollowers);
        } catch (retryErr) {
          log.warn(`[TwitterGraphQLClient] Retry with same ${activeOp} query ID also failed — rethrowing`);
          throw retryErr;
        }
      }
      if (err instanceof TwitterGraphQLError && shouldRetryFollowersRequestError(err)) {
        const statusLabel =
          err.httpStatus !== undefined ? `HTTP ${err.httpStatus}` : `${err.code} transport failure`;
        log.warn(
          `[TwitterGraphQLClient] ${activeOp} request failed with ${statusLabel} — retrying once after short backoff`
        );
        await new Promise((resolve) => setTimeout(resolve, 750));
        try {
          return await operation(this.queryIds.followers, this.queryIds.blueVerifiedFollowers);
        } catch (retryErr) {
          log.warn(`[TwitterGraphQLClient] Retry after transient ${activeOp} failure also failed — rethrowing`);
          throw retryErr;
        }
      }
      throw err;
    }
  }

  /**
   * Generic auto-refresh retry for any single-queryId operation.
   *
   * Mirrors `withAutoRefreshRetry` (searchTimeline) but parameterized by the
   * queryIds field name + the OperationName used to re-discover the ID from
   * the X bundle. Use this for operations that were previously NOT covered by
   * auto-recovery (UserByScreenName, community members) — without it, a stale
   * query ID required a manual env-var override and a redeploy.
   */
  private async withQueryIdAutoRefresh<K extends keyof TwitterGraphQLClient['queryIds'], T>(
    opKey: K,
    opName: Parameters<typeof getQueryId>[0],
    operation: (queryId: string) => Promise<T>,
  ): Promise<T> {
    const initialQueryId = await this.preferDiscoveredQueryId(opKey, opName);
    try {
      return await operation(initialQueryId);
    } catch (err) {
      if (err instanceof TwitterGraphQLError && err.code === 'QUERY_ID_STALE') {
        log.info(`[TwitterGraphQLClient] ${opName} query ID is stale — attempting auto-discovery...`);
        invalidateQueryIdCache();
        invalidateClientTransaction();
        const newId = await getQueryId(opName);
        if (newId && newId !== this.queryIds[opKey]) {
          log.info(`[TwitterGraphQLClient] ${opName} query ID updated: ${this.queryIds[opKey]} → ${newId}`);
          this.queryIds = { ...this.queryIds, [opKey]: newId };
          return await operation(newId);
        }
        log.info(`[TwitterGraphQLClient] Auto-discovery returned same ${opName} query ID — retrying once in case of transient failure`);
        try {
          return await operation(this.queryIds[opKey]);
        } catch (retryErr) {
          log.warn(`[TwitterGraphQLClient] Retry with same ${opName} query ID also failed — rethrowing`);
          throw retryErr;
        }
      }
      throw err;
    }
  }

  private async preferDiscoveredQueryId<K extends keyof TwitterGraphQLClient['queryIds']>(
    opKey: K,
    opName: Parameters<typeof getQueryId>[0],
  ): Promise<string> {
    const discoveredId = await getQueryId(opName);
    if (discoveredId && discoveredId !== this.queryIds[opKey]) {
      log.info(
        `[TwitterGraphQLClient] ${opName} query ID preloaded from manifest: ${this.queryIds[opKey]} → ${discoveredId}`,
      );
      this.queryIds = { ...this.queryIds, [opKey]: discoveredId };
    }
    return this.queryIds[opKey];
  }

  private async preferDiscoveredFollowerQueryIds(): Promise<void> {
    const discovered = await discoverFollowerQueryIds();
    const updates: Partial<TwitterGraphQLClient['queryIds']> = {};

    if (discovered.followers && discovered.followers !== this.queryIds.followers) {
      updates.followers = discovered.followers;
    }
    if (discovered.following && discovered.following !== this.queryIds.following) {
      updates.following = discovered.following;
    }
    if (
      discovered.blueVerifiedFollowers &&
      discovered.blueVerifiedFollowers !== this.queryIds.blueVerifiedFollowers
    ) {
      updates.blueVerifiedFollowers = discovered.blueVerifiedFollowers;
    }

    if (Object.keys(updates).length === 0) {
      return;
    }

    log.info('[TwitterGraphQLClient] Follower query IDs preloaded from manifest', updates);
    this.queryIds = { ...this.queryIds, ...updates };
  }

  private buildDmInboxParams(
    count: number,
    cursor?: string,
    options: { requireMaxId?: boolean } = {}
  ): URLSearchParams {
    const params = new URLSearchParams();
    params.set('nsfw_filtering_enabled', 'false');
    params.set('filter_low_quality', 'true');
    params.set('include_quality', 'all');
    params.set('include_ext_profile_image_shape', '1');
    params.set('dm_secret_conversations_enabled', 'false');
    params.set('krs_registration_enabled', 'false');
    params.set('include_ext_limited_action_results', 'true');
    params.set('dm_users', 'true');
    params.set('include_groups', 'true');
    params.set('include_inbox_timelines', 'true');
    params.set('supports_reactions', 'true');
    params.set('supports_edit', 'true');
    params.set('include_ext_edit_control', 'true');
    params.set('include_ext_business_affiliations_label', 'true');
    params.set('include_ext_parody_commentary_fan_label', 'true');
    params.set(
      'ext',
      'mediaColor,altText,mediaStats,highlightedLabel,parodyCommentaryFanLabel,voiceInfo,birdwatchPivot,superFollowMetadata,unmentionInfo,editControl,article'
    );
    params.set('count', String(Math.min(Math.max(count, 1), 200)));
    if (cursor) {
      params.set('max_id', cursor);
    } else if (options.requireMaxId) {
      params.set('max_id', '0');
    }
    return params;
  }

  private async fetchDmInboxState(count = 100, cursor?: string): Promise<DmInboxStateRaw> {
    const params = this.buildDmInboxParams(count, cursor);
    const url = `https://x.com/i/api/1.1/dm/inbox_initial_state.json?${params.toString()}`;
    const headers = buildCommonHeaders(this.auth, this.userAgent, {
      referer: 'https://x.com/messages',
    });
    await addClientTransactionId(headers, 'GET', url);
    let responseText = '';
    let responseStatus = 0;
    let responseHeaders: Headers | undefined;
    let parsed: unknown = null;

    try {
      const response = await fetchImpersonated(url, {
        method: 'GET',
        headers,
      });

      responseStatus = response.status;
      responseHeaders = response.headers;
      await this.handleSetCookieRotation(response.headers);
      responseText = await response.text();
      parsed = tryParseJson(responseText);

      if (!response.ok) {
        throw classifyNonOkResponse(responseStatus, responseText, parsed, undefined, response.headers);
      }
    } catch (err) {
      if (err instanceof TwitterGraphQLError) throw err;
      throw new TwitterGraphQLError(
        `Network error fetching DM inbox: ${(err as Error).message}`,
        'NETWORK_ERROR'
      );
    }

    const inbox = (parsed as DmInboxResponse | null)?.inbox_initial_state;
    if (!inbox) {
      throw new TwitterGraphQLError(
        'Failed to parse DM inbox response',
        'API_ERROR',
        responseStatus
      );
    }

    return inbox;
  }

  // Fetches the message-request (untrusted) inbox timeline. This is what twikit calls
  // `dm_inbox_timeline('untrusted')`. Replies from leads who don't follow back land here
  // and never appear in `inbox_initial_state`, so we have to query it separately.
  private async fetchUntrustedInboxTimeline(
    count = 100,
    cursor?: string
  ): Promise<DmInboxStateRaw> {
    const params = this.buildDmInboxParams(count, cursor, { requireMaxId: true });
    const url = `https://x.com/i/api/1.1/dm/inbox_timeline/untrusted.json?${params.toString()}`;
    const headers = buildCommonHeaders(this.auth, this.userAgent, {
      referer: 'https://x.com/messages/requests',
    });
    await addClientTransactionId(headers, 'GET', url);
    let responseText = '';
    let responseStatus = 0;
    let parsed: unknown = null;

    try {
      const response = await fetchImpersonated(url, {
        method: 'GET',
        headers,
      });

      responseStatus = response.status;
      await this.handleSetCookieRotation(response.headers);
      responseText = await response.text();
      parsed = tryParseJson(responseText);

      if (!response.ok) {
        throw classifyNonOkResponse(responseStatus, responseText, parsed, undefined, response.headers);
      }
    } catch (err) {
      if (err instanceof TwitterGraphQLError) throw err;
      throw new TwitterGraphQLError(
        `Network error fetching untrusted DM inbox: ${(err as Error).message}`,
        'NETWORK_ERROR'
      );
    }

    // The untrusted timeline response wraps the same conversation/user/entries shape under
    // `inbox_timeline` instead of `inbox_initial_state`.
    const wrapper = parsed as
      | (TwitterApiResponseBase & { inbox_timeline?: DmInboxStateRaw })
      | null;
    const inbox = wrapper?.inbox_timeline;
    if (!inbox) {
      throw new TwitterGraphQLError(
        'Failed to parse untrusted DM inbox response',
        'API_ERROR',
        responseStatus
      );
    }

    return inbox;
  }

  private async fetchDmConversationPage(
    conversationId: string,
    cursor?: { maxId?: string; minId?: string }
  ): Promise<DmConversationTimelineRaw | null> {
    const params = new URLSearchParams();
    params.set('context', 'FETCH_DM_CONVERSATION_HISTORY');
    params.set('include_ext_profile_image_shape', '1');
    params.set('dm_secret_conversations_enabled', 'false');
    params.set('krs_registration_enabled', 'false');
    params.set('include_ext_limited_action_results', 'true');
    params.set('dm_users', 'true');
    params.set('include_groups', 'true');
    params.set('include_inbox_timelines', 'true');
    params.set('supports_reactions', 'true');
    params.set('supports_edit', 'true');
    params.set('include_conversation_info', 'true');
    params.set(
      'ext',
      'mediaColor,altText,mediaStats,highlightedLabel,parodyCommentaryFanLabel,voiceInfo,birdwatchPivot,superFollowMetadata,unmentionInfo,editControl,article'
    );

    if (cursor?.maxId) {
      params.set('max_id', cursor.maxId);
    }
    if (cursor?.minId) {
      params.set('min_id', cursor.minId);
    }

    const url = `https://x.com/i/api/1.1/dm/conversation/${conversationId}.json?${params.toString()}`;
    const headers = buildCommonHeaders(this.auth, this.userAgent, {
      referer: `https://x.com/i/chat/${conversationId}`,
    });
    await addClientTransactionId(headers, 'GET', url);
    let responseText = '';
    let responseStatus = 0;
    let responseHeaders: Headers | undefined;
    let parsed: unknown = null;

    try {
      const response = await fetchImpersonated(url, {
        method: 'GET',
        headers,
      });

      responseStatus = response.status;
      responseHeaders = response.headers;
      await this.handleSetCookieRotation(response.headers);
      responseText = await response.text();
      parsed = tryParseJson(responseText);

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw classifyNonOkResponse(responseStatus, responseText, parsed, undefined, response.headers);
      }
    } catch (err) {
      if (err instanceof TwitterGraphQLError) throw err;
      throw new TwitterGraphQLError(
        `Network error fetching DM conversation ${conversationId}: ${(err as Error).message}`,
        'NETWORK_ERROR'
      );
    }

    return (parsed as DmConversationResponse | null)?.conversation_timeline ?? null;
  }

  async getInboxConversations(args: {
    count?: number;
    cursor?: string;
    kind?: 'trusted' | 'untrusted';
  } = {}): Promise<TwitterDMInboxResult> {
    return this.withLimiter('getInboxConversations', () => this.getInboxConversationsImpl(args));
  }

  private async getInboxConversationsImpl(args: {
    count?: number;
    cursor?: string;
    kind?: 'trusted' | 'untrusted';
  } = {}): Promise<TwitterDMInboxResult> {
    const inbox =
      args.kind === 'untrusted'
        ? await this.fetchUntrustedInboxTimeline(args.count ?? 100, args.cursor)
        : await this.fetchDmInboxState(args.count ?? 100, args.cursor);
    const users = inbox.users ?? {};
    const senderUserId = this.getSenderUserId();

    const conversations = Object.values(inbox.conversations ?? {})
      .map((conversation) => {
        const participantIds = (conversation.participants ?? [])
          .map((participant) => participant.user_id ?? '')
          .filter(Boolean);
        const nonSelfParticipantIds = participantIds.filter((userId) => userId !== senderUserId);
        const participants = nonSelfParticipantIds
          .filter((userId) => userId !== senderUserId)
          .map((userId) => ({
            userId,
            screenName: users[userId]?.screen_name,
            name: users[userId]?.name,
          }));

        const conversationEntries = (inbox.entries ?? []).filter((entry) => {
          const message = extractDmMessage(entry);
          return message?.conversation_id === conversation.conversation_id;
        });
        const unreadState = deriveDmInboxConversationState({
          conversation,
          entries: conversationEntries,
          senderUserId,
        });

        return {
          conversationId: conversation.conversation_id ?? '',
          participantIds,
          participants,
          isGroupConversation: nonSelfParticipantIds.length > 1,
          unreadCount: unreadState.unreadCount,
          isUnread: unreadState.isUnread,
          lastReadEventId: unreadState.lastReadEventId,
          unreadCountTruncated: unreadState.unreadCountTruncated,
          latestInboundMessageAt: unreadState.latestInboundMessageAt,
          inboxMessages: unreadState.inboxMessages,
          messagesSinceReadEvent: unreadState.messagesSinceReadEvent,
          requiresConversationFetch: unreadState.requiresConversationFetch,
          lastMessage: unreadState.lastMessage,
        };
      })
      .filter((conversation) => conversation.conversationId.length > 0);

    return {
      conversations,
      nextCursor: inbox.cursor,
      hasNextPage: false,
    };
  }

  async getUnreadInboxConversations(args: {
    count?: number;
    cursor?: string;
    kind?: 'trusted' | 'untrusted';
    sortBy?: 'latest_inbound' | 'latest_message';
  } = {}): Promise<TwitterUnreadDMInboxResult> {
    const inbox = await this.getInboxConversations({
      count: args.count,
      cursor: args.cursor,
      kind: args.kind,
    });
    const unreadConversations = inbox.conversations
      .filter((conversation) => conversation.isUnread)
      .sort((left, right) => {
        if (args.sortBy === 'latest_message') {
          return (right.lastMessage?.createdAt ?? 0) - (left.lastMessage?.createdAt ?? 0);
        }

        return (
          (right.latestInboundMessageAt ?? right.lastMessage?.createdAt ?? 0) -
          (left.latestInboundMessageAt ?? left.lastMessage?.createdAt ?? 0)
        );
      });

    return {
      ...inbox,
      unreadConversations,
    };
  }

  async getConversationMessages(args: {
    conversationId: string;
    limit?: number;
    beforeSentAt?: number;
    minEntryId?: string;
  }): Promise<TwitterDMConversationMessagesResult | null> {
    return this.withLimiter('getConversationMessages', () => this.getConversationMessagesImpl(args));
  }

  private async getConversationMessagesImpl(args: {
    conversationId: string;
    limit?: number;
    beforeSentAt?: number;
    // When set, fetches only messages newer than this entry_id (incremental sync via X's
    // `min_id` param). Skips backfill pagination — newer messages are already on the first
    // page since X returns them in descending order.
    minEntryId?: string;
  }): Promise<TwitterDMConversationMessagesResult | null> {
    const maxMessages = Math.min(args.limit ?? 50, 50);
    const senderUserId = this.getSenderUserId();
    const collected: TwitterDMConversationMessage[] = [];
    let cursor: { maxId?: string; minId?: string } | undefined = args.minEntryId
      ? { minId: args.minEntryId }
      : undefined;
    let exhausted = false;
    const incrementalMode = Boolean(args.minEntryId);

    for (let iteration = 0; iteration < 10 && collected.length < maxMessages + 1; iteration++) {
      const page = await this.fetchDmConversationPage(args.conversationId, cursor);
      if (!page) {
        return null;
      }

      const pageMessages = parseDmConversationMessages(page.entries ?? [], senderUserId)
        .sort((left, right) => right.createdAt - left.createdAt)
        .filter((message) =>
          args.beforeSentAt === undefined ? true : message.createdAt < args.beforeSentAt
        );

      collected.push(...pageMessages);

      // Incremental mode: stop after first page. Backfilling older messages is not the goal.
      if (incrementalMode) {
        exhausted = true;
        break;
      }

      exhausted = page.status === 'AT_END' || !page.min_entry_id;
      if (exhausted) {
        break;
      }

      cursor = { maxId: page.min_entry_id };
    }

    const pageMessages = collected
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, maxMessages);

    return {
      conversationId: args.conversationId,
      messages: pageMessages.reverse(),
      nextCursor:
        pageMessages.length === maxMessages
          ? pageMessages[pageMessages.length - 1]?.createdAt ?? null
          : null,
      hasMore: collected.length > maxMessages || !exhausted,
    };
  }

  async getConversationMessagesByScreenName(args: {
    screenName: string;
    limit?: number;
    beforeSentAt?: number;
    minEntryId?: string;
  }): Promise<{
    user: TwitterUserLookupResult;
    conversationId: string | null;
    messages: TwitterDMConversationMessage[];
    nextCursor: number | null;
    hasMore: boolean;
  }> {
    const user = await this.lookupUserByScreenName(args.screenName);
    const senderUserId = this.getSenderUserId();
    const candidateIds = Array.from(
      new Set([
        buildDmConversationId(senderUserId, user.userId),
        `${senderUserId}:${user.userId}`,
        `${user.userId}:${senderUserId}`,
      ])
    );

    for (const conversationId of candidateIds) {
      const result = await this.getConversationMessages({
        conversationId,
        limit: args.limit,
        beforeSentAt: args.beforeSentAt,
        minEntryId: args.minEntryId,
      });
      if (result) {
        return {
          user,
          conversationId: result.conversationId,
          messages: result.messages,
          nextCursor: result.nextCursor,
          hasMore: result.hasMore,
        };
      }
    }

    const inboxes = [await this.getInboxConversations({ count: 200 })];
    try {
      inboxes.push(await this.getInboxConversations({ count: 200, kind: 'untrusted' }));
    } catch (err) {
      // Message-request/untrusted inbox access is best-effort here. Some accounts may not
      // have this timeline available, but trusted inbox lookup above remains valid.
      log.warn(
        `[TwitterGraphQLClient] Failed to search untrusted DM inbox for @${args.screenName}:`,
        err instanceof Error ? err.message : String(err)
      );
    }

    const conversation = inboxes
      .flatMap((inbox) => inbox.conversations)
      .find((entry) => isOneToOneInboxConversation(entry, senderUserId, user.userId));

    if (!conversation) {
      return {
        user,
        conversationId: null,
        messages: [],
        nextCursor: null,
        hasMore: false,
      };
    }

    const result = await this.getConversationMessages({
      conversationId: conversation.conversationId,
      limit: args.limit,
      beforeSentAt: args.beforeSentAt,
      minEntryId: args.minEntryId,
    });

    return {
      user,
      conversationId: conversation.conversationId,
      messages: result?.messages ?? [],
      nextCursor: result?.nextCursor ?? null,
      hasMore: result?.hasMore ?? false,
    };
  }

  /**
   * Returns the Twitter user ID of the authenticated account.
   *
   * Reads directly from the `twid` cookie (`u%3D<userId>`) — no API call needed.
   * Falls back to `cachedSenderUserId` if the cookie is absent.
   */
  getSenderUserId(): string {
    if (this.cachedSenderUserId) return this.cachedSenderUserId;

    if (this.auth.twid) {
      // twid cookie format: "u%3D1234567890" (URL-encoded "u=<id>")
      const decoded = decodeURIComponent(this.auth.twid);
      const match = decoded.match(/^u=(\d+)$/);
      if (match) {
        this.cachedSenderUserId = match[1];
        return this.cachedSenderUserId;
      }
    }

    throw new TwitterGraphQLError(
      'Cannot determine sender user ID: twid cookie is missing or malformed. ' +
        'Ensure the session includes the twid cookie.',
      'API_ERROR'
    );
  }

  async lookupUserByScreenName(screenName: string): Promise<TwitterUserLookupResult> {
    return this.withLimiter('lookupUserByScreenName', () => this.lookupUserByScreenNameImpl(screenName));
  }

  private async lookupUserByScreenNameImpl(screenName: string): Promise<TwitterUserLookupResult> {
    return this.withQueryIdAutoRefresh('userByScreenName', 'UserByScreenName', (queryId) =>
      this.lookupUserByScreenNameWithQueryId(screenName, queryId),
    );
  }

  private async lookupUserByScreenNameWithQueryId(
    screenName: string,
    queryId: string,
  ): Promise<TwitterUserLookupResult> {
    const variables = JSON.stringify(buildUserByScreenNameVariables(screenName));

    const url = new URL(
      `https://x.com/i/api/graphql/${queryId}/UserByScreenName`
    );
    url.searchParams.set('variables', variables);
    url.searchParams.set('features', USER_BY_SCREEN_NAME_FEATURES);
    url.searchParams.set('fieldToggles', USER_BY_SCREEN_NAME_FIELD_TOGGLES);

    const headers = await buildGraphqlHeaders(this.auth, this.userAgent, url.toString(), {
      referer: `https://x.com/${screenName.replace(/^@/, '')}`,
    });
    let responseText = '';
    let responseStatus = 0;
    let responseHeaders: Headers | undefined;
    let parsed: unknown = null;

    try {
      const response = await fetchImpersonated(url.toString(), {
        method: 'GET',
        headers,
      });

      responseStatus = response.status;
      responseHeaders = response.headers;
      await this.handleSetCookieRotation(response.headers);
      responseText = await response.text();
      parsed = tryParseJson(responseText);

      if (!response.ok) {
        throw classifyNonOkResponse(responseStatus, responseText, parsed, url.toString(), response.headers);
      }
    } catch (err) {
      if (err instanceof TwitterGraphQLError) throw err;
      throw new TwitterGraphQLError(
        `Network error looking up user @${screenName}: ${(err as Error).message}`,
        'NETWORK_ERROR'
      );
    }

    if (!isUserByScreenNameResponse(parsed)) {
      throw new TwitterGraphQLError(
        `Failed to parse UserByScreenName response for @${screenName}`,
        'API_ERROR',
        responseStatus
      );
    }

    const apiErrors = parseApiErrors(parsed);
    const userResult = parsed.data?.user?.result;

    if (!userResult) {
      const bodyError = classifyApiErrorsFromBody(apiErrors, responseStatus, responseHeaders);
      if (bodyError) throw bodyError;

      if (apiErrors.length > 0) {
        throw new TwitterGraphQLError(
          `User @${screenName} not found or unavailable: ${apiErrors[0].message}`,
          'USER_NOT_FOUND',
          responseStatus,
          apiErrors
        );
      }
      throw new TwitterGraphQLError(
        `User @${screenName} not found or unavailable`,
        'USER_NOT_FOUND',
        responseStatus
      );
    }

    if (userResult.__typename === 'UserUnavailable') {
      throw new TwitterGraphQLError(
        `User @${screenName} is unavailable`,
        'USER_NOT_FOUND',
        responseStatus
      );
    }

    // Try numeric rest_id first, then id_str, then decode the base64 GraphQL global ID
    // ("VXNlcjoxMDAwMDAwMDAwMDAwMDAwMDAx" → "User:1000000000000000001").
    let userId =
      userResult.rest_id ??
      userResult.id_str ??
      '';

    if (!userId && userResult.id) {
      const decoded = Buffer.from(userResult.id, 'base64').toString('utf8');
      // Format is "User:123456789"
      const match = decoded.match(/^User:(\d+)$/);
      if (match) userId = match[1];
    }

    if (!userId) {
      throw new TwitterGraphQLError(
        `Could not extract user ID for @${screenName}`,
        'API_ERROR',
        responseStatus
      );
    }

    // dm_permissions.can_dm is the current field; legacy.can_dm is a fallback for older shapes.
    const dmPermsFlag = userResult.dm_permissions?.can_dm;
    const legacyFlag = userResult.legacy?.can_dm;
    const canDm =
      dmPermsFlag !== undefined ? dmPermsFlag : legacyFlag;

    return {
      userId,
      screenName: userResult.legacy?.screen_name ?? screenName,
      canDm,
      displayName: userResult.core?.name?.trim() || userResult.legacy?.screen_name || screenName,
      profileImageUrl: userResult.avatar?.image_url,
      bio: userResult.profile_bio?.description ?? userResult.legacy?.description,
      location: userResult.location?.location || undefined,
      followerCount: userResult.relationship_counts?.followers ?? userResult.legacy?.followers_count,
      followingCount: userResult.relationship_counts?.following ?? userResult.legacy?.friends_count,
      isVerified:
        userResult.is_blue_verified === true ||
        userResult.verification?.verified === true,
      createdAt: userResult.core?.created_at ?? userResult.legacy?.created_at,
    };
  }

  async getFollowers(args: {
    username: string;
    cursor?: string;
    count?: number;
    verifiedOnly?: boolean;
  }): Promise<TwitterFollowersResult> {
    return this.withLimiter('getFollowers', () => this.getFollowersImpl(args));
  }

  private async getFollowersImpl(args: {
    username: string;
    cursor?: string;
    count?: number;
    verifiedOnly?: boolean;
  }): Promise<TwitterFollowersResult> {
    const screenName = args.username.replace(/^@/, '').trim();

    return this.withFollowersAutoRefreshRetry(
      args.verifiedOnly ?? false,
      async (followersId, blueVerifiedId) => {
        let lookup: TwitterUserLookupResult;
        try {
          lookup = await this.lookupUserByScreenName(screenName);
        } catch (err) {
          if (err instanceof TwitterGraphQLError) {
            throw new TwitterGraphQLError(
              `User lookup for @${screenName} failed before fetching followers: ${err.message}`,
              err.code,
              err.httpStatus,
              err.apiErrors
            );
          }
          throw err;
        }

        const endpointName = args.verifiedOnly ? 'BlueVerifiedFollowers' : 'Followers';
        const queryId = args.verifiedOnly ? blueVerifiedId : followersId;
        const variables = buildFollowersVariables({
          userId: lookup.userId,
          count: args.count,
          cursor: args.cursor,
        });

        const url = new URL(`https://x.com/i/api/graphql/${queryId}/${endpointName}`);
        url.searchParams.set('variables', JSON.stringify(variables));
        url.searchParams.set('features', FOLLOWERS_FEATURES);
        url.searchParams.set('fieldToggles', TIMELINE_FIELD_TOGGLES);

        const refererSuffix = args.verifiedOnly ? 'verified_followers' : 'followers';
        const headers = await buildGraphqlHeaders(this.auth, this.userAgent, url.toString(), {
          referer: `https://x.com/${screenName}/${refererSuffix}`,
        });
        let responseText = '';
        let responseStatus = 0;
        let responseHeaders: Headers | undefined;
        let parsed: unknown = null;

        try {
          const response = await fetchImpersonated(url.toString(), {
            method: 'GET',
            headers,
          });

          responseStatus = response.status;
          responseHeaders = response.headers;
          await this.handleSetCookieRotation(response.headers);
          responseText = await response.text();
          parsed = tryParseJson(responseText);

          if (!response.ok) {
            throw classifyNonOkResponse(responseStatus, responseText, parsed, url.toString(), response.headers);
          }
        } catch (err) {
          if (err instanceof TwitterGraphQLError) throw err;
          throw new TwitterGraphQLError(
            `Network error fetching followers for @${screenName}: ${(err as Error).message}`,
            'NETWORK_ERROR'
          );
        }

        const apiErrors = parseApiErrors(parsed as TwitterApiResponseBase);
        const bodyError = classifyApiErrorsFromBody(apiErrors, responseStatus, responseHeaders);
        if (bodyError) {
          throw bodyError;
        }

        if (apiErrors.length > 0) {
          throw new TwitterGraphQLError(
            `Followers request failed: ${apiErrors[0].message || JSON.stringify(apiErrors[0])}`,
            'API_ERROR',
            responseStatus,
            apiErrors
          );
        }

        return parseFollowersTimelineResponse(parsed, {
          forceVerified: args.verifiedOnly,
        });
      }
    );
  }

  /**
   * Fetches the list of accounts a given user is following.
   *
   * Mirrors `getFollowers` exactly except the operationName + referer change.
   * The Following endpoint uses its own GraphQL query ID, discovered from the
   * web bundle alongside Followers/BlueVerifiedFollowers — see manifest-discovery.
   */
  async getFollowing(args: {
    username: string;
    cursor?: string;
    count?: number;
  }): Promise<TwitterFollowersResult> {
    return this.withLimiter('getFollowing', () => this.getFollowingImpl(args));
  }

  private async getFollowingImpl(args: {
    username: string;
    cursor?: string;
    count?: number;
  }): Promise<TwitterFollowersResult> {
    const screenName = args.username.replace(/^@/, '').trim();

    // Resolve numeric user ID first (same dependency as getFollowers).
    let lookup: TwitterUserLookupResult;
    try {
      lookup = await this.lookupUserByScreenName(screenName);
    } catch (err) {
      if (err instanceof TwitterGraphQLError) {
        throw new TwitterGraphQLError(
          `User lookup for @${screenName} failed before fetching following: ${err.message}`,
          err.code,
          err.httpStatus,
          err.apiErrors
        );
      }
      throw err;
    }

    return this.withQueryIdAutoRefresh('following', 'Following', async (followingQueryId) => {
      const variables = buildFollowersVariables({
        userId: lookup.userId,
        count: args.count,
        cursor: args.cursor,
      });

      const url = new URL(`https://x.com/i/api/graphql/${followingQueryId}/Following`);
      url.searchParams.set('variables', JSON.stringify(variables));
      url.searchParams.set('features', FOLLOWERS_FEATURES);
      url.searchParams.set('fieldToggles', TIMELINE_FIELD_TOGGLES);

      const headers = await buildGraphqlHeaders(this.auth, this.userAgent, url.toString(), {
        referer: `https://x.com/${screenName}/following`,
      });

      let responseText = '';
      let responseStatus = 0;
      let responseHeaders: Headers | undefined;
      let parsed: unknown = null;

      try {
        const response = await fetchImpersonated(url.toString(), {
          method: 'GET',
          headers,
        });

        responseStatus = response.status;
        responseHeaders = response.headers;
        await this.handleSetCookieRotation(response.headers);
        responseText = await response.text();
        parsed = tryParseJson(responseText);

        if (!response.ok) {
          throw classifyNonOkResponse(responseStatus, responseText, parsed, url.toString(), response.headers);
        }
      } catch (err) {
        if (err instanceof TwitterGraphQLError) throw err;
        throw new TwitterGraphQLError(
          `Network error fetching following for @${screenName}: ${(err as Error).message}`,
          'NETWORK_ERROR'
        );
      }

      const apiErrors = parseApiErrors(parsed as TwitterApiResponseBase);
      const bodyError = classifyApiErrorsFromBody(apiErrors, responseStatus, responseHeaders);
      if (bodyError) throw bodyError;

      if (apiErrors.length > 0) {
        throw new TwitterGraphQLError(
          `Following request failed: ${apiErrors[0].message || JSON.stringify(apiErrors[0])}`,
          'API_ERROR',
          responseStatus,
          apiErrors
        );
      }

      // Following responses use the same timeline envelope as Followers, so the
      // existing follower parser applies as-is.
      return parseFollowersTimelineResponse(parsed, { forceVerified: false });
    });
  }

  async getCommunityMembers(args: {
    communityId: string;
    count?: number;
    cursor?: string;
  }): Promise<TwitterCommunityMembersResult> {
    return this.withLimiter('getCommunityMembers', () => this.getCommunityMembersImpl(args));
  }

  private async getCommunityMembersImpl(args: {
    communityId: string;
    count?: number;
    cursor?: string;
  }): Promise<TwitterCommunityMembersResult> {
    return this.withQueryIdAutoRefresh('communityMembers', 'membersSliceTimeline_Query', (queryId) =>
      this.getCommunityMembersWithQueryId(args, queryId),
    );
  }

  private async getCommunityMembersWithQueryId(
    args: { communityId: string; count?: number; cursor?: string },
    queryId: string,
  ): Promise<TwitterCommunityMembersResult> {
    const communityId = args.communityId.trim();
    const variables = buildCommunityMembersVariables({
      communityId,
      count: args.count,
      cursor: args.cursor,
    });

    const url = new URL(
      `https://x.com/i/api/graphql/${queryId}/membersSliceTimeline_Query`
    );
    url.searchParams.set('variables', JSON.stringify(variables));
    url.searchParams.set('features', FOLLOWERS_FEATURES);
    url.searchParams.set('fieldToggles', TIMELINE_FIELD_TOGGLES);
    const referer = `https://x.com/i/communities/${communityId}/members`;
    let headers: Record<string, string>;
    try {
      headers = await buildGraphqlHeaders(this.auth, this.userAgent, url.toString(), {
        referer,
      });
    } catch (error) {
      if (!isTransactionIdBootstrapError(error)) {
        throw error;
      }
      log.warn(
        { communityId, err: error.message },
        'Retrying community members GraphQL request without x-client-transaction-id after bootstrap failure'
      );
      headers = buildCommonHeaders(this.auth, this.userAgent, { referer });
    }
    let responseText = '';
    let responseStatus = 0;
    let responseHeaders: Headers | undefined;
    let parsed: unknown = null;

    try {
      const response = await fetchImpersonated(url.toString(), {
        method: 'GET',
        headers,
      });

      responseStatus = response.status;
      responseHeaders = response.headers;
      await this.handleSetCookieRotation(response.headers);
      responseText = await response.text();
      parsed = tryParseJson(responseText);

      if (!response.ok) {
        throw classifyNonOkResponse(responseStatus, responseText, parsed, url.toString(), response.headers);
      }
    } catch (err) {
      if (err instanceof TwitterGraphQLError) throw err;
      throw new TwitterGraphQLError(
        `Network error fetching community members for ${communityId}: ${(err as Error).message}`,
        'NETWORK_ERROR'
      );
    }

    const apiErrors = parseApiErrors(parsed as TwitterApiResponseBase);
    const bodyError = classifyApiErrorsFromBody(apiErrors, responseStatus, responseHeaders);
    if (bodyError) {
      throw bodyError;
    }

    if (apiErrors.length > 0) {
      throw new TwitterGraphQLError(
        `Community members request failed: ${apiErrors[0].message || JSON.stringify(apiErrors[0])}`,
        'API_ERROR',
        responseStatus,
        apiErrors
      );
    }

    const result = parseCommunityMembersTimelineResponse(parsed);

    // Community member slices ship lean user objects — most members come back
    // without follower/following counts. We backfill counts via a per-member
    // lookupUserByScreenName, but CAP how many we enrich per page. A single page
    // can now hold up to ~100 members, and enriching every one fired ~100 lookups
    // per page; across a multi-page scrape that drains the per-account lookup
    // budget (the bucket is 60/min) and trips X's account-level rate window,
    // which used to stall community scrapes and then abort them mid-run — the
    // community-specific "stops partway" bug. Followers never hit this because
    // they arrive with counts already. Capping keeps enrichment best-effort and
    // bounded so the run keeps flowing; uncapped members simply keep their
    // slice-provided values, and bio/location enrichment for members we actually
    // save still happens downstream via the bounded /api/twitter/users path.
    const MAX_ENRICH_PER_PAGE = 20;
    const usersNeedingEnrichment = result.users
      .filter((user) => user.followerCount === undefined || user.followingCount === undefined)
      .slice(0, MAX_ENRICH_PER_PAGE);

    if (usersNeedingEnrichment.length === 0) {
      return result;
    }

    const enrichments = await Promise.allSettled(
      usersNeedingEnrichment.map(async (user) => ({
        username: user.username,
        lookup: await this.lookupUserByScreenName(user.username),
      }))
    );

    const lookupByUsername = new Map<string, TwitterUserLookupResult>();
    for (const enrichment of enrichments) {
      if (enrichment.status === 'fulfilled') {
        lookupByUsername.set(enrichment.value.username, enrichment.value.lookup);
      }
    }

    return {
      ...result,
      users: result.users.map((user) => {
        const lookup = lookupByUsername.get(user.username);
        return lookup ? mergeLeadProfile(user, lookup) : user;
      }),
    };
  }

  async searchUsers(args: {
    query: string;
    cursor?: string;
    count?: number;
  }): Promise<TwitterFollowersResult> {
    return this.withLimiter('searchUsers', () => this.searchUsersImpl(args));
  }

  private async searchUsersImpl(args: {
    query: string;
    cursor?: string;
    count?: number;
  }): Promise<TwitterFollowersResult> {
    return this.withAutoRefreshRetry(async (queryId) => {
      const variables: Record<string, unknown> = {
        rawQuery: args.query,
        count: args.count ?? 100,
        querySource: 'typed_query',
        product: 'People',
      };

      if (args.cursor) {
        variables.cursor = args.cursor;
      }

      const url = new URL(`https://x.com/i/api/graphql/${queryId}/SearchTimeline`);
      url.searchParams.set('variables', JSON.stringify(variables));
      url.searchParams.set('features', SEARCH_TIMELINE_FEATURES);
      url.searchParams.set('fieldToggles', TIMELINE_FIELD_TOGGLES);

      const headers = await buildGraphqlHeaders(this.auth, this.userAgent, url.toString(), {
        referer: `https://x.com/search?q=${encodeURIComponent(args.query)}&src=typed_query&f=user`,
      });
      let responseText = '';
      let responseStatus = 0;
      let responseHeaders: Headers | undefined;
      let parsed: unknown = null;

      try {
        const response = await fetchImpersonated(url.toString(), {
          method: 'GET',
          headers,
        });

        responseStatus = response.status;
        responseHeaders = response.headers;
        await this.handleSetCookieRotation(response.headers);
        responseText = await response.text();
        parsed = tryParseJson(responseText);

        if (!response.ok) {
          throw classifyNonOkResponse(responseStatus, responseText, parsed, url.toString(), response.headers);
        }
      } catch (err) {
        if (err instanceof TwitterGraphQLError) throw err;
        throw new TwitterGraphQLError(
          `Network error during user search for "${args.query}": ${(err as Error).message}`,
          'NETWORK_ERROR'
        );
      }

      const apiErrors = parseApiErrors(parsed as TwitterApiResponseBase);
      const bodyError = classifyApiErrorsFromBody(apiErrors, responseStatus, responseHeaders);
      if (bodyError) throw bodyError;

      if (apiErrors.length > 0) {
        throw new TwitterGraphQLError(
          `User search failed: ${apiErrors[0].message || JSON.stringify(apiErrors[0])}`,
          'API_ERROR',
          responseStatus,
          apiErrors
        );
      }

      return parseSearchUsersResponse(parsed);
    });
  }

  async searchRepliers(args: {
    tweetId: string;
    cursor?: string;
    count?: number;
  }): Promise<TwitterFollowersResult> {
    return this.withLimiter('searchRepliers', () => this.searchRepliersImpl(args));
  }

  private async searchRepliersImpl(args: {
    tweetId: string;
    cursor?: string;
    count?: number;
  }): Promise<TwitterFollowersResult> {
    return this.withAutoRefreshRetry(async (queryId) => {
      const rawQuery = `conversation_id:${args.tweetId}`;

      const variables: Record<string, unknown> = {
        rawQuery,
        count: args.count ?? 100,
        querySource: 'tweet_detail',
        product: 'Latest',
      };

      if (args.cursor) {
        variables.cursor = args.cursor;
      }

      const url = new URL(`https://x.com/i/api/graphql/${queryId}/SearchTimeline`);
      url.searchParams.set('variables', JSON.stringify(variables));
      url.searchParams.set('features', SEARCH_TIMELINE_FEATURES);
      url.searchParams.set('fieldToggles', TIMELINE_FIELD_TOGGLES);

      const headers = await buildGraphqlHeaders(this.auth, this.userAgent, url.toString(), {
        referer: `https://x.com/i/status/${args.tweetId}`,
      });
      let responseText = '';
      let responseStatus = 0;
      let responseHeaders: Headers | undefined;
      let parsed: unknown = null;

      try {
        const response = await fetchImpersonated(url.toString(), {
          method: 'GET',
          headers,
        });

        responseStatus = response.status;
        responseHeaders = response.headers;
        await this.handleSetCookieRotation(response.headers);
        responseText = await response.text();
        parsed = tryParseJson(responseText);

        if (!response.ok) {
          throw classifyNonOkResponse(responseStatus, responseText, parsed, url.toString(), response.headers);
        }
      } catch (err) {
        if (err instanceof TwitterGraphQLError) throw err;
        throw new TwitterGraphQLError(
          `Network error fetching repliers for tweet ${args.tweetId}: ${(err as Error).message}`,
          'NETWORK_ERROR'
        );
      }

      const apiErrors = parseApiErrors(parsed as TwitterApiResponseBase);
      const bodyError = classifyApiErrorsFromBody(apiErrors, responseStatus, responseHeaders);
      if (bodyError) throw bodyError;

      if (apiErrors.length > 0) {
        throw new TwitterGraphQLError(
          `Repliers search failed: ${apiErrors[0].message || JSON.stringify(apiErrors[0])}`,
          'API_ERROR',
          responseStatus,
          apiErrors
        );
      }

      return parseSearchRepliersResponse(parsed);
    });
  }

  /**
   * Sends a DM via Twitter's internal REST endpoint `POST /1.1/dm/new2.json`.
   *
   * Mirrors twikit's payload shape (V11Client.dm_new): we address the conversation
   * by `conversation_id = "{recipientId}-{senderId}"` rather than `recipient_ids`,
   * and include the same companion fields the X web client sends (`cards_platform`,
   * `dm_users`, `include_cards`, `include_quote_count`, `recipient_ids: false`).
   * This shape returns the full inbox-style response (`entries`/`users`/`conversations`),
   * from which we pull the first `message_data` entry — same as twikit.
   */
  async sendDM(args: {
    recipientId: string;
    text: string;
    mediaId?: string;
    replyToDmId?: string;
  }): Promise<TwitterDMSendResult> {
    return this.withLimiter('sendDM', () => this.sendDMImpl(args));
  }

  private async sendDMImpl(args: {
    recipientId: string;
    text: string;
    mediaId?: string;
    replyToDmId?: string;
  }): Promise<TwitterDMSendResult> {
    const senderId = this.getSenderUserId();
    const conversationId = `${args.recipientId}-${senderId}`;

    const url = 'https://x.com/i/api/1.1/dm/new2.json';

    const payload: Record<string, unknown> = {
      cards_platform: 'Web-12',
      conversation_id: conversationId,
      dm_users: false,
      include_cards: 1,
      include_quote_count: true,
      recipient_ids: false,
      text: args.text,
    };
    if (args.mediaId) payload.media_id = args.mediaId;
    if (args.replyToDmId) payload.reply_to_dm_id = args.replyToDmId;

    const headers = buildCommonHeaders(this.auth, this.userAgent);
    await addClientTransactionId(headers, 'POST', url);
    let responseText = '';
    let responseStatus = 0;
    let responseHeaders: Headers | undefined;
    let parsed: unknown = null;

    try {
      const response = await fetchImpersonated(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      responseStatus = response.status;
      responseHeaders = response.headers;
      await this.handleSetCookieRotation(response.headers);
      responseText = await response.text();
      parsed = tryParseJson(responseText);

      if (!response.ok) {
        throw classifyNonOkResponse(responseStatus, responseText, parsed, undefined, response.headers);
      }
    } catch (err) {
      if (err instanceof TwitterGraphQLError) throw err;
      throw new TwitterGraphQLError(
        `Network error sending DM: ${(err as Error).message}`,
        'NETWORK_ERROR'
      );
    }

    // Check for API-level errors embedded in a 200 response.
    const apiErrors = parseApiErrors(parsed as TwitterApiResponseBase);
    if (apiErrors.length > 0) {
      const bodyError = classifyApiErrorsFromBody(apiErrors, responseStatus, responseHeaders);
      if (bodyError) throw bodyError;

      throw new TwitterGraphQLError(
        `DM send failed: ${apiErrors[0].message || JSON.stringify(apiErrors[0])}`,
        'API_ERROR',
        responseStatus,
        apiErrors
      );
    }

    // Response shape (inbox-style, returned when posting with `conversation_id`):
    //   { entries: [{ message: { message_data: { id, conversation_id, sender_id,
    //       recipient_id, text, ... } } }, ...], users: {...}, conversations: {...} }
    // Mirrors twikit: walk the parsed body for the first `message_data`.
    const messageData = findFirstByKey(parsed, 'message_data') as
      | Record<string, unknown>
      | undefined;

    const resultMessageId = (messageData?.['id'] as string | undefined) ?? '';
    const resultConversationId =
      (messageData?.['conversation_id'] as string | undefined) ?? conversationId;

    return { conversationId: resultConversationId, messageId: resultMessageId };
  }

  /**
   * Follows a user via X's internal v1.1 endpoint:
   * `POST /i/api/1.1/friendships/create.json`.
   *
   * d60/twikit currently implements `follow_user` through this v1.1 REST
   * endpoint rather than a GraphQL mutation. The form payload below mirrors
   * twikit's `V11Client.create_friendships` flags so X returns a full user
   * object with `following` / `follow_request_sent` state.
   */
  async followUser(args: { userId: string }): Promise<TwitterFollowUserResult> {
    return this.withLimiter('followUser', () => this.followUserImpl(args));
  }

  private async followUserImpl(args: { userId: string }): Promise<TwitterFollowUserResult> {
    const userId = args.userId.trim();
    if (!userId) {
      throw new TwitterGraphQLError('Cannot follow user: userId is required', 'API_ERROR');
    }

    const url = 'https://x.com/i/api/1.1/friendships/create.json';
    const form = new URLSearchParams({
      include_profile_interstitial_type: '1',
      include_blocking: '1',
      include_blocked_by: '1',
      include_followed_by: '1',
      include_want_retweets: '1',
      include_mute_edge: '1',
      include_can_dm: '1',
      include_can_media_tag: '1',
      include_ext_is_blue_verified: '1',
      include_ext_verified_type: '1',
      include_ext_profile_image_shape: '1',
      skip_status: '1',
      user_id: userId,
    });

    const headers = buildCommonHeaders(this.auth, this.userAgent, {
      referer: `https://x.com/i/user/${userId}`,
    });
    headers['content-type'] = 'application/x-www-form-urlencoded';
    await addClientTransactionId(headers, 'POST', url);

    let responseText = '';
    let responseStatus = 0;
    let responseHeaders: Headers | undefined;
    let parsed: unknown = null;

    try {
      const response = await fetchImpersonated(url, {
        method: 'POST',
        headers,
        body: form.toString(),
      });

      responseStatus = response.status;
      responseHeaders = response.headers;
      await this.handleSetCookieRotation(response.headers);
      responseText = await response.text();
      parsed = tryParseJson(responseText);

      if (!response.ok) {
        throw classifyNonOkResponse(responseStatus, responseText, parsed, undefined, response.headers);
      }
    } catch (err) {
      if (err instanceof TwitterGraphQLError) throw err;
      throw new TwitterGraphQLError(
        `Network error following user ${userId}: ${(err as Error).message}`,
        'NETWORK_ERROR'
      );
    }

    if (!isRecord(parsed)) {
      throw new TwitterGraphQLError(
        `Failed to parse follow response for user ${userId}`,
        'API_ERROR',
        responseStatus
      );
    }

    const apiErrors = parseApiErrors(parsed as TwitterApiResponseBase);
    if (apiErrors.length > 0) {
      const bodyError = classifyApiErrorsFromBody(apiErrors, responseStatus, responseHeaders);
      if (bodyError) throw bodyError;

      throw new TwitterGraphQLError(
        `Follow failed: ${apiErrors[0].message || JSON.stringify(apiErrors[0])}`,
        'API_ERROR',
        responseStatus,
        apiErrors
      );
    }

    return {
      userId: stringValue(parsed.id_str) ?? stringValue(parsed.id) ?? userId,
      screenName: stringValue(parsed.screen_name),
      following: booleanValue(parsed.following),
      followRequestSent: booleanValue(parsed.follow_request_sent),
      followedBy: booleanValue(parsed.followed_by),
    };
  }

  /**
   * Fires a lightweight read-only request to the DM inbox updates endpoint.
   * X's own web client hits this endpoint continuously while the messages tab
   * is open, so the request pattern is completely normal and expected.
   *
   * Used in two scenarios:
   *   1. Session warmup — called once before the first DM of a session to make
   *      the session open look like a real user landing on the messages tab.
   *   2. Noise injection — called occasionally between DMs to break the rigid
   *      UserByScreenName → SendMessage sequence that is otherwise detectable
   *      via statistical analysis of request patterns.
   *
   * Errors are silently swallowed — this call is best-effort and must never
   * interrupt the main DM workflow.
   */
  async fetchInboxUpdates(): Promise<void> {
    const url = 'https://x.com/i/api/1.1/dm/inbox_initial_state.json' +
      '?filter_low_quality=true&include_quality=all&include_blocked_by=true' +
      '&include_followed_by=true&skip_status=true&dm_secret_conversations_enabled=false' +
      '&krs_registration_enabled=true&cards_platform=Web-12&include_cards=1' +
      '&include_ext_alt_text=true&include_reply_count=1&tweet_mode=extended' +
      '&include_groups=true&include_inbox_timelines=true&include_ext_media_color=true' +
      '&supports_reactions=true&count=20';

    const headers = buildCommonHeaders(this.auth, this.userAgent, {
      referer: 'https://x.com/messages',
    });

    try {
      const response = await fetchImpersonated(url, {
        method: 'GET',
        headers,
      });
      await this.handleSetCookieRotation(response.headers);
    } catch {
      // Best-effort only — never let a noise request affect the main flow
    }
  }

  /**
   * Performs a short session warmup before the first DM of a new session.
   * Fires a passive inbox read and waits a short Gaussian-distributed delay
   * to simulate a real user navigating to the messages tab before composing.
   *
   * Only called for fresh workflow runs, not for mid-workflow resumes.
   */
  async performSessionWarmup(): Promise<void> {
    await this.fetchInboxUpdates();
    // Short human-like pause after "opening" the messages tab (1.5 – 4 seconds)
    const pauseMs = gaussianDelayMs(1500, 4000);
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
}

/**
 * Gaussian delay helper local to the client module.
 * Produces bell-curve distributed values between min and max (inclusive).
 */
function gaussianDelayMs(min: number, max: number): number {
  const mean = (min + max) / 2;
  const std = (max - min) / 6;
  const u = 1 - Math.random();
  const v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.min(max, Math.max(min, Math.round(mean + z * std)));
}
