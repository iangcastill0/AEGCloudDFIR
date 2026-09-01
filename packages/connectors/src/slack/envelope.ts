/**
 * Slack's response envelope, and why nothing may bypass it.
 *
 * Slack answers a FAILED call with **HTTP 200** and `{"ok": false, "error":
 * "..."}`. Every other provider in this codebase signals failure with a status
 * code, and `ensureOk` is built on exactly that assumption. Handed a Slack
 * response it sees 200, returns happily, and the collection records zero
 * messages as a complete success.
 *
 * That is the "reports success, silently broken" failure this project keeps
 * being bitten by, pre-installed in the provider's API design. So every Slack
 * response passes through here before anything else looks at it.
 */
import { ConnectorError } from '../types.js';

export class SlackApiError extends ConnectorError {
  /** Slack's own error code: missing_scope, not_in_channel, ratelimited, … */
  readonly slackError: string;
  readonly needed?: string;

  constructor(message: string, opts: { slackError: string; needed?: string }) {
    super(message);
    this.slackError = opts.slackError;
    if (opts.needed !== undefined) this.needed = opts.needed;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The payload, or a thrown error carrying Slack's own diagnosis.
 *
 * A body with no `ok` field is rejected rather than passed through: Slack
 * returns an HTML sign-in page for some auth failures, and treating that as an
 * empty-but-successful result would collect nothing and say so cheerfully.
 */
export function readSlackEnvelope(body: unknown, call: string): Record<string, unknown> {
  if (!isRecord(body) || typeof body['ok'] !== 'boolean') {
    throw new SlackApiError(
      `slack ${call}: response was not a Slack API envelope (no "ok" field)`,
      { slackError: 'malformed_response' },
    );
  }
  if (body['ok'] === true) return body;

  const slackError = typeof body['error'] === 'string' ? body['error'] : 'unknown_error';
  const needed = typeof body['needed'] === 'string' ? body['needed'] : undefined;
  // Slack has already worked out what is wrong. missing_scope, not_in_channel
  // and token_revoked are three different fixes, and the code names which.
  return (() => {
    throw new SlackApiError(
      `slack ${call}: ${slackError}${needed === undefined ? '' : ` (needs ${needed})`}`,
      { slackError, ...(needed === undefined ? {} : { needed }) },
    );
  })();
}

/**
 * The cursor for the next page, or undefined at the end.
 *
 * Slack sends `next_cursor: ""` on the last page. Passing an empty string back
 * as a cursor restarts the listing from the beginning, which loops forever
 * while looking like healthy paging.
 */
export function nextSlackCursor(body: Record<string, unknown>): string | undefined {
  const meta = body['response_metadata'];
  if (!isRecord(meta)) return undefined;
  const cursor = meta['next_cursor'];
  return typeof cursor === 'string' && cursor.length > 0 ? cursor : undefined;
}

/** Slack's Retry-After, in milliseconds. Undefined when it did not say. */
export function slackRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}
