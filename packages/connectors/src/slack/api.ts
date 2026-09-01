/**
 * The Slack Web API client.
 *
 * Deliberately not built on `providerFetch`. That helper decides success from
 * the HTTP status, and Slack reports failure with **HTTP 200** and
 * `{"ok": false}` — so the shared retry and error handling would classify a
 * failed call as a successful one and a collection would record nothing while
 * reporting completion. Everything here goes through `readSlackEnvelope`
 * instead.
 *
 * Rate limiting is handled here too, for the same reason: Slack's 429 carries a
 * `Retry-After` that says exactly how long to wait, and failing the job instead
 * would drop a page of messages in the middle of a collection.
 */
import type { FetchLike } from '../http.js';
import type { TokenProvider } from '../types.js';
import { ConnectorError } from '../types.js';
import { nextSlackCursor, readSlackEnvelope, slackRetryAfterMs } from './envelope.js';

const DEFAULT_BASE_URL = 'https://slack.com/api';
const DEFAULT_TIMEOUT_MS = 60_000;
/** Slack's own maximum for the paginated read methods. */
export const SLACK_PAGE_LIMIT = 200;

export interface SlackClientOptions {
  tokenProvider: TokenProvider;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /** Injectable so rate-limit behaviour is testable without real waiting. */
  sleepImpl?: (ms: number) => Promise<void>;
  maxRateLimitRetries?: number;
}

export type SlackParams = Record<string, string | number | boolean | undefined>;

export class SlackClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly maxRateLimitRetries: number;

  constructor(private readonly options: SlackClientOptions) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? ((u, i) => fetch(u, i));
    this.sleepImpl =
      options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRateLimitRetries = options.maxRateLimitRetries ?? 5;
  }

  /** One Web API call. Throws SlackApiError on `ok: false`. */
  async call(method: string, params: SlackParams): Promise<Record<string, unknown>> {
    const token = await this.options.tokenProvider.getAccessToken();
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      // Skipped, not stringified: Slack reads the literal "undefined" as a
      // cursor value and answers invalid_cursor.
      if (value === undefined) continue;
      body.set(key, String(value));
    }

    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetchImpl(`${this.baseUrl}/${method}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });

      if (response.status === 429) {
        if (attempt >= this.maxRateLimitRetries) {
          throw new ConnectorError(
            `slack ${method}: still rate limited after ${String(this.maxRateLimitRetries)} retries`,
          );
        }
        // Slack says how long. Guessing would either hammer it or stall.
        await this.sleepImpl(slackRetryAfterMs(response.headers) ?? 1000);
        continue;
      }

      // A non-200 that is not a 429 is a transport or gateway problem; the
      // envelope check below cannot help with an HTML error page.
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      return readSlackEnvelope(parsed, method);
    }
  }

  /**
   * Every page of a collection-returning method.
   *
   * Yields arrays rather than items so a caller can checkpoint per page, and
   * throws when the named key is missing: a renamed or absent collection would
   * otherwise page silently over nothing and report a clean, empty result.
   */
  async *paginate(
    method: string,
    params: SlackParams,
    key: string,
  ): AsyncGenerator<unknown[], void, undefined> {
    let cursor: string | undefined;
    do {
      const body = await this.call(method, {
        limit: SLACK_PAGE_LIMIT,
        ...params,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const items = body[key];
      if (!Array.isArray(items)) {
        throw new ConnectorError(`slack ${method}: response has no "${key}" array`);
      }
      yield items;
      cursor = nextSlackCursor(body);
    } while (cursor !== undefined);
  }
}
