import { describe, expect, it } from 'bun:test';
import { parseSearchUsersResponse, parseSearchRepliersResponse } from '../../src/x/search-parser';

function searchPayloadForUser(result: Record<string, unknown>) {
  return {
    data: {
      search_by_raw_query: {
        search_timeline: {
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
                            rest_id: '123',
                            core: {
                              name: 'Candidate User',
                              screen_name: 'candidate',
                            },
                            legacy: {
                              followers_count: 100,
                              friends_count: 25,
                            },
                            ...result,
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
  };
}

describe('parseSearchUsersResponse', () => {
  it('preserves missing DM permission as unknown', () => {
    const result = parseSearchUsersResponse(searchPayloadForUser({}));

    expect(result.users[0]?.canDm).toBeUndefined();
  });

  it('uses current DM permission when present', () => {
    expect(
      parseSearchUsersResponse(
        searchPayloadForUser({ dm_permissions: { can_dm: true } })
      ).users[0]?.canDm
    ).toBe(true);

    expect(
      parseSearchUsersResponse(
        searchPayloadForUser({ dm_permissions: { can_dm: false } })
      ).users[0]?.canDm
    ).toBe(false);
  });

  it('falls back to legacy DM permission only when the current field is absent', () => {
    expect(
      parseSearchUsersResponse(
        searchPayloadForUser({ legacy: { can_dm: true } })
      ).users[0]?.canDm
    ).toBe(true);

    expect(
      parseSearchUsersResponse(
        searchPayloadForUser({
          dm_permissions: { can_dm: false },
          legacy: { can_dm: true },
        })
      ).users[0]?.canDm
    ).toBe(false);
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
      const result = parseSearchUsersResponse(searchPayloadForUser({ ...user, legacy: fixture.fields.legacy }));
      expect(result.users).toHaveLength(1);
      expect(result.users[0]).toMatchObject({ username: 'edgrows', bio: 'Founder', followerCount: fixture.followers, followingCount: fixture.following, canDm: fixture.canDm });
    });
  }
});

describe('replier profile field compatibility', () => {
  for (const fixture of profileFieldCases) {
    it(fixture.name, () => {
      const user = { __typename: 'User', rest_id: '123', core: { screen_name: 'edgrows' }, ...fixture.fields };
      const payload = { data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [{ entries: [{ content: { itemContent: {
        tweet_results: { result: { core: { user_results: { result: user } } } },
      } } }] }] } } } } };
      expect(parseSearchRepliersResponse(payload).users[0]).toMatchObject({ followerCount: fixture.followers, followingCount: fixture.following, canDm: fixture.canDm });
    });
  }
});
