import type { FetchLike, ProviderFetchOptions, RetryPolicy } from '../http.js';
import type { RateLimitObserver, TokenProvider } from '../types.js';

export interface GoogleConnectorOptions {
  tokenProvider: TokenProvider;
  /** e.g. https://www.googleapis.com (EV_GOOGLE_API_BASE_URL). */
  googleApiBaseUrl: string;
  onRateLimit?: RateLimitObserver;
  fetchImpl?: FetchLike;
  retry?: Partial<RetryPolicy>;
  timeoutMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  randomImpl?: () => number;
}

export function googleFetchOptions(opts: GoogleConnectorOptions): ProviderFetchOptions {
  return {
    tokenProvider: opts.tokenProvider,
    provider: 'google',
    retry: opts.retry,
    onRateLimit: opts.onRateLimit,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
    sleepImpl: opts.sleepImpl,
    randomImpl: opts.randomImpl,
  };
}

export function normalizeBaseUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Gmail/Workspace APIs always address the authenticated principal: 'me' in
 * delegated mode, and in organization mode the DWD token source already
 * impersonates the custodian, so the API user id stays 'me'.
 */
export const GOOGLE_SELF_UID = 'me';
