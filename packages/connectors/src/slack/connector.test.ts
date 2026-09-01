import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../http.js';
import { SlackChatConnector, conversationTypes, mapConversation } from './connector.js';

function connector(queue: Record<string, unknown>[]) {
  const calls: { method: string; body: string }[] = [];
  let i = 0;
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ method: url.split('/').pop() ?? '', body: String(init?.body ?? '') });
    const payload = queue[Math.min(i, queue.length - 1)];
    i += 1;
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, ...payload }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return {
    calls,
    api: new SlackChatConnector({
      tokenProvider: { getAccessToken: () => Promise.resolve('xoxp') },
      baseUrl: 'https://slack.test/api',
      fetchImpl,
      sleepImpl: () => Promise.resolve(),
    }),
  };
}

describe('conversationTypes', () => {
  it('leaves DMs out unless they were asked for', () => {
    // Reaching a custodian's private messages is a materially larger intrusion
    // than reading a public channel, and must be a decision someone made.
    const scope = {
      includePublic: true,
      includePrivate: true,
      includeDms: false,
      includeGroupDms: false,
      includeArchived: false,
    };
    expect(conversationTypes(scope)).toBe('public_channel,private_channel');
    expect(conversationTypes({ ...scope, includeDms: true })).toContain('im');
  });

  it('is empty when nothing was selected, so nothing is listed', () => {
    expect(
      conversationTypes({
        includePublic: false,
        includePrivate: false,
        includeDms: false,
        includeGroupDms: false,
        includeArchived: false,
      }),
    ).toBe('');
  });
});

describe('mapConversation', () => {
  it('records whether the token can actually read the channel', () => {
    // A public channel the user is not in is listed but unreadable. Collecting
    // it and finding nothing would look like an empty channel.
    const out = mapConversation({ id: 'C1', name: 'general', is_member: false });
    expect(out.isMember).toBe(false);
    expect(out.kind).toBe('public_channel');
  });

  it('does not invent a name for a DM', () => {
    // Slack gives a DM no name, only the counterpart's user id. A friendly name
    // here would be a guess presented as fact.
    expect(mapConversation({ id: 'D1', is_im: true, user: 'U9' }).name).toBe('dm:U9');
  });

  it('distinguishes the four conversation kinds', () => {
    expect(mapConversation({ id: 'C1' }).kind).toBe('public_channel');
    expect(mapConversation({ id: 'C2', is_private: true }).kind).toBe('private_channel');
    expect(mapConversation({ id: 'G1', is_mpim: true }).kind).toBe('mpim');
    expect(mapConversation({ id: 'D1', is_im: true }).kind).toBe('im');
  });
});

describe('SlackChatConnector.fetchMessagePage', () => {
  const PARENT = { ts: '100.0', user: 'U1', text: 'q?', thread_ts: '100.0', reply_count: 2 };
  const PLAIN = { ts: '101.0', user: 'U2', text: 'hello' };

  it('fetches the replies that history does not return', async () => {
    const { api, calls } = connector([
      { messages: [PARENT, PLAIN], response_metadata: { next_cursor: '' } },
      {
        messages: [
          PARENT,
          { ts: '100.1', user: 'U2', text: 'a', thread_ts: '100.0' },
          { ts: '100.2', user: 'U3', text: 'b', thread_ts: '100.0' },
        ],
        response_metadata: { next_cursor: '' },
      },
    ]);
    const page = await api.fetchMessagePage('C1');
    expect(calls.map((c) => c.method)).toEqual(['conversations.history', 'conversations.replies']);
    expect(page.threadsFetched).toBe(1);
    // 2 from history + 2 replies, with the parent not counted twice.
    expect(page.messages).toHaveLength(4);
  });

  it('does not return the thread parent twice', async () => {
    // conversations.replies includes the parent as its first element. Keeping
    // it would produce two evidence items with the same id.
    const { api } = connector([
      { messages: [PARENT], response_metadata: { next_cursor: '' } },
      {
        messages: [PARENT, { ts: '100.1', user: 'U2', text: 'a', thread_ts: '100.0' }],
        response_metadata: { next_cursor: '' },
      },
    ]);
    const page = await api.fetchMessagePage('C1');
    expect(page.messages.filter((m) => m.ts === '100.0')).toHaveLength(1);
  });

  it('makes no reply call when nothing is threaded', async () => {
    const { api, calls } = connector([
      { messages: [PLAIN], response_metadata: { next_cursor: '' } },
    ]);
    const page = await api.fetchMessagePage('C1');
    expect(page.threadsFetched).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('passes the date window through to Slack', async () => {
    const { api, calls } = connector([{ messages: [], response_metadata: { next_cursor: '' } }]);
    await api.fetchMessagePage('C1', { oldest: '1700000000.000000' });
    expect(calls[0]?.body).toContain('oldest=1700000000');
  });

  it('surfaces the next cursor so paging can continue', async () => {
    const { api } = connector([{ messages: [PLAIN], response_metadata: { next_cursor: 'NEXT' } }]);
    expect((await api.fetchMessagePage('C1')).nextCursor).toBe('NEXT');
  });
});
