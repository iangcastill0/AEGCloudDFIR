import type { FetchLike, ProviderFetchOptions, RetryPolicy } from '../http.js';
import type { ConnectionMode, RateLimitObserver, TokenProvider } from '../types.js';

export interface GraphConnectorOptions {
  tokenProvider: TokenProvider;
  /** e.g. https://graph.microsoft.com/v1.0 (CDFIR_MS_GRAPH_BASE_URL). */
  graphBaseUrl: string;
  mode: ConnectionMode;
  onRateLimit?: RateLimitObserver;
  fetchImpl?: FetchLike;
  retry?: Partial<RetryPolicy>;
  timeoutMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  randomImpl?: () => number;
}

export function graphFetchOptions(opts: GraphConnectorOptions): ProviderFetchOptions {
  return {
    tokenProvider: opts.tokenProvider,
    provider: 'microsoft',
    retry: opts.retry,
    onRateLimit: opts.onRateLimit,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
    sleepImpl: opts.sleepImpl,
    randomImpl: opts.randomImpl,
  };
}

/** '/me' in delegated mode; '/users/{id-or-upn}' in organization mode. */
export function userSegment(mode: ConnectionMode, custodian: string): string {
  return mode === 'delegated' || custodian === 'me'
    ? '/me'
    : `/users/${encodeURIComponent(custodian)}`;
}

/** Strip a trailing slash from a configured base URL. */
export function normalizeBaseUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
