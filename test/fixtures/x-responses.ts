// Response bodies shaped after the types and parsers in the X client
// (src/x/client.ts, search-parser.ts). They are not recordings of live X.
export const SENDER_ID = '101';
export const PEER_ID = '900';

export const userByRestId = {
  data: {
    user: {
      result: {
        __typename: 'User',
        rest_id: SENDER_ID,
        core: { name: 'Acme Inc', screen_name: 'acme' },
        legacy: { followers_count: 1200, friends_count: 80 },
        dm_permissions: { can_dm: true },
      },
    },
  },
};

function userEntry(id: string, handle: string, canDm: boolean) {
  return {
    content: {
      itemContent: {
        user_results: {
          result: {
            __typename: 'User',
            rest_id: id,
            core: { name: handle.toUpperCase(), screen_name: handle },
            legacy: { followers_count: 50, friends_count: 10, description: `bio of ${handle}` },
            dm_permissions: { can_dm: canDm },
          },
        },
      },
    },
  };
}

export const searchTimeline = {
  data: {
    search_by_raw_query: {
      search_timeline: {
        timeline: {
          instructions: [
            {
              entries: [
                userEntry('2001', 'founder_a', true),
                userEntry('2002', 'founder_b', false),
                { content: { __typename: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'CURSOR-2' } },
              ],
            },
          ],
        },
      },
    },
  },
};

function dm(id: string, sender: string, recipient: string, text: string, time: string) {
  return {
    message: {
      id,
      conversation_id: `${PEER_ID}-${SENDER_ID}`,
      message_data: { id, time, sender_id: sender, recipient_id: recipient, text },
    },
  };
}

export const inboxInitialState = {
  inbox_initial_state: {
    cursor: 'INBOX-CURSOR',
    users: {
      [SENDER_ID]: { id_str: SENDER_ID, screen_name: 'acme', name: 'Acme Inc' },
      [PEER_ID]: { id_str: PEER_ID, screen_name: 'jane', name: 'Jane Doe' },
      '901': { id_str: '901', screen_name: 'g1', name: 'G1' },
      '902': { id_str: '902', screen_name: 'g2', name: 'G2' },
    },
    conversations: {
      [`${PEER_ID}-${SENDER_ID}`]: {
        conversation_id: `${PEER_ID}-${SENDER_ID}`,
        participants: [{ user_id: SENDER_ID, last_read_event_id: '7001' }, { user_id: PEER_ID }],
      },
      group: { conversation_id: 'group', participants: [{ user_id: SENDER_ID }, { user_id: '901' }, { user_id: '902' }] },
    },
    entries: [
      dm('7001', SENDER_ID, PEER_ID, 'Thanks for following!', '1760600000000'),
      dm('7002', PEER_ID, SENDER_ID, 'What does it cost?', '1760600060000'),
    ],
  },
};

export const untrustedTimeline = { inbox_timeline: { users: {}, conversations: {}, entries: [] } };

export const dmNew2 = {
  entries: [{ message: { message_data: { id: '7003', conversation_id: `${PEER_ID}-${SENDER_ID}`, text: 'reply' } } }],
};

export const sessionExpired = { errors: [{ code: 32, message: 'Could not authenticate you.' }] };
