import type { TwitterFollowerLead } from './follower-parser';

interface CommunityUserResult {
  __typename?: string;
  rest_id?: string;
  is_blue_verified?: boolean;
  avatar?: {
    image_url?: string;
  };
  core?: {
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
  privacy?: {
    protected?: boolean;
  };
  profile_bio?: {
    description?: string;
  };
  verification?: {
    verified?: boolean;
  };
}

interface CommunityMembersResponse {
  data?: {
    communityResults?: {
      result?: {
        members_slice?: {
          items_results?: Array<{
            result?: CommunityUserResult;
          }>;
          slice_info?: {
            next_cursor?: string;
          };
        };
      };
    };
  };
}

export interface ParsedCommunityMembersTimeline {
  users: TwitterFollowerLead[];
  nextCursor?: string;
  hasNextPage: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeCommunityUser(result: CommunityUserResult): TwitterFollowerLead | null {
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
      result.is_blue_verified === true ||
      result.verification?.verified === true,
    canDm: result.dm_permissions?.can_dm,
    createdAt: result.legacy?.created_at,
  };
}

export function parseCommunityMembersTimelineResponse(
  payload: unknown
): ParsedCommunityMembersTimeline {
  if (!isRecord(payload)) {
    return { users: [], hasNextPage: false };
  }

  const response = payload as CommunityMembersResponse;
  const items =
    response.data?.communityResults?.result?.members_slice?.items_results ?? [];
  const nextCursor =
    response.data?.communityResults?.result?.members_slice?.slice_info?.next_cursor;

  const users = items
    .map((item) => item.result)
    .filter((result): result is CommunityUserResult => Boolean(result))
    .filter((result) => result.__typename === 'User')
    .map((result) => normalizeCommunityUser(result))
    .filter((result): result is TwitterFollowerLead => Boolean(result));

  return {
    users,
    nextCursor,
    hasNextPage: Boolean(nextCursor),
  };
}
