// X's public web-client bearer token and default GraphQL query ids. The defaults
// mirror Altimis/Scweet v5's bundled manifest; query-id discovery refreshes them
// at runtime when X rotates its web bundle.
export const xConfig = {
  twitterBearerToken:
    'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
  twitterUserByScreenNameQueryId: 'IGgvgiOx4QZndDHuD3x9TQ',
  twitterUserByRestIdQueryId: 'tD8zKvQzwY3kdx5yz6YmOw',
  twitterSendDmQueryId: 'LkAIEchf8AGj-WgeLoTVcw',
  twitterFollowersQueryId: 'Enf9DNUZYiT037aersI5gg',
  twitterFollowingQueryId: 'ntIPnH1WMBKW--4Tn1q71A',
  twitterBlueVerifiedFollowersQueryId: '4zBtcnE_c0v8wn1Zx0yF5Q',
  twitterCommunityMembersQueryId: 'WSbJGJjZaVasSj9bnqSZSA',
  twitterSearchTimelineQueryId: 'rkp6b4vtR9u7v3naGoOzUQ',
} as const;
