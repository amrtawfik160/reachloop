import type { TwitterFollowerLead, ParsedFollowersTimeline } from './follower-parser';

// ── Shared cursor shape ───────────────────────────────────────────────────────

interface TimelineCursorEntry {
  content?: {
    __typename?: string;
    cursorType?: string;
    value?: string;
  };
}

// ── User entry (People search) ────────────────────────────────────────────────

interface TimelineUserResult {
  __typename?: string;
  rest_id?: string;
  is_blue_verified?: boolean;
  avatar?: { image_url?: string };
  core?: { created_at?: string; name?: string; screen_name?: string };
  dm_permissions?: { can_dm?: boolean };
  legacy?: {
    created_at?: string;
    description?: string;
    followers_count?: number;
    friends_count?: number;
    can_dm?: boolean;
  };
  location?: { location?: string };
  profile_bio?: { description?: string };
  verification?: { verified?: boolean };
}

interface TimelineUserEntry {
  content?: {
    __typename?: string;
    itemContent?: {
      __typename?: string;
      user_results?: { result?: TimelineUserResult };
    };
  };
}

// ── Tweet entry (tweet/repliers search) ──────────────────────────────────────

interface TimelineTweetResult {
  __typename?: string;
  core?: {
    user_results?: { result?: TimelineUserResult };
  };
  tweet?: {
    core?: { user_results?: { result?: TimelineUserResult } };
  };
}

interface TimelineTweetEntry {
  content?: {
    __typename?: string;
    itemContent?: {
      __typename?: string;
      tweet_results?: { result?: TimelineTweetResult };
    };
    items?: Array<{
      item?: {
        itemContent?: {
          __typename?: string;
          tweet_results?: { result?: TimelineTweetResult };
        };
      };
    }>;
  };
}

// ── Search response wrapper ───────────────────────────────────────────────────

