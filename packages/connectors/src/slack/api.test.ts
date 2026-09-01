import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../http.js';
import { SlackApiError } from './envelope.js';
import { SlackClient } from './api.js';

function client(responses: (() => Response)[], seen: { url: string; body: string }[] = []) {
  let i = 0;
  const fetchImpl: FetchLike = (url, init) => {
    seen.push({ url, body: String(init?.body ?? '') });
    const factory = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (factory === undefined) throw new Error('no queued response');
    return Promise.resolve(factory());
  };
  return {
    seen,
    api: new SlackClient({
      tokenProvider: { getAccessToken: () => Promise.resolve('xoxp-test') },
      baseUrl: 'https://slack.test/api',
      fetchImpl,
      sleepImpl: () => Promise.resolve(),
    }),
  };
}

const ok = (payload: Record<string, unknown>) => () =>
  new Response(JSON.stringify({ ok: true, ...payload }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('SlackClient.call', () => {
  it('treats ok:false as a failure despite the 200', async () => {
    const { api } = client([
      () =>
        new Response(JSON.stringify({ ok: false, error: 'not_in_channel' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ]);
    await expect(api.call('conversations.history', {})).rejects.toBeInstanceOf(SlackApiError);
  });

  it('posts form-encoded, which is what Slack expects for these methods', async () => {
    const { api, seen } = client([ok({ messages: [] })]);
    await api.call('conversations.history', { channel: 'C1', limit: 200 });
    expect(seen[0]?.url).toBe('https://slack.test/api/conversations.history');
    expect(seen[0]?.body).toContain('channel=C1');
    expect(seen[0]?.body).toContain('limit=200');
  });

  it('omits undefined parameters instead of sending the string "undefined"', async () => {
    // Slack takes 'undefined' as a literal cursor and returns invalid_cursor.
    const { api, seen } = client([ok({ messages: [] })]);
    await api.call('conversations.history', { channel: 'C1', cursor: undefined });
    expect(seen[0]?.body).not.toContain('undefined');
  });

  it('waits and retries on a 429 rather than losing the page', async () => {
    // Slack rate-limits hard and tells you exactly how long to wait. Failing
    // the job instead would drop a page of messages mid-collection.
    const sleeps: number[] = [];
    let i = 0;
    const fetchImpl: FetchLike = () => {
      i += 1;
      return Promise.resolve(
        i === 1
          ? new Response('', { status: 429, headers: { 'retry-after': '3' } })
          : new Response(JSON.stringify({ ok: true, messages: [{ ts: '1.0' }] }), { status: 200 }),
      );
    };
    const api = new SlackClient({
      tokenProvider: { getAccessToken: () => Promise.resolve('t') },
      baseUrl: 'https://slack.test/api',
      fetchImpl,
      sleepImpl: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    const body = await api.call('conversations.history', { channel: 'C1' });
    expect(sleeps).toEqual([3000]);
    expect((body['messages'] as unknown[]).length).toBe(1);
  });

  it('gives up after repeated rate limits rather than retrying forever', async () => {
    const fetchImpl: FetchLike = () =>
      Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '1' } }));
    const api = new SlackClient({
      tokenProvider: { getAccessToken: () => Promise.resolve('t') },
      baseUrl: 'https://slack.test/api',
      fetchImpl,
      sleepImpl: () => Promise.resolve(),
      maxRateLimitRetries: 2,
    });
    await expect(api.call('conversations.history', {})).rejects.toThrow(/rate limit/i);
  });
});

describe('SlackClient.paginate', () => {
  it('follows the cursor to the end', async () => {
    const { api } = client([
      ok({ channels: [{ id: 'C1' }], response_metadata: { next_cursor: 'p2' } }),
      ok({ channels: [{ id: 'C2' }], response_metadata: { next_cursor: '' } }),
    ]);
    const all: unknown[] = [];
    for await (const page of api.paginate('conversations.list', {}, 'channels')) {
      all.push(...page);
    }
    expect(all).toHaveLength(2);
  });

  it('stops on an empty cursor instead of restarting the listing', async () => {
    // next_cursor: "" means the end. Sending it back restarts from page one,
    // which loops forever while looking like healthy paging.
    const calls: { url: string; body: string }[] = [];
    const { api } = client([ok({ channels: [], response_metadata: { next_cursor: '' } })], calls);
    for await (const _page of api.paginate('conversations.list', {}, 'channels')) {
      // drain
    }
    expect(calls).toHaveLength(1);
  });

  it('refuses a page whose collection key is missing', async () => {
    // A renamed or absent key would otherwise page silently over nothing.
    const { api } = client([ok({ response_metadata: { next_cursor: '' } })]);
    const drain = async (): Promise<void> => {
      for await (const _page of api.paginate('conversations.list', {}, 'channels')) {
        // drain
      }
    };
    await expect(drain()).rejects.toThrow(/channels/);
  });
});
