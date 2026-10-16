import { describe, expect, it } from 'bun:test';
import { parseSearchUsersResponse } from '../../src/x/search-parser';

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
