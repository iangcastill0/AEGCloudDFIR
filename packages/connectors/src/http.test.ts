import { describe, expect, it } from 'vitest';
import {
  followRedirectWithoutAuth,
  parseRetryAfterMs,
  providerFetch,
  sanitizeUrl,
  type FetchLike,
} from './http.js';
import {
  ProviderApiError,
  ProviderAuthError,
  ProviderThrottledError,
  type TokenProvider,
} from './types.js';

class SequenceTokenProvider implements TokenProvider {
  invalidations = 0;
  private index = 0;
  constructor(private readonly tokens: string[]) {}
  getAccessToken(): Promise<string> {
    return Promise.resolve(this.tokens[Math.min(this.index, this.tokens.length - 1)] ?? 'tok');
  }
  invalidate(): void {
    this.invalidations += 1;
    this.index += 1;
  }
}

interface SeenRequest {
  url: string;
  authorization: string | null;
}

function queuedFetch(responses: (() => Response)[]): { fetchImpl: FetchLike; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  let i = 0;
  const fetchImpl: FetchLike = (url, init) => {
    const headers = new Headers(init?.headers);
    seen.push({ url, authorization: headers.get('authorization') });
    const factory = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (factory === undefined) throw new Error('no queued response');
    return Promise.resolve(factory());
  };
  return { fetchImpl, seen };
}

function baseOpts(fetchImpl: FetchLike, extra: Record<string, unknown> = {}) {
  const sleeps: number[] = [];
  return {
    sleeps,
    opts: {
      tokenProvider: new SequenceTokenProvider(['t1', 't2']),
      provider: 'microsoft' as const,
      fetchImpl,
      sleepImpl: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      randomImpl: () => 1,
      ...extra,
    },
  };
}

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
  });
  it('parses an HTTP-date', () => {
    const now = Date.now();
    const value = new Date(now + 5000).toUTCString();
    const ms = parseRetryAfterMs(value, now);
    expect(ms).toBeGreaterThan(3000);
    expect(ms).toBeLessThanOrEqual(5000);
  });
  it('returns undefined for garbage and null', () => {
    expect(parseRetryAfterMs('soon')).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });
});

describe('sanitizeUrl', () => {
  it('strips query strings that could contain tokens', () => {
    expect(sanitizeUrl('https://x.example/a/b?access_token=secret123#f')).toBe(
      'https://x.example/a/b',
    );
  });
});

