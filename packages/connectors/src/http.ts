/**
 * Shared provider HTTP layer: bearer injection, 401 re-auth (single retry),
 * Retry-After / 429 / 503 handling, exponential backoff with full jitter,
 * per-attempt timeouts, and sanitized errors (never a header value or a
 * query string, which may carry tokens).
 */
import {
  ProviderApiError,
  ProviderAuthError,
  ProviderThrottledError,
  type ProviderName,
  type RateLimitObserver,
  type TokenProvider,
} from './types.js';

export interface RetryPolicy {
  maxAttempts: number;
  baseMs: number;
  capMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseMs: 500,
  capMs: 30_000,
};

export const DEFAULT_TIMEOUT_MS = 60_000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ProviderFetchOptions {
  tokenProvider: TokenProvider;
  provider: ProviderName;
  retry?: Partial<RetryPolicy>;
  onRateLimit?: RateLimitObserver;
  fetchImpl?: FetchLike;
  /** Per-attempt timeout. Defaults to 60s. */
  timeoutMs?: number;
  /** Injectable for tests: replaces real waiting between retries. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Injectable for tests: uniform [0,1) source for jitter. */
  randomImpl?: () => number;
}

/** Strips query string and fragment: URLs in error messages must never carry tokens. */
export function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    // Not parseable — refuse to echo it at all rather than risk leaking.
    return '<unparseable-url>';
  }
}

/** Parse a Retry-After header value: delta-seconds or HTTP-date. Returns ms or undefined. */
export function parseRetryAfterMs(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Fetch a provider URL with auth, throttling and retry semantics.
 *
 * - Injects `Authorization: Bearer <token>` from the token provider.
 * - 401: invalidates the token and retries exactly once with a fresh token.
 * - 429/503: honors Retry-After (seconds or HTTP-date), otherwise full-jitter
 *   exponential backoff; notifies `onRateLimit` before each wait.
 * - Other 5xx: full-jitter backoff retries.
 * - Network errors and per-attempt timeouts are retried like 5xx.
 * - Exhausted retries throw ProviderThrottledError (429) or ProviderApiError.
 * - Non-retryable statuses (including 3xx with redirect:'manual' and 4xx like
 *   404/410) are returned to the caller for provider-specific mapping.
 */
export async function providerFetch(
  url: string,
  init: RequestInit,
  opts: ProviderFetchOptions,
): Promise<Response> {
  const retry: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...opts.retry };
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const sleep = opts.sleepImpl ?? defaultSleep;
  const random = opts.randomImpl ?? Math.random;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const safeUrl = sanitizeUrl(url);

  let authRetried = false;
  let attempt = 0;

  while (true) {
    attempt += 1;
    const token = await opts.tokenProvider.getAccessToken();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);

    let response: Response | undefined;
    let transportFailure: string | undefined;
    try {
      response = await fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      transportFailure =
        err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')
          ? `request timed out after ${timeoutMs}ms`
          : 'network error during request';
    }

    if (response !== undefined) {
      if (response.status === 401) {
        if (!authRetried) {
          authRetried = true;
          attempt -= 1; // the auth retry does not consume a backoff attempt
          opts.tokenProvider.invalidate();
          continue;
        }
        throw new ProviderAuthError(
          `unauthorized (401) after token refresh for ${init.method ?? 'GET'} ${safeUrl}`,
          { status: 401 },
        );
      }

      if (!RETRYABLE_STATUS.has(response.status)) {
        return response; // 2xx, 3xx (manual redirects) and non-retryable 4xx
      }

      const throttled = response.status === 429 || response.status === 503;
      if (attempt >= retry.maxAttempts) {
        const message = `provider returned ${response.status} after ${attempt} attempts for ${init.method ?? 'GET'} ${safeUrl}`;
        if (response.status === 429) {
          throw new ProviderThrottledError(message, {
            retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
          });
        }
        throw new ProviderApiError(message, {
          status: response.status,
          requestId: response.headers.get('request-id') ?? undefined,
        });
      }

      const retryAfterMs = throttled
        ? parseRetryAfterMs(response.headers.get('retry-after'))
        : undefined;
      const backoffMs = Math.round(
        random() * Math.min(retry.capMs, retry.baseMs * 2 ** (attempt - 1)),
      );
      const waitMs = retryAfterMs ?? backoffMs;
      if (throttled) {
        opts.onRateLimit?.({
          provider: opts.provider,
          waitMs,
          reason: retryAfterMs !== undefined ? 'retry-after' : 'backoff',
          attempt,
        });
      }
      await sleep(waitMs);
      continue;
    }

    // Transport-level failure (timeout / network).
    if (attempt >= retry.maxAttempts) {
      throw new ProviderApiError(
        `${transportFailure ?? 'request failed'} after ${attempt} attempts for ${init.method ?? 'GET'} ${safeUrl}`,
        { status: 0 },
      );
    }
    await sleep(Math.round(random() * Math.min(retry.capMs, retry.baseMs * 2 ** (attempt - 1))));
  }
}

interface ProviderErrorBody {
  code?: string;
  requestId?: string;
}

async function readErrorBody(response: Response): Promise<ProviderErrorBody> {
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed !== 'object' || parsed === null) return {};
    const error = (parsed as Record<string, unknown>)['error'];
    if (typeof error === 'string') return { code: error };
    if (typeof error !== 'object' || error === null) return {};
    const rec = error as Record<string, unknown>;
    const code =
      typeof rec['code'] === 'string'
        ? rec['code']
        : typeof rec['status'] === 'string'
          ? rec['status']
          : typeof rec['code'] === 'number'
            ? String(rec['code'])
            : undefined;
    const inner = rec['innerError'];
    const requestId =
      typeof inner === 'object' && inner !== null
        ? (inner as Record<string, unknown>)['request-id']
        : undefined;
    return { code, requestId: typeof requestId === 'string' ? requestId : undefined };
  } catch {
    return {};
  }
}

/**
 * Throws a sanitized ProviderApiError for non-2xx responses. Callers should
 * first branch on statuses with provider-specific meaning (404, 410, 403).
 */
export async function ensureOk(response: Response, context: string): Promise<Response> {
  if (response.ok) return response;
  const body = await readErrorBody(response);
  throw new ProviderApiError(`${context}: provider returned HTTP ${response.status}`, {
    status: response.status,
    providerCode: body.code,
    requestId: body.requestId ?? response.headers.get('request-id') ?? undefined,
  });
}

/**
 * Follow a 3xx redirect WITHOUT the Authorization header. Graph /content
 * returns a 302 to a pre-authenticated URL which must not receive our bearer
 * token (and whose query string must never be logged).
 */
export async function followRedirectWithoutAuth(
  response: Response,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<Response> {
  const location = response.headers.get('location');
  if (response.status < 300 || response.status >= 400 || location === null) {
    throw new ProviderApiError('expected a redirect response with a Location header', {
      status: response.status,
    });
  }
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const downloaded = await fetchImpl(location, {
    method: 'GET',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!downloaded.ok) {
    throw new ProviderApiError(
      `pre-authenticated download failed with HTTP ${downloaded.status} for ${sanitizeUrl(location)}`,
      { status: downloaded.status },
    );
  }
  return downloaded;
}