interface SearchTimelineResponse {
  data?: {
    search_by_raw_query?: {
      search_timeline?: {
        timeline?: {
          instructions?: Array<{
            type?: string;
            entries?: Array<TimelineUserEntry | TimelineTweetEntry | TimelineCursorEntry>;
            entry?: TimelineUserEntry | TimelineTweetEntry | TimelineCursorEntry;
          }>;
        };
      };
    };
  };
  errors?: Array<{ code?: number; message?: string }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeUser(result: TimelineUserResult): TwitterFollowerLead | null {
  const xUserId = result.rest_id?.trim();
  const username = result.core?.screen_name?.trim();

  if (!xUserId || !username) return null;

  const dmPermsFlag = result.dm_permissions?.can_dm;
  const legacyFlag = result.legacy?.can_dm;
  const canDm = dmPermsFlag !== undefined ? dmPermsFlag : legacyFlag;

  return {
    xUserId,
    username,
    displayName: result.core?.name?.trim() || username,
    profileImageUrl: result.avatar?.image_url,
    bio: result.profile_bio?.description ?? result.legacy?.description,
    location: result.location?.location || undefined,
    followerCount: Number(result.legacy?.followers_count ?? 0),
    followingCount: Number(result.legacy?.friends_count ?? 0),
    isVerified: result.is_blue_verified === true || result.verification?.verified === true,
    canDm,
    createdAt: result.core?.created_at ?? result.legacy?.created_at,
  };
}

function getAllEntries(
  response: SearchTimelineResponse
): Array<TimelineUserEntry | TimelineTweetEntry | TimelineCursorEntry> {
  const instructions =
    response.data?.search_by_raw_query?.search_timeline?.timeline?.instructions ?? [];

  const entries: Array<TimelineUserEntry | TimelineTweetEntry | TimelineCursorEntry> = [];

  for (const instruction of instructions) {
    if (Array.isArray(instruction.entries)) {
      entries.push(...instruction.entries);
    }
    if (instruction.entry) {
      entries.push(instruction.entry);
    }
  }

  return entries;
}

// ── People search parser ──────────────────────────────────────────────────────

export function parseSearchUsersResponse(payload: unknown): ParsedFollowersTimeline {
  if (!isRecord(payload)) return { users: [], hasNextPage: false };

  const response = payload as SearchTimelineResponse;
  const entries = getAllEntries(response);
  const users: TwitterFollowerLead[] = [];
  const seen = new Set<string>();
  let nextCursor: string | undefined;

  for (const entry of entries) {
    const content = (entry as TimelineCursorEntry).content;

    // Cursor entry
    if (
      content?.__typename === 'TimelineTimelineCursor' &&
      (content as { cursorType?: string }).cursorType === 'Bottom' &&
      typeof (content as { value?: string }).value === 'string' &&
      (content as { value?: string }).value!.trim().length > 0
    ) {
      nextCursor = (content as { value?: string }).value;
      continue;
    }

    // User entry (People search)
    const userResult = (entry as TimelineUserEntry).content?.itemContent?.user_results?.result;
    if (userResult && userResult.__typename === 'User') {
      const lead = normalizeUser(userResult);
      if (lead && !seen.has(lead.xUserId)) {
        seen.add(lead.xUserId);
        users.push(lead);
      }
      continue;
    }

    // Module entries (sometimes wrapped in items array)
    const items = (entry as TimelineTweetEntry).content?.items;
    if (Array.isArray(items)) {
      for (const item of items) {
        const tweetResult = item?.item?.itemContent?.tweet_results?.result;
        const authorResult =
          tweetResult?.core?.user_results?.result ??
          tweetResult?.tweet?.core?.user_results?.result;
        if (authorResult && authorResult.__typename === 'User') {
          const lead = normalizeUser(authorResult);
          if (lead && !seen.has(lead.xUserId)) {
            seen.add(lead.xUserId);
            users.push(lead);
          }
        }
      }
    }
  }

  return { users, nextCursor, hasNextPage: Boolean(nextCursor) };
}

// ── Tweet / repliers search parser ───────────────────────────────────────────

export function parseSearchRepliersResponse(payload: unknown): ParsedFollowersTimeline {
  if (!isRecord(payload)) return { users: [], hasNextPage: false };

  const response = payload as SearchTimelineResponse;
  const entries = getAllEntries(response);
  const users: TwitterFollowerLead[] = [];
  const seen = new Set<string>();
  let nextCursor: string | undefined;

  for (const entry of entries) {
    const content = (entry as TimelineCursorEntry).content;

    // Cursor entry
    if (
      content?.__typename === 'TimelineTimelineCursor' &&
      (content as { cursorType?: string }).cursorType === 'Bottom' &&
      typeof (content as { value?: string }).value === 'string' &&
      (content as { value?: string }).value!.trim().length > 0
    ) {
      nextCursor = (content as { value?: string }).value;
      continue;
    }

    // Tweet entry — extract author
    const tweetResult = (entry as TimelineTweetEntry).content?.itemContent?.tweet_results?.result;
    if (tweetResult) {
      const authorResult =
        tweetResult.core?.user_results?.result ??
        tweetResult.tweet?.core?.user_results?.result;

      if (authorResult && authorResult.__typename === 'User') {
        const lead = normalizeUser(authorResult);
        if (lead && !seen.has(lead.xUserId)) {
          seen.add(lead.xUserId);
          users.push(lead);
        }
      }
      continue;
    }

    // Module entries with items
    const items = (entry as TimelineTweetEntry).content?.items;
    if (Array.isArray(items)) {
      for (const item of items) {
        const innerTweetResult = item?.item?.itemContent?.tweet_results?.result;
        const authorResult =
          innerTweetResult?.core?.user_results?.result ??
          innerTweetResult?.tweet?.core?.user_results?.result;
        if (authorResult && authorResult.__typename === 'User') {
          const lead = normalizeUser(authorResult);
          if (lead && !seen.has(lead.xUserId)) {
            seen.add(lead.xUserId);
            users.push(lead);
          }
        }
      }
    }
  }

  return { users, nextCursor, hasNextPage: Boolean(nextCursor) };
}