describe('providerFetch', () => {
  it('honors Retry-After seconds on 429 and reports the wait', async () => {
    const { fetchImpl } = queuedFetch([
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }),
      () => new Response('ok', { status: 200 }),
    ]);
    const events: { reason: string; waitMs: number; attempt: number }[] = [];
    const { opts, sleeps } = baseOpts(fetchImpl, {
      onRateLimit: (info: { reason: string; waitMs: number; attempt: number }) => events.push(info),
    });
    const res = await providerFetch('https://api.example/x', { method: 'GET' }, opts);
    expect(res.status).toBe(200);
    expect(sleeps).toEqual([2000]);
    expect(events).toEqual([
      expect.objectContaining({ reason: 'retry-after', waitMs: 2000, attempt: 1 }),
    ]);
  });

  it('honors Retry-After HTTP-dates', async () => {
    const date = new Date(Date.now() + 5000).toUTCString();
    const { fetchImpl } = queuedFetch([
      () => new Response('busy', { status: 503, headers: { 'retry-after': date } }),
      () => new Response('ok', { status: 200 }),
    ]);
    const { opts, sleeps } = baseOpts(fetchImpl);
    const res = await providerFetch('https://api.example/x', { method: 'GET' }, opts);
    expect(res.status).toBe(200);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(2000);
    expect(sleeps[0]).toBeLessThanOrEqual(5000);
  });

  it('backs off with full jitter capped at capMs when no Retry-After', async () => {
    const { fetchImpl } = queuedFetch([
      () => new Response('e', { status: 503 }),
      () => new Response('e', { status: 503 }),
      () => new Response('e', { status: 503 }),
      () => new Response('ok', { status: 200 }),
    ]);
    const { opts, sleeps } = baseOpts(fetchImpl, {
      retry: { maxAttempts: 5, baseMs: 100, capMs: 250 },
    });
    const res = await providerFetch('https://api.example/x', { method: 'GET' }, opts);
    expect(res.status).toBe(200);
    // randomImpl() === 1 → min(cap, base * 2^(attempt-1)) exactly.
    expect(sleeps).toEqual([100, 200, 250]);
  });

  it('refreshes the token and retries exactly once on 401', async () => {
    const { fetchImpl, seen } = queuedFetch([
      () => new Response('unauthorized', { status: 401 }),
      () => new Response('ok', { status: 200 }),
    ]);
    const { opts } = baseOpts(fetchImpl);
    const res = await providerFetch('https://api.example/x', { method: 'GET' }, opts);
    expect(res.status).toBe(200);
    expect((opts.tokenProvider as SequenceTokenProvider).invalidations).toBe(1);
    expect(seen.map((s) => s.authorization)).toEqual(['Bearer t1', 'Bearer t2']);
  });

  it('throws ProviderAuthError when 401 persists after refresh', async () => {
    const { fetchImpl } = queuedFetch([() => new Response('no', { status: 401 })]);
    const { opts } = baseOpts(fetchImpl);
    await expect(
      providerFetch('https://api.example/x', { method: 'GET' }, opts),
    ).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it('retries 5xx then throws a sanitized ProviderApiError', async () => {
    const { fetchImpl, seen } = queuedFetch([() => new Response('boom', { status: 500 })]);
    const { opts } = baseOpts(fetchImpl, { retry: { maxAttempts: 3, baseMs: 1, capMs: 2 } });
    const err = await providerFetch(
      'https://api.example/x?access_token=secret123',
      { method: 'GET' },
      opts,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderApiError);
    expect((err as ProviderApiError).status).toBe(500);
    expect((err as ProviderApiError).message).not.toContain('secret123');
    expect(seen).toHaveLength(3);
  });

  it('throws ProviderThrottledError when 429 retries are exhausted', async () => {
    const { fetchImpl } = queuedFetch([
      () => new Response('throttled', { status: 429, headers: { 'retry-after': '1' } }),
    ]);
    const { opts } = baseOpts(fetchImpl, { retry: { maxAttempts: 2, baseMs: 1, capMs: 2 } });
    const err = await providerFetch('https://api.example/x', { method: 'GET' }, opts).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderThrottledError);
    expect((err as ProviderThrottledError).retryAfterMs).toBe(1000);
  });

  it('returns non-retryable 4xx responses to the caller', async () => {
    const { fetchImpl } = queuedFetch([() => new Response('gone', { status: 410 })]);
    const { opts } = baseOpts(fetchImpl);
    const res = await providerFetch('https://api.example/x', { method: 'GET' }, opts);
    expect(res.status).toBe(410);
  });

  it('aborts a hung request via the per-attempt timeout', async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) return;
        signal.addEventListener('abort', () => reject(signal.reason));
      });
    const { opts } = baseOpts(fetchImpl, {
      timeoutMs: 20,
      retry: { maxAttempts: 1, baseMs: 1, capMs: 2 },
    });
    const err = await providerFetch('https://api.example/slow', { method: 'GET' }, opts).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderApiError);
    expect((err as ProviderApiError).message).toContain('timed out');
  });
});

describe('followRedirectWithoutAuth', () => {
  it('follows the Location without forwarding the Authorization header', async () => {
    const { fetchImpl, seen } = queuedFetch([() => new Response('bytes', { status: 200 })]);
    const redirect = new Response(null, {
      status: 302,
      headers: { location: 'https://cdn.example/blob?tempauth=abc' },
    });
    const res = await followRedirectWithoutAuth(redirect, { fetchImpl });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.authorization).toBeNull();
    expect(seen[0]?.url).toBe('https://cdn.example/blob?tempauth=abc');
  });

  it('rejects non-redirect responses', async () => {
    await expect(
      followRedirectWithoutAuth(new Response('x', { status: 200 })),
    ).rejects.toBeInstanceOf(ProviderApiError);
  });
});
