import { describe, expect, it } from 'bun:test';
import { parseFollowersTimelineResponse } from '../../src/x/follower-parser';

describe('parseFollowersTimelineResponse', () => {
  it('extracts users and the bottom cursor from a followers timeline payload', () => {
    const result = parseFollowersTimelineResponse({
      data: {
        user: {
          result: {
            timeline: {
              timeline: {
                instructions: [
                  {
                    entries: [
                      {
                        content: {
                          __typename: 'TimelineTimelineItem',
                          itemContent: {
                            __typename: 'TimelineUser',
                            user_results: {
                              result: {
                                __typename: 'User',
                                rest_id: '123',
                                avatar: {
                                  image_url: 'https://pbs.twimg.com/profile_images/example_normal.jpg',
                                },
                                core: {
                                  created_at: 'Wed Dec 02 00:01:29 +0000 2009',
                                  name: 'Designer Two',
                                  screen_name: 'designer_two',
                                },
                                dm_permissions: {
                                  can_dm: true,
                                },
                                legacy: {
                                  description: 'I design digital products for people.',
                                  followers_count: 392,
                                  friends_count: 785,
                                },
                                location: {
                                  location: 'San Francisco, CA',
                                },
                                profile_bio: {
                                  description: 'I design digital products for people.',
                                },
                                verification: {
                                  verified: false,
                                },
                              },
                            },
                          },
                        },
                      },
                      {
                        content: {
                          __typename: 'TimelineTimelineCursor',
                          cursorType: 'Bottom',
                          value: '1861532089065416182|2040404708673191914',
                        },
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    });

    expect(result.hasNextPage).toBe(true);
    expect(result.nextCursor).toBe('1861532089065416182|2040404708673191914');
    expect(result.users).toEqual([
      {
        xUserId: '123',
        username: 'designer_two',
        displayName: 'Designer Two',
        profileImageUrl: 'https://pbs.twimg.com/profile_images/example_normal.jpg',
        bio: 'I design digital products for people.',
        location: 'San Francisco, CA',
        followerCount: 392,
        followingCount: 785,
        isVerified: false,
        canDm: true,
        createdAt: 'Wed Dec 02 00:01:29 +0000 2009',
      },
    ]);
  });

  it('forces verified=true for blue verified followers payloads', () => {
    const result = parseFollowersTimelineResponse(
      {
        data: {
          user: {
            result: {
              timeline: {
                timeline: {
                  instructions: [
                    {
                      entries: [
                        {
                          content: {
                            itemContent: {
                              user_results: {
                                result: {
                                  __typename: 'User',
                                  rest_id: '456',
                                  core: {
                                    name: 'Blue User',
                                    screen_name: 'blueuser',
                                  },
                                  legacy: {
                                    followers_count: 12,
                                    friends_count: 34,
                                  },
                                },
                              },
                            },
                          },
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      },
      { forceVerified: true }
    );

    expect(result.users[0]?.isVerified).toBe(true);
    expect(result.hasNextPage).toBe(false);
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
      const result = parseFollowersTimelineResponse({ data: { user: { result: { timeline: { timeline: { instructions: [{ entries: [{ content: { itemContent: { user_results: { result: user } } } }] }] } } } } } });
      expect(result.users).toHaveLength(1);
      expect(result.users[0]).toMatchObject({ username: 'edgrows', bio: 'Founder', followerCount: fixture.followers, followingCount: fixture.following, canDm: fixture.canDm });
    });
  }
});
