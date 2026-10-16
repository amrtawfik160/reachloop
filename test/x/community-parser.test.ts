import { describe, expect, it } from 'bun:test';
import { parseCommunityMembersTimelineResponse } from '../../src/x/community-parser';

describe('parseCommunityMembersTimelineResponse', () => {
  it('extracts users and next cursor from a community members payload', () => {
    const result = parseCommunityMembersTimelineResponse({
      data: {
        communityResults: {
          result: {
            members_slice: {
              items_results: [
                {
                  result: {
                    __typename: 'User',
                    rest_id: '1000001',
                    avatar: {
                      image_url: 'https://pbs.twimg.com/profile_images/example_normal.jpg',
                    },
                    core: {
                      name: 'Founder One',
                      screen_name: 'founder_one',
                    },
                    legacy: {
                      created_at: 'Wed Aug 08 01:31:45 +0000 2007',
                      description: 'Bootstrapped founder.',
                      followers_count: 12457,
                      friends_count: 982,
                    },
                    profile_bio: {
                      description: 'Bootstrapped founder.',
                    },
                    verification: {
                      verified: false,
                    },
                    is_blue_verified: true,
                  },
                },
                {
                  result: {
                    __typename: 'TimelineUserUnavailable',
                  },
                },
              ],
              slice_info: {
                next_cursor: 'CycRAAAAAAwABAwKmwzBVQo+vQAAAABEb5BTCm07AAABfwdrA/gADJorCj69f/////////8KbTt//////////wAIP8AAAAACAAAA',
              },
            },
          },
        },
      },
    });

    expect(result).toEqual({
      users: [
        {
          xUserId: '1000001',
          username: 'founder_one',
          displayName: 'Founder One',
          profileImageUrl: 'https://pbs.twimg.com/profile_images/example_normal.jpg',
          bio: 'Bootstrapped founder.',
          location: undefined,
          followerCount: 12457,
          followingCount: 982,
          isVerified: true,
          canDm: undefined,
          createdAt: 'Wed Aug 08 01:31:45 +0000 2007',
        },
      ],
      nextCursor:
        'CycRAAAAAAwABAwKmwzBVQo+vQAAAABEb5BTCm07AAABfwdrA/gADJorCj69f/////////8KbTt//////////wAIP8AAAAACAAAA',
      hasNextPage: true,
    });
  });

  it('returns an empty page when the payload shape is missing', () => {
    expect(parseCommunityMembersTimelineResponse(null)).toEqual({
      users: [],
      hasNextPage: false,
    });
  });
});

const profileFieldCases = [
  { name: 'modern-only counts and missing DM permission', fields: { relationship_counts: { followers: 5083, following: 3196 } }, followers: 5083, following: 3196, canDm: undefined },
  { name: 'modern counts over conflicting legacy counts and current false over legacy true', fields: { relationship_counts: { followers: 5083, following: 3196 }, legacy: { followers_count: 9, friends_count: 8, can_dm: true }, dm_permissions: { can_dm: false } }, followers: 5083, following: 3196, canDm: false },
  { name: 'explicit modern zeros over nonzero legacy counts', fields: { relationship_counts: { followers: 0, following: 0 }, legacy: { followers_count: 9, friends_count: 8 } }, followers: 0, following: 0, canDm: undefined },
  { name: 'legacy fallback when modern fields are missing', fields: { relationship_counts: { followers: 5083 }, legacy: { followers_count: 9, friends_count: 0, can_dm: false } }, followers: 5083, following: 0, canDm: false },
  { name: 'missing counts and DM permission as unknown', fields: {}, followers: undefined, following: undefined, canDm: undefined },
];

describe('profile field compatibility', () => {
  for (const fixture of profileFieldCases) {
    it(fixture.name, () => {
      const user = { __typename: 'User', rest_id: '123', core: { screen_name: 'edgrows', name: 'Ed' }, profile_bio: { description: 'Founder' }, ...fixture.fields };
      const result = parseCommunityMembersTimelineResponse({ data: { communityResults: { result: { members_slice: { items_results: [{ result: user }] } } } } });
      expect(result.users).toHaveLength(1);
      expect(result.users[0]).toMatchObject({ username: 'edgrows', bio: 'Founder', followerCount: fixture.followers, followingCount: fixture.following, canDm: fixture.canDm });
    });
  }
});
