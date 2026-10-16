interface TimelineCursorEntry {
  content?: {
    __typename?: string;
    cursorType?: string;
    value?: string;
  };
}

interface TimelineUserEntry {
  content?: {
    __typename?: string;
    itemContent?: {
      __typename?: string;
      user_results?: {
        result?: TimelineUserResult;
      };
    };
  };
}

interface TimelineUserResult {
  __typename?: string;
  rest_id?: string;
  is_blue_verified?: boolean;
  avatar?: {
    image_url?: string;
  };
  core?: {
    created_at?: string;
    name?: string;
    screen_name?: string;
  };
  dm_permissions?: {
    can_dm?: boolean;
  };
  legacy?: {
    created_at?: string;
    description?: string;
    followers_count?: number;
    friends_count?: number;
  };
  location?: {
    location?: string;
  };
  profile_bio?: {
    description?: string;
  };
  verification?: {
    verified?: boolean;
  };
}

interface FollowersTimelineResponse {
  data?: {
    user?: {
      result?: {
        timeline?: {
          timeline?: {
            instructions?: Array<{
              entries?: Array<TimelineUserEntry | TimelineCursorEntry>;
            }>;
          };
        };
      };
    };
  };
  errors?: Array<{ code?: number; message?: string }>;
}

export interface TwitterFollowerLead {
  xUserId: string;
  username: string;
  displayName: string;
  profileImageUrl?: string;
  bio?: string;
  location?: string;
  followerCount: number;
  followingCount: number;
  isVerified: boolean;
  canDm?: boolean;
  createdAt?: string;
}

export interface ParsedFollowersTimeline {
  users: TwitterFollowerLead[];
  nextCursor?: string;
  hasNextPage: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getInstructionEntries(response: FollowersTimelineResponse): Array<TimelineUserEntry | TimelineCursorEntry> {
  const instructions =
    response.data?.user?.result?.timeline?.timeline?.instructions ?? [];

  return instructions.flatMap((instruction) =>
    Array.isArray(instruction.entries) ? instruction.entries : []
  );
}

function normalizeTimelineUser(
  result: TimelineUserResult,
  forceVerified: boolean
): TwitterFollowerLead | null {
  const xUserId = result.rest_id?.trim();
  const username = result.core?.screen_name?.trim();

  if (!xUserId || !username) {
    return null;
  }

  return {
    xUserId,
    username,
    displayName: result.core?.name?.trim() || username,
    profileImageUrl: result.avatar?.image_url,
    bio: result.profile_bio?.description ?? result.legacy?.description,
    location: result.location?.location || undefined,
    followerCount: Number(result.legacy?.followers_count ?? 0),
    followingCount: Number(result.legacy?.friends_count ?? 0),
    isVerified:
      forceVerified ||
      result.is_blue_verified === true ||
      result.verification?.verified === true,
    canDm: result.dm_permissions?.can_dm,
    createdAt: result.core?.created_at ?? result.legacy?.created_at,
  };
}

export function parseFollowersTimelineResponse(
  payload: unknown,
  options: { forceVerified?: boolean } = {}
): ParsedFollowersTimeline {
  if (!isRecord(payload)) {
    return { users: [], hasNextPage: false };
  }

  const response = payload as FollowersTimelineResponse;
  const entries = getInstructionEntries(response);
  const users: TwitterFollowerLead[] = [];
  let nextCursor: string | undefined;

  for (const entry of entries) {
    const entryContent = entry.content;

    if (
      entryContent?.__typename === 'TimelineTimelineCursor' &&
      'cursorType' in entryContent &&
      entryContent.cursorType === 'Bottom' &&
      'value' in entryContent &&
      typeof entryContent.value === 'string' &&
      entryContent.value.trim().length > 0
    ) {
      nextCursor = entryContent.value;
      continue;
    }

    const result =
      (entry as TimelineUserEntry).content?.itemContent?.user_results?.result;

    if (!result || result.__typename !== 'User') {
      continue;
    }

    const normalized = normalizeTimelineUser(
      result,
      options.forceVerified ?? false
    );
    if (normalized) {
      users.push(normalized);
    }
  }

  return {
    users,
    nextCursor,
    hasNextPage: Boolean(nextCursor),
  };
}
